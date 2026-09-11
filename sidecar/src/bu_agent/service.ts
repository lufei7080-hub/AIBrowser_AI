/**
 * browser-use 风格自主 Agent 主循环（天枢台实现）
 * 仅 CDP 附着已启动 CloakBrowser；不改环境配置。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

import {
  agentForcedToolRequestPatch,
  beginAgentLlmWait,
  createLlmClient,
  extractAssistantContent,
} from "../ai_client.js";
import {
  createModelRouter,
  isIntentConfigured,
} from "../ai_model_router.js";
import { OmniActionGateway, runWithGateway } from "../core/action_gateway.js";
import {
  emitInteractiveExtractDebug,
  snapshotInteractiveElements,
} from "../interactive_elements.js";
import {
  assertObservationReady,
  buildObservationNudges,
  disposeObservation,
  materializeShotDataUrls,
  prepareObservation,
  type ObservationPack,
} from "../page_pipeline/index.js";
import type { JsonLogger } from "../json-logger.js";
import type { SidecarAiSettings } from "../engine.js";
import { findIndexByTextHint } from "./captcha_form_hints.js";
import {
  assertPersistableTrajectorySteps,
  buildTrajectoryPayload,
  domainFromUrl,
  persistTrajectoryToDisk,
  type TrajectoryStep,
} from "../trajectory.js";
import { ensureActionsRegistered } from "./actions.js";
import { assertRequiredActions } from "./registry.js";
import { buildBrowserStateWithShortIdDiff } from "./browser_state.js";
import { AgentFileSystem } from "./filesystem.js";
import { judgeTrace, shouldSkipJudge } from "./judge.js";
import { MessageManager } from "./message_manager.js";
import { multiAct } from "./multi_act.js";
import {
  agentOutputFromToolCalls,
  agentOutputJsonSchema,
  buildUserStateMessage,
  extractJsonObject,
  loadSystemPrompt,
  normalizeAgentOutput,
} from "./prompts.js";
import { analyzeTask, planItemNeedsObservation } from "./task_analyze.js";
import {
  extractPageReading,
  formatPageReadingForLlm,
} from "../page_read.js";
import { buildSkillMatchNudges, ensureSkillsLoaded } from "./skills/index.js";
import { buildRegistryOpenAiTools } from "./tool_schemas.js";
import {
  DEFAULT_AGENT_SETTINGS,
  type AgentOutput,
  type AgentSettings,
  type BrowserStateSummary,
} from "./views.js";

export interface AgentConfirmActionPreview {
  kind: "fill" | "click";
  id: string;
  text: string;
  value?: string;
  selectorHint?: string;
}

export interface AgentConfirmRequest {
  requestId: string;
  url: string;
  reason?: string;
  actions: AgentConfirmActionPreview[];
}

export interface AgentConfirmResponse {
  approved: boolean;
  fillOverrides?: Record<string, string>;
}

export interface AgentHandoverRequest {
  requestId: string;
  url: string;
  reason: string;
}

export interface AgentLoopDeps {
  logger: JsonLogger;
  aiSettings: SidecarAiSettings;
  goal: string;
  maxRounds?: number;
  senseMode?: string;
  profileId?: string;
  /** 环境 userDataDir：用于落盘 agent llm_json 供测试窗读取 */
  userDataDir?: string | null;
  /** UI 开关：Agent 全景多帧截图 */
  panoramaEnabled?: boolean;
  enableRecording?: boolean;
  controlMemorySeed?: unknown[];
  geoContext?: unknown;
  personaData?: unknown;
  requestConfirm: (request: AgentConfirmRequest) => Promise<AgentConfirmResponse>;
  askUser: (requestId: string, question: string) => Promise<string>;
  requestHandover: (request: AgentHandoverRequest) => Promise<void>;
  signal?: AbortSignal;
}

export interface AgentLoopResult {
  success: boolean;
  summary: string;
  rounds: number;
  trajectory?: TrajectoryStep[];
  domain?: string;
  startUrl?: string;
}

export async function runBuAutonomousAgentLoop(
  page: Page,
  deps: AgentLoopDeps,
): Promise<AgentLoopResult> {
  ensureActionsRegistered();
  assertRequiredActions();
  ensureSkillsLoaded();

  let settings: AgentSettings = {
    ...DEFAULT_AGENT_SETTINGS,
    maxActionsPerStep: 5,
    useVision: "auto",
    useThinking: true,
    flashMode: false,
    useJudge: true,
  };

  const maxSteps = Math.max(1, Math.min(80, deps.maxRounds ?? 40));
  const startUrl = page.url();
  const profileId = deps.profileId || "default";
  const fsRoot = join(homedir(), ".cloakforge");
  const fileSystem = new AgentFileSystem(fsRoot, profileId);
  const messageManager = new MessageManager(settings);
  const enableRecording = deps.enableRecording === true;
  /** 勾选「录制执行轨迹」时由网关收集；成功后落库 + 推送轨迹记忆 */
  const recordedSteps: Omit<TrajectoryStep, "step">[] = [];
  /** 必须用 getter：new_tab / switch 后跟活动页，禁止钉死初始 page */
  let activePage = page;
  const gateway = new OmniActionGateway(() => activePage, {
    logger: deps.logger,
    record: enableRecording
      ? (snapshot) => {
          recordedSteps.push(snapshot);
        }
      : undefined,
  });

  let includeScreenshotNext = false;
  let previousObservation: ObservationPack | null = null;
  const panoramaEnabled = deps.panoramaEnabled === true;
  if (panoramaEnabled) {
    settings = { ...settings, useVision: true };
    includeScreenshotNext = true;
  }
  let previousShortIds: Set<string> | null = null;
  let previousUrl: string | null = null;
  let browserState: BrowserStateSummary | null = null;
  let doneSummary = "";
  let doneSuccess = false;
  let finished = false;

  deps.logger.agentState("running", { profileId });
  deps.logger.agentProgress("Agent 已启动（Analyze → Bootstrap → Execute）", {
    goal: deps.goal,
    maxSteps,
    enableRecording,
  });
  if (enableRecording) {
    deps.logger.agentProgress("轨迹录制已开启：成功结束后写入「轨迹记忆」", {
      phase: "record",
    });
  }

  const systemPrompt = loadSystemPrompt(settings);
  const router = createModelRouter(deps.aiSettings);
  let lastHadError = false;
  let lastElementCount = 0;
  let forceObserveNext = true;

  const bindActivePage = (p: Page): void => {
    activePage = p;
  };

  await runWithGateway(gateway, async () => {
    // ——— Phase A：任务分析（不抽 DOM）———
    deps.logger.agentProgress("任务分析中…（拆解自然语言计划，不观察页面）", {
      phase: "analyze",
    });
    const analyzed = await analyzeTask({
      goal: deps.goal,
      aiSettings: deps.aiSettings,
      signal: deps.signal,
    });
    messageManager.seedPlan(analyzed.plan, 0);
    deps.logger.agentProgress(
      `任务分析完成 · ${analyzed.plan.length} 步计划（${analyzed.source}）`,
      {
        phase: "analyze",
        plan: analyzed.plan,
        bootstrap: analyzed.bootstrapActions.map((a) => a.name),
        queryTerms: analyzed.queryTerms,
        acceptance: analyzed.acceptance,
      },
    );

    // ——— Phase B：引导导航（零全量提取）———
    if (analyzed.bootstrapActions.length > 0) {
      const bootUrl = String(analyzed.bootstrapActions[0]?.params?.url ?? "");
      deps.logger.agentProgress(
        bootUrl ? `引导打开：${bootUrl}` : "引导执行 bootstrap 动作…",
        { phase: "bootstrap", actions: analyzed.bootstrapActions.map((a) => a.name) },
      );
      activePage = pickLivePage(activePage);
      const bootState = await minimalBrowserState(activePage);
      const bootResults = await multiAct(analyzed.bootstrapActions, {
        page: activePage,
        logger: deps.logger,
        aiSettings: deps.aiSettings,
        browserState: bootState,
        fileSystem,
        profileId,
        goal: deps.goal,
        requestConfirm: async (req) => {
          deps.logger.agentConfirmRequired({
            requestId: req.requestId,
            url: req.url,
            reason: req.reason,
            actions: req.actions,
            profileId,
          });
          return deps.requestConfirm(req);
        },
        askUser: deps.askUser,
        requestHandover: async (req) => {
          deps.logger.agentHandoverRequired({
            requestId: req.requestId,
            url: req.url,
            reason: req.reason,
            profileId,
          });
          await deps.requestHandover(req);
        },
        setIncludeScreenshotNext: (v) => {
          includeScreenshotNext = v;
        },
        setActivePage: bindActivePage,
        resolveElement: () => null,
      });
      activePage = pickLivePage(activePage);
      await activePage.waitForLoadState("domcontentloaded", { timeout: 12_000 }).catch(() => undefined);
      await activePage.waitForTimeout(300).catch(() => undefined);
      const bootErr = bootResults.some((r) => r.error);
      lastHadError = bootErr;
      if (!bootErr && messageManager.plan.length > 1) {
        // 打开类首步已完成 → 推进到下一项
        messageManager.applyPlanUpdate({
          action: [],
          current_plan_item: 1,
        });
      }
      forceObserveNext = true;
    }

    // ——— Phase C：按计划执行（按需观察）———
    for (let step = 1; step <= maxSteps; step++) {
      if (deps.signal?.aborted) {
        throw new Error("Agent 已中止");
      }

      activePage = pickLivePage(activePage);
      const planText = messageManager.currentPlanText();
      const needObserve =
        forceObserveNext ||
        lastHadError ||
        lastElementCount === 0 ||
        planItemNeedsObservation(planText) ||
        includeScreenshotNext ||
        panoramaEnabled;

      disposeObservation(previousObservation);
      previousObservation = null;

      let pack: ObservationPack | null = null;
      let visionImages: string[] = [];

      if (needObserve) {
        deps.logger.agentProgress(`第 ${step}/${maxSteps} 步：观察页面…`, {
          url: activePage.url(),
          planItem: planText,
        });
        const requestedShot = includeScreenshotNext;
        pack = await prepareObservation(activePage, {
          goal: deps.goal,
          profileId,
          panoramaEnabled,
          forceViewportShot: requestedShot && !panoramaEnabled,
          senseMode: "balanced",
          signal: deps.signal,
          previous: null,
        });
        // 首页竞态：偶发 0 控件但 URL 已就绪 → 短等后重抽一次
        if (
          !pack.softError &&
          pack.llm_json.length === 0 &&
          /^https?:\/\//i.test(pack.url || activePage.url())
        ) {
          deps.logger.agentProgress(`第 ${step} 步：控件为 0，短暂等待后重抽…`, {
            step,
            url: pack.url,
          });
          await activePage.waitForTimeout(900).catch(() => undefined);
          disposeObservation(pack);
          pack = await prepareObservation(activePage, {
            goal: deps.goal,
            profileId,
            panoramaEnabled,
            forceViewportShot: requestedShot && !panoramaEnabled,
            senseMode: "balanced",
            signal: deps.signal,
            previous: null,
          });
        }
        previousObservation = pack;
        assertObservationReady(pack);

        // Agent 显式要图却拍不到 → 立即失败，禁止静默「截图关闭」空转
        if (
          requestedShot &&
          !panoramaEnabled &&
          (!pack.shots || pack.shots.length === 0)
        ) {
          const reason = pack.error?.trim()
            ? `截图失败：${pack.error}`
            : SCREENSHOT_CAPABILITY_ERROR;
          deps.logger.agentProgress(`截图能力不可用：${reason}`, {
            step,
            phase: "screenshot_gate",
          });
          doneSummary = reason;
          finished = true;
          doneSuccess = false;
          includeScreenshotNext = false;
          break;
        }

        let fillSnap = null as Awaited<ReturnType<typeof snapshotInteractiveElements>> | null;
        try {
          fillSnap = await Promise.race([
            snapshotInteractiveElements(activePage, null),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
          ]);
        } catch {
          fillSnap = null;
        }

        void emitInteractiveExtractDebug(deps.logger, {
          profileId,
          source: "agent_loop",
          fill: fillSnap,
          agent: {
            url: pack.url,
            extractedAt: pack.extractedAt,
            llm_json: pack.llm_json,
            element_map: pack.element_map,
            skipped: 0,
          },
          userDataDir: null,
          title: pack.title,
        }).catch(() => undefined);

      deps.logger.agentProgress(
        pack.softError
          ? `第 ${step} 步：观察软着陆 — ${pack.error ?? "unknown"}`
          : `第 ${step} 步：提取完成 · ${pack.llm_json.length} 控件 · ${pack.readyNote}`,
        {
          step,
          url: pack.url,
          elements: pack.llm_json.length,
          readyNote: pack.readyNote,
          softError: pack.softError,
          error: pack.error,
        },
      );

        // 全景开 或 Agent 本步请求了 screenshot：都必须把图挂给决策模型
        const shouldAttachShots =
          !pack.softError &&
          (panoramaEnabled || includeScreenshotNext) &&
          Boolean(pack.shots?.length);
        visionImages = shouldAttachShots ? materializeShotDataUrls(pack) : [];
        if (includeScreenshotNext) {
          includeScreenshotNext = false;
        }

        browserState = await buildBrowserStateWithShortIdDiff(
          activePage,
          {
            url: pack.url,
            extractedAt: pack.extractedAt,
            llm_json: pack.llm_json,
            element_map: pack.element_map,
            skipped: 0,
            screenshotBase64: visionImages[0] ?? null,
          },
          previousShortIds,
          previousUrl,
          settings.maxClickableElementsLength,
        );
        browserState.screenshotList = visionImages;
        browserState.observationError = pack.softError ? pack.error : null;
        if (pack.a11ySummary?.trim()) {
          browserState.interactiveTree = `${browserState.interactiveTree}\n\n# a11y_summary\n${pack.a11ySummary.slice(0, 4000)}`;
        }
        lastElementCount = browserState.elementCount;
        forceObserveNext = false;
      } else {
        deps.logger.agentProgress(
          `第 ${step}/${maxSteps} 步：按计划推进（跳过重观察）· ${planText ?? ""}`,
          { url: activePage.url(), skippedObserve: true },
        );
        browserState = await minimalBrowserState(activePage);
        browserState.interactiveTree =
          `${browserState.interactiveTree}\n\n# note\n本步按计划跳过全量 DOM 提取；若需点击/输入请先 screenshot 或下一轮将强制观察。`;
        lastElementCount = 0;
        forceObserveNext = true;
      }

      if (!browserState) {
        throw new Error("browserState 未初始化");
      }

      // 确定性页面阅读：给「分析/总结/自然语言验收」可引用的正文，不依赖二次 extract LLM
      browserState.pageDigest = await safePageDigest(activePage);
      if (browserState.pageDigest) {
        deps.logger.agentProgress(
          `第 ${step} 步：页面阅读就绪 · ${browserState.pageDigest.slice(0, 80).replace(/\s+/g, " ")}…`,
          { step, hasPageDigest: true },
        );
      }

      previousShortIds = new Set(
        [...browserState.selectorMap.values()].map((e) => e.shortId),
      );
      previousUrl = browserState.url;
      messageManager.recordPage(
        browserState.url,
        browserState.interactiveTree,
        browserState.elementCount,
      );

      const nudges = [
        ...messageManager.buildNudges(step, maxSteps),
        ...(pack ? buildObservationNudges(pack) : []),
      ];
      if (analyzed.queryTerms.length) {
        nudges.push(
          `检索词提示：${analyzed.queryTerms.join("、")}（输入时优先用此词，勿改写）`,
        );
      }
      if (analyzed.acceptance) {
        nudges.push(`验收标准：${analyzed.acceptance}`);
      }
      if (planText && /输入|搜索框|找/.test(planText)) {
        nudges.push(
          `当前计划项是「${planText}」：优先 input/click，禁止无必要的重新 navigate。`,
        );
      }
      if (/注册|register|sign\s*up/i.test(deps.goal)) {
        nudges.push(
          "目标含注册：若 browser_state 已有「Go to register / Register / 注册」控件，直接 click 其 index；禁止无谓 search_page。",
        );
      }
      if (/中文|语言|english|\ben\b|\bzh\b|hebrew|עבר|locale|語系/i.test(deps.goal)) {
        nudges.push(
          "UI 语言/图标入口：若 index 文案模糊（button/icon/language），必须 ask_vision_locate(query=要点哪个形态)，禁止 ask_user 猜图标；无视觉模型时系统会直接报错停机。",
        );
      }
      if (/验证码|captcha|人机验证|match2025|猿人学|停留时间最长|迷雾|动图|滑块|缺口|验证答案|算式|依次点击|按顺序点击|点选/i.test(deps.goal)) {
        const verifyHit = findIndexByTextHint(
          browserState.selectorMap,
          /验证答案/i,
          /提交参赛/i,
        );
        const last = messageManager.history[messageManager.history.length - 1];
        const lastBlob = (last?.actionResults ?? [])
          .map((r) => `${r.extractedContent ?? ""} ${r.longTermMemory ?? ""} ${r.error ?? ""}`)
          .join(" ");
        const filledPending =
          /已输入|filled|填入|已填/i.test(lastBlob) &&
          !/verified|验证通过|已点击.*验证答案/i.test(lastBlob);
        const toolAsksClick = /click\(index=\d+\)|下一轮仅 click/i.test(lastBlob);

        if ((filledPending || toolAsksClick) && verifyHit) {
          nudges.push(
            `验证码收尾：本步唯一动作 click(index=${verifyHit.index})「${verifyHit.label}」。禁止再 solve_captcha，禁止空等。`,
          );
        } else if (verifyHit) {
          nudges.push(
            `验证码：优先本轮唯一动作 solve_captcha。browser_state 已有「${verifyHit.label}」index=${verifyHit.index}——若工具失败但已心算答案，同轮 multi_act：input(答案)+click(index=${verifyHit.index})；禁止只填不点、禁止空等。`,
          );
        } else {
          nudges.push(
            "验证码：本轮唯一动作 solve_captcha（自动分发 GIF/滑块/算式）。失败勿换别名空转；未支持类型勿死磕；禁止刷新。",
          );
        }
      }

      // 图标/图片目标：DOM 文本含糊且任务需要点图 → 无视觉模型则硬停（语言球/点某图通用）
      if (
        pack &&
        !pack.softError &&
        pageLooksIconAmbiguous(pack.llm_json) &&
        goalNeedsVisualLocate(deps.goal) &&
        !isIntentConfigured(router.pool, "vision")
      ) {
        deps.logger.agentProgress(VISION_CAPABILITY_ERROR, {
          step,
          phase: "vision_gate",
          elements: pack.llm_json.length,
        });
        doneSummary = VISION_CAPABILITY_ERROR;
        finished = true;
        doneSuccess = false;
        break;
      }
      if (
        pack &&
        !pack.softError &&
        pageLooksIconAmbiguous(pack.llm_json) &&
        goalNeedsVisualLocate(deps.goal) &&
        isIntentConfigured(router.pool, "vision")
      ) {
        nudges.push(
          "当前页多为无文字图标：本步优先 ask_vision_locate(query=清晰描述要点的控件形态，click=true)；禁止 ask_user，禁止瞎点 button。",
        );
      }

      const goalNeedsUnderstanding = goalNeedsPageUnderstanding(deps.goal);
      const planNeedsUnderstanding = planItemNeedsPageUnderstanding(planText);
      const digestReady = Boolean(browserState.pageDigest?.trim());
      const pageUrl = browserState.url;
      const onSerp = isSearchResultsUrl(pageUrl);

      if (digestReady && (goalNeedsUnderstanding || planNeedsUnderstanding)) {
        nudges.push(
          "本步需理解页面内容：请优先根据 <page_digest> 用中文回答用户问题，然后单独调用 done(text=完整答案)。" +
            "禁止空转观察；仅当 page_digest 明显不足时再调用一次 extract。",
        );
      } else if (digestReady && onSerp && !goalNeedsUnderstanding) {
        const digest = browserState.pageDigest ?? "";
        const qOk = queryMatchedOnPage(analyzed.queryTerms, digest, pageUrl);
        nudges.push(
          qOk
            ? "搜索类目标：结果页已可读（见 page_digest）。请立即 done(success=true)，text 简要确认已搜到关键词即可，勿再分析整页。"
            : "已在搜索结果页：对照 page_digest 确认查询词是否匹配；匹配则 done，不匹配则修正搜索后 done。",
        );
      } else if (planNeedsUnderstanding && !digestReady) {
        nudges.push(
          "需要理解页面但暂无 page_digest：先 search_page 或 extract(query=用户问题)，拿到内容后再 done。",
        );
      }

      if (step === maxSteps) {
        nudges.push(
          "这是最后一步：必须调用 done；若有 page_digest，把已读到的结论写入 text。",
        );
      }

      nudges.push(
        ...buildSkillMatchNudges({
          goal: deps.goal,
          url: browserState.url,
          pageText: `${browserState.pageDigest ?? ""}\n${browserState.interactiveTree ?? ""}`.slice(
            0,
            4000,
          ),
        }),
      );

      const personaHint =
        deps.geoContext || deps.personaData
          ? `\n（环境已注入 GeoIP/人设，生成资料须保持一致；资料语种≠UI 语言。）`
          : "";

      const wantVision = visionImages.length > 0;
      const userMsg = buildUserStateMessage({
        userRequest: deps.goal + personaHint,
        history: messageManager.history,
        compactedMemory: messageManager.compactedMemory,
        fileSystemSummary: fileSystem.summary(),
        todoContents: fileSystem.readTodo(),
        plan: messageManager.plan,
        browser: browserState,
        readState: messageManager.consumeReadState(),
        stepNumber: step,
        maxSteps,
        includeScreenshot: wantVision,
        visionImages,
        nudges,
      });

      deps.logger.agentProgress(
        `第 ${step} 步：可见可交互元素 ${browserState.elementCount} 个 | ${browserState.url}`,
        {
          step,
          elements: browserState.elementCount,
        },
      );

      // 本地已够时跳过远端模型：① SERP 总结/验收 ② 空控件时直达搜索 URL
      const autoDone = tryDeterministicDone({
        goal: deps.goal,
        queryTerms: analyzed.queryTerms,
        pageUrl,
        pageDigest: browserState.pageDigest,
        goalNeedsUnderstanding,
        planNeedsUnderstanding,
        elementCount: browserState.elementCount,
      });
      const autoSearch =
        !autoDone
          ? tryDeterministicSearchNavigate({
              queryTerms: analyzed.queryTerms,
              pageUrl,
              elementCount: browserState.elementCount,
            })
          : null;

      let output: AgentOutput;
      if (autoDone) {
        deps.logger.agentProgress(
          `第 ${step} 步：本地已验收（跳过模型）· ${autoDone.memory?.slice(0, 80) ?? "done"}`,
          { step, skippedLlm: true, reason: "deterministic_serp_done" },
        );
        output = autoDone;
        if (pack) {
          disposeObservation(pack);
          previousObservation = null;
        }
      } else if (autoSearch) {
        deps.logger.agentProgress(
          `第 ${step} 步：本地直达搜索（跳过模型）· ${analyzed.queryTerms[0] ?? ""}`,
          { step, skippedLlm: true, reason: "deterministic_search_navigate" },
        );
        output = autoSearch;
        if (pack) {
          disposeObservation(pack);
          previousObservation = null;
        }
      } else {
        const messages: ChatCompletionMessageParam[] = [
          { role: "system", content: systemPrompt },
          buildLlmUserContent(userMsg.text, userMsg.images),
        ];
        const digestReadyForFast =
          Boolean(browserState.pageDigest?.trim()) &&
          isSearchResultsUrl(pageUrl) &&
          queryMatchedOnPage(
            analyzed.queryTerms,
            browserState.pageDigest ?? "",
            pageUrl,
          );
        const simpleTask =
          isSimpleAgentTask(deps.goal, analyzed.queryTerms) || digestReadyForFast;
        try {
          deps.logger.agentProgress(
            `第 ${step} 步：等待模型决策…（${simpleTask ? "快模+精简工具" : "逻辑模"}）`,
            { step, simpleTask },
          );
          if (pack) assertObservationReady(pack);
          output = await callAgentLlm({
            deps,
            router,
            messages,
            settings,
            signal: deps.signal,
            intent: simpleTask && !wantVision ? "fast_text" : "logic",
            toolsMode: simpleTask ? "core" : "full",
            onWaitTick: (elapsedMs) => {
              deps.logger.agentProgress(
                `第 ${step} 步：仍在等待模型…已 ${Math.round(elapsedMs / 1000)}s`,
                { step, elapsedMs },
              );
            },
          });
        } catch (err) {
          messageManager.recordFailure();
          lastHadError = true;
          forceObserveNext = true;
          const msg = err instanceof Error ? err.message : String(err);
          deps.logger.agentProgress(`第 ${step} 步：模型输出解析失败 — ${msg}`, {
            error: msg,
          });
          if (messageManager.consecutiveFailureCount >= settings.maxFailures) {
            doneSummary = `LLM 连续失败: ${msg}`;
            finished = true;
            doneSuccess = false;
            break;
          }
          continue;
        } finally {
          if (pack) {
            disposeObservation(pack);
            previousObservation = null;
          }
        }
      }

      if (output.thinking) {
        deps.logger.agentProgress(`思考：${output.thinking.slice(0, 240)}`, {
          thinking: output.thinking.slice(0, 500),
        });
      }
      if (output.next_goal) {
        deps.logger.agentProgress(`下一步目标：${output.next_goal}`, {});
      }

      const actions = output.action.slice(0, settings.maxActionsPerStep);
      if (actions.some((a) => a.name === "done") && actions.length > 1) {
        const onlyDone = actions.filter((a) => a.name === "done");
        actions.length = 0;
        actions.push(...onlyDone.slice(0, 1));
      }

      // 软门禁：应交互却乱 navigate → 保留但追加 nudge 记入下一步（本步仍执行，由模型自纠）
      if (
        planText &&
        /输入|搜索框|找|点击/.test(planText) &&
        actions.every((a) => a.name === "navigate")
      ) {
        deps.logger.agentProgress(
          `计划纠偏提示：当前项「${planText}」却全是 navigate，建议改为找框/输入`,
          { planItem: planText },
        );
        forceObserveNext = true;
      }

      deps.logger.agentProgress(
        `执行动作：${actions.map((a) => a.name).join(" → ") || "(空)"}`,
        { actions: actions.map((a) => a.name) },
      );

      messageManager.recordActions(actions);

      const results = await multiAct(actions, {
        page: activePage,
        logger: deps.logger,
        aiSettings: deps.aiSettings,
        browserState,
        fileSystem,
        profileId,
        goal: deps.goal,
        requestConfirm: async (req) => {
          deps.logger.agentConfirmRequired({
            requestId: req.requestId,
            url: req.url,
            reason: req.reason,
            actions: req.actions,
            profileId,
          });
          return deps.requestConfirm({
            requestId: req.requestId,
            url: req.url,
            reason: req.reason,
            actions: req.actions,
          });
        },
        askUser: deps.askUser,
        requestHandover: async (req) => {
          deps.logger.agentHandoverRequired({
            requestId: req.requestId,
            url: req.url,
            reason: req.reason,
            profileId,
          });
          await deps.requestHandover({
            requestId: req.requestId,
            url: req.url,
            reason: req.reason,
          });
        },
        setIncludeScreenshotNext: (v) => {
          includeScreenshotNext = v;
        },
        setActivePage: bindActivePage,
        resolveElement: (index) => browserState?.selectorMap.get(index) ?? null,
        signal: deps.signal,
      });

      for (const r of results) {
        if (r.error) {
          deps.logger.agentProgress(`动作失败：${r.error}`, { error: r.error });
        } else if (r.extractedContent) {
          // UI 进度只展示短摘要：技能全文 / 长 dump 进 read_state，勿把「禁止 ask_user」等教条刷成「等待补充」
          const dump = r.extractedContent;
          const mem = (r.longTermMemory || "").trim();
          const progressBody =
            mem &&
            dump.length > 240 &&
            mem.length < dump.length &&
            (mem.length <= 240 || /^#\s*Skill:|^\{/.test(dump.trim()))
              ? mem
              : dump;
          deps.logger.agentProgress(`动作结果：${progressBody.slice(0, 200)}`, {});
        }
      }

      messageManager.appendStep(output, results);
      activePage = pickLivePage(activePage);

      const hasError = results.some((r) => r.error);
      lastHadError = hasError;
      if (hasError) {
        messageManager.recordFailure();
        forceObserveNext = true;
      } else {
        messageManager.recordSuccess();
      }

      // 导航类动作后必须观察
      if (actions.some((a) => a.name === "navigate" || a.name === "search" || a.name === "go_back")) {
        forceObserveNext = true;
      }

      const doneResult = results.find((r) => r.isDone);
      if (doneResult) {
        doneSummary = doneResult.extractedContent || output.memory || "任务结束";
        doneSuccess = doneResult.success !== false;
        finished = true;
        break;
      }
    }
  });

  if (!finished) {
    doneSummary = doneSummary || "达到最大步数，任务未显式 done";
    doneSuccess = false;
  }

  if (settings.useJudge && messageManager.history.length > 0) {
    if (
      shouldSkipJudge({
        successClaimed: doneSuccess,
        history: messageManager.history,
        goal: deps.goal,
        finalText: doneSummary,
      })
    ) {
      deps.logger.agentProgress("验收评判：跳过（短轨迹已成功）", {
        phase: "judge",
        skipped: true,
      });
    } else {
      try {
        deps.logger.agentProgress("验收评判中…", { phase: "judge" });
        const judgement = await judgeTrace({
          goal: deps.goal,
          history: messageManager.history,
          finalText: doneSummary,
          successClaimed: doneSuccess,
          aiSettings: deps.aiSettings,
        });
        const passed = judgement.verdict !== false;
        deps.logger.agentProgress(
          passed
            ? `验收评判：通过 · ${(judgement.reasoning || "").slice(0, 120)}`
            : `验收评判：未通过 · ${(judgement.reasoning || judgement.failureReason || "").slice(0, 160)}`,
          {
            phase: "judge",
            verdict: passed,
          },
        );
        if (doneSuccess && judgement.verdict === false) {
          doneSuccess = false;
          doneSummary = `${doneSummary}\n[judge] ${judgement.reasoning}`;
        }
      } catch (err) {
        deps.logger.agentProgress(
          `验收评判：跳过（超时或失败）· ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            200,
          ),
          { phase: "judge", error: true },
        );
      }
    }
  }

  // 勾选录制且任务成功：经 agentTrajectory → Rust 落库 → 前端「轨迹记忆」
  if (enableRecording) {
    if (!doneSuccess) {
      deps.logger.agentProgress("任务未成功，未写入轨迹记忆", {
        phase: "record",
        skipped: true,
      });
    } else if (recordedSteps.length === 0) {
      deps.logger.agentProgress(
        "录制已开启但无可用步骤（可能均为临时 ID 选择器被过滤）",
        { phase: "record", skipped: true },
      );
    } else {
      try {
        const actions: TrajectoryStep[] = recordedSteps.map((s, i) => ({
          ...s,
          step: i + 1,
        }));
        assertPersistableTrajectorySteps(actions);
        const domainHint =
          actions.find((a) => a.type === "navigate" && a.url)?.url ||
          actions.find((a) => a.url)?.url ||
          startUrl;
        const payload = buildTrajectoryPayload({
          goal: deps.goal,
          startUrl: startUrl || domainHint,
          actions,
          domain: domainFromUrl(domainHint),
        });
        // 先磁盘（强校验）再 DB/事件，避免库里留下不可回放脏数据
        let filePath: string | undefined;
        try {
          filePath = await persistTrajectoryToDisk(payload);
        } catch (diskErr) {
          deps.logger.agentProgress(
            `轨迹磁盘写入失败，仍尝试落库：${
              diskErr instanceof Error ? diskErr.message : String(diskErr)
            }`.slice(0, 180),
            { phase: "record", warn: true },
          );
        }
        deps.logger.agentTrajectory({
          ...payload,
          profileId,
          ...(filePath ? { filePath } : {}),
        });
        deps.logger.agentProgress(
          `轨迹已录制 ${actions.length} 步 · ${payload.title}`,
          {
            phase: "record",
            domain: payload.domain,
            steps: actions.length,
            filePath: filePath ?? null,
          },
        );
      } catch (err) {
        deps.logger.agentProgress(
          `轨迹落库失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
          { phase: "record", error: true },
        );
      }
    }
  }

  deps.logger.agentState(doneSuccess ? "complete" : "failed", {
    profileId,
    summary: doneSummary.slice(0, 500),
  });

  return {
    success: doneSuccess,
    summary: doneSummary,
    rounds: messageManager.history.length,
    domain: domainFromUrl(page.url() || startUrl),
    startUrl,
  };
}

function pickLivePage(seed: Page): Page {
  try {
    const pages = seed.context().pages().filter((p) => {
      try {
        return !p.isClosed();
      } catch {
        return false;
      }
    });
    if (!pages.length) return seed;
    if (seed.isClosed() || !pages.includes(seed)) {
      return pages[pages.length - 1]!;
    }
    return seed;
  } catch {
    return seed;
  }
}

/** 轻量 browser_state：仅 URL/标题，不抽 DOM（bootstrap / 跳过观察） */
async function minimalBrowserState(page: Page): Promise<BrowserStateSummary> {
  let title = "";
  try {
    title = await page.title();
  } catch {
    title = "";
  }
  const tabs: Array<{ id: string; url: string; title: string }> = [];
  try {
    const pages = page.context().pages();
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i]!;
      let t = "";
      try {
        t = await p.title();
      } catch {
        t = "";
      }
      tabs.push({
        id: String(i + 1).padStart(4, "0").slice(-4),
        url: p.url(),
        title: t,
      });
    }
  } catch {
    /* ignore */
  }
  return {
    url: page.url(),
    title,
    tabs,
    interactiveTree: "(observation skipped — URL-only state)",
    elementCount: 0,
    selectorMap: new Map(),
    screenshotBase64: null,
    observationError: null,
    pageDigest: null,
  };
}

function goalNeedsPageUnderstanding(goal: string): boolean {
  return /总结|摘要|概括|分析|解读|介绍|是谁|是什么|怎么样|告诉我|详情|内容|汇报|提取信息|读一下|看看/.test(
    String(goal ?? ""),
  );
}

/** Agent 请求截图却无法落地时的用户可见错误（非站点特例） */
const SCREENSHOT_CAPABILITY_ERROR =
  "需要截图才能继续（图标/图片入口无法仅靠 DOM 文案定位），但当前无法获取页面截图。" +
  "请确认浏览器窗口可用后重试；若仍失败，请到设置中开启 Agent 截图相关能力并配置可用的视觉模型。";

/** 需要视觉定位但未配置 vision 槽 */
const VISION_CAPABILITY_ERROR =
  "当前页面入口多为图标/图片，任务需要视觉定位，但未配置视觉模型（vision）。" +
  "请到「设置 → AI」填写视觉模型后重试。不要用 ask_user 猜测要点哪个图标——下次点任意图片入口同样需要视觉能力。";

function goalNeedsVisualLocate(goal: string): boolean {
  const g = String(goal ?? "");
  return /语言|locale|hebrew|עבר|english|\ben\b|中文|繁體|简体|語系|图标|圖片|图片|截图|点.*图|点击.*图|切换.*语|设置成|改成.*语/i.test(
    g,
  );
}

function pageLooksIconAmbiguous(
  elements: Array<{ text?: string; name?: string; type?: string }>,
): boolean {
  if (!elements.length) return false;
  let vague = 0;
  for (const el of elements) {
    const t = String(el.text || el.name || el.type || "")
      .replace(/\s+/g, " ")
      .trim();
    if (
      !t ||
      t.length <= 2 ||
      /^(button|icon|link|img|image|language|support|icon:)/i.test(t)
    ) {
      vague += 1;
    }
  }
  return vague >= 3 && vague / elements.length >= 0.45;
}

function planItemNeedsPageUnderstanding(planText: string | undefined | null): boolean {
  return /总结|摘要|概括|分析|解读|介绍|提取|阅读|详情|验收|回答|汇报/.test(
    String(planText ?? ""),
  );
}

function isSearchResultsUrl(url: string): boolean {
  const u = String(url ?? "");
  return (
    /[?&](wd|word|q|query|keyword)=/i.test(u) ||
    /\/s(\?|\/)/i.test(u) ||
    /tn=news/i.test(u) ||
    /\/sf\/vsearch/i.test(u) ||
    /baidu\.com\/(s|sf)/i.test(u) ||
    /google\.[^/]+\/search/i.test(u) ||
    /bing\.com\/search/i.test(u)
  );
}

function queryMatchedOnPage(
  queryTerms: string[],
  digest: string,
  pageUrl: string,
): boolean {
  if (!queryTerms.length) return true;
  let decoded = pageUrl;
  try {
    decoded = decodeURIComponent(pageUrl);
  } catch {
    /* keep raw */
  }
  const hay = `${digest}\n${pageUrl}\n${decoded}`;
  return queryTerms.some(
    (q) =>
      Boolean(q) &&
      (hay.includes(q) ||
        pageUrl.includes(encodeURIComponent(q)) ||
        decoded.includes(q)),
  );
}

/** 简单打开/搜索类任务：可用快模 + 精简工具 */
function isSimpleAgentTask(goal: string, queryTerms: string[]): boolean {
  if (/填表|注册|登录|下单|支付|上传|复杂|验证码|captcha|人机验证|match2025|猿人学/i.test(goal)) {
    return false;
  }
  // 「搜索+总结第一条」仍算可快模：交付主要靠 page_digest
  if (queryTerms.length > 0 && /搜索|百度|谷歌|必应/.test(goal)) return true;
  if (goalNeedsPageUnderstanding(goal) && !/搜索|百度|谷歌|必应/.test(goal)) {
    return false;
  }
  if (queryTerms.length > 0) return true;
  return /搜索|打开|百度|谷歌|必应|访问|前往/.test(goal) && goal.length < 80;
}

function digestHasDeliverableFirstResult(digest: string): boolean {
  const d = String(digest ?? "");
  if (d.length < 60) return false;
  return (
    /置顶卡|知识卡|建议第一条|type=serp|type=featured|organic|第一条/.test(d) ||
    (/查询词=/.test(d) && d.length > 120)
  );
}

function buildSearchUrlForQuery(pageUrl: string, query: string): string {
  const q = encodeURIComponent(query);
  const u = pageUrl || "";
  if (/google\./i.test(u)) return `https://www.google.com/search?q=${q}`;
  if (/bing\.com/i.test(u)) return `https://www.bing.com/search?q=${q}`;
  return `https://www.baidu.com/s?wd=${q}`;
}

/**
 * 首页 0 控件 / 引擎首页：不调模型，直接 navigate 到搜索结果 URL。
 */
function tryDeterministicSearchNavigate(input: {
  queryTerms: string[];
  pageUrl: string;
  elementCount: number;
}): AgentOutput | null {
  const q = input.queryTerms[0]?.trim();
  if (!q) return null;
  if (isSearchResultsUrl(input.pageUrl) && queryMatchedOnPage([q], "", input.pageUrl)) {
    return null;
  }
  const onEngine =
    /baidu\.com|google\.|bing\.com/i.test(input.pageUrl) ||
    /about:blank|^$/i.test(input.pageUrl);
  if (!onEngine) return null;

  const url = buildSearchUrlForQuery(input.pageUrl, q);
  return {
    thinking: `本地直达搜索「${q}」（跳过模型；控件=${input.elementCount}）`,
    evaluation_previous_goal: "deterministic_search_navigate",
    memory: `导航至搜索结果：${url}`,
    next_goal: "打开搜索结果并总结",
    action: [{ name: "navigate", params: { url } }],
  };
}

/**
 * 本地观察已足够验收时跳过远端 LLM。
 * - 普通搜索：SERP 匹配即可 done
 * - 总结/分析：page_digest 已含置顶/第一条实质内容时直接交付 digest
 */
function tryDeterministicDone(input: {
  goal: string;
  queryTerms: string[];
  pageUrl: string;
  pageDigest: string | null | undefined;
  goalNeedsUnderstanding: boolean;
  planNeedsUnderstanding: boolean;
  elementCount: number;
}): AgentOutput | null {
  if (!isSearchResultsUrl(input.pageUrl)) {
    return null;
  }
  const digest = String(input.pageDigest ?? "").trim();
  const qOk = queryMatchedOnPage(input.queryTerms, digest, input.pageUrl);
  if (!qOk) return null;

  const q = input.queryTerms[0] || "目标关键词";
  const needsSummary =
    input.goalNeedsUnderstanding || input.planNeedsUnderstanding;

  if (needsSummary) {
    if (!digestHasDeliverableFirstResult(digest)) {
      return null;
    }
    const text =
      `已在搜索结果页完成「${q}」检索，并根据页面阅读摘要交付如下：\n\n` +
      digest.slice(0, 2800);
    return {
      thinking: "page_digest 已含置顶/第一条，跳过模型直接总结 done",
      evaluation_previous_goal: "deterministic_serp_summarize",
      memory: text.slice(0, 240),
      next_goal: "完成",
      action: [{ name: "done", params: { text, success: true } }],
    };
  }

  if (!digest && input.elementCount < 3) return null;

  const text = digest
    ? `已打开「${q}」相关搜索/资讯结果页，页面可读。\n${digest.slice(0, 600)}`
    : `已到达「${q}」搜索结果页：${input.pageUrl.slice(0, 160)}`;

  return {
    thinking: "本地 SERP/资讯页已匹配查询词，跳过模型直接 done",
    evaluation_previous_goal: "deterministic_serp_done",
    memory: text.slice(0, 240),
    next_goal: "完成",
    action: [{ name: "done", params: { text, success: true } }],
  };
}

async function safePageDigest(page: Page): Promise<string | null> {
  try {
    const reading = await Promise.race([
      extractPageReading(page),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_500)),
    ]);
    if (!reading) return null;
    const text = formatPageReadingForLlm(reading).trim();
    return text ? text.slice(0, 3500) : null;
  } catch {
    return null;
  }
}

function buildLlmUserContent(
  text: string,
  images: string[],
): ChatCompletionMessageParam {
  if (!images.length) {
    return { role: "user", content: text };
  }
  return {
    role: "user",
    content: [
      { type: "text", text },
      ...images.map((b64) => ({
        type: "image_url" as const,
        image_url: {
          url: b64.startsWith("data:") ? b64 : `data:image/jpeg;base64,${b64}`,
          detail: "low" as const,
        },
      })),
    ],
  };
}

async function callAgentLlm(input: {
  deps: AgentLoopDeps;
  router: ReturnType<typeof createModelRouter>;
  messages: ChatCompletionMessageParam[];
  settings: AgentSettings;
  signal?: AbortSignal;
  intent?: "fast_text" | "logic";
  toolsMode?: "full" | "core";
  onWaitTick?: (elapsedMs: number) => void;
}): Promise<AgentOutput> {
  const intent = input.intent ?? "logic";
  const resolved = input.router.resolve(intent);
  const model = resolved.model;
  const client = createLlmClient(input.deps.aiSettings);
  const tools = buildRegistryOpenAiTools(input.toolsMode ?? "full");

  const wait = beginAgentLlmWait({
    parentSignal: input.signal,
    timeoutMs: intent === "fast_text" ? 35_000 : 60_000,
    tickMs: 5_000,
    onTick: input.onWaitTick,
  });
  try {
    // 主路径：强制 function calling（与旧天枢台一致，国产模型最稳）
    try {
      const completion = await client.chat.completions.create(
        {
          model,
          messages: input.messages,
          tools,
          tool_choice: "required" as const,
          temperature: 0.2,
          ...agentForcedToolRequestPatch(model),
        } as never,
        { signal: wait.signal },
      );
      const msg = completion.choices[0]?.message;
      const toolCalls = msg?.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        return agentOutputFromToolCalls(
          toolCalls.map((tc) => ({
            function: {
              name: tc.function?.name,
              arguments: tc.function?.arguments,
            },
          })),
          typeof msg?.content === "string" ? msg.content : null,
        );
      }
      if (msg?.content) {
        return normalizeAgentOutput(extractJsonObject(String(msg.content)));
      }
      throw new Error("模型未返回 tool_calls 也未返回 JSON");
    } catch (firstErr) {
      // 回退：json_object + 宽松解析 + 一次修复重试
      const schema = agentOutputJsonSchema(input.settings);
      const completion = await client.chat.completions.create(
        {
          model,
          messages: [
            ...input.messages,
            {
              role: "system",
              content: `必须输出 JSON，含非空 action 数组。示例：{"memory":"...","next_goal":"...","action":[{"navigate":{"url":"https://example.com"}}]}。Schema 意图：${JSON.stringify(schema)}`,
            },
          ],
          temperature: 0.1,
          response_format: { type: "json_object" },
        } as never,
        { signal: wait.signal },
      );
      const content = extractAssistantContent(completion);
      try {
        return normalizeAgentOutput(extractJsonObject(content));
      } catch (parseErr) {
        const repair = await client.chat.completions.create(
          {
            model,
            messages: [
              {
                role: "system",
                content:
                  "把下面内容改成合法 JSON AgentOutput，action 必须是非空数组，每项形如 {\"navigate\":{\"url\":\"...\"}}。只输出 JSON。",
              },
              {
                role: "user",
                content: `原始输出：\n${content}\n\n解析错误：${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n首次错误：${firstErr instanceof Error ? firstErr.message : String(firstErr)}`,
              },
            ],
            temperature: 0,
            response_format: { type: "json_object" },
          } as never,
          { signal: wait.signal },
        );
        const repaired = extractAssistantContent(repair);
        return normalizeAgentOutput(extractJsonObject(repaired));
      }
    }
  } finally {
    wait.stop();
  }
}

import { chromium, type Browser, type Page } from "playwright-core";

import {
  bindActivePage,
  resolveActivePageFromBrowser,
} from "./cdp_session.js";
import { extractPageFormSchema } from "./dom_parser.js";
import { parseFillInput } from "./fill_export.js";
import { fillActionsToRpaActions, mergeProfileIntoFillActions } from "./fill_action_builder.js";
import { runFillEngine, runFillEngineFromActions, type FillProfile, type SidecarAiSettings } from "./engine.js";
import { generateHybridFillProfile } from "./hybrid_fill.js";
import { generateRpaActionsFromProfile, remapRpaActionDataKeys } from "./rpa_action_generator.js";
import { installIpcGuards, JsonLogger, bindCommandWaitId } from "./json-logger.js";
import { IpcClient, reportOrFallback } from "./ipc_client.js";
import { attachStdinLineParser } from "./stdin_line_parser.js";
import {
  awaitPause,
  resumePause,
  startPauseHttpServer,
  stopPauseHttpServer,
} from "./task_pause_lock.js";
import { installParentProcessWatchdog } from "./parent_process_watchdog.js";
import {
  parseRpaActions,
  parseRpaData,
  RpaStateMachine,
  type RpaAction,
} from "./rpa_engine.js";
import { attachBrowserUrlWatchers, createPageUrlEmitter } from "./page_url_watcher.js";
import { prepareSmartElementFill } from "./smart_element_fill.js";
import { schemaToRpaActions } from "./rpa_schema.js";
import { buildFillReadyExportJson } from "./fill_export.js";
import {
  readInteractiveElementCache,
  snapshotInteractiveElements,
} from "./interactive_elements.js";
import { runAutonomousAgentLoop } from "./agent_loop.js";
import { parseControlMemorySeed } from "./cross_task_memory.js";
import { parseFieldOverrides } from "./deferred_generation.js";
import { parseGeoContext, parsePersonaData } from "./persona_engine.js";
import { replayTrajectoryOnPage } from "./replay_engine.js";
import { deliverAfterTrajectoryReplay, trajectoryNeedsAiDelivery } from "./replay_deliver.js";
import {
  formatEngineBusyMessage,
  isEngineBusy,
  type EngineBusyState,
} from "./engine_mutex.js";
import {
  deletePersistedTrajectory,
  listPersistedTrajectories,
  loadTrajectoryFromFile,
  type TrajectoryStep,
} from "./trajectory.js";

installIpcGuards();
installParentProcessWatchdog();

const logger = new JsonLogger();

// —— Milestone 1：初始化本地 IPC 上报客户端（懒加载，未注入 env 则为 null）——
const ipcClient = IpcClient.global;
logger.status("ipc_client_init", {
  enabled: ipcClient !== null,
  baseUrl: ipcClient?.baseUrl ?? null,
});

let rpaMachine: RpaStateMachine | null = null;
let rpaRunning = false;
let agentRunning = false;
let trajectoryReplayRunning = false;
let trajectoryReplayAbort: AbortController | null = null;

function engineBusySnapshot(): EngineBusyState {
  return { agentRunning, rpaRunning, trajectoryReplayRunning };
}

/** 互斥拦截：忙则写明确错误并返回 true（调用方应立即 return） */
function rejectIfEngineBusy(
  requested: string,
  channel: "agent" | "rpa",
  waitId?: string | null,
): boolean {
  const state = engineBusySnapshot();
  if (!isEngineBusy(state)) {
    return false;
  }
  const msg = formatEngineBusyMessage(state, requested);
  logger.warn("engine_busy_reject", { requested, ...state, msg, waitId: waitId ?? null });
  const waitPayload = waitId?.trim() ? { waitId: waitId.trim() } : {};
  if (channel === "agent") {
    logger.agentState("failed", { step: 0, msg, ...waitPayload });
  } else {
    logger.rpaState("paused", {
      step: 0,
      msg,
      actions: rpaMachine?.actions ?? [],
      ...waitPayload,
    });
  }
  return true;
}
/** stdin 命令串行队列：保证 rpaRunning 读改写原子、禁止并发污染 */
let commandQueue: Promise<void> = Promise.resolve();
const pageUrlEmitter = createPageUrlEmitter(logger);

type ConfirmResolver = (value: {
  approved: boolean;
  fillOverrides?: Record<string, string>;
}) => void;
type AskResolver = (value: string) => void;

const pendingConfirmResolvers = new Map<string, ConfirmResolver>();
const pendingAskResolvers = new Map<string, AskResolver>();
let agentAbortController: AbortController | null = null;

function enqueueCommand(task: () => Promise<void>): void {
  commandQueue = commandQueue
    .then(async () => {
      await task();
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("command_queue_failed", { error: message });
    });
}

function parseCdpUrl(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cdp-url" && argv[index + 1]) {
      return argv[index + 1];
    }
    if (arg.startsWith("--cdp-url=")) {
      return arg.slice("--cdp-url=".length);
    }
  }

  throw new Error("missing required argument: --cdp-url");
}

/** 解析轨迹回放覆盖表（兼容旧 string 与新 {mode,value,label,inputType}） */
function parseValueOverrides(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  let hasPlain = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const selector = String(key ?? "").trim();
    if (!selector) {
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      // 结构化覆盖交给 parseFieldOverrides
      continue;
    }
    out[selector] = value == null ? "" : String(value);
    hasPlain = true;
  }
  return hasPlain ? out : undefined;
}

function attachStdinAbortListener(
  abortController: AbortController,
  onAbort: () => void | Promise<void>,
  onCommand?: (payload: Record<string, unknown>) => void | Promise<void>,
): void {
  /** 确认/问答必须绕过串行队列，否则会被 agent_start 阻塞 */
  const IMMEDIATE_COMMANDS = new Set([
    "agent_confirm",
    "agent_cancel",
    "agent_user_reply",
    "agent_handover_continue",
    "agent_abort",
    "agent_bring_to_front",
  ]);

  attachStdinLineParser((trimmed) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      logger.warn("ignored non-json stdin line", { line: trimmed });
      return;
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "command" in parsed &&
      (parsed as { command: unknown }).command === "abort"
    ) {
      if (!abortController.signal.aborted) {
        abortController.abort("stdin abort");
      }
      return;
    }

    if (onCommand && typeof parsed === "object" && parsed !== null && "command" in parsed) {
      const payload = parsed as Record<string, unknown>;
      const command = String(payload.command ?? "");
      if (IMMEDIATE_COMMANDS.has(command)) {
        void Promise.resolve(onCommand(payload)).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error("immediate_command_failed", { command, error: message });
        });
        return;
      }
      enqueueCommand(async () => {
        await onCommand(payload);
      });
    }
  });

  abortController.signal.addEventListener(
    "abort",
    () => {
      void onAbort();
    },
    { once: true },
  );
}

async function disconnectBrowser(browser: Browser | null): Promise<void> {
  if (!browser || !browser.isConnected()) {
    return;
  }

  try {
    await browser.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("browser close reported an error during teardown", { error: message });
  }
}

function resolveActivePage(browser: Browser) {
  return resolveActivePageFromBrowser(browser);
}

interface ProxyAuthSettings {
  server: string;
  username?: string | null;
  password?: string | null;
}

function asProxyAuth(value: unknown): ProxyAuthSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const server = String(record.server ?? "").trim();
  if (!server) {
    return null;
  }
  return {
    server,
    username: record.username ? String(record.username) : null,
    password: record.password ? String(record.password) : null,
  };
}

/** 已挂过代理鉴权的 Page，避免重复 Fetch.enable 叠监听 */
const proxyAuthPages = new WeakSet<object>();
/** 已挂过代理鉴权的 BrowserContext，避免 install 被多条命令重复调用时累积 context.on("page") 监听 */
const proxyAuthContexts = new WeakSet<object>();

/**
 * CDP 代理鉴权兜底。
 * 注意：Fetch.enable 默认会拦截请求；若只处理 authRequired、不 continueRequest，
 * Playwright page.goto 会一直挂起（页面左上角转圈），而地址栏手动输入仍可能“看起来能开”。
 * Manifest V2 扩展是主路径；此处必须同时 continue 所有 requestPaused。
 */
async function attachProxyAuthToPage(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  if (proxyAuthPages.has(page)) {
    return;
  }
  proxyAuthPages.add(page);

  const session = await page.context().newCDPSession(page);

  session.on("Fetch.requestPaused", (event: { requestId?: string }) => {
    const requestId = event.requestId;
    if (!requestId) {
      return;
    }
    void session.send("Fetch.continueRequest", { requestId }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/Target closed|Session closed|already been used/i.test(message)) {
        logger.warn("proxy_fetch_continue_failed", { error: message });
      }
    });
  });

  session.on("Fetch.authRequired", (event: { requestId?: string }) => {
    const requestId = event.requestId;
    if (!requestId) {
      return;
    }
    void session
      .send("Fetch.continueWithAuth", {
        requestId,
        authChallengeResponse: {
          response: "ProvideCredentials",
          username,
          password,
        },
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("proxy auth handler failed", { error: message });
      });
  });

  await session.send("Fetch.enable", { handleAuthRequests: true });
}

async function installProxyAuthHandler(browser: Browser, proxyAuth: ProxyAuthSettings): Promise<void> {
  const username = proxyAuth.username?.trim() ?? "";
  const password = proxyAuth.password?.trim() ?? "";
  if (!username) {
    return;
  }

  const contexts = browser.contexts();
  for (const context of contexts) {
    for (const page of context.pages()) {
      try {
        await attachProxyAuthToPage(page, username, password);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("proxy_auth_attach_page_failed", { error: message });
      }
    }
    // 同一 context 只挂一次 page 监听，避免 install 被多条命令重复调用时累积监听器
    if (proxyAuthContexts.has(context)) {
      continue;
    }
    proxyAuthContexts.add(context);
    context.on("page", (page) => {
      void attachProxyAuthToPage(page, username, password).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("proxy_auth_attach_newpage_failed", { error: message });
      });
    });
  }
  logger.status("proxy_auth_handler_installed", {
    server: proxyAuth.server,
    note: "Fetch.enable + continueRequest（修复代理下 goto 挂死）",
  });
}

function asOptionalFillProfile(value: unknown): FillProfile {
  if (value === undefined || value === null) {
    return {};
  }
  return asFillProfile(value);
}

function resolveUserDataDir(payload: Record<string, unknown>): string | null {
  const raw = payload.userDataDir ?? payload.user_data_dir;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolvePressEnterAfterFill(payload: Record<string, unknown>): boolean {
  return payload.pressEnterAfterFill === true || payload.press_enter_after_fill === true;
}

async function handleRpaStart(
  browser: Browser,
  payload: Record<string, unknown>,
): Promise<void> {
  const waitId = String(payload.waitId ?? payload.wait_id ?? "").trim() || null;
  bindCommandWaitId(waitId);
  if (rejectIfEngineBusy("RPA 填表/启动", "rpa", waitId)) {
    return;
  }

  rpaRunning = true;
  try {
    const page = resolveActivePage(browser);
    const proxyAuth = asProxyAuth(payload.proxyAuth);
    if (proxyAuth) {
      await installProxyAuthHandler(browser, proxyAuth);
    }

    const skipHybrid = payload.skipHybrid === true || payload.skip_hybrid === true;
    const continuous =
      payload.continuous === true ||
      payload.continuousReplay === true ||
      payload.continuous_replay === true;
    const pressEnterAfterFill = resolvePressEnterAfterFill(payload);
    const rawInput = String(payload.rawInput ?? payload.raw_input ?? "").trim();
    const parsedFill = rawInput ? parseFillInput(rawInput) : null;
    const rawActions = parseRpaActions(payload.actions);
    let data = parseRpaData(payload.data ?? payload.profile);

    if (Object.keys(data).length === 0 && parsedFill && Object.keys(parsedFill.profile).length > 0) {
      data = parsedFill.profile;
    }

    if (payload.confirmedProfile !== undefined && payload.confirmedProfile !== null) {
      data = parseRpaData(payload.confirmedProfile);
    } else if (Object.keys(data).length === 0) {
      const partialProfile = asOptionalFillProfile(payload.profile);
      data = Object.fromEntries(
        Object.entries(partialProfile).map(([key, value]) => [key, String(value)]),
      );
    }

    let actions: RpaAction[] = rawActions;

    if (actions.length === 0 && parsedFill?.actions?.length) {
      actions = fillActionsToRpaActions(parsedFill.actions);
      logger.progress("rpa_actions_from_fill_export", { actionCount: actions.length });
    }

    if (actions.length === 0 && !skipHybrid) {
      const aiSettings = asAiSettings(payload.ai);
      const partialHint =
        rawInput ||
        Object.entries(data)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n");

      logger.progress("rpa_hybrid_preprocess", { partialInputLength: partialHint.length });
      const userDataDir = resolveUserDataDir(payload);
      const hybridProfile = await generateHybridFillProfile(
        page,
        partialHint,
        aiSettings,
        logger,
        userDataDir,
      );
      data = Object.fromEntries(
        Object.entries(hybridProfile).map(([key, value]) => [key, String(value)]),
      );

      const schema = await extractPageFormSchema(page);
      try {
        actions = await generateRpaActionsFromProfile(schema, data, aiSettings, logger);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("rpa_action_llm_failed", { error: message, fallback: "schema_to_rpa_actions" });
        actions = remapRpaActionDataKeys(schemaToRpaActions(schema, 1, data), data);
      }
      logger.rpaActions(actions, 0);
    } else if (actions.length > 0 && Object.keys(data).length > 0) {
      actions = remapRpaActionDataKeys(actions, data);
    }

    rpaMachine = new RpaStateMachine(actions, data, {
      pressEnterAfterFill,
      pauseAfterClick: !continuous,
    });
    logger.status("rpa_session_ready", {
      actionCount: actions.length,
      dataKeys: Object.keys(data).length,
      continuous,
    });
    await rpaMachine.runUntilPause(page, logger);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("rpa_start_failed", { error: message });
    logger.rpaState("paused", { step: 0, msg: message, actions: rpaMachine?.actions ?? [] });
  } finally {
    rpaRunning = false;
  }
}

async function handleRpaResume(browser: Browser): Promise<void> {
  if (!rpaMachine) {
    logger.warn("rpa_resume_ignored", { reason: "no_active_session" });
    logger.rpaState("paused", { step: 0, msg: "无活动 RPA 会话，请先启动填表" });
    return;
  }
  if (rejectIfEngineBusy("RPA 继续", "rpa", null)) {
    return;
  }

  rpaRunning = true;
  try {
    const page = resolveActivePage(browser);
    rpaMachine.resume();
    await rpaMachine.runUntilPause(page, logger);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("rpa_resume_failed", { error: message });
    logger.rpaState("paused", {
      step: rpaMachine.stepIndex,
      msg: message,
      actions: rpaMachine.actions,
    });
  } finally {
    rpaRunning = false;
  }
}

async function handleRpaRescan(
  browser: Browser,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const page = resolveActivePage(browser);
    const startStep = (rpaMachine?.actions.length ?? 0) + 1;
    const profileData = parseRpaData(payload.data ?? payload.profile);
    const rawInput = String(payload.rawInput ?? payload.raw_input ?? "").trim();
    const parsedFill = rawInput ? parseFillInput(rawInput) : null;
    const mergedProfile =
      Object.keys(profileData).length > 0
        ? profileData
        : parsedFill && Object.keys(parsedFill.profile).length > 0
          ? parsedFill.profile
          : profileData;
    const userDataDir = resolveUserDataDir(payload);

    let newActions: RpaAction[] = [];
    const cached = userDataDir ? await readInteractiveElementCache(userDataDir, page.url()) : null;
    if (cached) {
      const exportPayload = buildFillReadyExportJson(cached);
      newActions = fillActionsToRpaActions(
        mergeProfileIntoFillActions(exportPayload.fillActions, mergedProfile),
      ).map((action, index) => ({ ...action, step: startStep + index }));
      logger.progress("rpa_rescan_interactive_elements", { actionCount: newActions.length });
    } else {
      const snapshot = userDataDir
        ? await snapshotInteractiveElements(page, userDataDir)
        : null;
      if (snapshot) {
        const exportPayload = buildFillReadyExportJson(snapshot);
        newActions = fillActionsToRpaActions(
          mergeProfileIntoFillActions(exportPayload.fillActions, mergedProfile),
        ).map((action, index) => ({ ...action, step: startStep + index }));
        logger.progress("rpa_rescan_snapshot_elements", { actionCount: newActions.length });
      } else {
        const schema = await extractPageFormSchema(page);
        newActions = schemaToRpaActions(schema, startStep, mergedProfile);
        logger.progress("rpa_rescan_dom_schema", { actionCount: newActions.length });
      }
    }

    if (!rpaMachine) {
      rpaMachine = new RpaStateMachine([], mergedProfile);
    }

    rpaMachine.appendActions(newActions);
    rpaMachine.pauseManual();
    logger.rpaActions(rpaMachine.actions, rpaMachine.stepIndex);
    logger.rpaState("paused", {
      step: rpaMachine.stepIndex,
      msg: `已追加 ${newActions.length} 个步骤，等待继续执行`,
      actions: rpaMachine.actions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("rpa_rescan_failed", { error: message });
    logger.rpaState("paused", {
      step: rpaMachine?.stepIndex ?? 0,
      msg: `扫描失败: ${message}`,
      actions: rpaMachine?.actions ?? [],
    });
  }
}

async function handleRpaPause(): Promise<void> {
  if (!rpaMachine) {
    logger.rpaState("paused", { step: 0, msg: "无活动 RPA 会话" });
    return;
  }
  rpaMachine.pauseManual();
  logger.rpaState("paused", {
    step: rpaMachine.stepIndex,
    msg: "用户手动暂停",
    actions: rpaMachine.actions,
  });
}

async function handleGetUrl(browser: Browser): Promise<void> {
  try {
    const page = resolveActivePage(browser);
    pageUrlEmitter.emitIfChanged(page.url());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("get_url_failed", { error: message });
  }
}

async function handleLegacyFill(
  browser: Browser,
  payload: Record<string, unknown>,
): Promise<void> {
  const page = resolveActivePage(browser);
  const partialProfile = asFillProfile(payload.profile);
  const directFill = payload.directFill === true || payload.direct_fill === true;
  let aiSettings: SidecarAiSettings | null = null;
  try {
    aiSettings = asAiSettings(payload.ai);
  } catch (error) {
    if (!directFill) {
      throw error;
    }
  }
  const proxyAuth = asProxyAuth(payload.proxyAuth);
  if (proxyAuth) {
    await installProxyAuthHandler(browser, proxyAuth);
  }

  const rawInput = String(payload.rawInput ?? payload.raw_input ?? "").trim();
  const skipHybrid = payload.skipHybrid === true || payload.skip_hybrid === true;
  const pressEnterAfterFill = resolvePressEnterAfterFill(payload);
  const userDataDir = resolveUserDataDir(payload);
  const partialHint =
    rawInput ||
    Object.entries(partialProfile)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");

  logger.progress("fill_command_received", {
    fieldCount: Object.keys(partialProfile).length,
    textModel: aiSettings?.textModel ?? "direct-heuristic",
    hybrid: !skipHybrid && payload.confirmedProfile === undefined,
    directFill,
  });

  let completeProfile: FillProfile;
  if (payload.confirmedProfile !== undefined && payload.confirmedProfile !== null) {
    completeProfile = asFillProfile(payload.confirmedProfile);
  } else if (skipHybrid || directFill) {
    completeProfile = partialProfile;
  } else {
    if (!aiSettings) {
      throw new Error("混合推演填表需要配置 AI API Key");
    }
    completeProfile = await generateHybridFillProfile(
      page,
      partialHint,
      aiSettings,
      logger,
      userDataDir,
    );
  }

  if (Object.keys(completeProfile).length === 0) {
    throw new Error("填表数据为空或无法解析为 JSON 对象");
  }

  const parsedInput = parseFillInput(rawInput || JSON.stringify(completeProfile));
  const mergedProfile = { ...parsedInput.profile, ...completeProfile };
  const prebuiltActions =
    parsedInput.actions && parsedInput.actions.length > 0
      ? mergeProfileIntoFillActions(parsedInput.actions, mergedProfile).filter((action) =>
          action.action === "click" ? true : (action.value ?? "").trim().length > 0,
        )
      : null;

  if ((directFill || prebuiltActions) && prebuiltActions && prebuiltActions.length > 0) {
    logger.progress("fill_using_prebuilt_actions", { actionCount: prebuiltActions.length });
    await runFillEngineFromActions(page, prebuiltActions, logger, { pressEnterAfterFill });
    return;
  }

  await runFillEngine(page, mergedProfile, logger, aiSettings, {
    userDataDir,
    directMappingOnly: directFill,
    pressEnterAfterFill,
  });
}

async function handleSmartElementFill(
  browser: Browser,
  payload: Record<string, unknown>,
): Promise<void> {
  const page = resolveActivePage(browser);
  const aiSettings = asAiSettings(payload.ai);
  const proxyAuth = asProxyAuth(payload.proxyAuth);
  if (proxyAuth) {
    await installProxyAuthHandler(browser, proxyAuth);
  }

  const naturalLanguage = String(
    payload.naturalLanguage ?? payload.natural_language ?? payload.rawInput ?? payload.raw_input ?? "",
  ).trim();
  if (!naturalLanguage) {
    throw new Error("智能填表需要自然语言描述（例如卡号、地址、姓名等）");
  }

  const userDataDir = resolveUserDataDir(payload);
  const seedRaw = String(payload.seedInput ?? payload.seed_input ?? "").trim();
  const seedParsed = seedRaw ? parseFillInput(seedRaw) : { profile: {}, actions: null, exportPayload: null };
  const requireExtract = payload.requireInteractiveExtract === true;

  if (requireExtract && !userDataDir) {
    throw new Error("智能填表需要 profile userDataDir（请确认元素提取已开启）");
  }

  logger.progress("smart_element_fill_start", {
    textLength: naturalLanguage.length,
    hasSeedProfile: Object.keys(seedParsed.profile).length > 0,
  });

  const prepared = await prepareSmartElementFill(page, naturalLanguage, aiSettings, logger, {
    userDataDir,
    seedProfile: seedParsed.profile,
  });

  const actions = mergeProfileIntoFillActions(
    prepared.exportPayload.fillActions,
    prepared.fillProfile,
  ).filter((action) => (action.value ?? "").trim().length > 0);

  logger.result("smart_fill_ready", {
    type: "smart_fill_ready",
    exportPayload: prepared.exportPayload,
    fillProfile: prepared.fillProfile,
    filledFieldCount: prepared.filledFieldCount,
    actionCount: actions.length,
  });

  await runFillEngineFromActions(page, actions, logger, {
    pressEnterAfterFill: resolvePressEnterAfterFill(payload),
  });

  logger.result("smart_element_fill_complete", {
    filledFieldCount: prepared.filledFieldCount,
    actionCount: actions.length,
  });
}

function resolvePendingConfirm(
  requestId: string,
  approved: boolean,
  fillOverrides?: Record<string, string>,
): boolean {
  const resolver = pendingConfirmResolvers.get(requestId);
  if (!resolver) {
    return false;
  }
  pendingConfirmResolvers.delete(requestId);
  resolver({ approved, fillOverrides });
  return true;
}

function resolvePendingAsk(requestId: string, answer: string): boolean {
  const resolver = pendingAskResolvers.get(requestId);
  if (!resolver) {
    return false;
  }
  pendingAskResolvers.delete(requestId);
  resolver(answer);
  return true;
}

function resolvePendingHandover(requestId: string): boolean {
  // Milestone 4：走真·挂起锁（HTTP / stdin 共用）
  return resumePause(requestId || null);
}

function rejectAllAgentPendings(reason: string): void {
  for (const [id, resolver] of pendingConfirmResolvers) {
    pendingConfirmResolvers.delete(id);
    resolver({ approved: false });
  }
  for (const [id, resolver] of pendingAskResolvers) {
    pendingAskResolvers.delete(id);
    resolver(`（中止）${reason}`);
  }
  // 释放全部挂起锁，避免 Agent abort 后 Promise 永挂
  resumePause(null);
  void reason;
}

function reportTaskBlocked(payload: {
  requestId: string;
  url: string;
  reason: string;
  profileId: string;
}): void {
  const data = {
    requestId: payload.requestId,
    url: payload.url,
    reason: payload.reason,
    profileId: payload.profileId,
    pausedAt: new Date().toISOString(),
  };
  const fallback = (): void => {
    logger.agentHandoverRequired(data);
  };
  reportOrFallback("agent_task_blocked", data, fallback);
  logger.agentState("paused", {
    step: 0,
    msg: `任务已挂起，等待人工接管：${payload.reason.slice(0, 80)}`,
    requestId: payload.requestId,
  });
}

async function handleAgentStart(
  browser: Browser,
  payload: Record<string, unknown>,
  waitId?: string | null,
): Promise<void> {
  const boundWaitId =
    waitId?.trim() || String(payload.waitId ?? payload.wait_id ?? "").trim() || null;
  bindCommandWaitId(boundWaitId);
  if (rejectIfEngineBusy("Agent 启动", "agent", boundWaitId)) {
    return;
  }

  const goal = String(payload.goal ?? payload.userGoal ?? "").trim();
  if (!goal) {
    logger.agentState("failed", { step: 0, msg: "缺少用户目标 goal" });
    return;
  }

  const aiSettings = asAiSettings(payload.ai);
  const maxRounds = Number(payload.maxRounds ?? 15);
  const profileId = String(payload.profileId ?? payload.profile_id ?? "unknown").trim() || "unknown";
  const storage = (payload.storage && typeof payload.storage === "object"
    ? payload.storage
    : {}) as Record<string, unknown>;
  const { configureDownloadRoots } = await import("./utils/file_manager.js");
  configureDownloadRoots({
    browserDownloadDir: String(storage.browserDownloadDir ?? payload.browserDownloadDir ?? "").trim() || null,
    scraperDownloadDir: String(storage.scraperDownloadDir ?? payload.scraperDownloadDir ?? "").trim() || null,
  });

  agentAbortController = new AbortController();
  agentRunning = true;

  try {
    const page = resolveActivePage(browser);
    bindActivePage(page);
    const proxyAuth = asProxyAuth(payload.proxyAuth);
    if (proxyAuth) {
      await installProxyAuthHandler(browser, proxyAuth);
    }

    const result = await runAutonomousAgentLoop(page, {
      logger,
      aiSettings,
      goal,
      profileId,
      userDataDir: resolveUserDataDir(payload),
      maxRounds: Number.isFinite(maxRounds) && maxRounds > 0 ? maxRounds : 15,
      senseMode: String(payload.senseMode ?? payload.agentSenseMode ?? "balanced"),
      panoramaEnabled:
        payload.panoramaEnabled === true ||
        payload.agent_panorama_enabled === true ||
        payload.agentPanoramaEnabled === true,
      enableRecording:
        payload.enableRecording === true ||
        payload.enable_recording === true,
      controlMemorySeed: parseControlMemorySeed(
        payload.controlMemory ?? payload.control_memory,
      ),
      geoContext: parseGeoContext(payload.geoContext ?? payload.geo_context),
      personaData: parsePersonaData(payload.personaData ?? payload.persona_data),
      signal: agentAbortController.signal,
      requestConfirm: (request) =>
        new Promise((resolve) => {
          pendingConfirmResolvers.set(request.requestId, resolve);
        }),
      askUser: (requestId, _question) =>
        new Promise((resolve) => {
          pendingAskResolvers.set(requestId, resolve);
        }),
      requestHandover: async (request) => {
        const profileIdStr = String(profileId ?? "").trim();
        reportTaskBlocked({
          requestId: request.requestId,
          url: request.url ?? "",
          reason: request.reason ?? "需要人工接管",
          profileId: profileIdStr,
        });
        // 真·挂起：未决 Promise，直到 resume（HTTP / stdin）调用 resolve
        await awaitPause(request.requestId);
        logger.agentState("running", {
          step: 0,
          msg: "人工接管完成，恢复执行",
          requestId: request.requestId,
        });
      },
    });

    logger.result("agent_loop_done", {
      success: result.success,
      summary: result.summary,
      rounds: result.rounds,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("agent_start_failed", { error: message });
    logger.agentState("failed", { step: 0, msg: message });
  } finally {
    rejectAllAgentPendings("Agent 已结束");
    agentRunning = false;
    agentAbortController = null;
  }
}

async function handleTrajectoryList(payload: Record<string, unknown>): Promise<void> {
  const domain = String(payload.domain ?? "").trim();
  try {
    const items = await listPersistedTrajectories(domain || undefined);
    logger.result("trajectory_list", {
      count: items.length,
      items: items.map((item) => ({
        fileName: item.fileName,
        filePath: item.filePath,
        domain: item.domain,
        title: item.title,
        goal: item.goal,
        startUrl: item.startUrl,
        stepCount: item.stepCount,
        savedAt: item.savedAt,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("trajectory_list_failed", { error: message });
  }
}

async function handleTrajectoryReplay(
  browser: Browser,
  payload: Record<string, unknown>,
): Promise<void> {
  const waitId = String(payload.waitId ?? payload.wait_id ?? "").trim() || null;
  bindCommandWaitId(waitId);
  if (rejectIfEngineBusy("轨迹回放", "agent", waitId)) {
    return;
  }

  trajectoryReplayRunning = true;
  trajectoryReplayAbort = new AbortController();
  const title = String(payload.title ?? "轨迹回放").trim() || "轨迹回放";
  const engineTag = { engine: "trajectory_replay" as const };
  let goal = String(payload.goal ?? "").trim();

  try {
    let steps: TrajectoryStep[] = [];
    const filePath = String(payload.filePath ?? payload.file_path ?? "").trim();
    if (filePath) {
      const loaded = await loadTrajectoryFromFile(filePath);
      steps = loaded.actions;
      if (!goal) {
        goal = String(loaded.goal ?? loaded.title ?? title).trim();
      }
      logger.agentState("running", {
        ...engineTag,
        step: 0,
        msg: `开始回放「${loaded.title || title}」· ${steps.length} 步` +
          (trajectoryNeedsAiDelivery(goal) ? " · 完成后将 AI 交付" : ""),
      });
    } else {
      const rawActions = payload.actions;
      if (!Array.isArray(rawActions)) {
        throw new Error("缺少 filePath 或 actions");
      }
      steps = rawActions as TrajectoryStep[];
      if (!goal) {
        goal = title;
      }
      logger.agentState("running", {
        ...engineTag,
        step: 0,
        msg: `开始回放「${title}」· ${steps.length} 步` +
          (trajectoryNeedsAiDelivery(goal) ? " · 完成后将 AI 交付" : ""),
      });
    }

    const page = resolveActivePage(browser);
    const proxyAuth = asProxyAuth(payload.proxyAuth);
    if (proxyAuth) {
      await installProxyAuthHandler(browser, proxyAuth);
    }
    const overridesRaw = payload.valueOverrides ?? payload.value_overrides;
    const valueOverrides = parseValueOverrides(overridesRaw);
    const fieldOverrides = parseFieldOverrides(overridesRaw);
    const aiSettings = payload.ai ? asAiSettings(payload.ai) : null;
    const result = await replayTrajectoryOnPage(page, steps, {
      selectorTimeoutMs: 8_000,
      signal: trajectoryReplayAbort.signal,
      valueOverrides,
      fieldOverrides,
      resolveContext: {
        geo: payload.geoContext ?? payload.geo_context ?? null,
        persona: payload.personaData ?? payload.persona_data ?? null,
        aiSettings,
        logger,
      },
      onProgress: (event) => {
        if (event.status === "start") {
          logger.agentProgress(
            `正在执行第 ${event.step} 步 [${event.type}] ${event.selector || ""}`.trim(),
            {
              ...engineTag,
              step: event.step,
              type: event.type,
              selector: event.selector,
            },
          );
        } else if (event.status === "ok") {
          logger.agentProgress(`回放第 ${event.step} 步完成 [${event.type}]`, {
            ...engineTag,
            step: event.step,
            type: event.type,
          });
        } else if (event.status === "fail") {
          logger.agentState("failed", {
            ...engineTag,
            step: event.step,
            msg: `回放失败：第 ${event.step} 步 · ${event.message ?? ""}`,
          });
        }
      },
    });

    if (!result.ok) {
      const aborted = Boolean(trajectoryReplayAbort?.signal.aborted);
      if (aborted && !String(result.error ?? "").includes("回放已手动停止")) {
        logger.agentState("failed", {
          ...engineTag,
          step: result.failedStep ?? result.completedSteps,
          msg: "回放已手动停止",
        });
      }
      logger.result("trajectory_replay_done", {
        ok: false,
        completedSteps: result.completedSteps,
        failedStep: result.failedStep ?? null,
        error: result.error ?? "回放失败",
        aborted,
      });
      return;
    }

    // 混合回放：机械步成功后，若目标需分析/汇报 → 单次 LLM 交付（对齐 Agent 效果）
    let deliverSummary = "";
    let delivered = false;
    if (trajectoryNeedsAiDelivery(goal) && !trajectoryReplayAbort.signal.aborted) {
      try {
        logger.agentProgress("回放机械步完成，开始 AI 交付分析…", {
          ...engineTag,
          step: result.completedSteps,
        });
        const aiSettings = payload.ai ? asAiSettings(payload.ai) : null;
        const deliver = await deliverAfterTrajectoryReplay(
          page,
          goal,
          aiSettings,
          logger,
          trajectoryReplayAbort.signal,
        );
        delivered = deliver.delivered;
        deliverSummary = deliver.summary;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (trajectoryReplayAbort.signal.aborted || message.includes("回放已手动停止")) {
          logger.agentState("failed", {
            ...engineTag,
            step: result.completedSteps,
            msg: "回放已手动停止",
          });
          logger.result("trajectory_replay_done", {
            ok: false,
            completedSteps: result.completedSteps,
            aborted: true,
            error: "回放已手动停止",
          });
          return;
        }
        logger.warn("replay_deliver_failed", { error: message });
        deliverSummary = `机械回放成功，但 AI 交付失败：${message}`;
      }
    }

    const completeMsg = delivered
      ? deliverSummary
      : deliverSummary
        ? `回放成功 · 共 ${result.completedSteps} 步\n${deliverSummary}`
        : `回放成功 · 共 ${result.completedSteps} 步`;

    logger.agentState("complete", {
      ...engineTag,
      step: result.completedSteps,
      msg: completeMsg,
    });
    logger.result("trajectory_replay_done", {
      ok: true,
      completedSteps: result.completedSteps,
      delivered,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("trajectory_replay_failed", { error: message });
    logger.agentState("failed", {
      ...engineTag,
      step: 0,
      msg: `回放失败：${message}`,
    });
  } finally {
    trajectoryReplayRunning = false;
    trajectoryReplayAbort = null;
  }
}

async function handleTrajectoryDelete(payload: Record<string, unknown>): Promise<void> {
  const filePath = String(payload.filePath ?? payload.file_path ?? "").trim();
  if (!filePath) {
    logger.error("trajectory_delete_failed", { error: "缺少 filePath" });
    return;
  }
  try {
    await deletePersistedTrajectory(filePath);
    logger.result("trajectory_deleted", { filePath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("trajectory_delete_failed", { error: message });
  }
}

function handleAgentImmediateCommand(payload: Record<string, unknown>): boolean {
  const command = String(payload.command ?? "");

  if (command === "agent_confirm") {
    const requestId = String(payload.requestId ?? "").trim();
    const fillOverrides =
      typeof payload.fillOverrides === "object" && payload.fillOverrides !== null
        ? Object.fromEntries(
            Object.entries(payload.fillOverrides as Record<string, unknown>).map(([key, value]) => [
              key,
              String(value ?? ""),
            ]),
          )
        : undefined;
    if (!resolvePendingConfirm(requestId, true, fillOverrides)) {
      logger.warn("agent_confirm_no_pending", { requestId });
    }
    return true;
  }

  if (command === "agent_cancel") {
    const requestId = String(payload.requestId ?? "").trim();
    if (requestId) {
      resolvePendingConfirm(requestId, false);
    } else {
      rejectAllAgentPendings("用户取消");
    }
    return true;
  }

  if (command === "agent_user_reply") {
    const requestId = String(payload.requestId ?? "").trim();
    const answer = String(payload.answer ?? payload.reply ?? "").trim();
    if (!resolvePendingAsk(requestId, answer || "（用户未填写）")) {
      logger.warn("agent_user_reply_no_pending", { requestId });
    }
    return true;
  }

  if (command === "agent_handover_continue") {
    const requestId = String(payload.requestId ?? "").trim();
    if (requestId) {
      if (!resolvePendingHandover(requestId)) {
        logger.warn("agent_handover_continue_no_pending", { requestId });
      }
    } else {
      // 无 requestId：恢复全部挂起锁
      resumePause(null);
    }
    return true;
  }

  if (command === "agent_abort" || command === "trajectory_abort") {
    rejectAllAgentPendings("用户中止 Agent");
    if (agentAbortController && !agentAbortController.signal.aborted) {
      agentAbortController.abort("agent_abort");
    }
    if (trajectoryReplayAbort && !trajectoryReplayAbort.signal.aborted) {
      // 仅打断回放循环；终态由 handleTrajectoryReplay 统一推送
      trajectoryReplayAbort.abort("trajectory_abort");
    } else if (command === "agent_abort") {
      logger.agentState("failed", { step: 0, msg: "用户中止 Agent" });
    }
    return true;
  }

  return false;
}

/** Milestone 4：CDP/Playwright 将当前页唤到前台，方便用户处理验证码 */
async function handleBringToFront(browser: Browser): Promise<void> {
  try {
    const page = await resolveActivePageFromBrowser(browser);
    await page.bringToFront();
    // 双保险：经 CDP Session 再发 Page.bringToFront
    try {
      const session = await page.context().newCDPSession(page);
      await session.send("Page.bringToFront").catch(() => undefined);
      await session.detach().catch(() => undefined);
    } catch {
      // Playwright bringToFront 已足够；CDP 失败可忽略
    }
    logger.result("agent_bring_to_front", { ok: true, url: page.url() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("agent_bring_to_front_failed", { error: message });
  }
}

function asFillProfile(value: unknown): FillProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fill profile must be a JSON object");
  }

  const profile: FillProfile = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) {
      continue;
    }
    profile[key] = String(entry);
  }
  return profile;
}

function asAiSettings(value: unknown): SidecarAiSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fill command requires ai settings object from Rust host");
  }
  const record = value as Record<string, unknown>;
  const apiKey = String(record.apiKey ?? record.api_key ?? "").trim();
  const apiBaseUrl = String(record.apiBaseUrl ?? record.api_base_url ?? "").trim();
  if (!apiKey) {
    throw new Error("fill command ai.apiKey is required");
  }
  if (!apiBaseUrl) {
    throw new Error("fill command ai.apiBaseUrl is required");
  }
  return {
    apiKey,
    apiBaseUrl,
    textModel: record.textModel
      ? String(record.textModel)
      : record.agentModel
        ? String(record.agentModel)
        : undefined,
    chatModel: record.chatModel ? String(record.chatModel) : undefined,
    agentModel: record.agentModel
      ? String(record.agentModel)
      : record.textModel
        ? String(record.textModel)
        : undefined,
    visionModel: record.visionModel ? String(record.visionModel) : undefined,
  };
}

async function main(): Promise<void> {
  const abortController = new AbortController();
  let browser: Browser | null = null;
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.status("shutting_down", { reason });
    stopPauseHttpServer();
    await disconnectBrowser(browser);
    logger.result("sidecar_stopped", { reason, exitCode });
    process.exit(exitCode);
  };

  attachStdinAbortListener(abortController, () => {
    void shutdown("abort_signal");
  }, async (payload) => {
    if (!browser) {
      return;
    }

    if (handleAgentImmediateCommand(payload)) {
      return;
    }

    const command = String(payload.command ?? "");
    const waitId = String(payload.waitId ?? payload.wait_id ?? "").trim() || null;
    // 长任务命令绑定 waitId，终态回传给 Rust 精确唤醒
    if (
      command === "agent_start" ||
      command === "rpa_start" ||
      command === "trajectory_replay" ||
      command === "fill" ||
      command === "smart_element_fill"
    ) {
      bindCommandWaitId(waitId);
    }

    if (command === "agent_bring_to_front") {
      // 仅 Intervention「去处理」经 Rust 下发；自动化循环禁止主动抢焦点
      await handleBringToFront(browser);
      return;
    }

    if (command === "agent_start") {
      try {
        await handleAgentStart(browser, payload, waitId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("agent_start_failed", { error: message });
      }
      return;
    }

    if (command === "trajectory_list") {
      await handleTrajectoryList(payload);
      return;
    }

    if (command === "trajectory_replay") {
      await handleTrajectoryReplay(browser, payload);
      return;
    }

    if (command === "trajectory_delete") {
      await handleTrajectoryDelete(payload);
      return;
    }

    if (command === "preview_hybrid") {
      try {
        const page = resolveActivePage(browser);
        const aiSettings = asAiSettings(payload.ai);
        const proxyAuth = asProxyAuth(payload.proxyAuth);
        if (proxyAuth) {
          await installProxyAuthHandler(browser, proxyAuth);
        }

        const rawInput = String(payload.rawInput ?? payload.raw_input ?? "").trim();
        const partialProfile = asFillProfile(payload.profile);
        const partialHint =
          rawInput ||
          Object.entries(partialProfile)
            .map(([key, value]) => `${key}: ${value}`)
            .join("\n");

        logger.progress("preview_hybrid_start", {
          partialInputLength: partialHint.length,
        });

        const profile = await generateHybridFillProfile(
          page,
          partialHint,
          aiSettings,
          logger,
          resolveUserDataDir(payload),
        );
        process.stdout.write(`${JSON.stringify({ type: "hybrid_preview", profile })}\n`);
        logger.result("hybrid_preview_ready", { keyCount: Object.keys(profile).length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("preview_hybrid_failed", { error: message });
      }
      return;
    }

    if (command === "rpa_start") {
      await handleRpaStart(browser, payload);
      return;
    }

    if (command === "rpa_resume") {
      await handleRpaResume(browser);
      return;
    }

    if (command === "rpa_rescan") {
      await handleRpaRescan(browser, payload);
      return;
    }

    if (command === "rpa_pause") {
      await handleRpaPause();
      return;
    }

    if (command === "get_url") {
      await handleGetUrl(browser);
      return;
    }

    if (command === "smart_element_fill") {
      try {
        await handleSmartElementFill(browser, payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("smart_element_fill_failed", { error: message });
      }
      return;
    }

    if (command === "fill") {
      try {
        await handleLegacyFill(browser, payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("fill_command_failed", { error: message });
      }
      return;
    }
  });

  process.on("SIGINT", () => {
    if (!abortController.signal.aborted) {
      abortController.abort("sigint");
    }
  });

  process.on("SIGTERM", () => {
    if (!abortController.signal.aborted) {
      abortController.abort("sigterm");
    }
  });

  const cdpUrl = parseCdpUrl(process.argv.slice(2));
  logger.status("sidecar_starting", { cdpUrl });

  // Milestone 4：真·挂起 Resume HTTP（127.0.0.1 随机端口），供 Rust 直连唤醒
  try {
    const pausePort = await startPauseHttpServer();
    process.stdout.write(
      `${JSON.stringify({
        type: "pause_server",
        port: pausePort,
        ts: new Date().toISOString(),
      })}\n`,
    );
    logger.status("pause_server_ready", { port: pausePort });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("pause_server_failed", { error: message });
  }

  try {
    logger.progress("connecting_cdp", { cdpUrl });
    browser = await chromium.connectOverCDP(cdpUrl, {
      timeout: 30_000,
    });

    const contexts = browser.contexts();
    logger.status("cdp_connected", {
      cdpUrl,
      contextCount: contexts.length,
      browserConnected: browser.isConnected(),
    });

    browser.on("disconnected", () => {
      logger.status("browser_disconnected", { cdpUrl });
      void shutdown("browser_disconnected");
    });

    await attachBrowserUrlWatchers(browser, logger);

    logger.progress("awaiting_commands", {
      hint: 'send {"command":"rpa_start"|fill|rpa_resume|rpa_rescan|get_url|abort}',
    });

    await new Promise<void>((resolve) => {
      if (abortController.signal.aborted) {
        resolve();
        return;
      }
      abortController.signal.addEventListener("abort", () => resolve(), { once: true });
    });

    await shutdown("abort_signal");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("sidecar_failed", { error: message, cdpUrl });
    await disconnectBrowser(browser);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error("unhandled_sidecar_error", { error: message });
  process.exit(1);
});

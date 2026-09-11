/**
 * 特征感知回放引擎 — 无 LLM，按 TrajectoryStep[] 在 Playwright Page 上顺序执行
 *
 * - 防遮挡：click 使用 force + 短超时，避免被下拉/弹层卡死 60s
 * - 特征屏障：带 postCondition 的步先断言 URL，再 networkidle + 人类停顿；旧轨迹无特征则降级
 *
 * 注意：默认不写 console（Sidecar 仅允许 JSON stdout）；诊断脚本可设 verboseConsole。
 * 数据覆盖：可选 valueOverrides / fieldOverrides 按 selector 运行时覆盖 fill/select 值，不改轨迹 JSON。
 * 延迟生成：fieldOverrides.mode=ai_prompt 时在填表前一秒 JIT 调用 fast_text。
 */
import type { Page } from "playwright-core";

import { resolveCoordToViewportPixels } from "./core/action_gateway.js";
import { safeGoto, softSettleAfterNavigation } from "./cdp_session.js";
import {
  lookupFieldOverride,
  resolveFieldOverrideValue,
  type FieldOverrideSpec,
  type ResolveOverrideContext,
} from "./deferred_generation.js";
import {
  isTempIdSelector,
  type TrajectoryActionType,
  type TrajectoryPostCondition,
  type TrajectoryStep,
} from "./trajectory.js";
import { JsonLogger } from "./json-logger.js";

const logger = new JsonLogger();

/** 单步选择器等待上限（避免 Playwright 反复重试拖成数分钟） */
const DEFAULT_SELECTOR_TIMEOUT_MS = 8_000;
/** 点击强点：3s 内穿透遮罩，禁止 60s 死等 */
const CLICK_TIMEOUT_MS = 3_000;
const FILL_TIMEOUT_MS = 6_000;
const POST_URL_TIMEOUT_MS = 5_000;
const NETWORK_IDLE_TIMEOUT_MS = 3_000;
const HUMAN_SETTLE_MS = 1_500;
/** 回放全部完成后 → AI 交接前的防抢跑屏障 */
const HANDOFF_NETWORK_IDLE_MS = 8_000;
const HANDOFF_DOM_STABLE_TIMEOUT_MS = 8_000;
const HANDOFF_DOM_POLL_MS = 400;
const HANDOFF_HUMAN_BUFFER_MS = 2_500;
const HANDOFF_MIN_BODY_CHARS = 60;

const SEARCH_INPUT_FALLBACKS = [
  "#kw",
  'input[name="wd"]',
  "#chat-textarea",
  'input[type="search"]',
];

const SEARCH_SUBMIT_SELECTORS = new Set([
  "#su",
  "#chat-submit-button",
  'input[type="submit"]',
  'button[type="submit"]',
]);

export interface ReplayEngineOptions {
  selectorTimeoutMs?: number;
  stepPauseMs?: number;
  verboseConsole?: boolean;
  /** @deprecated 旧版 string 覆盖；优先使用 fieldOverrides */
  valueOverrides?: Record<string, string>;
  /** 结构化覆盖：fixed（含 {{变量}}）/ ai_prompt（JIT） */
  fieldOverrides?: Record<string, FieldOverrideSpec>;
  /** JIT / 变量插值上下文 */
  resolveContext?: ResolveOverrideContext;
  /** 用户中止回放 */
  signal?: AbortSignal;
  onProgress?: (event: ReplayProgressEvent) => void;
}

export interface ReplayProgressEvent {
  step: number;
  type: string;
  selector: string;
  status: "start" | "ok" | "fail";
  message?: string;
}

export interface ReplayEngineResult {
  ok: boolean;
  completedSteps: number;
  failedStep?: number;
  error?: string;
}

type LooseStep = TrajectoryStep & {
  action?: string;
  postCondition?: TrajectoryPostCondition;
};

function resolveStepType(step: LooseStep): TrajectoryActionType | string {
  return (step.type || step.action || "").toLowerCase();
}

function makeConsole(verbose: boolean) {
  return {
    ok: (message: string) => {
      if (verbose) {
        logger.debug(`replay_ok: ${message}`);
      }
    },
    fail: (message: string) => {
      if (verbose) {
        logger.debug(`replay_fail: ${message}`);
      }
    },
    dim: (message: string) => {
      if (verbose) {
        logger.debug(`replay_detail: ${message}`);
      }
    },
  };
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("回放已手动停止");
  }
}

/** 让 Stop 能打断正在进行的 Playwright 等待 */
function withAbort<T>(signal: AbortSignal | undefined, promise: Promise<T>): Promise<T> {
  if (!signal) {
    return promise;
  }
  assertNotAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error("回放已手动停止"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** 去掉 Playwright Call log 里的 ANSI，避免前端刷屏 */
export function stripAnsi(text: string): string {
  return String(text ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim();
}

export function toPlaywrightSelector(selector: string): string {
  const trimmed = String(selector ?? "").trim();
  if (!trimmed) {
    return trimmed;
  }
  if (
    trimmed.startsWith("xpath=") ||
    trimmed.startsWith("css=") ||
    trimmed.startsWith("text=") ||
    trimmed.startsWith("internal:")
  ) {
    return trimmed;
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("(")) {
    return `xpath=${trimmed}`;
  }
  return trimmed;
}

export function resolveReplayFillValue(
  selector: string,
  recordedValue: string | undefined,
  valueOverrides?: Record<string, string>,
): string {
  const fallback = String(recordedValue ?? "");
  if (!valueOverrides) {
    return fallback;
  }
  const raw = String(selector ?? "").trim();
  const pw = toPlaywrightSelector(raw);
  if (Object.prototype.hasOwnProperty.call(valueOverrides, raw)) {
    return String(valueOverrides[raw] ?? "");
  }
  if (pw !== raw && Object.prototype.hasOwnProperty.call(valueOverrides, pw)) {
    return String(valueOverrides[pw] ?? "");
  }
  if (pw.startsWith("xpath=") && Object.prototype.hasOwnProperty.call(valueOverrides, pw.slice(6))) {
    return String(valueOverrides[pw.slice(6)] ?? "");
  }
  if (
    !raw.startsWith("xpath=") &&
    Object.prototype.hasOwnProperty.call(valueOverrides, `xpath=${raw}`)
  ) {
    return String(valueOverrides[`xpath=${raw}`] ?? "");
  }
  return fallback;
}

/** 解析最终填表值：优先结构化 fieldOverrides（含延迟 AI），否则回退旧 string overrides */
export async function resolveReplayFillValueDeferred(
  selector: string,
  step: TrajectoryStep,
  options?: ReplayEngineOptions,
): Promise<string> {
  const recorded = String(step.value ?? "");
  const fieldSpec = lookupFieldOverride(selector, options?.fieldOverrides);
  if (fieldSpec && options?.resolveContext) {
    const enriched: FieldOverrideSpec = {
      ...fieldSpec,
      label:
        fieldSpec.label ||
        step.label ||
        step.semanticContext?.label ||
        undefined,
      inputType:
        fieldSpec.inputType ||
        step.inputType ||
        step.semanticContext?.inputType ||
        undefined,
    };
    return resolveFieldOverrideValue(enriched, recorded, options.resolveContext);
  }
  if (fieldSpec) {
    // 无上下文时：fixed 原样返回；ai_prompt 无法生成则回退录制值
    if (fieldSpec.mode === "fixed") {
      return fieldSpec.value.length > 0 ? fieldSpec.value : recorded;
    }
    return recorded;
  }
  return resolveReplayFillValue(selector, recorded, options?.valueOverrides);
}

function looksLikeSearchInput(selector: string): boolean {
  const s = selector.toLowerCase();
  return (
    s.includes("chat-textarea") ||
    s.includes("#kw") ||
    s.includes('name="wd"') ||
    s.includes("search")
  );
}

function looksLikeSearchSubmit(selector: string): boolean {
  const s = selector.toLowerCase().trim();
  if (SEARCH_SUBMIT_SELECTORS.has(s)) {
    return true;
  }
  return s === "#su" || s.includes("chat-submit") || s.includes("search-btn");
}

/** 提取用于 URL 特征匹配的主路径（去掉 query，容忍动态参数） */
export function postConditionUrlNeedle(rawUrl: string): string {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const withoutQuery = trimmed.split("?")[0] ?? trimmed;
  return withoutQuery.split("#")[0] ?? withoutQuery;
}

function urlMatchesPostCondition(href: string, recordedUrl: string): boolean {
  const needle = postConditionUrlNeedle(recordedUrl);
  if (!needle) {
    return true;
  }
  try {
    const current = href.includes(needle) || postConditionUrlNeedle(href).includes(needle);
    return current;
  } catch {
    return false;
  }
}

/**
 * 特征屏障：有 postCondition 则断言 URL；无论新旧轨迹均做 AJAX 稳定 + 人类停顿。
 * 绝对禁止在状态变更后立刻进入下一步。
 */
async function settleAfterStateChange(
  page: Page,
  step: LooseStep,
  signal?: AbortSignal,
): Promise<void> {
  const postUrl = String(step.postCondition?.url ?? "").trim();
  if (postUrl) {
    const needle = postConditionUrlNeedle(postUrl);
    if (needle) {
      await withAbort(
        signal,
        page
          .waitForURL((url) => urlMatchesPostCondition(url.href, postUrl), {
            timeout: POST_URL_TIMEOUT_MS,
          })
          .catch(() => undefined),
      );
    }
  }

  // 强制 AJAX/SPA 稳定屏障（旧轨迹无 postCondition 时也走此降级路径）
  await withAbort(
    signal,
    page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => undefined),
  );
  // 人类视觉停顿：给 SPA 渲染与动画收尾时间
  await withAbort(signal, sleep(HUMAN_SETTLE_MS));
}

/**
 * 动态 DOM 稳定：正文长度与摘要连续两次采样一致，且达到最小字符数。
 * 用于拦截 AJAX 搜索结果尚未挂载时的「残影」交接。
 */
async function waitForDomContentStable(
  page: Page,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + HANDOFF_DOM_STABLE_TIMEOUT_MS;
  let lastSig = "";
  let stableHits = 0;

  while (Date.now() < deadline) {
    assertNotAborted(signal);
    const sig = await withAbort(
      signal,
      page
        .evaluate((minChars) => {
          const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "IFRAME", "LINK", "META"]);
          const root =
            document.querySelector("#content_left, #rso, #b_results, main, article") ||
            document.body;
          if (!root) {
            return "0:";
          }
          const parts: string[] = [];
          const walk = (node: Node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node as HTMLElement;
              if (SKIP.has(el.tagName)) {
                return;
              }
              try {
                const style = window.getComputedStyle(el);
                if (
                  style.display === "none" ||
                  style.visibility === "hidden" ||
                  Number(style.opacity) === 0
                ) {
                  return;
                }
              } catch {
                /* ignore */
              }
              if (el.getAttribute("aria-hidden") === "true") {
                return;
              }
              for (const child of Array.from(el.childNodes)) {
                walk(child);
              }
              return;
            }
            if (node.nodeType === Node.TEXT_NODE) {
              const t = String(node.textContent ?? "")
                .replace(/\s+/g, " ")
                .trim();
              if (t) {
                parts.push(t);
              }
            }
          };
          walk(root);
          const text = parts.join(" ").trim();
          const len = text.length;
          return `${len}:${text.slice(0, 160)}:${len >= minChars ? "1" : "0"}`;
        }, HANDOFF_MIN_BODY_CHARS)
        .catch(() => "0::0"),
    );

    const enough = sig.endsWith(":1");
    if (sig && enough && sig === lastSig) {
      stableHits += 1;
      if (stableHits >= 2) {
        return;
      }
    } else {
      stableHits = 0;
      lastSig = sig;
    }
    await withAbort(signal, sleep(HANDOFF_DOM_POLL_MS));
  }
}

/**
 * 回放全部完成后 → AI 交接前的防抢跑屏障。
 * networkidle → DOM 稳定 → 人类视觉缓冲；禁止 0ms 开环交接残影 DOM。
 */
export async function settleBeforeAiHandoff(
  page: Page,
  signal?: AbortSignal,
): Promise<void> {
  assertNotAborted(signal);
  await withAbort(
    signal,
    page
      .waitForLoadState("networkidle", { timeout: HANDOFF_NETWORK_IDLE_MS })
      .catch(() => undefined),
  );
  await waitForDomContentStable(page, signal);
  assertNotAborted(signal);
  await withAbort(signal, sleep(HANDOFF_HUMAN_BUFFER_MS));
}

async function waitAttached(
  page: Page,
  selector: string,
  timeoutMs: number,
): Promise<string> {
  const pw = toPlaywrightSelector(selector);
  const locator = page.locator(pw).first();
  await locator.waitFor({ state: "attached", timeout: timeoutMs });
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  return pw;
}

async function resolveFillSelector(
  page: Page,
  primary: string,
  timeoutMs: number,
): Promise<string> {
  try {
    return await waitAttached(page, primary, timeoutMs);
  } catch (primaryError) {
    if (!looksLikeSearchInput(primary)) {
      throw primaryError;
    }
    const tried = new Set([toPlaywrightSelector(primary), primary]);
    for (const candidate of SEARCH_INPUT_FALLBACKS) {
      const key = toPlaywrightSelector(candidate);
      if (tried.has(key)) {
        continue;
      }
      tried.add(key);
      try {
        return await waitAttached(page, candidate, 2_500);
      } catch {
        /* next */
      }
    }
    throw primaryError;
  }
}

async function clickSearchOrButton(
  page: Page,
  selector: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  // 关掉百度联想层，避免挡住 #su
  await page.keyboard.press("Escape").catch(() => undefined);
  await sleep(120);
  assertNotAborted(signal);

  const pw = toPlaywrightSelector(selector);
  const locator = page.locator(pw).first();
  const attached = await locator.count().catch(() => 0);
  if (attached > 0) {
    try {
      await withAbort(
        signal,
        locator.click({ force: true, timeout: Math.min(timeoutMs, CLICK_TIMEOUT_MS) }),
      );
      return;
    } catch (error) {
      assertNotAborted(signal);
      /* fall through to Enter */
      void error;
    }
  }

  if (looksLikeSearchSubmit(selector)) {
    await page.keyboard.press("Enter");
    await sleep(300);
    return;
  }

  await withAbort(signal, waitAttached(page, selector, timeoutMs));
  await withAbort(
    signal,
    page.locator(pw).first().click({ force: true, timeout: CLICK_TIMEOUT_MS }),
  );
}

/**
 * 核心：对已连接的 Page 回放轨迹（推荐用于 Sidecar CDP 会话）
 */
export async function replayTrajectoryOnPage(
  page: Page,
  steps: TrajectoryStep[],
  options?: ReplayEngineOptions,
): Promise<ReplayEngineResult> {
  const timeout = options?.selectorTimeoutMs ?? DEFAULT_SELECTOR_TIMEOUT_MS;
  const pauseMs = options?.stepPauseMs ?? 120;
  const valueOverrides = options?.valueOverrides;
  const fieldOverrides = options?.fieldOverrides;
  const signal = options?.signal;
  const emit = options?.onProgress;
  const log = makeConsole(options?.verboseConsole === true);
  const overrideCount =
    (fieldOverrides ? Object.keys(fieldOverrides).length : 0) ||
    (valueOverrides ? Object.keys(valueOverrides).length : 0);

  if (!Array.isArray(steps) || steps.length === 0) {
    const error = "轨迹步骤为空，无法回放";
    log.fail(error);
    return { ok: false, completedSteps: 0, error };
  }

  log.dim(
    `▶ 回放开始 · 共 ${steps.length} 步 · timeout=${timeout}ms` +
      (overrideCount > 0 ? ` · overrides=${overrideCount}` : ""),
  );

  for (let index = 0; index < steps.length; index += 1) {
    assertNotAborted(signal);
    const step = steps[index] as LooseStep;
    const stepNo = step.step ?? index + 1;
    const type = resolveStepType(step);
    const selector = String(step.selector ?? "").trim();
    const validSelector = toPlaywrightSelector(selector);
    let usedFeatureSettle = false;

    emit?.({ step: stepNo, type, selector: validSelector || selector, status: "start" });
    log.dim(
      `  → step ${stepNo}/${steps.length} [${type}] ${validSelector || step.value || step.url || ""}`,
    );

    try {
      if (selector && isTempIdSelector(selector)) {
        throw new Error(`拒绝执行临时 ID selector「${selector}」`);
      }

      switch (type) {
        case "navigate": {
          const target = String(step.value ?? step.url ?? selector).trim();
          if (!target) {
            throw new Error("navigate 缺少目标 URL");
          }
          await withAbort(signal, safeGoto(page, target, { softNetworkIdle: false }));
          await withAbort(
            signal,
            softSettleAfterNavigation(page, {
              softNetworkIdle: false,
              domTimeoutMs: 2_500,
            }),
          );
          // 特征屏障：禁止立刻进入下一步
          await settleAfterStateChange(page, step, signal);
          usedFeatureSettle = true;
          break;
        }
        case "wait": {
          const delay = Number(step.value ?? 500);
          const ms = Number.isFinite(delay) ? Math.min(delay, 10_000) : 500;
          await withAbort(signal, sleep(ms));
          break;
        }
        case "fill":
        case "select": {
          if (!validSelector) {
            throw new Error(`${type} 缺少 selector`);
          }
          const resolved = await withAbort(signal, resolveFillSelector(page, selector, timeout));
          assertNotAborted(signal);
          const finalValue = await withAbort(
            signal,
            resolveReplayFillValueDeferred(selector, step, options),
          );
          const locator = page.locator(resolved).first();
          if (type === "select") {
            await withAbort(
              signal,
              locator.selectOption({ label: finalValue }).catch(async () => {
                await locator.selectOption({ value: finalValue });
              }),
            );
          } else {
            await locator.click({ force: true, timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
            await withAbort(
              signal,
              locator.fill(finalValue, { timeout: FILL_TIMEOUT_MS }).catch(async () => {
                await locator.fill("").catch(() => undefined);
                await page.keyboard.type(finalValue, { delay: 15 });
              }),
            );
            // 搜索框填完后收起联想，方便下一步点按钮；下一步若是提交也可直接 Enter
            if (looksLikeSearchInput(resolved) || looksLikeSearchInput(selector)) {
              await sleep(150);
              const next = steps[index + 1] as LooseStep | undefined;
              const nextType = next ? resolveStepType(next) : "";
              const nextSel = String(next?.selector ?? "").trim();
              if (nextType === "click" && looksLikeSearchSubmit(nextSel)) {
                // 预提交由下一步处理；此处仅 Esc 清遮挡
                await page.keyboard.press("Escape").catch(() => undefined);
              }
            }
          }
          break;
        }
        case "click": {
          const primary =
            String(step.primarySelector ?? step.fallbackSelector ?? selector).trim() ||
            validSelector;
          if (!primary && !(Number.isFinite(Number(step.x)) || step.fallbackCoordinates)) {
            throw new Error("click 缺少 selector");
          }
          assertNotAborted(signal);
          if (primary && !isTempIdSelector(primary)) {
            try {
              await clickSearchOrButton(page, primary, timeout, signal);
              await settleAfterStateChange(page, step, signal);
              usedFeatureSettle = true;
              break;
            } catch {
              /* fall through to coordinates / label */
            }
          }
          const labelHeal = String(step.semanticLabel ?? step.label ?? "").trim();
          if (labelHeal && labelHeal !== "（点击）" && labelHeal !== "（坐标点击）") {
            try {
              await withAbort(
                signal,
                page.getByText(labelHeal, { exact: false }).first().click({
                  force: true,
                  delay: 50,
                  timeout: CLICK_TIMEOUT_MS,
                }),
              );
              await settleAfterStateChange(page, step, signal);
              usedFeatureSettle = true;
              break;
            } catch {
              /* fall through to coordinates */
            }
          }
          const rawCoords = step.fallbackCoordinates ?? {
            x: Number(step.x),
            y: Number(step.y),
            unit: undefined as "relative" | "px" | undefined,
          };
          if (!Number.isFinite(Number(rawCoords.x)) || !Number.isFinite(Number(rawCoords.y))) {
            throw new Error("click 缺少可用 selector 与坐标");
          }
          const box = page.viewportSize() ?? { width: 1280, height: 720 };
          const pixel = resolveCoordToViewportPixels(
            {
              x: Number(rawCoords.x),
              y: Number(rawCoords.y),
              unit: (rawCoords as { unit?: string }).unit,
            },
            box,
            step.viewport,
          );
          if (!Number.isFinite(pixel.x) || !Number.isFinite(pixel.y)) {
            throw new Error("click 坐标无法映射到当前视口");
          }
          await withAbort(
            signal,
            page.mouse.click(pixel.x, pixel.y, {
              delay: 50,
            }),
          );
          await settleAfterStateChange(page, step, signal);
          usedFeatureSettle = true;
          break;
        }
        case "click_point": {
          assertNotAborted(signal);
          const fallback = String(
            step.primarySelector ?? step.fallbackSelector ?? selector,
          ).trim();
          let clicked = false;
          if (fallback && !isTempIdSelector(fallback) && !fallback.startsWith("text=")) {
            try {
              await clickSearchOrButton(page, fallback, Math.min(timeout, 3_000), signal);
              clicked = true;
            } catch {
              clicked = false;
            }
          } else if (fallback.startsWith("text=")) {
            const label = fallback.slice("text=".length).trim();
            if (label) {
              try {
                await withAbort(
                  signal,
                  page.getByText(label, { exact: false }).first().click({
                    force: true,
                    delay: 50,
                    timeout: CLICK_TIMEOUT_MS,
                  }),
                );
                clicked = true;
              } catch {
                clicked = false;
              }
            }
          }
          if (!clicked) {
            const box = page.viewportSize() ?? { width: 1280, height: 720 };
            const rawX = Number(step.fallbackCoordinates?.x ?? step.x);
            const rawY = Number(step.fallbackCoordinates?.y ?? step.y);
            if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
              throw new Error("click_point 缺少可用 selector 与坐标");
            }
            const pixel = resolveCoordToViewportPixels(
              {
                x: rawX,
                y: rawY,
                unit: step.fallbackCoordinates?.unit,
              },
              box,
              step.viewport,
            );
            await withAbort(signal, page.mouse.click(pixel.x, pixel.y, { delay: 50 }));
          }
          await settleAfterStateChange(page, step, signal);
          usedFeatureSettle = true;
          break;
        }
        case "keypress": {
          const key = String(step.value ?? "").trim() || "Enter";
          await withAbort(signal, page.keyboard.press(key));
          await sleep(200);
          break;
        }
        case "scroll": {
          const direction = String(step.value ?? "down").toLowerCase();
          const dir =
            direction === "up" || direction === "bottom" ? direction : "down";
          await page.evaluate((d: string) => {
            if (d === "bottom") {
              window.scrollTo(0, document.documentElement.scrollHeight);
              return;
            }
            window.scrollBy(0, d === "up" ? -600 : 600);
          }, dir);
          await sleep(200);
          break;
        }
        default:
          throw new Error(`不支持的动作类型: ${type || "(empty)"}`);
      }

      emit?.({ step: stepNo, type, selector: validSelector || selector, status: "ok" });
      log.ok(`step ${stepNo} [${type}] 完成`);
      // 特征屏障已含人类停顿时不再叠 pause
      if (!usedFeatureSettle) {
        await sleep(pauseMs);
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = stripAnsi(raw);
      const aborted = signal?.aborted === true || message.includes("回放已手动停止");
      const detail = aborted
        ? `回放已手动停止 · step=${stepNo}`
        : `回放中止 · step=${stepNo} · type=${type} · selector=${validSelector || selector || "(none)"} · ${message}`;
      log.fail(detail);
      emit?.({
        step: stepNo,
        type,
        selector: validSelector || selector,
        status: "fail",
        message: detail,
      });
      return {
        ok: false,
        completedSteps: index,
        failedStep: stepNo,
        error: detail,
      };
    }
  }

  log.ok(`回放全部完成 · ${steps.length} 步`);
  // 防抢跑：最后一步后必须沉淀，再允许上层交接 AI
  log.dim("  … 交接前网络/DOM 沉淀屏障");
  await settleBeforeAiHandoff(page, signal);
  log.ok("沉淀完成 · 可安全交接 AI");
  return { ok: true, completedSteps: steps.length };
}

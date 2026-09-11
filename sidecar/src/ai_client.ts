import OpenAI from "openai";

import type { SidecarAiSettings } from "./engine.js";

export const DEFAULT_TEXT_MODEL = "deepseek-v4-flash";
export const DEFAULT_VISION_MODEL = "deepseek-v4-flash-vision-exp";

/** 默认 HTTP 超时（毫秒） */
export const LLM_REQUEST_TIMEOUT_MS = 60_000;

/** Agent 主循环单次调用超时（flash 友好，避免 60s×重试≈2 分钟假死） */
export const AGENT_TURN_TIMEOUT_MS = 35_000;

/** OpenAI 兼容：DeepSeek / 智谱 BigModel（https://open.bigmodel.cn/api/paas/v4）等 */
export function createLlmClient(settings: SidecarAiSettings): OpenAI {
  const apiKey = settings.apiKey.trim();
  if (!apiKey) {
    throw new Error("missing apiKey in sidecar AI settings");
  }

  return new OpenAI({
    apiKey,
    baseURL: settings.apiBaseUrl.trim() || "https://api.deepseek.com",
    timeout: LLM_REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  });
}

/** 合并 AbortSignal；任一 abort 则整体 abort */
export function mergeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => Boolean(s));
  if (list.length === 0) {
    return new AbortController().signal;
  }
  if (list.length === 1) {
    return list[0]!;
  }
  const merged = new AbortController();
  const onAbort = () => merged.abort();
  for (const signal of list) {
    if (signal.aborted) {
      merged.abort();
      break;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return merged.signal;
}

/** Agent 轮次：超时信号 + 可选心跳回调 */
export function beginAgentLlmWait(input: {
  parentSignal?: AbortSignal;
  timeoutMs?: number;
  onTick?: (elapsedMs: number) => void;
  tickMs?: number;
}): { signal: AbortSignal; stop: () => void } {
  const timeoutMs = input.timeoutMs ?? AGENT_TURN_TIMEOUT_MS;
  const timeoutSignal =
    typeof AbortSignal !== "undefined" &&
    typeof (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout === "function"
      ? (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout(timeoutMs)
      : (() => {
          const c = new AbortController();
          setTimeout(() => c.abort(), timeoutMs);
          return c.signal;
        })();
  const signal = mergeAbortSignals(input.parentSignal, timeoutSignal);
  const started = Date.now();
  const tickMs = input.tickMs ?? 8_000;
  const timer = setInterval(() => {
    try {
      input.onTick?.(Date.now() - started);
    } catch {
      /* ignore */
    }
  }, tickMs);
  return {
    signal,
    stop: () => clearInterval(timer),
  };
}

/** Abort / 超时属于预期中断，不得冒泡成 Unhandled Rejection */
export function isLlmAbortOrTimeoutError(error: unknown): boolean {
  if (error == null) {
    return false;
  }
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    name === "APIUserAbortError" ||
    name === "APIConnectionTimeoutError"
  ) {
    return true;
  }
  if (/aborted|abort(?:ed)?|timeout|ETIMEDOUT|ECONNRESET|user.?abort/i.test(message)) {
    return true;
  }
  return false;
}

/** 将中断/超时转为 UI 友好文案 */
export function formatLlmInterruptMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/timeout|Timeout|ETIMEDOUT/i.test(message) || (error as { name?: string })?.name === "TimeoutError") {
    return `LLM 请求超时（超过 ${AGENT_TURN_TIMEOUT_MS / 1000} 秒），已中止本轮调用`;
  }
  if (isLlmAbortOrTimeoutError(error)) {
    return "LLM 请求已中止（用户停止或连接中断）";
  }
  return message || "LLM 请求失败";
}

/** DeepSeek V4 默认开启 Thinking，与 tool_choice=required 互斥 */
export function modelNeedsThinkingDisabledForForcedTools(model: string): boolean {
  const m = String(model ?? "").toLowerCase();
  if (!m) {
    return false;
  }
  return (
    /deepseek-v4|deepseek-reasoner/.test(m) ||
    m.includes("v4-flash") ||
    m.includes("v4-pro") ||
    /thinking/i.test(m)
  );
}

export function isThinkingToolChoiceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Thinking mode does not support this tool_choice/i.test(message);
}

/**
 * Agent 强制工具轮请求体补丁：
 * DeepSeek V4 须显式 thinking.disabled，否则 400。
 * 经 OpenAI SDK 用类型断言透传（官方字段尚未进类型）。
 */
export function agentForcedToolRequestPatch(model: string): Record<string, unknown> {
  if (!modelNeedsThinkingDisabledForForcedTools(model)) {
    return {};
  }
  return {
    thinking: { type: "disabled" },
  };
}

/**
 * 从 OpenAI 兼容 completion 安全提取 assistant 文本内容。
 * 统一 `choices[0]?.message?.content` 访问链；无内容时返回空字符串。
 * 与各处 `String(x.choices[0]?.message?.content ?? "")` 完全一致。
 */
export function extractAssistantContent(completion: unknown): string {
  const content = (completion as {
    choices?: Array<{ message?: { content?: unknown } | null } | undefined> | undefined;
  } | null | undefined)?.choices?.[0]?.message?.content;
  return String(content ?? "");
}

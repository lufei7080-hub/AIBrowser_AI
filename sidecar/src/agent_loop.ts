/**
 * 自主 Agent 入口（兼容层）
 * 实现已迁移至 bu_agent/（browser-use 契约）。
 * 保留 IPC/HITL 类型与历史折叠工具供 diagnostics 使用。
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";
import type { Page } from "playwright-core";

import {
  runBuAutonomousAgentLoop,
  type AgentConfirmActionPreview,
  type AgentConfirmRequest,
  type AgentConfirmResponse,
  type AgentHandoverRequest,
  type AgentLoopDeps,
  type AgentLoopResult,
} from "./bu_agent/service.js";

export type {
  AgentConfirmActionPreview,
  AgentConfirmRequest,
  AgentConfirmResponse,
  AgentHandoverRequest,
  AgentLoopDeps,
  AgentLoopResult,
};

/** 页面状态标记 — 诊断/折叠共用（兼容旧 system_check） */
export const PAGE_STATE_MARK = "【本轮可交互元素 llm_json】";
/** 历史页面 JSON 折叠占位 */
export const FOLDED_PAGE_STATE = "[旧页面状态已折叠]";

export function extractMessageText(content: ChatCompletionMessageParam["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part && part.type === "text") {
        return String((part as { text?: string }).text ?? "");
      }
      return "";
    })
    .join("\n");
}

/**
 * Token 治理：折叠旧页面观测（兼容旧诊断用例）。
 * 新 BU 循环使用 MessageManager，不再依赖本函数主路径。
 */
export function compressAgentHistory(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  const pageStateIndices: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg?.role === "user" && extractMessageText(msg.content).includes(PAGE_STATE_MARK)) {
      pageStateIndices.push(i);
    }
  }
  const keepLatestPage =
    pageStateIndices.length > 0 ? pageStateIndices[pageStateIndices.length - 1]! : -1;

  return messages.map((msg, index) => {
    if (msg.role === "user" && pageStateIndices.includes(index) && index !== keepLatestPage) {
      const text = extractMessageText(msg.content);
      const goalLine = text.split("\n").find((line) => line.startsWith("【用户目标】")) ?? "";
      const memLine = text.split("\n").find((line) => line.startsWith("【工作记忆】")) ?? "";
      return {
        role: "user" as const,
        content: [goalLine, memLine, FOLDED_PAGE_STATE, "（历史页面 JSON/截图已压缩）"]
          .filter(Boolean)
          .join("\n"),
      };
    }
    return msg;
  });
}

/** 自主 Agent 主入口 — browser-use 对齐实现 */
export async function runAutonomousAgentLoop(
  page: Page,
  deps: AgentLoopDeps,
): Promise<AgentLoopResult> {
  return runBuAutonomousAgentLoop(page, deps);
}

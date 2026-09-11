/**
 * 旧 OpenAI function-calling 工具表已退场（自主 Agent → bu_agent）。
 * 本文件仅保留填表/置信度等旁路仍引用的参数类型。
 */

export interface AgentFillItem {
  id: string;
  value: string;
  need_enter?: boolean;
}

export interface AgentBatchFillField {
  short_id: string;
  value: string;
  need_enter?: boolean;
}

export interface AgentFillAndClickArgs {
  fill_data: AgentFillItem[];
  click_id?: string;
  reason?: string;
  confidence?: number;
}

export interface AgentBatchFillArgs {
  fields: AgentBatchFillField[];
  click_id?: string;
  reason?: string;
  confidence?: number;
  allow_hallucination_for_non_critical?: boolean;
}

export interface AgentNavigateArgs {
  url: string;
  reason?: string;
}

export interface AgentHoverArgs {
  id: string;
  reason?: string;
}

export interface AgentScrollArgs {
  direction: "up" | "down" | "bottom";
  distance?: number;
  reason?: string;
}

export interface AgentClickVisibleTextArgs {
  text: string;
  reason?: string;
}

/** @deprecated 自主 Agent 已改用 bu_agent registry；保留空表避免误引用编译失败 */
export const AGENT_TOOLS: never[] = [];

/** @deprecated 请使用 bu_agent/registry.assertRequiredActions */
export function assertRequiredAgentTools(): string[] {
  return [];
}

export function listAgentToolNames(): string[] {
  return [];
}

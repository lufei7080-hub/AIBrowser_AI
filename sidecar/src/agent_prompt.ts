/**
 * Brain Kernel — 运行时提示词来自 bu_agent/system_prompt_text.ts
 */
import { SYSTEM_PROMPT_THINKING } from "./bu_agent/system_prompt_text.js";

export const AGENT_SYSTEM_PROMPT = SYSTEM_PROMPT_THINKING.replace(/\{max_actions\}/g, "5");

export function buildAgentTurnCoach(_goal: string): string {
  return "";
}

export function buildStuckCoach(_reason: string): string {
  return "";
}

export function buildForceToolCoach(): string {
  return "";
}

export function buildVisionPlaybook(): string {
  return "";
}

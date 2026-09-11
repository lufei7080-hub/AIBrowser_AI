import type { Page } from "playwright-core";
import type { ActionResult, AgentAction, BrowserStateSummary, IndexedElementRef } from "./views.js";
import type { AgentFileSystem } from "./filesystem.js";
import type { JsonLogger } from "../json-logger.js";
import type { SidecarAiSettings } from "../engine.js";

export const TERMINATES_SEQUENCE = new Set([
  "navigate",
  "search",
  "go_back",
  "switch",
  "close",
  "evaluate",
  "done",
  "handover_to_human",
  "solve_captcha",
  "solve_animated_captcha",
  "solve_slider_captcha",
  "solve_math_captcha",
  "solve_point_select_captcha",
  "ask_user",
  "screenshot",
]);

export interface ActionContext {
  page: Page;
  logger: JsonLogger;
  aiSettings: SidecarAiSettings;
  browserState: BrowserStateSummary;
  fileSystem: AgentFileSystem;
  profileId?: string;
  goal: string;
  /** 用户停止 Agent 时 abort；长耗时动作须轮询 */
  signal?: AbortSignal;
  requestConfirm: (args: {
    requestId: string;
    url: string;
    reason: string;
    actions: Array<{ kind: "fill" | "click"; id: string; text: string; value?: string }>;
  }) => Promise<{ approved: boolean; fillOverrides?: Record<string, string> }>;
  askUser: (requestId: string, question: string) => Promise<string>;
  requestHandover: (args: {
    requestId: string;
    reason: string;
    url: string;
  }) => Promise<void>;
  setIncludeScreenshotNext: (v: boolean) => void;
  /** 新标签 / 切标签后切换 Agent 活动页（网关 getter 同步） */
  setActivePage?: (page: Page) => void;
  resolveElement: (index: number) => IndexedElementRef | null;
}

export type ActionHandler = (
  params: Record<string, unknown>,
  ctx: ActionContext,
) => Promise<ActionResult>;

const handlers = new Map<string, ActionHandler>();

export function registerAction(name: string, handler: ActionHandler): void {
  handlers.set(name, handler);
}

export function getActionHandler(name: string): ActionHandler | undefined {
  return handlers.get(name);
}

export function listRegisteredActions(): string[] {
  return [...handlers.keys()].sort();
}

export function assertRequiredActions(): void {
  const required = [
    "navigate",
    "click",
    "input",
    "scroll",
    "wait",
    "done",
    "extract",
    "search_page",
    "find_elements",
    "scrape_page_data",
    "ask_user",
    "handover_to_human",
    "ask_vision_locate",
    "click_viewport",
    "list_skills",
    "recall_skill",
    "detect_page_blockers",
    "solve_captcha",
    "solve_animated_captcha",
    "solve_slider_captcha",
    "solve_math_captcha",
    "solve_point_select_captcha",
  ];
  const missing = required.filter((n) => !handlers.has(n));
  if (missing.length) {
    throw new Error(`BU Agent 缺少必选动作: ${missing.join(", ")}`);
  }
}

export function parseActionList(actions: AgentAction[]): AgentAction[] {
  return actions.map((a) => ({
    name: a.name,
    params: a.params ?? {},
  }));
}

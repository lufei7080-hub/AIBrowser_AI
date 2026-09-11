/**
 * LLM token budget helpers — shared truncation / compact JSON / thought strip.
 */

export type AgentSenseMode = "economy" | "balanced" | "classic";

export const AGENT_LLM_JSON_CAP: Record<AgentSenseMode, number> = {
  economy: 48,
  balanced: 64,
  classic: 80,
};

export const TOOL_RESULT_MAX_CHARS = 800;
export const PLANNER_MAX_FILE_CHARS = 20_000;
export const AUTO_SELECTOR_HTML_DEFAULT = 12_000;
export const AUTO_SELECTOR_HTML_MAX = 20_000;
export const SCRAPE_DEFAULT_MAX_ITEMS = 50;
export const CHAT_FILLABLE_CAP = 40;
export const FILL_MAP_MAX_TOKENS = 2048;
export const SELECTOR_INFER_MAX_TOKENS = 1200;

export function normalizeAgentSenseMode(raw: unknown): AgentSenseMode {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (value === "economy" || value === "省token" || value === "省 token") {
    return "economy";
  }
  if (value === "classic" || value === "经典" || value === "经典视觉") {
    return "classic";
  }
  return "balanced";
}

export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Strip &lt;thought&gt;…&lt;/thought&gt; blocks from assistant text (history compression). */
export function stripThought(text: string): string {
  return text.replace(/<thought>[\s\S]*?<\/thought>/gi, "").trim();
}

export function shouldAutoScreenshot(input: {
  mode: AgentSenseMode;
  round: number;
  pageChanged: boolean;
  forceVision: boolean;
  lastMutating: boolean;
  /** 目标暗示图标/语言球/空间布局（仅作卡死时开眼提示，禁止每轮强制截图） */
  goalSuggestsVision?: boolean;
  /** 控件 JSON 未覆盖目标关键词 */
  controlsMissGoal?: boolean;
  /** 同页连续失败次数 */
  samePageLoopCount?: number;
}): boolean {
  if (input.forceVision) {
    return true;
  }
  if (input.mode === "classic") {
    return true;
  }
  const stuck = (input.samePageLoopCount ?? 0) >= 1;
  // 同页无进展：开眼一次即可（感知图+agent 工具优先；禁止语言类目标每轮烧 vision）
  if (stuck) {
    return true;
  }
  if (input.mode === "economy") {
    return false;
  }
  // balanced：页变且刚做了突变动作时才附带截图；语言球靠【可见感知图】+ click_visible_text
  void input.goalSuggestsVision;
  void input.controlsMissGoal;
  return input.pageChanged && input.lastMutating;
}

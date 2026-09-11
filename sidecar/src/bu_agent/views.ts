/**
 * browser-use 对齐的 Agent 视图类型（天枢台 TypeScript 移植）
 */
export type VisionMode = boolean | "auto";

export interface AgentSettings {
  useVision: VisionMode;
  maxFailures: number;
  maxActionsPerStep: number;
  useThinking: boolean;
  flashMode: boolean;
  useJudge: boolean;
  maxHistoryItems: number | null;
  enablePlanning: boolean;
  planningReplanOnStall: number;
  planningExplorationLimit: number;
  loopDetectionEnabled: boolean;
  loopDetectionWindow: number;
  maxClickableElementsLength: number;
  stepTimeoutMs: number;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  useVision: "auto",
  maxFailures: 5,
  maxActionsPerStep: 5,
  useThinking: true,
  flashMode: false,
  useJudge: true,
  maxHistoryItems: null,
  enablePlanning: true,
  planningReplanOnStall: 3,
  planningExplorationLimit: 5,
  loopDetectionEnabled: true,
  loopDetectionWindow: 20,
  maxClickableElementsLength: 40000,
  stepTimeoutMs: 180_000,
};

export type PlanItemStatus = "pending" | "current" | "done" | "skipped";

export interface PlanItem {
  text: string;
  status: PlanItemStatus;
}

export interface AgentAction {
  name: string;
  params: Record<string, unknown>;
}

export interface AgentOutput {
  thinking?: string;
  evaluation_previous_goal?: string;
  memory?: string;
  next_goal?: string;
  current_plan_item?: number | null;
  plan_update?: string[] | null;
  action: AgentAction[];
}

export interface ActionResult {
  isDone?: boolean;
  success?: boolean | null;
  error?: string | null;
  extractedContent?: string | null;
  longTermMemory?: string | null;
  includeExtractedContentOnlyOnce?: boolean;
  metadata?: Record<string, unknown>;
}

export interface HistoryItem {
  stepNumber: number;
  evaluationPreviousGoal?: string;
  memory?: string;
  nextGoal?: string;
  actionResults: ActionResult[];
  actions: AgentAction[];
}

export interface JudgementResult {
  verdict: boolean;
  reasoning: string;
  failureReason?: string | null;
  impossibleTask?: boolean;
  reachedCaptcha?: boolean;
}

export interface PageFingerprint {
  url: string;
  elementCount: number;
  textHash: string;
}

export interface BrowserStateSummary {
  url: string;
  title: string;
  tabs: Array<{ id: string; url: string; title: string }>;
  interactiveTree: string;
  elementCount: number;
  selectorMap: Map<number, IndexedElementRef>;
  /** 兼容单图；优先用 screenshotList */
  screenshotBase64?: string | null;
  /** 多帧视口截图（data-url 或 raw base64），detail=low */
  screenshotList?: string[];
  pageInfo?: { pagesAbove: number; pagesBelow: number };
  /** 观察软错误占位 */
  observationError?: string | null;
  /**
   * 确定性页面阅读摘要（SERP/正文脚本抽取，零二次 LLM）。
   * 用于「分析/总结/自然语言理解」验收，避免只靠交互索引瞎猜。
   */
  pageDigest?: string | null;
}

export interface IndexedElementRef {
  index: number;
  shortId: string;
  selector: string;
  xpath: string;
  tagName: string;
  inputType: string | null;
  text: string;
  role?: string;
  placeholder?: string;
  name?: string;
  rect?: { x: number; y: number; w: number; h: number } | null;
}

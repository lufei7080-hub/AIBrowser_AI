import { createHash } from "node:crypto";
import type {
  ActionResult,
  AgentAction,
  AgentOutput,
  AgentSettings,
  HistoryItem,
  PageFingerprint,
  PlanItem,
} from "./views.js";

export class MessageManager {
  history: HistoryItem[] = [];
  compactedMemory: string | null = null;
  plan: PlanItem[] = [];
  readStateBuffer: string | null = null;
  private recentActionHashes: string[] = [];
  private consecutiveStagnantPages = 0;
  private lastFingerprint: PageFingerprint | null = null;
  private consecutiveFailures = 0;
  private stepsWithoutPlan = 0;

  constructor(private readonly settings: AgentSettings) {}

  get consecutiveFailureCount(): number {
    return this.consecutiveFailures;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  appendStep(output: AgentOutput, results: ActionResult[]): void {
    this.history.push({
      stepNumber: this.history.length + 1,
      evaluationPreviousGoal: output.evaluation_previous_goal,
      memory: output.memory,
      nextGoal: output.next_goal,
      actionResults: results,
      actions: output.action,
    });
    if (this.settings.maxHistoryItems && this.history.length > this.settings.maxHistoryItems) {
      this.history = this.history.slice(-this.settings.maxHistoryItems);
    }
    this.collectReadState(results);
    this.applyPlanUpdate(output);
  }

  private collectReadState(results: ActionResult[]): void {
    const chunks: string[] = [];
    for (const r of results) {
      if (r.includeExtractedContentOnlyOnce && r.extractedContent) {
        chunks.push(r.extractedContent);
      }
    }
    this.readStateBuffer = chunks.length ? chunks.join("\n\n") : null;
  }

  consumeReadState(): string | null {
    const v = this.readStateBuffer;
    this.readStateBuffer = null;
    return v;
  }

  applyPlanUpdate(output: AgentOutput): void {
    if (!this.settings.enablePlanning || this.settings.flashMode) return;
    if (Array.isArray(output.plan_update) && output.plan_update.length) {
      this.plan = output.plan_update.map((text, i) => ({
        text,
        status:
          typeof output.current_plan_item === "number" && output.current_plan_item === i
            ? ("current" as const)
            : ("pending" as const),
      }));
      this.stepsWithoutPlan = 0;
      return;
    }
    if (typeof output.current_plan_item === "number" && this.plan.length) {
      const idx = output.current_plan_item;
      this.plan = this.plan.map((item, i) => {
        if (i < idx) return { ...item, status: item.status === "skipped" ? item.status : "done" };
        if (i === idx) return { ...item, status: "current" };
        return { ...item, status: item.status === "current" ? "pending" : item.status };
      });
    }
    if (!this.plan.length) this.stepsWithoutPlan += 1;
  }

  /** Phase A：用任务分析结果播种计划 */
  seedPlan(steps: string[], currentIndex = 0): void {
    if (!this.settings.enablePlanning || this.settings.flashMode) return;
    const cleaned = steps.map((s) => String(s ?? "").trim()).filter(Boolean);
    if (!cleaned.length) return;
    const idx = Math.max(0, Math.min(currentIndex, cleaned.length - 1));
    this.plan = cleaned.map((text, i) => ({
      text,
      status: i < idx ? ("done" as const) : i === idx ? ("current" as const) : ("pending" as const),
    }));
    this.stepsWithoutPlan = 0;
  }

  currentPlanText(): string | null {
    const cur = this.plan.find((p) => p.status === "current");
    return cur?.text ?? this.plan[0]?.text ?? null;
  }

  recordActions(actions: AgentAction[]): void {
    for (const a of actions) {
      const h = hashAction(a.name, a.params);
      this.recentActionHashes.push(h);
      const win = this.settings.loopDetectionWindow;
      if (this.recentActionHashes.length > win) {
        this.recentActionHashes = this.recentActionHashes.slice(-win);
      }
    }
  }

  recordPage(url: string, domText: string, elementCount: number): void {
    const textHash = createHash("sha256").update(domText).digest("hex").slice(0, 16);
    const fp: PageFingerprint = { url, elementCount, textHash };
    if (
      this.lastFingerprint &&
      this.lastFingerprint.url === fp.url &&
      this.lastFingerprint.textHash === fp.textHash &&
      this.lastFingerprint.elementCount === fp.elementCount
    ) {
      this.consecutiveStagnantPages += 1;
    } else {
      this.consecutiveStagnantPages = 0;
    }
    this.lastFingerprint = fp;
  }

  buildNudges(stepNumber: number, maxSteps: number): string[] {
    const nudges: string[] = [];
    if (stepNumber >= Math.floor(maxSteps * 0.75)) {
      nudges.push(
        "步骤预算已用约 75%。请优先交付高价值部分结果；若无法完整完成，准备在剩余步骤内 done(success=false) 并汇总已得信息。",
      );
    }
    if (!this.settings.loopDetectionEnabled) return nudges;

    const counts = new Map<string, number>();
    for (const h of this.recentActionHashes) {
      counts.set(h, (counts.get(h) ?? 0) + 1);
    }
    let maxRep = 0;
    for (const c of counts.values()) maxRep = Math.max(maxRep, c);
    if (maxRep >= 3) {
      nudges.push(
        `<sys>检测到相似动作在近期窗口内重复 ${maxRep} 次。请更换策略，勿机械重试同一操作。</sys>`,
      );
    }
    if (this.consecutiveStagnantPages >= 3) {
      nudges.push(
        `<sys>页面指纹连续 ${this.consecutiveStagnantPages} 步未变化。请尝试滚动、换入口、search_page，或 ask_user/handover。</sys>`,
      );
    }
    if (
      this.settings.enablePlanning &&
      this.settings.planningExplorationLimit > 0 &&
      this.stepsWithoutPlan >= this.settings.planningExplorationLimit &&
      !this.plan.length
    ) {
      nudges.push("探索已足够，请输出 plan_update 建立计划后再推进。");
    }
    if (
      this.settings.planningReplanOnStall > 0 &&
      this.consecutiveFailures >= this.settings.planningReplanOnStall
    ) {
      nudges.push("连续失败较多，请修订 plan_update 并换路径。");
    }
    return nudges;
  }
}

function hashAction(name: string, params: Record<string, unknown>): string {
  const normalized = JSON.stringify({ name, params });
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

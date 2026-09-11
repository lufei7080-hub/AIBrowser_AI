import { normalizeDomain } from "./domain";
import {
  agentConfirmCohortKey,
  compareProfileIdAsc,
  normalizeAgentGoalKey,
  type AgentRouteMode,
} from "./agentGoalRouter";
import type { AgentConfirmActionRow } from "../components/AgentConfirmModal";

export type AgentHumanKind = "confirm" | "handover" | "ask";

export interface PendingAgentHuman {
  profileId: string;
  kind: AgentHumanKind;
  requestId: string;
  url: string;
  domain: string;
  goalKey: string;
  reason?: string;
  question?: string;
  actions?: AgentConfirmActionRow[];
  fillValues?: Record<string, string>;
}

export function buildPendingHuman(input: {
  profileId: string;
  kind: AgentHumanKind;
  requestId: string;
  url?: string;
  goalKey: string;
  reason?: string;
  question?: string;
  actions?: AgentConfirmActionRow[];
  fillValues?: Record<string, string>;
}): PendingAgentHuman {
  const url = input.url?.trim() ?? "";
  return {
    profileId: input.profileId,
    kind: input.kind,
    requestId: input.requestId,
    url,
    domain: normalizeDomain(url) || url.trim().toLowerCase(),
    goalKey: normalizeAgentGoalKey(input.goalKey),
    reason: input.reason,
    question: input.question,
    actions: input.actions,
    fillValues: input.fillValues,
  };
}

export function cohortKeyOf(item: PendingAgentHuman): string {
  return agentConfirmCohortKey(item.kind, item.goalKey, item.domain || item.url);
}

/** Pull the next cohort (same kind+goal+domain) sorted by profile id ascending. */
export function takeNextHumanCohort(
  pending: PendingAgentHuman[],
): { cohort: PendingAgentHuman[]; rest: PendingAgentHuman[] } {
  if (pending.length === 0) {
    return { cohort: [], rest: [] };
  }
  const sorted = [...pending].sort((a, b) => compareProfileIdAsc(a.profileId, b.profileId));
  const first = sorted[0];
  const key = cohortKeyOf(first);
  const cohort = sorted.filter((item) => cohortKeyOf(item) === key);
  const cohortIds = new Set(cohort.map((item) => `${item.kind}:${item.profileId}:${item.requestId}`));
  const rest = pending.filter(
    (item) => !cohortIds.has(`${item.kind}:${item.profileId}:${item.requestId}`),
  );
  return { cohort, rest };
}

export function mergeIntoActiveCohort(
  active: PendingAgentHuman[],
  incoming: PendingAgentHuman,
): PendingAgentHuman[] | null {
  if (active.length === 0) {
    return null;
  }
  if (cohortKeyOf(active[0]) !== cohortKeyOf(incoming)) {
    return null;
  }
  if (
    active.some(
      (item) => item.profileId === incoming.profileId && item.requestId === incoming.requestId,
    )
  ) {
    return active;
  }
  return [...active, incoming].sort((a, b) => compareProfileIdAsc(a.profileId, b.profileId));
}

/** Merge fill actions from two confirm payloads (same profile sequential → one form). */
export function mergeConfirmActions(
  existing: AgentConfirmActionRow[] | undefined,
  incoming: AgentConfirmActionRow[] | undefined,
): AgentConfirmActionRow[] {
  const map = new Map<string, AgentConfirmActionRow>();
  for (const row of existing ?? []) {
    map.set(`${row.kind}:${row.id}`, row);
  }
  for (const row of incoming ?? []) {
    map.set(`${row.kind}:${row.id}`, row);
  }
  return Array.from(map.values());
}

export function mergeFillValues(
  existing: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined,
): Record<string, string> {
  return { ...(existing ?? {}), ...(incoming ?? {}) };
}

/** Prefer showing one batch title when many fill fields. */
export function confirmModalTitle(actions: AgentConfirmActionRow[] | undefined): string {
  const fills = (actions ?? []).filter((a) => a.kind === "fill");
  if (fills.length >= 2) {
    return `人工确认 · 批量填表（${fills.length} 个字段）`;
  }
  return "人工确认 · Agent 拟执行动作";
}

export function formatAgentRouteBadge(
  mode: AgentRouteMode | "idle",
  batchIds: string[],
  focusId: string | null,
): { label: string; title: string } {
  if (mode === "idle" || batchIds.length === 0) {
    return {
      label: focusId ? `当前控制 #${focusId}` : "未绑定环境",
      title: focusId
        ? "智能填表 / 单开回放作用于焦点环境；Agent 未点名时操作「已勾选且已打开」的环境（仅限制 AI 并行数，打开浏览器不限）"
        : "请在左侧勾选并启动环境",
    };
  }
  if (mode === "broadcast") {
    return {
      label: `广播 ${batchIds.length} 个`,
      title: `未点名：已选且已打开的环境并行同一任务（#${batchIds.join("、#")}）`,
    };
  }
  return {
    label: `分派 ${batchIds.length} 个`,
    title: `点名分派：#${batchIds.join("、#")}`,
  };
}

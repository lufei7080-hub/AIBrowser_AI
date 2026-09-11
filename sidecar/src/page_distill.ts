/**
 * Page control distillation: short-ID map, prioritize, structure hash, diffs.
 * Deterministic Node-side preprocessing — LLM never sees long selectors/xpaths.
 *
 * 原则：脚本优先给 Agent 的短 ID 树必须「表单字段 > 主操作按钮 > 链接噪音」，
 * 并按目标词/视口加权，避免 dense 页把输入框截断掉。
 */

import { createHash } from "node:crypto";

import type { AgentElementRef, AgentExtractResult, AgentLlmElement } from "./interactive_elements.js";
import { AGENT_LLM_JSON_CAP, type AgentSenseMode } from "./llm_budget.js";

const TYPE_PRIORITY: Record<string, number> = {
  searchbox: 0,
  textbox: 0,
  combobox: 1,
  checkbox: 2,
  radio: 2,
  button: 3,
  link: 4,
  tab: 5,
  menuitem: 5,
  iframe: 6,
  other: 9,
};

const FILLABLE_TYPES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "textarea",
  "select",
]);

const NOISE_LINK_RE =
  /home|首页|主页|about|关于|privacy|隐私|cookie|terms|协议|copyright|©|footer|下载.?app|帮助中心/i;

/** 短标签 / 图标控件：不应当页脚噪音挤掉 */
const CHROME_KEEP_RE =
  /^(en|eng|english|he|zh|cn|中文|繁|简|language|support|客服|icon[:.].+|headset)$/i;

export interface DistillOptions {
  /** 用户目标：命中文案/placeholder/name 的控件优先保留 */
  goal?: string;
  /** 视口尺寸；有 rect 时偏好可见控件 */
  viewport?: { width: number; height: number } | null;
}

export interface DistillResult {
  llm_json: AgentLlmElement[];
  element_map: Map<string, AgentElementRef>;
  structureHash: string;
  truncated: number;
  host: string;
}

/** 兼容历史 input:text / textarea / select → 蒸馏友好类型 */
export function normalizeDistillType(type: string): string {
  const t = String(type ?? "").toLowerCase().trim();
  if (!t) {
    return "other";
  }
  if (TYPE_PRIORITY[t] !== undefined) {
    return t;
  }
  if (t === "textarea" || t === "input:text" || t === "input:email" || t === "input:password" || t === "input:tel" || t === "input:number" || t === "input:url") {
    return "textbox";
  }
  if (t === "input:search" || t === "search") {
    return "searchbox";
  }
  if (t === "select" || t === "input:select-one") {
    return "combobox";
  }
  if (t.startsWith("input:")) {
    return "textbox";
  }
  return t;
}

function typeRank(type: string): number {
  return TYPE_PRIORITY[normalizeDistillType(type)] ?? TYPE_PRIORITY.other;
}

function isFillableType(type: string): boolean {
  const n = normalizeDistillType(type);
  return FILLABLE_TYPES.has(n) || n.startsWith("input:");
}

function controlBlob(el: AgentLlmElement): string {
  return `${el.text ?? ""} ${el.name ?? ""} ${el.placeholder ?? ""} ${el.type ?? ""}`.toLowerCase();
}

function extractGoalTokens(goal: string): string[] {
  const raw = String(goal ?? "");
  if (!raw.trim()) {
    return [];
  }
  const tokens = new Set<string>();
  for (const m of raw.matchAll(
    /[\u4e00-\u9fff]{2,8}|[A-Za-z]{3,16}|עברית|עִבְרִית|Hebrew|EN|HE|Login|Register|password|邮箱|手机|验证码/gi,
  )) {
    const t = String(m[0] ?? "").trim().toLowerCase();
    if (t.length >= 2) {
      tokens.add(t);
    }
  }
  return Array.from(tokens).slice(0, 24);
}

function goalHitScore(el: AgentLlmElement, tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  const blob = controlBlob(el);
  let hits = 0;
  for (const token of tokens) {
    if (blob.includes(token.toLowerCase())) {
      hits += 1;
    }
  }
  return hits;
}

function viewportScore(
  ref: AgentElementRef | undefined,
  viewport: { width: number; height: number } | null | undefined,
): number {
  const rect = ref?.rect;
  if (!rect || !viewport || viewport.width < 1 || viewport.height < 1) {
    return 0;
  }
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  if (cx < 0 || cy < 0 || cx > viewport.width || cy > viewport.height) {
    return 2; // 视口外略降权（仍可能是表单，不丢）
  }
  if (cy < viewport.height * 0.85 && cx < viewport.width * 0.98) {
    return -1; // 视口内加权
  }
  return 0;
}

function noisePenalty(el: AgentLlmElement): number {
  const n = normalizeDistillType(el.type);
  if (n === "link" || n === "button") {
    const text = (el.text ?? "").trim();
    if (CHROME_KEEP_RE.test(text)) {
      return 0;
    }
    if (NOISE_LINK_RE.test(text) && text.length > 10) {
      return 4;
    }
    // 巨型链接文案通常是导航块
    if (n === "link" && text.length > 40) {
      return 2;
    }
  }
  return 0;
}

/** 语言 / 客服 / 注册相关控件加权 */
function chromeBoost(el: AgentLlmElement, goal: string): number {
  const blob = controlBlob(el);
  const g = String(goal ?? "");
  let boost = 0;
  if (/language|support|icon:|\ben\b|中文|客服/i.test(blob)) {
    boost -= 6;
  }
  if (/注册|register|中文|语言|english|客服|support/i.test(g) && /register|注册|language|support|en|中文|icon:/i.test(blob)) {
    boost -= 10;
  }
  return boost;
}

/** 综合排序：类型 → 目标命中 → 可填 → 视口 → 噪音 → id */
export function prioritizeControls(
  list: AgentLlmElement[],
  options?: DistillOptions & { element_map?: Map<string, AgentElementRef> },
): AgentLlmElement[] {
  const tokens = extractGoalTokens(options?.goal ?? "");
  const viewport = options?.viewport ?? null;
  const map = options?.element_map;
  const goal = options?.goal ?? "";

  return [...list]
    .map((el, index) => {
      const ref = map?.get(el.id);
      const rank =
        typeRank(el.type) * 10 +
        (isFillableType(el.type) ? -8 : 0) +
        goalHitScore(el, tokens) * -12 +
        viewportScore(ref, viewport) +
        noisePenalty(el) +
        chromeBoost(el, goal) +
        index * 0.001;
      return { el, rank };
    })
    .sort((a, b) => a.rank - b.rank || a.el.id.localeCompare(b.el.id, undefined, { numeric: true }))
    .map((row) => row.el);
}

/** Stable skeleton fingerprint: types + normalized texts of form-like controls */
export function computeStructureHash(controls: AgentLlmElement[]): string {
  const skeleton = prioritizeControls(controls)
    .filter((el) => {
      const n = normalizeDistillType(el.type);
      return ["textbox", "searchbox", "combobox", "checkbox", "radio", "button"].includes(n);
    })
    .slice(0, 40)
    .map((el) => {
      const n = normalizeDistillType(el.type);
      const text =
        n === "button" || n === "checkbox" || n === "radio"
          ? (el.text ?? "").slice(0, 24).toLowerCase()
          : (el.name || el.placeholder || el.text || n).slice(0, 24).toLowerCase();
      return `${n}:${text}`;
    })
    .join("|");
  return createHash("sha1").update(skeleton || "empty").digest("hex").slice(0, 16);
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Remap extract to short numeric ids ("1","2",…) and cap by sense mode.
 * Local element_map keeps real selector/xpath for execution.
 */
export function distillForLlm(
  extract: AgentExtractResult,
  mode: AgentSenseMode,
  options?: DistillOptions,
): DistillResult {
  const cap = AGENT_LLM_JSON_CAP[mode];
  // 归一化类型后再排序，保证 input:text 等进入 textbox 优先级
  const normalized = extract.llm_json.map((el) => ({
    ...el,
    type: normalizeDistillType(el.type),
  }));
  const ranked = prioritizeControls(normalized, {
    goal: options?.goal,
    viewport: options?.viewport,
    element_map: extract.element_map,
  });

  // 硬保底：至少保留一批可填字段（避免全被链接挤掉）
  const fillables = ranked.filter((el) => isFillableType(el.type));
  const others = ranked.filter((el) => !isFillableType(el.type));
  const fillKeep = Math.min(fillables.length, Math.max(12, Math.floor(cap * 0.45)));
  const merged = [...fillables.slice(0, fillKeep), ...others];
  // 再按原 rank 去重保序
  const seen = new Set<string>();
  const ordered: AgentLlmElement[] = [];
  for (const el of ranked) {
    if (merged.some((m) => m.id === el.id) && !seen.has(el.id)) {
      seen.add(el.id);
      ordered.push(el);
    }
  }
  for (const el of merged) {
    if (!seen.has(el.id)) {
      seen.add(el.id);
      ordered.push(el);
    }
  }

  const truncated = Math.max(0, ordered.length - cap);
  const kept = ordered.slice(0, cap);

  const llm_json: AgentLlmElement[] = [];
  const element_map = new Map<string, AgentElementRef>();

  kept.forEach((item, index) => {
    const shortId = String(index + 1);
    const ref = extract.element_map.get(item.id);
    const slim: AgentLlmElement = {
      id: shortId,
      type: normalizeDistillType(item.type),
      text: (item.text ?? "").slice(0, 60),
    };
    if (item.placeholder) {
      slim.placeholder = item.placeholder.slice(0, 40);
    }
    // 可填控件保留 name，方便 Agent 对齐「手机号/密码」等字段
    if (item.name && isFillableType(item.type)) {
      slim.name = item.name.slice(0, 40);
    }
    // 短语言码按钮：保留 role 无必要；text 已够
    llm_json.push(slim);
    if (ref) {
      element_map.set(shortId, {
        ...ref,
        id: shortId,
        rect: ref.rect ?? null,
      });
    }
  });

  return {
    llm_json,
    element_map,
    structureHash: computeStructureHash(normalized),
    truncated,
    host: hostOfUrl(extract.url),
  };
}

export function applyDistillToExtract(
  extract: AgentExtractResult,
  mode: AgentSenseMode,
  options?: DistillOptions,
): AgentExtractResult & { structureHash: string; truncated: number } {
  const distilled = distillForLlm(extract, mode, options);
  return {
    ...extract,
    llm_json: distilled.llm_json,
    element_map: distilled.element_map,
    structureHash: distilled.structureHash,
    truncated: distilled.truncated,
  };
}

/** Compact text diff for subsequent rounds (token saver). */
export function formatControlDiff(
  prev: AgentLlmElement[] | null,
  next: AgentLlmElement[],
): string | null {
  if (!prev || prev.length === 0) {
    return null;
  }
  const prevSkeleton = new Map(prev.map((el) => [`${el.type}|${el.text}`, el.id]));
  const nextSkeleton = new Map(next.map((el) => [`${el.type}|${el.text}`, el.id]));
  const nextById = new Map(next.map((el) => [el.id, el]));
  const appeared: string[] = [];
  const gone: string[] = [];
  for (const [key, id] of nextSkeleton) {
    if (!prevSkeleton.has(key)) {
      const el = nextById.get(id);
      if (el) {
        appeared.push(`${el.id}:${el.type}:${(el.text ?? "").slice(0, 24)}`);
      }
    }
  }
  for (const [key, id] of prevSkeleton) {
    if (!nextSkeleton.has(key)) {
      gone.push(String(id));
    }
  }
  if (appeared.length === 0 && gone.length === 0) {
    return "【差分】控件骨架无显著变化（请结合最新全量 JSON）";
  }
  const parts = ["【差分】"];
  if (appeared.length) {
    parts.push(`+${appeared.slice(0, 12).join(", ")}`);
  }
  if (gone.length) {
    parts.push(`-${gone.slice(0, 12).join(", ")}`);
  }
  return parts.join(" ");
}

export function cacheKeyHostStructure(host: string, structureHash: string): string {
  return `${host || "_"}::${structureHash}`;
}

/** Accept "1" / "e1" / "E12" → map key "1" / "12". */
export function normalizeAgentElementId(raw: string): string {
  const id = String(raw ?? "").trim();
  if (!id) {
    return "";
  }
  const matched = /^e(\d+)$/i.exec(id);
  if (matched) {
    return matched[1]!;
  }
  return id;
}

/**
 * 跨任务同站控件记忆 — Domain 级 LRU
 * 原则：只存脱敏 selector / 意图描述 / 可选视口坐标；绝不存填表值或密码。
 * Token 策略：开局命中 → 注入短 id 高优提示，减少探索轮次与视觉调用。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "playwright-core";

import type { AgentElementRef, AgentExtractResult } from "./interactive_elements.js";
import type { JsonLogger } from "./json-logger.js";
import { isTempIdSelector } from "./trajectory.js";

export const CONTROL_MEMORY_MARK = "【同站控件记忆】";
export const PER_DOMAIN_CAP = 50;
export const GLOBAL_DOMAIN_CAP = 80;

export type ControlMemoryKind = "fill" | "click" | "vision";

export interface ControlMemoryEntry {
  domain: string;
  /** 自然语言意图，如「搜索输入框」「登录按钮」「语言球 EN」 */
  intent: string;
  /** 归一化查找键 */
  intentKey: string;
  kind: ControlMemoryKind;
  /** 脱敏后的稳定 selector（禁止临时短 id） */
  selector: string;
  /** 可见文案提示（用于对齐本轮短 id） */
  textHint: string;
  xPercent?: number;
  yPercent?: number;
  hitCount: number;
  updatedAt: string;
}

export interface ControlMemoryMatch {
  entry: ControlMemoryEntry;
  shortId: string | null;
  selectorAlive: boolean;
  score: number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_ROOT = path.resolve(__dirname, "..");
export const CONTROL_MEMORY_DIR = path.join(SIDECAR_ROOT, "agent_exports", "control_memory");
const CONTROL_MEMORY_FILE = path.join(CONTROL_MEMORY_DIR, "lru.json");

/** domain → intentKey → entry；Map 插入序即 LRU（越新越靠后） */
const domainBuckets = new Map<string, Map<string, ControlMemoryEntry>>();

/** 清空进程内 LRU（每次 Agent 开局必须先调用，防止上轮残留） */
export function resetControlMemoryRuntime(): void {
  domainBuckets.clear();
}

/** 清空磁盘备份，避免幽灵 JSON 复活已删记忆 */
export async function wipeControlMemoryDisk(): Promise<void> {
  try {
    await mkdir(CONTROL_MEMORY_DIR, { recursive: true });
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      entries: [] as ControlMemoryEntry[],
    };
    await writeFile(CONTROL_MEMORY_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

/**
 * 以 SQLite 种子为唯一真相源开局灌入。
 * - seed 非空：只灌种子，并回写磁盘（覆盖幽灵 JSON）
 * - seed 为空：视为用户已清空，进程 + 磁盘一并清空（禁止再从 lru.json 复活）
 */
export async function bootstrapControlMemoryFromSeed(
  seed: ControlMemoryEntry[],
): Promise<{ fromSeed: number; wipedDisk: boolean }> {
  resetControlMemoryRuntime();
  const rows = Array.isArray(seed) ? seed : [];
  if (rows.length === 0) {
    await wipeControlMemoryDisk();
    return { fromSeed: 0, wipedDisk: true };
  }
  const fromSeed = hydrateControlMemory(rows);
  try {
    await persistControlMemoryToDisk();
  } catch {
    /* ignore */
  }
  return { fromSeed, wipedDisk: false };
}

export function normalizeDomain(urlOrHost: string): string {
  const raw = String(urlOrHost ?? "").trim();
  if (!raw) {
    return "";
  }
  try {
    const host = raw.includes("://") ? new URL(raw).hostname : raw;
    return host.replace(/^www\./i, "").toLowerCase();
  } catch {
    return raw.replace(/^www\./i, "").toLowerCase();
  }
}

export function normalizeIntentKey(intent: string): string {
  return String(intent ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 80);
}

/** 脱敏：去掉临时 id、过长路径、疑似密钥片段 */
export function sanitizeSelector(raw: string): string {
  const selector = String(raw ?? "").trim();
  if (!selector || isTempIdSelector(selector)) {
    return "";
  }
  if (/password|passwd|token|csrf|authorization|api[_-]?key/i.test(selector)) {
    return "";
  }
  return selector.slice(0, 240);
}

export function sanitizeIntent(raw: string): string {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .replace(/密码[「"'：:\s]*[^\s「」"']+/gi, "密码（已脱敏）")
    .replace(/password\s*[:=]\s*\S+/gi, "password=(redacted)")
    .trim()
    .slice(0, 80);
}

function touchDomainLru(domain: string): void {
  const bucket = domainBuckets.get(domain);
  if (!bucket) {
    return;
  }
  domainBuckets.delete(domain);
  domainBuckets.set(domain, bucket);
  while (domainBuckets.size > GLOBAL_DOMAIN_CAP) {
    const oldest = domainBuckets.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    domainBuckets.delete(oldest);
  }
}

function ensureBucket(domain: string): Map<string, ControlMemoryEntry> {
  let bucket = domainBuckets.get(domain);
  if (!bucket) {
    bucket = new Map();
    domainBuckets.set(domain, bucket);
  } else {
    touchDomainLru(domain);
  }
  return bucket;
}

function evictDomainIfNeeded(bucket: Map<string, ControlMemoryEntry>): void {
  while (bucket.size > PER_DOMAIN_CAP) {
    const oldest = bucket.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    bucket.delete(oldest);
  }
}

export function rememberControl(input: {
  url: string;
  intent: string;
  kind: ControlMemoryKind;
  selector?: string;
  textHint?: string;
  xPercent?: number;
  yPercent?: number;
}): ControlMemoryEntry | null {
  const domain = normalizeDomain(input.url);
  const intent = sanitizeIntent(input.intent);
  const intentKey = normalizeIntentKey(intent);
  const selector = sanitizeSelector(input.selector ?? "");
  if (!domain || !intentKey) {
    return null;
  }
  if (!selector && (input.xPercent == null || input.yPercent == null)) {
    return null;
  }

  const bucket = ensureBucket(domain);
  const prev = bucket.get(intentKey);
  const entry: ControlMemoryEntry = {
    domain,
    intent,
    intentKey,
    kind: input.kind,
    selector: selector || prev?.selector || "",
    textHint: String(input.textHint ?? prev?.textHint ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 48),
    xPercent:
      typeof input.xPercent === "number" && Number.isFinite(input.xPercent)
        ? Math.min(100, Math.max(0, input.xPercent))
        : prev?.xPercent,
    yPercent:
      typeof input.yPercent === "number" && Number.isFinite(input.yPercent)
        ? Math.min(100, Math.max(0, input.yPercent))
        : prev?.yPercent,
    hitCount: (prev?.hitCount ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };

  if (bucket.has(intentKey)) {
    bucket.delete(intentKey);
  }
  bucket.set(intentKey, entry);
  evictDomainIfNeeded(bucket);
  return entry;
}

export function listDomainMemory(domainOrUrl: string): ControlMemoryEntry[] {
  const domain = normalizeDomain(domainOrUrl);
  const bucket = domainBuckets.get(domain);
  if (!bucket) {
    return [];
  }
  // 新→旧
  return [...bucket.values()].reverse();
}

/** 磁盘旧记忆：把「搜索李白/张学友」类意图塌缩为控件类型，避免跨任务串号 */
export function canonicalizeLegacySearchIntent(
  intent: string,
  kind: ControlMemoryKind,
): string {
  const raw = String(intent ?? "");
  if (!/搜索|search|百度一下|google|bing|查找/i.test(raw)) {
    return sanitizeIntent(raw);
  }
  // 含具体查询实体或「输入…并点击」叙事 → 一律泛化
  if (
    /输入[「"']?.+[」"']?|并点击|提交搜索|搜索框/i.test(raw) ||
    extractSalientTokens(raw).length > 0
  ) {
    return kind === "fill" ? "搜索输入框" : "搜索提交按钮";
  }
  return sanitizeIntent(raw);
}

export function hydrateControlMemory(entries: ControlMemoryEntry[]): number {
  let loaded = 0;
  for (const raw of entries) {
    const domain = normalizeDomain(raw.domain);
    const kind: ControlMemoryKind =
      raw.kind === "fill" || raw.kind === "click" || raw.kind === "vision"
        ? raw.kind
        : sanitizeSelector(raw.selector)
          ? "click"
          : "vision";
    const intent = canonicalizeLegacySearchIntent(raw.intent, kind);
    const intentKey = normalizeIntentKey(intent);
    const selector = sanitizeSelector(raw.selector);
    if (!domain || !intentKey) {
      continue;
    }
    if (!selector && (raw.xPercent == null || raw.yPercent == null)) {
      continue;
    }
    const bucket = ensureBucket(domain);
    const entry: ControlMemoryEntry = {
      domain,
      intent,
      intentKey,
      kind,
      selector,
      textHint: String(raw.textHint ?? "").slice(0, 48),
      xPercent: raw.xPercent,
      yPercent: raw.yPercent,
      hitCount: Math.max(1, Number(raw.hitCount) || 1),
      updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
    };
    // 同 intentKey 合并 hitCount（多条「李白/杨幂」会塌成同一「搜索提交按钮」）
    const prev = bucket.get(intentKey);
    if (prev) {
      entry.hitCount = Math.max(entry.hitCount, prev.hitCount) + Math.min(prev.hitCount, 3);
      if (!entry.selector && prev.selector) {
        entry.selector = prev.selector;
      }
      if (!entry.textHint && prev.textHint) {
        entry.textHint = prev.textHint;
      }
      bucket.delete(intentKey);
    }
    bucket.set(intentKey, entry);
    evictDomainIfNeeded(bucket);
    loaded += 1;
  }
  return loaded;
}

export function exportAllControlMemory(): ControlMemoryEntry[] {
  const out: ControlMemoryEntry[] = [];
  for (const bucket of domainBuckets.values()) {
    for (const entry of bucket.values()) {
      out.push(entry);
    }
  }
  return out;
}

export async function persistControlMemoryToDisk(): Promise<string> {
  await mkdir(CONTROL_MEMORY_DIR, { recursive: true });
  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    entries: exportAllControlMemory(),
  };
  await writeFile(CONTROL_MEMORY_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return CONTROL_MEMORY_FILE;
}

export async function loadControlMemoryFromDisk(): Promise<number> {
  try {
    const raw = await readFile(CONTROL_MEMORY_FILE, "utf8");
    const parsed = JSON.parse(raw) as { entries?: ControlMemoryEntry[] };
    if (!Array.isArray(parsed.entries)) {
      return 0;
    }
    return hydrateControlMemory(parsed.entries);
  } catch {
    return 0;
  }
}

/** 从 goal / reason / 控件文案推导可记忆意图 */
export function deriveControlIntent(input: {
  goal: string;
  reason?: string;
  kind: ControlMemoryKind;
  label?: string;
}): string {
  const blob = `${input.reason ?? ""} ${input.goal ?? ""} ${input.label ?? ""}`;
  // 搜索类一律泛化：禁止把「李白/张学友」等具体查询词写入同站记忆（防跨任务串号）
  if (/搜索|search|百度一下|google|bing|查找/i.test(blob)) {
    if (input.kind === "fill") {
      return "搜索输入框";
    }
    if (input.kind === "click") {
      return "搜索提交按钮";
    }
  }

  const reason = sanitizeIntent(input.reason ?? "");
  if (reason && !/输入[「"'].+[」"']|搜索.{0,12}并点击/i.test(reason)) {
    return reason;
  }
  const label = sanitizeIntent(input.label ?? "");
  if (label) {
    return input.kind === "fill" ? `填写「${label}」` : `点击「${label}」`;
  }
  const goal = String(input.goal ?? "");
  if (/语言|hebrew|希伯来|english|locale/i.test(goal)) {
    return input.kind === "vision" ? "语言球/语言入口" : "语言切换";
  }
  if (/登录|login|sign\s*in/i.test(goal)) {
    return input.kind === "fill" ? "登录表单字段" : "登录按钮";
  }
  if (/注册|register|sign\s*up/i.test(goal)) {
    return input.kind === "fill" ? "注册表单字段" : "注册入口/提交";
  }
  return input.kind === "fill" ? "表单填写" : input.kind === "vision" ? "视觉定位控件" : "页面点击";
}

/** 从目标/意图中抽可能的查询实体（中文词、英文词），用于冲突检测 */
export function extractSalientTokens(text: string): string[] {
  const raw = String(text ?? "");
  const tokens = new Set<string>();
  for (const m of raw.matchAll(/[「"']([^「」"']{2,24})[」"']/g)) {
    tokens.add(m[1]!.trim());
  }
  for (const m of raw.matchAll(/[\u4e00-\u9fff]{2,8}/g)) {
    const t = m[0]!;
    if (!/打开|百度|搜索|总结|分析|第一条|结果|然后|页面|点击|输入|提交|查找|告诉|发给/i.test(t)) {
      tokens.add(t);
    }
  }
  for (const m of raw.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,24}/g)) {
    const t = m[0]!.toLowerCase();
    if (!/https?|www|baidu|google|bing|search|click|fill|navigate/.test(t)) {
      tokens.add(t);
    }
  }
  return [...tokens];
}

/** 记忆意图是否与当前目标查询实体冲突（如记忆含「李白」目标是「张学友」） */
export function memoryIntentConflictsGoal(intent: string, goal: string): boolean {
  const intentTokens = extractSalientTokens(intent);
  const goalTokens = extractSalientTokens(goal);
  if (intentTokens.length === 0 || goalTokens.length === 0) {
    return false;
  }
  const goalSet = new Set(goalTokens.map((t) => t.toLowerCase()));
  for (const token of intentTokens) {
    if (!goalSet.has(token.toLowerCase()) && token.length >= 2) {
      // 意图里有目标没有的实体 → 冲突
      return true;
    }
  }
  return false;
}

function intentRelevance(entry: ControlMemoryEntry, goal: string): number {
  const g = goal.toLowerCase();
  const intent = entry.intent.toLowerCase();
  const key = entry.intentKey;
  if (memoryIntentConflictsGoal(entry.intent, goal)) {
    return -100;
  }
  let score = 0;
  if (!g) {
    return entry.hitCount;
  }
  if (g.includes(intent) || intent.includes(g.slice(0, 12))) {
    score += 8;
  }
  for (const token of key.split(/[\s/·|]+/).filter((t) => t.length >= 2)) {
    if (g.includes(token)) {
      score += 3;
    }
  }
  if (/搜索|search/i.test(g) && /搜索输入框|搜索提交|search/i.test(intent)) {
    score += 4;
  }
  if (/语言|hebrew|希伯来|locale/i.test(g) && /语言|hebrew|en\b|he\b/i.test(intent)) {
    score += 6;
  }
  if (/登录|login/i.test(g) && /登录|login/i.test(intent)) {
    score += 5;
  }
  if (/注册|register/i.test(g) && /注册|register/i.test(intent)) {
    score += 5;
  }
  score += Math.min(3, entry.hitCount);
  return score;
}

function findShortIdBySelector(
  extract: AgentExtractResult,
  selector: string,
): { id: string; ref: AgentElementRef } | null {
  const want = sanitizeSelector(selector);
  if (!want) {
    return null;
  }
  for (const [id, ref] of extract.element_map) {
    if (sanitizeSelector(ref.selector) === want) {
      return { id, ref };
    }
  }
  return null;
}

function findShortIdByTextHint(
  extract: AgentExtractResult,
  textHint: string,
): { id: string; ref: AgentElementRef } | null {
  const hint = textHint.trim().toLowerCase();
  if (!hint || hint.length < 1) {
    return null;
  }
  for (const [id, ref] of extract.element_map) {
    const text = String(ref.text ?? "").trim().toLowerCase();
    if (text && (text === hint || text.includes(hint) || hint.includes(text))) {
      return { id, ref };
    }
  }
  return null;
}

export async function selectorExistsOnPage(page: Page, selector: string): Promise<boolean> {
  const sel = sanitizeSelector(selector);
  if (!sel) {
    return false;
  }
  try {
    const locator =
      sel.startsWith("/") || sel.startsWith("xpath=")
        ? page.locator(sel.startsWith("xpath=") ? sel : `xpath=${sel}`).first()
        : page.locator(sel).first();
    const count = await locator.count();
    if (count <= 0) {
      return false;
    }
    return await locator.isVisible().catch(() => true);
  } catch {
    return false;
  }
}

/**
 * 按当前 URL + 用户目标检索同站记忆，并尝试对齐本轮短 id。
 */
export async function matchControlMemory(input: {
  page: Page;
  url: string;
  goal: string;
  extract: AgentExtractResult;
  limit?: number;
}): Promise<ControlMemoryMatch[]> {
  const domain = normalizeDomain(input.url);
  const entries = listDomainMemory(domain);
  if (entries.length === 0) {
    return [];
  }

  const scored: ControlMemoryMatch[] = [];
  for (const entry of entries) {
    const relevance = intentRelevance(entry, input.goal);
    // 与当前目标实体冲突的记忆一律丢弃（防「李白」串到「张学友」）
    if (relevance < 0) {
      continue;
    }
    if (relevance < 3 && input.goal.trim()) {
      // 无目标关联时仍保留高 hit 条目作兜底
      if (entry.hitCount < 2) {
        continue;
      }
    }
    let shortId: string | null = null;
    let selectorAlive = false;
    if (entry.selector) {
      const bySel = findShortIdBySelector(input.extract, entry.selector);
      if (bySel) {
        shortId = bySel.id;
        selectorAlive = true;
      } else {
        const byText = entry.textHint
          ? findShortIdByTextHint(input.extract, entry.textHint)
          : null;
        if (byText) {
          shortId = byText.id;
          selectorAlive = true;
        } else {
          selectorAlive = await selectorExistsOnPage(input.page, entry.selector);
        }
      }
    } else if (entry.xPercent != null && entry.yPercent != null) {
      selectorAlive = true;
    }
    if (!selectorAlive) {
      continue;
    }
    scored.push({
      entry,
      shortId,
      selectorAlive,
      score: relevance + (shortId ? 4 : 0) + Math.min(3, entry.hitCount),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, input.limit ?? 8);
}

export function formatControlMemoryForLlm(matches: ControlMemoryMatch[]): string | null {
  if (matches.length === 0) {
    return null;
  }
  const lines = [
    CONTROL_MEMORY_MARK,
    "同站历史控件类型参考（仅短 id / 文案）。禁止复用历史搜索词或其它任务实体；必须按【用户目标】本轮查询词操作。",
  ];
  for (const match of matches.slice(0, 6)) {
    const e = match.entry;
    const idPart = match.shortId ? `短id=${match.shortId}` : "短id=未对齐";
    const selPart = e.selector ? `selector≈${e.selector.slice(0, 60)}` : "";
    const coordPart =
      e.xPercent != null && e.yPercent != null
        ? `坐标≈(${e.xPercent},${e.yPercent})`
        : "";
    lines.push(
      `- [${e.kind}] 「${e.intent}」· ${idPart}${selPart ? ` · ${selPart}` : ""}${
        coordPart ? ` · ${coordPart}` : ""
      } · hits=${e.hitCount}`,
    );
  }
  return lines.join("\n");
}

/**
 * @deprecated 自动旁路已废除（易串任务）。保留函数供诊断，始终返回 null。
 */
export function pickBypassClickCandidate(
  _matches: ControlMemoryMatch[],
  _goal: string,
): ControlMemoryMatch | null {
  return null;
}

/** 成功后记忆 + 发 IPC 供 Rust SQLite 持久化 + 本地 JSON 备份 */
export async function rememberAndPersist(input: {
  logger: JsonLogger;
  url: string;
  intent: string;
  kind: ControlMemoryKind;
  selector?: string;
  textHint?: string;
  xPercent?: number;
  yPercent?: number;
}): Promise<ControlMemoryEntry | null> {
  const entry = rememberControl(input);
  if (!entry) {
    return null;
  }
  input.logger.agentControlMemoryUpsert({
    domain: entry.domain,
    intent: entry.intent,
    intentKey: entry.intentKey,
    kind: entry.kind,
    selector: entry.selector,
    textHint: entry.textHint,
    xPercent: entry.xPercent ?? null,
    yPercent: entry.yPercent ?? null,
    hitCount: entry.hitCount,
    updatedAt: entry.updatedAt,
  });
  try {
    await persistControlMemoryToDisk();
  } catch {
    // 磁盘备份失败不阻断主流程
  }
  return entry;
}

/** 解析 agent_start 下发的 controlMemory 种子 */
export function parseControlMemorySeed(raw: unknown): ControlMemoryEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ControlMemoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    out.push({
      domain: String(row.domain ?? ""),
      intent: String(row.intent ?? ""),
      intentKey: String(row.intentKey ?? row.intent_key ?? ""),
      kind: (String(row.kind ?? "click") as ControlMemoryKind) || "click",
      selector: String(row.selector ?? ""),
      textHint: String(row.textHint ?? row.text_hint ?? ""),
      xPercent:
        row.xPercent != null
          ? Number(row.xPercent)
          : row.x_percent != null
            ? Number(row.x_percent)
            : undefined,
      yPercent:
        row.yPercent != null
          ? Number(row.yPercent)
          : row.y_percent != null
            ? Number(row.y_percent)
            : undefined,
      hitCount: Number(row.hitCount ?? row.hit_count ?? 1) || 1,
      updatedAt: String(row.updatedAt ?? row.updated_at ?? ""),
    });
  }
  return out;
}

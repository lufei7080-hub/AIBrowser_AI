/**
 * Brain Kernel · 统一页面现实（PageReality）
 * 大脑 / 路由 / 验收只读本结构；站点差异体现在控件语义角色，不进 if(google) 脚本链。
 */
import type { Page } from "playwright-core";

import type { AgentExtractResult, AgentLlmElement } from "./interactive_elements.js";
import type { DistillResult } from "./page_distill.js";
import { hostOfUrl } from "./page_distill.js";
import type { PagePerceiveResult } from "./page_perceive.js";
import { formatPerceiveForLlm } from "./page_perceive.js";
import {
  formatPageReadingForLlm,
  isMeaningfulFeaturedCard,
  serpQueryMatchesGoal,
  type PageReadingResult,
} from "./page_read.js";
import {
  pageShowsLanguageTarget,
  resolveLanguageTarget,
  isLanguageSwitchGoal,
} from "./language_switch.js";

function hintSearchQuery(goal: string): string | null {
  const m = String(goal ?? "").match(
    /(?:百度|谷歌|google|bing)?\s*搜索\s*[「"']?([^「」"'\s，。；然后接着]{1,40})/i,
  );
  return m?.[1]?.trim() || null;
}

export type ControlRole =
  | "search_box"
  | "submit"
  | "link"
  | "input"
  | "button"
  | "checkbox"
  | "other";

export interface RealityControl {
  id: string;
  type: string;
  text: string;
  name?: string;
  placeholder?: string;
  role: ControlRole;
  /** 主搜索框候选分；越高越像真正的检索入口 */
  searchScore: number;
}

export interface PageReality {
  url: string;
  title: string;
  host: string;
  controls: RealityControl[];
  /** 通用主搜索框短 ID（已排除 AI Mode 等旁路入口） */
  primarySearchBoxId: string | null;
  primarySearchQuery: string | null;
  topResults: Array<{ rank: number; title: string; snippet: string; url?: string }>;
  featuredTitle: string | null;
  readingKind: "serp" | "article" | "generic" | "none";
  goalHits: string[];
  structureHash: string;
  queryMatchesGoal: boolean;
  hasOrganicResults: boolean;
  /** 交付子目标可验收：SERP 查询对齐 + 有可读结果 */
  deliveryReady: boolean;
  /** 切语言目标时页面是否已呈目标语信号 */
  langMatched: boolean;
  llmJson: AgentLlmElement[];
  perceiveBlock: string | null;
  readingBlock: string | null;
}

const DELIVERABLE_RE =
  /告诉我|发给我|发送给我|回复我|给我|总结|简化|分析|第一条|前\s*\d+|结果|多少|几度|温度|回答|报告|提取|说一下|是什么/i;

/** AI Mode / Gemini 等旁路入口：绝不当主搜索框 */
const SEARCH_BOX_NOISE_RE =
  /ai\s*mode|gemini|bard|copilot|chatgpt|人工智能模式|智能问答|问\s*ai|ask\s*ai/i;

const SEARCH_HINT_RE = /search|搜索|查找|query|keyword|搜一|百度一下|\bwd\b|\bq\b/i;
const SUBMIT_HINT_RE =
  /百度一下|google\s*search|搜索一下|search|提交|submit|go\b|查找|立即注册|马上注册|登录|下一步|אישור|המשך|לתשלום/i;

function elBlob(el: AgentLlmElement): string {
  return [el.text, el.placeholder, el.name, el.type, el.role]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isFillableType(type: string): boolean {
  return /searchbox|textbox|combobox|input|textarea|password|email|tel|number|search/i.test(
    type,
  );
}

function isClickableType(type: string): boolean {
  return /button|link|tab|menuitem|checkbox|radio|switch/i.test(type);
}

/** 主搜索框打分：越高越像真正检索框；噪声入口给负分 */
export function scoreSearchBoxCandidate(el: AgentLlmElement): number {
  const type = String(el.type ?? "").toLowerCase();
  const blob = elBlob(el);
  if (!isFillableType(type)) {
    return -100;
  }
  if (SEARCH_BOX_NOISE_RE.test(blob)) {
    return -50;
  }
  let score = 0;
  if (/searchbox/i.test(type)) {
    score += 20;
  }
  if (SEARCH_HINT_RE.test(blob)) {
    score += 12;
  }
  if (/^q$|^wd$|^keyword$|^query$/i.test(String(el.name ?? "").trim())) {
    score += 18;
  }
  if (/search|搜索/i.test(String(el.placeholder ?? ""))) {
    score += 8;
  }
  // 过长文案多半是评论/正文框
  if ((el.text ?? "").length > 40) {
    score -= 8;
  }
  return score;
}

export function annotateControlRole(el: AgentLlmElement): RealityControl {
  const type = String(el.type ?? "").toLowerCase();
  const blob = elBlob(el);
  const searchScore = scoreSearchBoxCandidate(el);
  let role: ControlRole = "other";
  if (searchScore >= 12) {
    role = "search_box";
  } else if (/checkbox|radio/i.test(type)) {
    role = "checkbox";
  } else if (isFillableType(type)) {
    role = "input";
  } else if (SUBMIT_HINT_RE.test(blob) && isClickableType(type)) {
    role = "submit";
  } else if (/button/i.test(type)) {
    role = "button";
  } else if (/link/i.test(type)) {
    role = "link";
  } else if (isClickableType(type)) {
    role = "button";
  }
  return {
    id: String(el.id ?? "").trim(),
    type: String(el.type ?? ""),
    text: String(el.text ?? ""),
    name: el.name,
    placeholder: el.placeholder,
    role,
    searchScore,
  };
}

/** 通用主搜索框：按分选最高且非噪声 */
export function pickPrimarySearchBox(llmJson: AgentLlmElement[]): AgentLlmElement | null {
  const rows = Array.isArray(llmJson) ? llmJson : [];
  const ranked = rows
    .map((el) => ({ el, score: scoreSearchBoxCandidate(el) }))
    .filter((row) => row.score >= 8)
    .sort((a, b) => b.score - a.score);
  if (ranked[0]) {
    return ranked[0].el;
  }
  // 弱回退：唯一可填框且非噪声
  const fillables = rows.filter((el) => {
    if (!isFillableType(String(el.type ?? ""))) {
      return false;
    }
    return !SEARCH_BOX_NOISE_RE.test(elBlob(el));
  });
  return fillables.length === 1 ? fillables[0]! : null;
}

export function composePageReality(input: {
  url: string;
  title?: string;
  distill: DistillResult | AgentExtractResult;
  perceive?: PagePerceiveResult | null;
  reading?: PageReadingResult | null;
  goal: string;
  langMatched?: boolean;
}): PageReality {
  const goal = String(input.goal ?? "");
  const distillUrl =
    "url" in input.distill && typeof (input.distill as { url?: string }).url === "string"
      ? String((input.distill as { url: string }).url)
      : "";
  const url = String(input.url ?? distillUrl ?? "");
  const llmJson = Array.isArray(input.distill.llm_json) ? input.distill.llm_json : [];
  const controls = llmJson.map(annotateControlRole);
  const primary = pickPrimarySearchBox(llmJson);
  const reading = input.reading ?? null;
  const primarySearchQuery = reading?.query?.trim() || null;
  const queryMatchesGoal = serpQueryMatchesGoal(goal, primarySearchQuery);
  const organicCount = reading?.organic?.length ?? 0;
  const featuredOk = isMeaningfulFeaturedCard(reading?.featured ?? null);
  // 必须有真实自然结果，或实质置顶卡；禁止首页导航残影
  const hasOrganicResults = Boolean(
    reading &&
      reading.kind === "serp" &&
      (organicCount > 0 || featuredOk),
  );
  const readingKind = reading?.kind ?? "none";
  const deliveryReady = Boolean(
    DELIVERABLE_RE.test(goal) &&
      reading &&
      reading.kind === "serp" &&
      queryMatchesGoal &&
      organicCount > 0,
  );

  const topResults = (reading?.organic ?? []).slice(0, 5).map((item) => ({
    rank: item.rank,
    title: item.title,
    snippet: item.snippet,
    url: item.url,
  }));

  return {
    url,
    title: String(input.title ?? "").trim(),
    host: hostOfUrl(url),
    controls,
    primarySearchBoxId: primary ? String(primary.id).trim() : null,
    primarySearchQuery,
    topResults,
    featuredTitle: reading?.featured?.title ?? reading?.recommendedFirst?.title ?? null,
    readingKind,
    goalHits: input.perceive?.goalHits ?? [],
    structureHash: String(
      (input.distill as DistillResult).structureHash ?? "",
    ).trim(),
    queryMatchesGoal,
    hasOrganicResults,
    deliveryReady,
    langMatched: Boolean(input.langMatched),
    llmJson,
    perceiveBlock: input.perceive ? formatPerceiveForLlm(input.perceive) : null,
    readingBlock:
      reading && (reading.kind === "serp" ? queryMatchesGoal : hasOrganicResults)
        ? formatPageReadingForLlm(reading)
        : null,
  };
}

/** 从活页组装现实（含 title / 语言信号） */
export async function buildPageReality(input: {
  page: Page;
  distill: DistillResult | AgentExtractResult;
  perceive?: PagePerceiveResult | null;
  reading?: PageReadingResult | null;
  goal: string;
}): Promise<PageReality> {
  let title = "";
  try {
    title = await input.page.title();
  } catch {
    title = "";
  }
  let langMatched = false;
  if (isLanguageSwitchGoal(input.goal)) {
    try {
      langMatched = await pageShowsLanguageTarget(
        input.page,
        resolveLanguageTarget(input.goal),
      );
    } catch {
      langMatched = false;
    }
  }
  return composePageReality({
    url: input.page.url() || distillUrlOf(input.distill),
    title,
    distill: input.distill,
    perceive: input.perceive,
    reading: input.reading,
    goal: input.goal,
    langMatched,
  });
}

function distillUrlOf(distill: DistillResult | AgentExtractResult): string {
  if ("url" in distill && typeof (distill as { url?: string }).url === "string") {
    return String((distill as { url: string }).url);
  }
  return "";
}

/** 压成给 LLM 的短块：当前现实 + 主搜索框提示 */
export function formatPageRealityForLlm(reality: PageReality, goal: string): string {
  const queryHint = hintSearchQuery(goal);
  const searchBoxes = reality.controls
    .filter((c) => c.role === "search_box")
    .slice(0, 3)
    .map((c) => `${c.id}(${c.placeholder || c.name || c.text || "search"})`)
    .join(", ");
  const lines = [
    "【页面现实·BrainKernel】",
    `url=${reality.url}`,
    reality.title ? `title=${reality.title.slice(0, 80)}` : "",
    `host=${reality.host} · hash=${reality.structureHash.slice(0, 12) || "∅"}`,
    `主搜索框=${reality.primarySearchBoxId ?? "无"}` +
      (searchBoxes ? ` · 候选[${searchBoxes}]` : ""),
    queryHint ? `目标检索词提示=${queryHint}` : "",
    reality.primarySearchQuery
      ? `页内查询词=${reality.primarySearchQuery} · 对齐目标=${reality.queryMatchesGoal ? "是" : "否"}`
      : "页内查询词=（无/非 SERP）",
    `阅读=${reality.readingKind} · 有结果=${reality.hasOrganicResults ? "是" : "否"} · 可交付=${reality.deliveryReady ? "是" : "否"}`,
    reality.langMatched ? "语言信号=已匹配目标语" : "",
    reality.featuredTitle ? `置顶/第一条标题=${reality.featuredTitle.slice(0, 60)}` : "",
  ];
  if (reality.topResults.length) {
    lines.push(
      "自然结果：" +
        reality.topResults
          .slice(0, 3)
          .map((r) => `${r.rank}.${r.title.slice(0, 40)}`)
          .join(" | "),
    );
  }
  lines.push(
    "规则：只根据本现实选工具；主搜索框用 short id 填写（禁止点 AI Mode）；查询未对齐禁止总结旧结果。",
  );
  return lines.filter(Boolean).join("\n");
}

/**
 * Phase A：任务分析（规则 + 短 LLM）
 * 不传 browser_state / 不抽 DOM；产出 plan + 可选 bootstrap navigate。
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

import {
  beginAgentLlmWait,
  createLlmClient,
  extractAssistantContent,
} from "../ai_client.js";
import { createModelRouter } from "../ai_model_router.js";
import type { SidecarAiSettings } from "../engine.js";
import { extractJsonObject } from "./prompts.js";
import type { AgentAction } from "./views.js";

export interface RuleSeed {
  urls: string[];
  siteHint: string | null;
  queryTerms: string[];
  acceptance: string | null;
  suggestedPlan: string[];
}

export interface TaskAnalyzeResult {
  plan: string[];
  bootstrapActions: AgentAction[];
  queryTerms: string[];
  acceptance: string | null;
  source: "rule+llm" | "rule_only";
}

const SITE_ALIASES: Array<{ re: RegExp; url: string; label: string }> = [
  { re: /百度|baidu/i, url: "https://www.baidu.com/", label: "百度" },
  { re: /谷歌|google/i, url: "https://www.google.com/", label: "谷歌" },
  { re: /必应|bing/i, url: "https://www.bing.com/", label: "必应" },
  { re: /淘宝|taobao/i, url: "https://www.taobao.com/", label: "淘宝" },
  { re: /京东|jd\.com/i, url: "https://www.jd.com/", label: "京东" },
  { re: /知乎|zhihu/i, url: "https://www.zhihu.com/", label: "知乎" },
  { re: /微博|weibo/i, url: "https://weibo.com/", label: "微博" },
];

/** 规则层：URL / 站点 / 检索词 / 默认计划骨架 */
export function ruleSeedFromGoal(goal: string): RuleSeed {
  const text = String(goal ?? "").trim();
  const urls: string[] = [];
  const urlRe = /https?:\/\/[^\s，。；、）)\]」"']+/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text))) {
    urls.push(m[0].replace(/[。．，,/;:：]+$/g, ""));
  }
  // 最长 URL 优先（完整路径压过仅域名）
  urls.sort((a, b) => b.length - a.length);

  let siteHint: string | null = null;
  let siteUrl: string | null = null;
  for (const alias of SITE_ALIASES) {
    if (alias.re.test(text)) {
      siteHint = alias.label;
      siteUrl = alias.url;
      break;
    }
  }
  if (siteUrl && !urls.includes(siteUrl)) {
    urls.push(siteUrl);
  }

  const queryTerms: string[] = [];
  const searchMatch =
    text.match(/(?:搜索|搜一下|查找|查询)\s*[「"']?([^「"'\n，。；]{1,40})/) ||
    text.match(/(?:百度|谷歌|必应)搜索\s*[「"']?([^「"'\n，。；]{1,40})/);
  if (searchMatch?.[1]) {
    queryTerms.push(searchMatch[1].trim().replace(/[然后并]+.*$/, "").trim());
  }

  let acceptance: string | null = null;
  const wantsUnderstanding =
    /总结|摘要|概括|分析|解读|介绍|是谁|是什么|怎么样|告诉我|详情|内容|汇报|提取信息/.test(
      text,
    );
  if (/总结|摘要|概括/.test(text)) {
    acceptance = "根据页面内容总结关键信息并 done";
  } else if (wantsUnderstanding) {
    acceptance = "根据页面阅读摘要回答用户自然语言问题并 done";
  }
  if (/第一条|第一条结果|第一条搜索/.test(text)) {
    acceptance = (acceptance ? `${acceptance}；` : "") + "读取并汇报第一条搜索结果";
  }

  // 搜索类目标：合并微步骤，避免「找框/输入/回车/确认」拆成 6+ 步
  const suggestedPlan: string[] = [];
  const isSimpleSearch =
    queryTerms.length > 0 &&
    Boolean(urls[0] || siteHint) &&
    !/(注册|登录|填写|下单|支付|上传|多页|爬取|采集)/.test(text);

  if (isSimpleSearch) {
    suggestedPlan.push(`打开 ${urls[0] || siteHint} 并搜索「${queryTerms[0]}」`);
    if (acceptance) {
      suggestedPlan.push(acceptance);
    } else {
      suggestedPlan.push("确认搜索结果页已打开，用 page_digest 简述后 done");
    }
    if (!suggestedPlan.some((p) => /done|验收/.test(p))) {
      suggestedPlan.push("对照用户请求验收并调用 done");
    }
  } else {
    if (urls[0] || siteHint) {
      suggestedPlan.push(`打开 ${urls[0] || siteHint}`);
    }
    if (queryTerms.length) {
      suggestedPlan.push(`在搜索框输入「${queryTerms[0]}」并提交`);
      suggestedPlan.push("确认已进入搜索结果页");
    }
    if (acceptance) {
      suggestedPlan.push(acceptance);
    }
    if (!suggestedPlan.length) {
      suggestedPlan.push("理解目标并打开相关页面");
      suggestedPlan.push("定位并完成必要交互");
      suggestedPlan.push("对照用户请求验收并 done");
    } else if (!/done|验收|总结|完成/.test(suggestedPlan[suggestedPlan.length - 1] ?? "")) {
      suggestedPlan.push("对照用户请求验收并调用 done");
    }
  }

  return { urls, siteHint, queryTerms, acceptance, suggestedPlan };
}

function bootstrapFromRules(seed: RuleSeed): AgentAction[] {
  const url = seed.urls[0];
  if (!url) return [];
  return [{ name: "navigate", params: { url } }];
}

/**
 * Phase A 入口：规则 + 短 LLM（失败则纯规则兜底）
 */
export async function analyzeTask(input: {
  goal: string;
  aiSettings: SidecarAiSettings;
  signal?: AbortSignal;
}): Promise<TaskAnalyzeResult> {
  const seed = ruleSeedFromGoal(input.goal);
  const ruleBootstrap = bootstrapFromRules(seed);

  try {
    const router = createModelRouter(input.aiSettings);
    const resolved = router.resolve("logic");
    const client = createLlmClient(input.aiSettings);
    const wait = beginAgentLlmWait({
      parentSignal: input.signal,
      timeoutMs: 45_000,
    });

    const messages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `你是任务分析器。根据用户自然语言拆解有序执行计划。
禁止输出页面观察或 DOM。只输出 JSON：
{"plan":["步骤1","步骤2",...],"bootstrap_url":"https://...或空","query_terms":["关键词"],"acceptance":"验收标准"}
规则：
- plan 硬上限 8 步；简单搜索/打开站点类任务必须 3–5 步
- 禁止把「找搜索框 / 输入 / 点按钮 / 等待加载 / 观察页面」拆成多个独立步骤；应合并为可 multi_act 的一步
- 禁止写「观察当前页」「截图」「提取 DOM」作为计划项（运行时会自动观察）
- 简体中文，可执行（打开并搜索→确认结果→验收 done）
- 若用户只要「打开/搜索」：验收=结果页出现即可 done，不要加「深度分析网页」步骤
- 若用户要「分析/总结/是谁/介绍」：计划中保留一步「根据页面阅读回答并 done」
- 若用户目标已含完整 https?:// URL（含路径），bootstrap_url 必须原样使用该 URL，禁止截成域名首页或截断路径
- 若目标仅含搜索引擎/站点名而无完整 URL，bootstrap_url 可填首页
- 不要写「观察当前页」作为第一步（除非用户明确要求分析当前已打开页）`,
      },
      {
        role: "user",
        content: `<user_request>${input.goal}</user_request>
<rule_seed>${JSON.stringify(seed)}</rule_seed>
请在 rule_seed 基础上完善 plan。rule_seed.urls[0] 若已是完整目标 URL，bootstrap_url 必须与之相同（勿改成站点首页）。若目标只是「某站搜索某词」，优先采用短计划（≤5 步），不要扩写。`,
      },
    ];

    try {
      const completion = await client.chat.completions.create(
        {
          model: resolved.model,
          messages,
          temperature: 0.1,
          response_format: { type: "json_object" },
        } as never,
        { signal: wait.signal },
      );
      const content = extractAssistantContent(completion);
      const parsed = extractJsonObject(content) as Record<string, unknown>;
      const planRaw = Array.isArray(parsed.plan) ? parsed.plan : seed.suggestedPlan;
      let plan = compactPlan(
        planRaw.map((p) => String(p ?? "").trim()).filter(Boolean),
        seed,
      );
      const llmBootstrap = String(parsed.bootstrap_url ?? "").trim();
      const bootstrapUrl = pickBootstrapUrl(llmBootstrap, seed.urls);
      const queryTerms = Array.isArray(parsed.query_terms)
        ? parsed.query_terms.map((t) => String(t).trim()).filter(Boolean)
        : seed.queryTerms;
      const acceptance =
        typeof parsed.acceptance === "string" && parsed.acceptance.trim()
          ? parsed.acceptance.trim()
          : seed.acceptance;

      const bootstrapActions: AgentAction[] = bootstrapUrl
        ? [{ name: "navigate", params: { url: normalizeUrl(bootstrapUrl) } }]
        : ruleBootstrap;

      return {
        plan: plan.length ? plan : seed.suggestedPlan,
        bootstrapActions,
        queryTerms,
        acceptance,
        source: "rule+llm",
      };
    } finally {
      wait.stop();
    }
  } catch {
    return {
      plan: seed.suggestedPlan,
      bootstrapActions: ruleBootstrap,
      queryTerms: seed.queryTerms,
      acceptance: seed.acceptance,
      source: "rule_only",
    };
  }
}

/** 计划硬上限；简单搜索若 LLM 扩写过长则回退规则短计划 */
const PLAN_HARD_CAP = 8;
const SIMPLE_SEARCH_CAP = 5;

function compactPlan(plan: string[], seed: RuleSeed): string[] {
  const cleaned = plan
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !/^(观察|截图|提取\s*DOM|等待页面|感知页面)/i.test(p));

  const simpleSearch =
    seed.queryTerms.length > 0 &&
    Boolean(seed.urls[0] || seed.siteHint) &&
    cleaned.length > SIMPLE_SEARCH_CAP;

  if (simpleSearch && seed.suggestedPlan.length > 0 && seed.suggestedPlan.length <= SIMPLE_SEARCH_CAP) {
    return seed.suggestedPlan.slice(0, SIMPLE_SEARCH_CAP);
  }

  return cleaned.slice(0, PLAN_HARD_CAP);
}

function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(t)) return `https://${t}`;
  return t;
}

/**
 * 选择 bootstrap URL：用户目标里已写出的完整 URL 优先于 LLM 截断的首页。
 * 修复：goal 含 topic/2 完整路径，但 LLM 只回 origin → Agent 停在首页。
 */
export function pickBootstrapUrl(llmUrl: string, seedUrls: string[]): string {
  const seed = String(seedUrls[0] ?? "").trim();
  const llm = String(llmUrl ?? "").trim();
  if (!llm && !seed) return "";
  if (!llm) return seed;
  if (!seed) return normalizeUrl(llm);

  const seedNorm = normalizeUrl(seed);
  const llmNorm = normalizeUrl(llm);

  // seed 以 llm 为前缀且更长 → LLM 截断（含 match20 / 仅域名）
  if (seedNorm.toLowerCase().startsWith(llmNorm.toLowerCase()) && seedNorm.length > llmNorm.length) {
    return seedNorm;
  }

  try {
    const s = new URL(seedNorm);
    const l = new URL(llmNorm);
    if (s.origin === l.origin) {
      const seedPath = s.pathname.replace(/\/$/, "") || "/";
      const llmPath = l.pathname.replace(/\/$/, "") || "/";
      // LLM 回首页或更短路径，seed 更具体
      if (llmPath === "/" && seedPath !== "/") return seedNorm;
      if (seedPath.startsWith(llmPath) && seedPath.length > llmPath.length) return seedNorm;
      // 同 origin 时：目标原文 URL 优先
      if (/^https?:\/\//i.test(seed)) return seedNorm;
    }
  } catch {
    /* ignore */
  }

  // 目标含显式 https URL 时，默认信任规则抽取
  if (/^https?:\/\//i.test(seed)) return seedNorm;
  return llmNorm;
}

/** 当前 plan 项是否需要页面观察（交互/验收） */
export function planItemNeedsObservation(planText: string | undefined | null): boolean {
  const t = String(planText ?? "").trim();
  if (!t) return true;
  // 纯打开/导航且无其它交互词 → 可不观察（bootstrap 已处理）
  if (
    /^(打开|导航|前往|访问)/.test(t) &&
    !/(输入|点击|搜索框|按钮|填写|总结|提取|结果|验收)/.test(t)
  ) {
    return false;
  }
  return true;
}

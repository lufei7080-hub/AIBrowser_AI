/**
 * CloakForge Brain — 计划 / 判断 / 工作记忆 / 验收 / 重规划
 * 原则：Token 花在计划·判断·纠偏；观测可压缩；秘密绝不幻想。
 */
import { createModelRouter } from "./ai_model_router.js";
import type { SidecarAiSettings } from "./engine.js";
import type { JsonLogger } from "./json-logger.js";
import { truncateText } from "./llm_budget.js";
import { extractAssistantContent } from "./ai_client.js";
import { stripFencedJson } from "./json_extract.js";
import { formatTabsStateForLlm, type TabStateEntry } from "./agent_tabs.js";
import { isLanguageSwitchGoal, resolveLanguageTarget } from "./language_switch.js";
import {
  buildFillLocaleCoach,
  generateLocaleFieldValue,
  generateMobileForLocale,
  inferLocaleFromFieldLabel,
  isFillLocaleGoal,
  resolveFillLocale,
  goalWantsHebrewLocale,
  type FillLocaleKind,
} from "./fill_locale.js";

export {
  resolveFillLocale,
  buildFillLocaleCoach,
  generateLocaleFieldValue,
  goalWantsHebrewLocale,
  isFillLocaleGoal,
} from "./fill_locale.js";
import type { PageReality } from "./page_reality.js";
import { serpQueryMatchesGoal } from "./page_read.js";

export type PlanStepStatus = "pending" | "doing" | "done" | "failed" | "skipped";

export type FieldSource =
  | "ai_solve"
  | "page_derive"
  | "context"
  | "user_secret"
  | "user_otp"
  | "human_wall"
  | "ask_clarify"
  | "ok_as_is";

/** 机检后置条件：步完成只能由 PageReality 验收，禁止教练/旁路口头 done */
export type StepExpectKind =
  | "url_matches"
  | "search_query_eq"
  | "has_organic_results"
  | "lang_is"
  | "form_fields_filled"
  | "delivery_ready"
  | "any";

export interface StepExpect {
  kind: StepExpectKind;
  /** url_matches：目标 host 片段或完整 URL */
  hostIncludes?: string;
  /** search_query_eq / delivery：期望检索词 */
  queryHint?: string;
  /** lang_is：目标语标签 */
  langLabel?: string;
}

export interface BrainPlanStep {
  id: string;
  intent: string;
  expectedSignal: string;
  toolsHint: string;
  status: PlanStepStatus;
  /** 验收类别：用于分步推进与禁止提前 finish */
  verifyKind?: "nav" | "language" | "form" | "search" | "deliver" | "finish" | "generic";
  /** Brain Kernel：可机检后置条件 */
  expect?: StepExpect;
}

export interface TaskPlan {
  goalRestated: string;
  taskKind:
    | "navigate"
    | "language"
    | "form"
    | "search_deliver"
    | "download"
    | "mixed"
    | "other";
  steps: BrainPlanStep[];
  successCriteria: string[];
  risks: string[];
  source: "llm" | "heuristic";
}

export interface FieldJudgment {
  source: FieldSource;
  reason: string;
  resolvedValue?: string;
  askQuestion?: string;
  blockFill: boolean;
}

/** 最近一次物理动作签名（用于动作级幻觉熔断） */
export interface ActionSignatureRecord {
  /** 例：TOOL:click_visible_text|ARG:{"text":"EN"} */
  signature: string;
  /** 执行时页面结构指纹（sha1 截断） */
  structureHash: string;
}

export interface WorkingMemory {
  plan: TaskPlan;
  currentStepIndex: number;
  facts: string[];
  replanCount: number;
  lastJudgments: string[];
  /** 最近 3 次精确动作签名（同结构指纹下禁止原样重放） */
  recentActions: ActionSignatureRecord[];
  /** Milestone 5：多 Tab 状态（每轮刷新，注入 LLM） */
  tabsState: TabStateEntry[];
}

export const BRAIN_PLAN_MARK = "【任务计划·大脑】";
export const BRAIN_MEMORY_MARK = "【工作记忆】";
export const BRAIN_JUDGE_MARK = "【判断大脑】";

const SECRET_FIELD_RE =
  /password|passwd|pwd|密码|口令|pin\b|cvv|cvc|card.?number|信用卡|银行卡|支付密码/i;
const OTP_FIELD_RE =
  /短信验证|邮箱验证|邮件验证|email\s*code|sms\s*code|短信码|邮箱码|authenticator|totp|google\s*auth|mfa|2fa|两步|otp|校验码|dynamic.?code|一次性|验证码/i;
const CAPTCHA_RE = /captcha|验证码图片|人机验证|滑块|点选|recaptcha|turnstile|hcaptcha/i;
const MATH_IN_LABEL_RE =
  /(\d+)\s*([+\-×x*÷/])\s*(\d+)\s*(?:=|＝|等于|\?)?/i;

/** 从目标里抽 URL */
/** 站点别名 → 可 goto 的 URL（规划 bootstrap / navigate 共用） */
export const AGENT_SITE_ALIASES: Record<string, string> = {
  谷歌: "https://www.google.com/",
  google: "https://www.google.com/",
  百度: "https://www.baidu.com/",
  baidu: "https://www.baidu.com/",
  bing: "https://www.bing.com/",
  必应: "https://www.bing.com/",
  youtube: "https://www.youtube.com/",
  油管: "https://www.youtube.com/",
  github: "https://github.com/",
};

/**
 * 从目标中解析应先打开的 URL。
 * 支持 https?:// 与常见站名别名（打开百度 / 百度搜索 …）。
 */
export function extractUrlFromGoal(goal: string): string | null {
  const g = String(goal ?? "");
  const matches = g.match(/https?:\/\/[^\s「」"'，。；、）\]]+/gi);
  if (matches?.length) {
    // 取最长完整 URL，避免截成域名
    const best = [...matches]
      .map((u) => u.replace(/[)，。；、/;:：]+$/g, ""))
      .sort((a, b) => b.length - a.length)[0];
    if (best) return best;
  }
  const aliases = Object.entries(AGENT_SITE_ALIASES).sort(
    (a, b) => b[0].length - a[0].length,
  );
  const lower = g.toLowerCase();
  for (const [alias, url] of aliases) {
    if (g.includes(alias) || lower.includes(alias.toLowerCase())) {
      return url;
    }
  }
  return null;
}

/**
 * 去掉 URL / 环境点名后，目标是否仍含「打开站点之后」的操作意图。
 * 用于禁止「打开 URL + 切语言/填表/…」被误判为纯导航并过早 exit。
 */
export function goalHasPostNavigateIntent(goal: string): boolean {
  const stripped = String(goal ?? "")
    .replace(/https?:\/\/[^\s「」"'，。；]+/gi, " ")
    .replace(/(?:环境\s*#?\s*|#)\d+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) {
    return false;
  }
  return /然后|并且|接着|之后|再去|再把|再将|再设|填|登录|注册|搜索|查找|总结|分析|提取|语言|語|语种|locale|language|希伯来|hebrew|עברית|english|中文|英文|阿拉伯|俄文|日语|韩语|法语|德语|设置|设定|切换|改成|换成|调成|设成|点[击選选]|下载|告诉我|发给我|提交|选择|验证|captcha|scroll|滚动/i.test(
    stripped,
  );
}

/**
 * 目标是否仅为打开/访问某站（可安全在 navigate 后启发式收工）。
 * 含切语言、填表、搜索等后续动作时必须为 false，强制走 Task Planner。
 */
export function goalIsNavigateOnly(goal: string): boolean {
  const g = String(goal ?? "").trim();
  if (!g) {
    return false;
  }
  if (goalHasPostNavigateIntent(g)) {
    return false;
  }
  const withoutUrl = g
    .replace(/https?:\/\/[^\s「」"'，。；]+/gi, " ")
    .replace(/(?:环境\s*#?\s*|#)\d+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  // 纯 URL、或「打开/访问 + 站名」且无后续意图
  if (!withoutUrl || withoutUrl.length <= 2) {
    return Boolean(extractUrlFromGoal(g));
  }
  return /打开|访问|进入|前往|go\s*to|open|navigate/i.test(g);
}

/** 从用户目标里抽出搜索关键词（去掉站名/动词） */
export function extractSearchQueryFromGoal(goal: string): string | null {
  let g = String(goal ?? "")
    .replace(/https?:\/\/[^\s「」"'，。；]+/gi, " ")
    .replace(/www\.[^\s]+/gi, " ");
  const patterns = [
    /(?:百度|谷歌|google|bing)?\s*搜索\s*[「"']?([^「」"'\s，。；然后接着]{1,40})/i,
    /搜(?:索)?一下\s*[「"']?([^「」"'\s，。；]{1,40})/i,
    /查找\s*[「"']?([^「」"'\s，。；]{1,40})/i,
    /[「"']([^「」"']{2,40})[」"']/,
  ];
  for (const re of patterns) {
    const m = g.match(re);
    if (m?.[1]?.trim()) {
      return m[1].trim();
    }
  }
  g = g
    .replace(
      /打开|页面|然后|总结|分析|第一条|结果|告诉我|发给我|百度|谷歌|google|bing|搜索|查找|网站|网址|访问|进入/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  const cn = g.match(/[\u4e00-\u9fff]{2,16}/);
  if (cn?.[0]) {
    return cn[0];
  }
  const en = g.match(/[A-Za-z][A-Za-z0-9_-]{2,24}/);
  return en?.[0] ?? null;
}

function classifyTaskKind(goal: string): TaskPlan["taskKind"] {
  const g = String(goal ?? "");
  const lang = isLanguageSwitchGoal(g);
  const form = /填|注册|登录|提交|表单|资料|结账|checkout|register|login|sign\s*up|sign\s*in/i.test(g);
  const cart = goalHasPostAuthIntent(g);
  const search = /搜索|查找|百度|google|bing|谷歌|必应|搜一下/i.test(g);
  const deliver = /总结|分析|提取|简化|理解|告诉我|发给我|第一条/i.test(g);
  const download = /下载|保存.*(图|文件|pdf)|落盘|@download/i.test(g);
  const nav = Boolean(extractUrlFromGoal(g)) || /打开|访问|前往/i.test(g);

  // 打开站 + 切语言（无表单/搜索）→ 归 language
  if (lang && !form && !search && !deliver && !download && !cart) {
    return "language";
  }
  // 搜索/总结（可带打开站）：优先 search_deliver，避免被 mixed 拖慢
  if ((search || deliver) && !lang && !form && !download && !cart) {
    return "search_deliver";
  }
  // 登录/注册后再加购等 → mixed，禁止登录完就 finish
  if (form && cart) {
    return "mixed";
  }
  const flags = [lang, form, search || deliver, download, nav, cart].filter(Boolean).length;
  if (flags >= 2) {
    return "mixed";
  }
  if (lang) {
    return "language";
  }
  if (form) {
    return "form";
  }
  if (search || deliver) {
    return "search_deliver";
  }
  if (download) {
    return "download";
  }
  if (nav) {
    return "navigate";
  }
  return "other";
}

function step(
  id: string,
  intent: string,
  expectedSignal: string,
  toolsHint: string,
  verifyKind?: BrainPlanStep["verifyKind"],
  expect?: StepExpect,
): BrainPlanStep {
  return { id, intent, expectedSignal, toolsHint, status: "pending", verifyKind, expect };
}

function hostTokenFromUrl(url: string | null): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
  }
}

/**
 * 用 PageReality 机检某步 expect。
 * 无 expect 时：仅 finish/deliver/any 软通过，其余拒绝（防口头 done）。
 */
export function verifyExpect(
  reality: PageReality,
  expect: StepExpect | undefined,
  goal: string,
): { ok: boolean; detail: string } {
  if (!expect) {
    return { ok: false, detail: "步骤缺少机检 expect，禁止仅凭教练标记完成" };
  }
  const g = String(goal ?? "");
  switch (expect.kind) {
    case "url_matches": {
      const want = String(expect.hostIncludes ?? "").toLowerCase().trim();
      if (!want) {
        return { ok: false, detail: "url_matches 缺少 hostIncludes" };
      }
      const host = reality.host.toLowerCase();
      const url = reality.url.toLowerCase();
      const ok =
        host.includes(want.replace(/^www\./, "")) ||
        url.includes(want) ||
        want.split(".")[0] !== undefined && host.includes(want.split(".")[0]!);
      return {
        ok,
        detail: ok
          ? `URL 已对齐 ${want}（${reality.host}）`
          : `URL 未对齐：当前 ${reality.host}，期望含 ${want}`,
      };
    }
    case "search_query_eq": {
      const hint =
        String(expect.queryHint ?? "").trim() ||
        extractSearchQueryFromGoal(g) ||
        "";
      if (!hint) {
        return { ok: false, detail: "无法从目标解析检索词" };
      }
      const q = reality.primarySearchQuery;
      const matched =
        Boolean(q) &&
        (serpQueryMatchesGoal(g, q) ||
          String(q).toLowerCase().includes(hint.toLowerCase()) ||
          g.includes(String(q)));
      // 必须在 SERP 且查询对齐；首页有搜索框不算完成
      const ok = reality.readingKind === "serp" && matched;
      return {
        ok,
        detail: ok
          ? `检索词已提交并对齐：「${q}」`
          : `检索未验收：页内查询=${q ?? "无"} · kind=${reality.readingKind} · 期望「${hint}」`,
      };
    }
    case "has_organic_results": {
      const ok =
        reality.hasOrganicResults &&
        reality.readingKind === "serp" &&
        reality.queryMatchesGoal &&
        reality.topResults.length > 0;
      return {
        ok,
        detail: ok
          ? `已取得自然结果（${reality.topResults[0]?.title ?? reality.featuredTitle ?? "条目"}）`
          : "尚无自然搜索结果（禁止把导航条/空翻译卡当结果）",
      };
    }
    case "lang_is": {
      const ok = reality.langMatched;
      return {
        ok,
        detail: ok
          ? `语言信号已匹配（${expect.langLabel ?? "目标语"}）`
          : `语言尚未切换为 ${expect.langLabel ?? "目标语"}`,
      };
    }
    case "form_fields_filled": {
      // 弱机检：有可填控件且当前不在明显空注册墙；强验收仍靠成功页/后续信号
      const fillables = reality.controls.filter(
        (c) => c.role === "input" || c.role === "search_box" || c.role === "checkbox",
      ).length;
      const ok = fillables === 0 || /success|成功|欢迎|dashboard|home/i.test(reality.url + reality.title);
      return {
        ok: fillables > 0 ? false : ok,
        detail:
          fillables > 0
            ? `表单仍有 ${fillables} 个可交互字段，待填写/提交验收`
            : "表单字段已不明显或已离开表单页",
      };
    }
    case "delivery_ready": {
      const ok = reality.deliveryReady && reality.topResults.length > 0;
      return {
        ok,
        detail: ok
          ? "交付条件已满足：SERP 查询对齐且有自然结果"
          : "交付未就绪：须等自然搜索结果加载完成",
      };
    }
    case "any":
      return { ok: true, detail: "软验收 any" };
    default:
      return { ok: false, detail: `未知 expect.kind` };
  }
}

/**
 * 按顺序用 PageReality 推进计划：仅当前及之前待完成步在 expect 通过时 mark done。
 * 返回本轮新完成的步骤 id。
 * 表单类 expect 不自动验收（由填写/提交工具路径 mark）。
 */
export function syncPlanStepsFromReality(
  mem: WorkingMemory,
  reality: PageReality,
  goal: string,
): { marked: string[]; blocked: { id: string; detail: string } | null } {
  const marked: string[] = [];
  let blocked: { id: string; detail: string } | null = null;
  for (let i = 0; i < mem.plan.steps.length; i += 1) {
    const s = mem.plan.steps[i]!;
    if (s.status === "done" || s.status === "skipped") {
      continue;
    }
    if (isTerminalPlanStep(s) && s.id === "finish") {
      break;
    }
    if (s.verifyKind === "deliver" || s.id === "deliver" || s.id === "read") {
      const exp: StepExpect =
        s.expect ??
        (s.id === "read" ? { kind: "has_organic_results" } : { kind: "delivery_ready" });
      const v = verifyExpect(reality, exp, goal);
      if (v.ok) {
        s.status = "done";
        marked.push(s.id);
        rememberFact(mem, `验收·${s.id}：${v.detail}`);
        continue;
      }
      blocked = { id: s.id, detail: v.detail };
      break;
    }
    const exp = s.expect;
    if (!exp) {
      blocked = { id: s.id, detail: "缺少 expect，需工具推进后再验收" };
      break;
    }
    if (exp.kind === "form_fields_filled") {
      blocked = {
        id: s.id,
        detail: "表单步须由填写/提交工具验收",
      };
      break;
    }
    if (exp.kind === "any") {
      // 软步：允许推进，不阻塞大脑闭环
      s.status = "done";
      marked.push(s.id);
      continue;
    }
    const v = verifyExpect(reality, exp, goal);
    if (v.ok) {
      s.status = "done";
      marked.push(s.id);
      rememberFact(mem, `验收·${s.id}：${v.detail}`);
      continue;
    }
    blocked = { id: s.id, detail: v.detail };
    break;
  }
  const nextIdx = mem.plan.steps.findIndex(
    (s) => s.status !== "done" && s.status !== "skipped",
  );
  if (nextIdx >= 0) {
    mem.currentStepIndex = nextIdx;
    if (mem.plan.steps[nextIdx]!.status === "pending") {
      mem.plan.steps[nextIdx]!.status = "doing";
    }
  } else {
    mem.currentStepIndex = Math.max(0, mem.plan.steps.length - 1);
  }
  return { marked, blocked };
}

/** 目标是否还含语言之外的实质工作（注册/填表/搜索/下载/加购等） */
export function goalHasFollowUpWork(goal: string): boolean {
  const g = String(goal ?? "");
  return (
    /填|注册|登录|表单|资料|结账|搜索|查找|总结|分析|下载|提交|邀请码|password|register|login|sign\s*up|checkout/i.test(
      g,
    ) || goalHasPostAuthIntent(g)
  );
}

/** 登录/注册之后还有购物等业务（禁止登录成功就 finish） */
export function goalHasPostAuthIntent(goal: string): boolean {
  return /加购|加入购物车|加到购物车|放进购物车|购物车|第一个商品|第一件商品|结算|下单|checkout|add\s*to\s*cart|buy\s*now|加入清单/i.test(
    String(goal ?? ""),
  );
}

/**
 * 公开演示站标准账号（SauceDemo 等）——目标写明「标准账号」时可用，禁止再 ask_user 要密码。
 */
export function resolveKnownDemoCredentials(goal: string): {
  username: string;
  password: string;
  reason: string;
} | null {
  const g = String(goal ?? "");
  const sauce =
    /saucedemo\.com|saucedemo|swag\s*labs/i.test(g) ||
    (/标准账号|standard_user|标准用户/i.test(g) && /sauce|swag/i.test(g));
  // 目标含 saucedemo URL/站名，且要登录
  const sauceLogin =
    /saucedemo\.com|saucedemo|swag\s*labs/i.test(g) &&
    /登录|login|sign\s*in|标准账号|standard/i.test(g);
  if (sauce || sauceLogin) {
    if (/locked_out|problem_user|performance_glitch|error_user|visual_user/i.test(g)) {
      return null;
    }
    return {
      username: "standard_user",
      password: "secret_sauce",
      reason: "SauceDemo 公开标准演示账号（非私密）",
    };
  }
  return null;
}

/** 从目标抽取邀请码等显式常量（通用，无站点特例） */
export function extractExplicitFormHints(goal: string): string[] {
  const g = String(goal ?? "");
  const hints: string[] = [];
  const demo = resolveKnownDemoCredentials(g);
  if (demo) {
    hints.push(`用户名=${demo.username}`);
    hints.push(`密码=${demo.password}`);
    hints.push(demo.reason);
  }
  const invite = g.match(/邀请码\s*[：:=]?\s*([A-Za-z0-9_-]{3,32})/i);
  if (invite?.[1]) {
    hints.push(`邀请码=${invite[1]}`);
  }
  const phone = g.match(/(?:手机|电话|手机号)\s*[：:=]?\s*(\+?\d[\d\s-]{6,18}\d)/);
  if (phone?.[1]) {
    hints.push(`手机=${phone[1].replace(/\s+/g, "")}`);
  }
  const email = g.match(
    /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/,
  );
  if (email?.[1] && !/example\.com/i.test(email[1])) {
    hints.push(`邮箱=${email[1]}`);
  }
  if (/其他随机|其余随机|随机填写|随便填|随机即可|均可随机|所有信息都随机|全部.*随机|都随机/i.test(g)) {
    hints.push("其余字段含密码均可随机生成并在完成后回传");
  }
  return hints;
}

/**
 * 用户明确授权随机填表（含密码）时：非 OTP/验证码墙字段允许随机。
 * 覆盖：「其他随机」「所有信息都随机」「全部随机」「都随机」等。
 */
export function goalAllowsRandomFill(goal: string): boolean {
  const g = String(goal ?? "");
  return /其他随机|其余随机|随机填写|随便填|随机即可|均可随机|密码随机|随机密码|所有信息都随机|全部信息都随机|全部都随机|全都随机|信息都随机|字段都随机|资料都随机|随机资料|资料随机|随机填|用随机|全部随机|都随机|全部.*随机|所有.*随机|随机.*资料|随机.*填/i.test(
    g,
  );
}

/** 目标要求希伯来语 / 以色列本地资料 — 见 fill_locale.goalWantsHebrewLocale */
// （实现已迁至 fill_locale.ts，此处 re-export）

/** 字段标签是否像身份/地址表单项（多语种） */
const IDENTITY_FIELD_RE =
  /用户名|账号|email|邮箱|手機|手机|姓名|name|username|full\s*name|phone|mobile|tel|地址|street|city|address|邮编|zip|postal|门牌|楼|单元|公寓|entrance|floor|apartment|house|שם|משפחה|אימייל|דוא"?ל|טלפון|רחוב|עיר|יישוב|מספר|דירה|קומה|כניסה|מיקוד|כתובת|اسم|عنوان|姓名|住所|이름|주소/i;

/** @deprecated 使用 generateLocaleFieldValue(label, "he") */
export function generateRandomMobileIl(): string {
  return generateMobileForLocale("he");
}

/** @deprecated 使用 generateLocaleFieldValue */
export function generateHebrewLocaleValue(label: string): string | null {
  return generateLocaleFieldValue(label, "he");
}

/** 生成可回传的随机密码（默认 6 位数字，同批密码字段共用） */
export function generateRandomPassword(length = 6): string {
  const n = Math.max(4, Math.min(12, length));
  let out = "";
  for (let i = 0; i < n; i += 1) {
    out += String(Math.floor(Math.random() * 10));
  }
  return out;
}

/** 生成随机新加坡风格手机号（8 位，8/9 开头） */
export function generateRandomMobileSg(): string {
  return generateMobileForLocale("en");
}

/** 按目标语种选择手机号格式 */
export function generateRandomMobileForGoal(goal: string): string {
  const locale = resolveFillLocale(goal)?.kind ?? "en";
  return generateMobileForLocale(locale);
}

/** 按目标 + 字段标签解析应使用的填资料语种 */
export function resolveFieldFillLocale(goal: string, label: string): FillLocaleKind {
  return resolveFillLocale(goal)?.kind ?? inferLocaleFromFieldLabel(label) ?? "en";
}

/** 无 LLM 时的启发式计划（保证「每次任务必有计划」） */
export function buildHeuristicPlan(goal: string): TaskPlan {
  const kind = classifyTaskKind(goal);
  const url = extractUrlFromGoal(goal);
  const steps: BrainPlanStep[] = [];
  const risks: string[] = [];
  const successCriteria: string[] = [];
  const formHints = extractExplicitFormHints(goal);
  const hostToken = hostTokenFromUrl(url);
  const searchQuery = extractSearchQueryFromGoal(goal) ?? undefined;

  if (url || kind === "navigate" || kind === "language" || kind === "mixed" || kind === "form") {
    if (url) {
      steps.push(
        step(
          "nav",
          `打开目标站 ${url}`,
          "URL 已变为目标域名",
          "agent_navigate",
          "nav",
          { kind: "url_matches", hostIncludes: hostToken },
        ),
      );
    }
  }

  if (kind === "language" || (kind === "mixed" && isLanguageSwitchGoal(goal))) {
    const target = resolveLanguageTarget(goal).label;
    steps.push(
      step(
        "lang_open",
        "找到并点击语言入口（地球仪/Language/EN 等通用特征）",
        "语言菜单展开或入口被点中",
        "click_visible_text",
        "language",
        { kind: "lang_is", langLabel: target },
      ),
      step(
        "lang_pick",
        `选择 ${target}`,
        `界面语言变为 ${target}`,
        "click_visible_text",
        "language",
        { kind: "lang_is", langLabel: target },
      ),
    );
    successCriteria.push(`界面语言切换为 ${target}`);
    if (goalHasFollowUpWork(goal)) {
      risks.push("语言切换只是中间步：验收后必须继续后续注册/填表/搜索，禁止提前 finish_task");
    } else {
      risks.push("语言入口可能是图标不在控件 JSON，须用感知图或视觉提问");
    }
  }

  if (kind === "search_deliver" || (kind === "mixed" && /搜索|总结|分析/i.test(goal))) {
    steps.push(
      step(
        "search",
        "在搜索框【填写】目标词并提交（Enter 或点搜索按钮）",
        "进入检索结果页且查询词对齐目标",
        "agent_batch_fill(need_enter) / agent_fill_and_click(fill+click_id)",
        "search",
        { kind: "search_query_eq", queryHint: searchQuery },
      ),
      step(
        "read",
        "阅读结果（知识卡或第一条）",
        "取得可读摘要",
        "read_page_content",
        "deliver",
        { kind: "has_organic_results", queryHint: searchQuery },
      ),
    );
    if (/总结|分析|提取|简化|理解|告诉我|发给我/i.test(goal)) {
      steps.push(
        step(
          "deliver",
          "按目标交付分析/总结",
          "finish_task.summary 含答案",
          "finish_task",
          "deliver",
          { kind: "delivery_ready", queryHint: searchQuery },
        ),
      );
      successCriteria.push("finish_task.summary 含用户要的分析内容");
    }
  }

  if (kind === "form" || (kind === "mixed" && /填|注册|登录|邀请码|资料|结账|checkout/i.test(goal))) {
    const hintLine = formHints.length ? `；已知：${formHints.join("；")}` : "";
    const fillLocale = resolveFillLocale(goal);
    const localeHint = fillLocale
      ? `；资料语种=${fillLocale.label}（生成该语种姓名·电话·地址，禁止切网站语言）`
      : "";
    steps.push(
      step(
        "form_scan",
        "识别表单字段并判断每格来源（AI可算/页内/用户私密/目标常量）",
        "字段清单与来源标签就绪",
        "感知图 + 判断大脑",
        "form",
        { kind: "form_fields_filled" },
      ),
      step(
        "form_fill",
        `按判断结果批量填写${hintLine}${localeHint}；目标含「随机」时密码也可随机；OTP/验证码墙仍须人工`,
        "必填项已填且非幻觉",
        "agent_batch_fill / ask_user",
        "form",
        { kind: "form_fields_filled" },
      ),
      step(
        "form_submit",
        "勾选协议复选框（若有）后点击「立即注册/提交/אישור」主按钮——禁止点「开户协议」链接",
        "成功提示或离开注册/登录页",
        "agent_batch_fill(click_id=立即注册/אישור类按钮)",
        "form",
        { kind: "form_fields_filled" },
      ),
    );
    successCriteria.push("表单按目标完成且无私密幻觉");
    if (fillLocale) {
      successCriteria.push(`表单值使用${fillLocale.label}格式（非切换 UI 语言）`);
      risks.push("「用X语填写」=资料语种，禁止点语言菜单/地球仪");
    }
    if (formHints.length) {
      successCriteria.push(`目标给定常量已写入：${formHints.join("，")}`);
    }
    if (goalAllowsRandomFill(goal)) {
      successCriteria.push("随机生成的账号/密码等须写入 finish_task.summary 回传用户");
    }
    risks.push("OTP/验证码墙必须人工；显式邀请码原样填写；提交钮勿点协议链接");
  }

  if (goalHasPostAuthIntent(goal)) {
    steps.push(
      step(
        "cart_add",
        "将列表中第一个商品加入购物车（点 Add to cart / 加入购物车）",
        "按钮变为 Remove 或购物车数量增加",
        "click_visible_text",
        "generic",
      ),
    );
    successCriteria.push("第一个商品已加入购物车");
    risks.push("登录/填表只是中间步：必须完成加购后再 finish_task，禁止登录成功就收工");
  }

  if (kind === "download" || /下载|保存图/i.test(goal)) {
    steps.push(
      step("dl", "定位资源并下载落盘", "本地路径可读", "scrape_page_data @download / file_download", "generic", {
        kind: "any",
      }),
    );
    successCriteria.push("下载文件已落盘");
  }

  if (steps.length === 0) {
    steps.push(
      step("explore", "理解页面并推进用户目标", "页面状态向目标靠近", "感知 + 合适工具", "generic", {
        kind: "any",
      }),
      step("finish", "确认目标达成后结束", "finish_task", "finish_task", "finish", { kind: "any" }),
    );
    successCriteria.push("用户目标语义完成");
  } else if (!steps.some((s) => s.id === "finish" || s.id === "deliver")) {
    steps.push(
      step(
        "finish",
        "全部前置步骤验收通过后 finish_task",
        "成功标准全部满足",
        "finish_task",
        "finish",
        { kind: "any" },
      ),
    );
  }

  if (!successCriteria.length) {
    successCriteria.push("用户目标已实质完成");
  }
  risks.push("卡住时用判断/重规划，勿空转；验证码墙 handover；未完成步骤禁止 finish");
  risks.push("BrainKernel：步完成必须由页面现实 expect 验收，禁止旁路口头收工");

  return {
    goalRestated: goal.trim(),
    taskKind: kind,
    steps: steps.map((s, i) => ({ ...s, status: i === 0 ? "doing" : "pending" })),
    successCriteria,
    risks,
    source: "heuristic",
  };
}

function parsePlanJson(raw: string): TaskPlan | null {
  const text = String(raw ?? "").trim();
  const body = stripFencedJson(text);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const obj = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    const stepsRaw = Array.isArray(obj.steps) ? obj.steps : [];
    const steps: BrainPlanStep[] = stepsRaw
      .map((row, index) => {
        const r = row as Record<string, unknown>;
        const id = String(r.id ?? `s${index + 1}`);
        const intent = String(r.intent ?? r.title ?? "").trim() || `步骤 ${index + 1}`;
        const expectedSignal =
          String(r.expectedSignal ?? r.expected ?? "").trim() || "页面出现预期变化";
        const toolsHint = String(r.toolsHint ?? r.tools ?? "").trim() || "合适工具";
        const s = step(id, intent, expectedSignal, toolsHint, inferVerifyKind(id, intent, toolsHint));
        return s;
      })
      .filter((s) => s.intent.length > 0);
    if (steps.length === 0) {
      return null;
    }
    steps[0]!.status = "doing";
    const kind = String(obj.taskKind ?? "other") as TaskPlan["taskKind"];
    return {
      goalRestated: String(obj.goalRestated ?? obj.goal ?? "").trim() || "（未复述）",
      taskKind: [
        "navigate",
        "language",
        "form",
        "search_deliver",
        "download",
        "mixed",
        "other",
      ].includes(kind)
        ? kind
        : "other",
      steps,
      successCriteria: Array.isArray(obj.successCriteria)
        ? obj.successCriteria.map((x) => String(x))
        : ["目标完成"],
      risks: Array.isArray(obj.risks) ? obj.risks.map((x) => String(x)) : [],
      source: "llm",
    };
  } catch {
    return null;
  }
}

function inferVerifyKind(
  id: string,
  intent: string,
  toolsHint: string,
): BrainPlanStep["verifyKind"] {
  const blob = `${id} ${intent} ${toolsHint}`;
  if (/finish|deliver|交付|收工/i.test(blob)) {
    return "finish";
  }
  if (/^nav|导航|打开|goto|navigate/i.test(blob)) {
    return "nav";
  }
  if (/lang|语言|hebrew|english|中文|locale/i.test(blob)) {
    return "language";
  }
  if (/form|填|注册|登录|邀请|表单|batch_fill/i.test(blob)) {
    return "form";
  }
  if (/search|搜索|查找|read_page/i.test(blob)) {
    return "search";
  }
  return "generic";
}

/** 计划是否覆盖目标里的每个子意图（防 LLM 压成 3~5 步漏注册/漏语言） */
export function planCoversGoalIntents(plan: TaskPlan, goal: string): {
  ok: boolean;
  missing: string[];
} {
  const g = String(goal ?? "");
  const missing: string[] = [];
  const kinds = new Set(
    plan.steps.map((s) => s.verifyKind).filter(Boolean) as Array<
      NonNullable<BrainPlanStep["verifyKind"]>
    >,
  );
  const ids = plan.steps.map((s) => s.id).join(" ");
  const intents = plan.steps.map((s) => s.intent).join(" ");
  const blob = `${ids} ${intents}`;

  if (extractUrlFromGoal(g) && !kinds.has("nav") && !/nav|导航|打开/i.test(blob)) {
    missing.push("nav");
  }
  if (isLanguageSwitchGoal(g) && !kinds.has("language") && !/lang|语言|中文|hebrew|english/i.test(blob)) {
    missing.push("language");
  }
  if (
    /填|注册|登录|邀请码|表单|register|login|sign\s*up/i.test(g) &&
    !kinds.has("form") &&
    !/form|填|注册|登录|邀请/i.test(blob)
  ) {
    missing.push("form");
  }
  if (
    /搜索|查找|百度|google|bing/i.test(g) &&
    !kinds.has("search") &&
    !/search|搜索|查找/i.test(blob)
  ) {
    missing.push("search");
  }
  if (
    /总结|分析|提取|告诉我|发给我|第一条/i.test(g) &&
    !kinds.has("deliver") &&
    !/deliver|read|总结|分析|交付/i.test(blob)
  ) {
    missing.push("deliver");
  }
  return { ok: missing.length === 0, missing };
}

/**
 * 以启发式骨架为准：LLM 计划若漏子意图则丢弃。
 * 混合/表单/语言/搜索 —— 一律确定性拆分，禁止 flash「压成 5 步」漏步骤。
 */
export async function createTaskPlan(
  goal: string,
  aiSettings: SidecarAiSettings,
  logger: JsonLogger,
): Promise<TaskPlan> {
  const heuristic = buildHeuristicPlan(goal);
  const key = aiSettings.apiKey?.trim();
  if (!key) {
    logger.progress("brain_plan_heuristic", { reason: "no_api_key", kind: heuristic.taskKind });
    return heuristic;
  }

  // 可结构化拆分的任务：禁止 LLM 压缩步骤（历史 bug：提示词写「步骤 2~5 个」导致漏注册）
  const skipLlmPlan =
    heuristic.taskKind === "mixed" ||
    heuristic.taskKind === "form" ||
    heuristic.taskKind === "language" ||
    heuristic.taskKind === "search_deliver" ||
    heuristic.taskKind === "navigate" ||
    heuristic.taskKind === "download" ||
    goalHasFollowUpWork(goal) ||
    isLanguageSwitchGoal(goal);

  if (skipLlmPlan) {
    logger.progress("brain_plan_ready", {
      source: "heuristic_fast",
      kind: heuristic.taskKind,
      steps: heuristic.steps.length,
      stepIds: heuristic.steps.map((s) => s.id),
      reason: "结构化目标用完整启发式拆分，禁止 LLM 压缩漏步",
    });
    return heuristic;
  }

  const planAbort = new AbortController();
  const PLAN_TIMEOUT_MS = 8_000;
  const timer = setTimeout(() => planAbort.abort(), PLAN_TIMEOUT_MS);

  try {
    const { route, client } = createModelRouter(aiSettings).forIntent(
      "logic",
      "大脑规划：深度逻辑模型",
    );
    const model = route.model;
    logger.agentState("running", {
      step: 0,
      msg: `大脑规划中… · ${model}`,
    });

    const response = await client.chat.completions.create(
      {
        model,
        temperature: 0.2,
        max_tokens: 900,
        messages: [
          {
            role: "system",
            content:
              "你是任务规划器。只用中文。输出唯一 JSON，不要 Markdown。" +
              '字段: goalRestated, taskKind(navigate|language|form|search_deliver|download|mixed|other), ' +
              "steps[{id,intent,expectedSignal,toolsHint}], successCriteria[], risks[]。" +
              "硬规则：用户目标里每个子意图必须单独成步（打开/切语言/注册填表/搜索/交付不可合并）；" +
              "步骤数按需要 3~10 个；密码/OTP 禁止幻想；最后一步可为 finish_task。",
          },
          {
            role: "user",
            content: [
              `【用户目标】${goal}`,
              `【完整骨架参考·不可删减子意图】${heuristic.steps.map((s) => s.id).join(" → ")}`,
              "请给出执行计划 JSON（必须覆盖参考骨架中的全部子意图）。",
            ].join("\n"),
          },
        ],
      },
      { signal: planAbort.signal },
    );
    const content = extractAssistantContent(response);
    const parsed = parsePlanJson(content);
    if (parsed) {
      const cover = planCoversGoalIntents(parsed, goal);
      if (!cover.ok) {
        logger.warn("brain_plan_llm_incomplete", {
          missing: cover.missing,
          llmSteps: parsed.steps.map((s) => s.id),
          fallback: "heuristic",
        });
      } else {
        logger.progress("brain_plan_ready", {
          source: "llm",
          model,
          kind: parsed.taskKind,
          steps: parsed.steps.length,
          stepIds: parsed.steps.map((s) => s.id),
        });
        return parsed;
      }
    } else {
      logger.warn("brain_plan_parse_failed", { preview: content.slice(0, 200) });
    }
  } catch (error) {
    logger.warn("brain_plan_llm_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }

  logger.progress("brain_plan_ready", {
    source: "heuristic",
    kind: heuristic.taskKind,
    steps: heuristic.steps.length,
    stepIds: heuristic.steps.map((s) => s.id),
  });
  return heuristic;
}

export function createWorkingMemory(plan: TaskPlan): WorkingMemory {
  return {
    plan,
    currentStepIndex: 0,
    facts: [],
    replanCount: 0,
    lastJudgments: [],
    recentActions: [],
    tabsState: [],
  };
}

/** 参与动作级熔断的工具（读页/收工/问答不计入） */
const ACTION_LOOP_TOOLS = new Set([
  "agent_navigate",
  "agent_fill_and_click",
  "agent_batch_fill",
  "agent_switch_tab",
  "agent_hover",
  "agent_scroll",
  "click_visible_text",
  "ask_vision_locate",
  "click_viewport",
]);

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(obj[key])}`)
    .join(",")}}`;
}

/** 规范化工具参数 JSON，保证签名可比较 */
export function normalizeToolArgsJson(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text) {
    return "{}";
  }
  try {
    return stableJsonStringify(JSON.parse(text));
  } catch {
    return text.replace(/\s+/g, " ").slice(0, 400);
  }
}

/** 精确动作签名：TOOL:name|ARG:{...} */
export function buildActionSignature(toolName: string, argsRaw: string): string {
  const name = String(toolName ?? "").trim();
  return `TOOL:${name}|ARG:${normalizeToolArgsJson(argsRaw)}`;
}

export function isActionLoopTool(toolName: string): boolean {
  return ACTION_LOOP_TOOLS.has(String(toolName ?? "").trim());
}

export function recordRecentAction(
  mem: WorkingMemory,
  signature: string,
  structureHash: string,
): void {
  const sig = String(signature ?? "").trim();
  const hash = String(structureHash ?? "").trim() || "empty";
  if (!sig) {
    return;
  }
  mem.recentActions.push({ signature: sig, structureHash: hash });
  if (mem.recentActions.length > 3) {
    mem.recentActions.splice(0, mem.recentActions.length - 3);
  }
}

export function clearRecentActions(mem: WorkingMemory): void {
  mem.recentActions = [];
}

export interface ActionHallucinationCheckInput {
  memory: WorkingMemory;
  toolName: string;
  signature: string;
  structureHash: string;
  goal: string;
}

/**
 * 动作级幻觉熔断：当前工具+参数与过去 3 次某条完全一致，且结构指纹未变 → 死循环。
 * 不再依赖 languagePhase / isMenuOpened 等站点状态机记忆。
 */
export function shouldBreakActionHallucination(
  input: ActionHallucinationCheckInput,
): { break: boolean; reason: string; matchCount: number } {
  const toolName = String(input.toolName ?? "").trim();
  if (!isActionLoopTool(toolName)) {
    return { break: false, reason: "", matchCount: 0 };
  }
  const signature = String(input.signature ?? "").trim();
  const structureHash = String(input.structureHash ?? "").trim() || "empty";
  if (!signature) {
    return { break: false, reason: "", matchCount: 0 };
  }

  const matches = input.memory.recentActions.filter(
    (row) => row.signature === signature && row.structureHash === structureHash,
  );
  const matchCount = matches.length;
  if (matchCount === 0) {
    return { break: false, reason: "", matchCount: 0 };
  }

  return {
    break: true,
    reason: "系统检测到重复无效操作",
    matchCount,
  };
}

export function formatPlanForLlm(plan: TaskPlan): string {
  const lines = [
    BRAIN_PLAN_MARK,
    `目标复述：${plan.goalRestated}`,
    `任务类型：${plan.taskKind} · 来源=${plan.source}`,
    "步骤（按序推进，完成当前步再进入下一步）：",
  ];
  for (let i = 0; i < plan.steps.length; i += 1) {
    const s = plan.steps[i]!;
    lines.push(
      `${i + 1}. [${s.status}] ${s.id} · ${s.intent} → 信号:${s.expectedSignal}` +
        (s.expect ? ` · expect:${s.expect.kind}` : "") +
        ` · 工具:${s.toolsHint}`,
    );
  }
  lines.push(`成功标准：${plan.successCriteria.join("；")}`);
  if (plan.risks.length) {
    lines.push(`风险：${plan.risks.join("；")}`);
  }
  return lines.join("\n");
}

export function formatWorkingMemoryForLlm(mem: WorkingMemory): string {
  const cur = mem.plan.steps[mem.currentStepIndex];
  const recent =
    mem.recentActions.length > 0
      ? mem.recentActions
          .map((row) => `${row.signature.slice(0, 96)}@${row.structureHash.slice(0, 8)}`)
          .join(" ‖ ")
      : "";
  const tabsBlock =
    mem.tabsState && mem.tabsState.length > 0
      ? formatTabsStateForLlm(mem.tabsState)
      : "tabs_state: []";
  const lines = [
    BRAIN_MEMORY_MARK,
    `当前步骤 ${mem.currentStepIndex + 1}/${mem.plan.steps.length}` +
      (cur ? `：[${cur.status}] ${cur.intent}` : "：（已完成或越界）"),
    cur ? `期望信号：${cur.expectedSignal}` : "",
    cur?.expect
      ? `机检 expect：${cur.expect.kind}${cur.expect.queryHint ? `(${cur.expect.queryHint})` : ""}${cur.expect.hostIncludes ? `(${cur.expect.hostIncludes})` : ""}`
      : "",
    mem.facts.length ? `已知事实：${mem.facts.slice(-8).join("；")}` : "已知事实：（无）",
    mem.lastJudgments.length
      ? `最近判断：${mem.lastJudgments.slice(-4).join(" | ")}`
      : "",
    recent ? `最近动作签名：${recent}` : "",
    tabsBlock,
    `重规划次数：${mem.replanCount}`,
  ];
  return lines.filter(Boolean).join("\n");
}

export function rememberFact(mem: WorkingMemory, fact: string): void {
  const t = fact.trim();
  if (!t) {
    return;
  }
  if (!mem.facts.includes(t)) {
    mem.facts.push(t);
  }
  if (mem.facts.length > 20) {
    mem.facts.splice(0, mem.facts.length - 20);
  }
}

export function advancePlanStep(mem: WorkingMemory, note?: string): void {
  const cur = mem.plan.steps[mem.currentStepIndex];
  if (cur && cur.status === "doing") {
    cur.status = "done";
  }
  if (note) {
    rememberFact(mem, note);
  }
  const next = mem.currentStepIndex + 1;
  if (next < mem.plan.steps.length) {
    mem.currentStepIndex = next;
    mem.plan.steps[next]!.status = "doing";
  }
}

/** 是否为终结步骤（可 finish，不算「未完成工作」） */
export function isTerminalPlanStep(step: BrainPlanStep): boolean {
  return (
    step.verifyKind === "finish" ||
    step.id === "finish" ||
    step.id === "deliver" ||
    /^finish_task$/i.test(step.toolsHint.trim())
  );
}

/** 尚未验收的实质工作步骤（不含 finish/deliver） */
export function listPendingWorkSteps(mem: WorkingMemory): BrainPlanStep[] {
  return mem.plan.steps.filter(
    (s) => s.status !== "done" && s.status !== "skipped" && !isTerminalPlanStep(s),
  );
}

/** 将某类步骤标为完成，并把指针移到下一未完成步 */
export function markStepsDoneByVerifyKind(
  mem: WorkingMemory,
  kind: NonNullable<BrainPlanStep["verifyKind"]>,
  note?: string,
): number {
  let marked = 0;
  for (const s of mem.plan.steps) {
    if (s.status === "done" || s.status === "skipped") {
      continue;
    }
    const match =
      s.verifyKind === kind ||
      (kind === "language" && /^lang_/i.test(s.id)) ||
      (kind === "nav" && s.id === "nav") ||
      (kind === "form" && /^form_/i.test(s.id)) ||
      (kind === "search" && /^search$/i.test(s.id));
    if (match) {
      s.status = "done";
      marked += 1;
    }
  }
  if (note) {
    rememberFact(mem, note);
  }
  const nextIdx = mem.plan.steps.findIndex(
    (s) => s.status !== "done" && s.status !== "skipped",
  );
  if (nextIdx >= 0) {
    mem.currentStepIndex = nextIdx;
    if (mem.plan.steps[nextIdx]!.status === "pending") {
      mem.plan.steps[nextIdx]!.status = "doing";
    }
  }
  return marked;
}

/** 分步教练：当前该做什么、还剩什么、禁止提前 finish */
export function formatStepProgressCoach(mem: WorkingMemory): string {
  const pending = listPendingWorkSteps(mem);
  const cur = mem.plan.steps[mem.currentStepIndex];
  const lines = [
    "【分步执行】按计划严格推进：完成当前步并验收信号后，再进入下一步。",
  ];
  if (cur && !isTerminalPlanStep(cur)) {
    lines.push(
      `当前步 ${mem.currentStepIndex + 1}/${mem.plan.steps.length}：${cur.intent}（期望：${cur.expectedSignal}；工具：${cur.toolsHint}）`,
    );
  }
  if (pending.length > 0) {
    lines.push(
      `未验收工作还剩 ${pending.length} 步：${pending.map((s) => s.id).join(" → ")}。在全部完成前禁止 finish_task。`,
    );
  } else {
    lines.push("实质工作步骤已全部验收，可以 finish_task。");
  }
  return lines.join("\n");
}

export function markCurrentStepFailed(mem: WorkingMemory, reason: string): void {
  const cur = mem.plan.steps[mem.currentStepIndex];
  if (cur) {
    cur.status = "failed";
  }
  rememberFact(mem, `步骤失败：${reason}`);
}

/** 简单算术求解（判断大脑：工具不会做题，AI/规则会） */
export function trySolveArithmetic(label: string): string | null {
  const m = String(label ?? "").match(MATH_IN_LABEL_RE);
  if (!m) {
    return null;
  }
  const a = Number(m[1]);
  const op = m[2];
  const b = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return null;
  }
  let result: number;
  switch (op) {
    case "+":
      result = a + b;
      break;
    case "-":
      result = a - b;
      break;
    case "*":
    case "×":
    case "x":
    case "X":
      result = a * b;
      break;
    case "/":
    case "÷":
      if (b === 0) {
        return null;
      }
      result = a / b;
      break;
    default:
      return null;
  }
  if (!Number.isFinite(result)) {
    return null;
  }
  return Number.isInteger(result) ? String(result) : String(Math.round(result * 1000) / 1000);
}

export function judgeField(input: {
  label: string;
  inputType?: string;
  name?: string;
  proposedValue: string;
  goal: string;
  pageTextBlob?: string;
}): FieldJudgment {
  const blob = `${input.label} ${input.inputType ?? ""} ${input.name ?? ""}`;
  const proposed = String(input.proposedValue ?? "").trim();

  if (CAPTCHA_RE.test(blob) && !OTP_FIELD_RE.test(blob)) {
    return {
      source: "human_wall",
      reason: "图形人机验证：非文本填空；AI 视觉点选/滑块（满 3 次再 HITL）",
      blockFill: true,
      askQuestion: undefined,
    };
  }

  if (SECRET_FIELD_RE.test(blob) || String(input.inputType ?? "").toLowerCase() === "password") {
    const demo = resolveKnownDemoCredentials(input.goal);
    if (demo) {
      return {
        source: "context",
        reason: demo.reason,
        resolvedValue: demo.password,
        blockFill: false,
      };
    }
    const goalHasPwd = /密码[「"'：:\s]*([^\s「」"']+)/i.exec(input.goal);
    if (goalHasPwd?.[1]) {
      return {
        source: "context",
        reason: "密码来自用户目标明文",
        resolvedValue: goalHasPwd[1],
        blockFill: false,
      };
    }
    // 用户明确随机：密码也可随机，禁止再 ask_user
    if (goalAllowsRandomFill(input.goal)) {
      const pwd =
        proposed && proposed.length >= 4 && !/请提供|随机|password/i.test(proposed)
          ? proposed
          : generateRandomPassword(6);
      return {
        source: "context",
        reason: "用户授权其他随机（含密码）",
        resolvedValue: pwd,
        blockFill: false,
      };
    }
    // 放宽：有拟填密码 → 不弹 ask_user，交给「人工确认」框一次核对/修改
    if (proposed && proposed.length >= 1 && !/请提供|请确认并提供/i.test(proposed)) {
      return {
        source: "ok_as_is",
        reason: "拟填密码，仅在确认框核对（可改），禁止二次索密",
        resolvedValue: proposed,
        blockFill: false,
      };
    }
    // 无拟填值：仍不 ask_user，留空进确认框让用户填写（只弹一次确认）
    return {
      source: "ok_as_is",
      reason: "密码留空，请在确认框填写",
      resolvedValue: "",
      blockFill: false,
    };
  }

  if (OTP_FIELD_RE.test(blob)) {
    return {
      source: "user_otp",
      reason: "短信/邮箱/验证器动态码：必须人工确认提供，禁止 AI 猜码",
      blockFill: true,
      askQuestion: `请输入收到的验证码（短信/邮箱/验证器；先确保已点击发送或打开验证器）。`,
    };
  }

  const math = trySolveArithmetic(input.label) ?? trySolveArithmetic(proposed);
  if (math) {
    return {
      source: "ai_solve",
      reason: `算术题由判断大脑计算 → ${math}`,
      resolvedValue: math,
      blockFill: false,
    };
  }

  // 页内可得：proposed 已在页面正文出现
  const page = String(input.pageTextBlob ?? "");
  if (proposed && page && page.includes(proposed) && proposed.length >= 2) {
    return {
      source: "page_derive",
      reason: "拟填值可在页面正文中找到",
      resolvedValue: proposed,
      blockFill: false,
    };
  }

  if (proposed) {
    return {
      source: "ok_as_is",
      reason: "非私密字段，采用模型/上下文值",
      resolvedValue: proposed,
      blockFill: false,
    };
  }

  // 空值 + 像必填名/邮箱/地址（含希伯来语结账字段）
  if (IDENTITY_FIELD_RE.test(blob)) {
    const demo = resolveKnownDemoCredentials(input.goal);
    if (demo && /用户名|账号|username|user\s*name|name|שם/i.test(blob) && !/email|邮箱|手机|טלפון|אימייל/i.test(blob)) {
      return {
        source: "context",
        reason: demo.reason,
        resolvedValue: demo.username,
        blockFill: false,
      };
    }
    if (goalAllowsRandomFill(input.goal)) {
      let generated = proposed;
      if (!generated) {
        const locale = resolveFieldFillLocale(input.goal, blob);
        generated = generateLocaleFieldValue(blob, locale) ?? "";
        if (!generated) {
          if (/手机|mobile|phone|tel|טלפון|נייד/i.test(blob)) {
            generated = generateMobileForLocale(locale);
          } else if (/email|邮箱|אימייל|דוא"?ל/i.test(blob)) {
            generated = `user${Date.now().toString(36).slice(-6)}@example.com`;
          } else {
            generated =
              generateLocaleFieldValue("full name", locale) ??
              `user${Date.now().toString(36).slice(-6)}`;
          }
        }
      }
      const localeSpec = resolveFillLocale(input.goal);
      return {
        source: "context",
        reason: localeSpec
          ? `用户授权随机（资料语种=${localeSpec.label}）`
          : "用户授权其他随机",
        resolvedValue: generated,
        blockFill: false,
      };
    }
    return {
      source: "ask_clarify",
      reason: "关键身份字段为空",
      blockFill: true,
      askQuestion: `请提供「${input.label || "该字段"}」的值。`,
    };
  }

  return {
    source: "ok_as_is",
    reason: "空值非私密，交由后续逻辑",
    resolvedValue: proposed,
    blockFill: false,
  };
}

export interface JudgedFillItem {
  id: string;
  value: string;
  judgment: FieldJudgment;
  /** 单字段置信度 0~1（用于合并确认门禁） */
  confidence: number;
}

const FILL_CONFIRM_THRESHOLD = 0.55;

function scoreSingleFillConfidence(input: {
  label: string;
  value: string;
  goal: string;
  judgment: FieldJudgment;
}): number {
  let score = 0.4;
  const value = String(input.value ?? "").trim();
  const goal = String(input.goal ?? "");
  if (!value) {
    return 0.2;
  }
  if (input.judgment.source === "ai_solve" || input.judgment.source === "page_derive" || input.judgment.source === "ok_as_is") {
    score += 0.35;
  }
  if (input.judgment.source === "context") {
    score += 0.45;
  }
  if (input.judgment.blockFill) {
    return 0.15;
  }
  // 密码拟填：略抬置信，但仍常低于跳过阈值 → 只走一次确认框
  if (/密码|password/i.test(input.label) && value && input.judgment.source === "ok_as_is") {
    score += 0.15;
  }
  if (goal.includes(value) || /公开|演示|SauceDemo|标准账号/i.test(input.judgment.reason)) {
    score += 0.25;
  } else if (value.length >= 2) {
    try {
      if (new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(goal)) {
        score += 0.2;
      }
    } catch {
      /* ignore bad pattern */
    }
  }
  if (/密码|password|otp|验证码|card/i.test(`${input.label} ${value}`) && input.judgment.source === "user_secret") {
    score = Math.max(score, 0.7);
  }
  if (/密码|password/i.test(input.label) && !goal.includes(value) && input.judgment.source === "ok_as_is") {
    score -= 0.25;
  }
  return Math.min(1, Math.max(0, score));
}

/**
 * 对 fill_data 做判断大脑门禁：可改值、可要求 ask_user（仅 OTP）、可因人机墙要求 handover。
 * 密码：不 ask_user，统一进一次人工确认框编辑。
 * 批量时统一算置信度：任一字段 <0.55 → needsHumanConfirm（一次合并确认，不拆窗）。
 */
export function judgeFillBatch(input: {
  fills: Array<{ id: string; value: string; label: string; inputType?: string; name?: string }>;
  goal: string;
  pageTextBlob?: string;
}): {
  items: JudgedFillItem[];
  needAskUser: string | null;
  needHandover: string | null;
  summaryLines: string[];
  fieldScores: Array<{ id: string; score: number; label: string }>;
  batchScore: number;
  needsHumanConfirm: boolean;
  lowConfidenceIds: string[];
} {
  const items: JudgedFillItem[] = [];
  const summaryLines: string[] = [];
  const fieldScores: Array<{ id: string; score: number; label: string }> = [];
  let needAskUser: string | null = null;
  let needHandover: string | null = null;
  const allowRandom = goalAllowsRandomFill(input.goal);
  /** 同批密码字段共用一个随机值，便于回传 */
  let sharedRandomPassword: string | null = null;

  for (const fill of input.fills) {
    let judgment = judgeField({
      label: fill.label,
      inputType: fill.inputType,
      name: fill.name,
      proposedValue: fill.value,
      goal: input.goal,
      pageTextBlob: input.pageTextBlob,
    });
    // 同批密码统一：登录/重复/交易密码共用
    const blob = `${fill.label} ${fill.inputType ?? ""} ${fill.name ?? ""}`;
    if (
      allowRandom &&
      (SECRET_FIELD_RE.test(blob) || String(fill.inputType ?? "").toLowerCase() === "password")
    ) {
      if (!sharedRandomPassword) {
        sharedRandomPassword =
          judgment.resolvedValue && String(judgment.resolvedValue).length >= 4
            ? String(judgment.resolvedValue)
            : generateRandomPassword(6);
      }
      judgment = {
        source: "context",
        reason: "用户授权其他随机（同批密码共用）",
        resolvedValue: sharedRandomPassword,
        blockFill: false,
      };
    }
    const value = judgment.resolvedValue !== undefined ? judgment.resolvedValue : fill.value;
    const confidence = scoreSingleFillConfidence({
      label: fill.label,
      value,
      goal: input.goal,
      judgment,
    });
    items.push({ id: fill.id, value, judgment, confidence });
    fieldScores.push({ id: fill.id, score: confidence, label: fill.label || fill.id });
    summaryLines.push(
      `${fill.label || fill.id}:${judgment.source}(${judgment.reason}) c=${confidence.toFixed(2)}`,
    );

    if (judgment.source === "human_wall") {
      needHandover = judgment.reason;
    } else if (
      judgment.blockFill &&
      judgment.askQuestion &&
      !needAskUser &&
      // 密码不再触发 ask_user；仅 OTP/验证码墙问题进入 ask
      /验证码|otp|sms|动态码|mfa|2fa/i.test(judgment.askQuestion + judgment.reason + fill.label)
    ) {
      needAskUser = judgment.askQuestion;
    }
  }

  const lowConfidenceIds = fieldScores
    .filter((row) => row.score + 1e-9 < FILL_CONFIRM_THRESHOLD)
    .map((row) => row.id);
  const batchScore =
    fieldScores.length === 0
      ? 1
      : fieldScores.reduce((sum, row) => sum + row.score, 0) / fieldScores.length;
  // 任一低置信 → 整批一次确认（打包全部字段，不逐个弹窗）
  const needsHumanConfirm = lowConfidenceIds.length > 0;

  return {
    items,
    needAskUser,
    needHandover,
    summaryLines,
    fieldScores,
    batchScore,
    needsHumanConfirm,
    lowConfidenceIds,
  };
}

/** 启发式：目标可能已达成 → 注入强提示立刻 finish_task */
export function buildEarlyFinishAlert(input: {
  goal: string;
  currentUrl: string;
  memory: WorkingMemory;
  prevUrl?: string;
}): string | null {
  const goal = String(input.goal ?? "");
  const url = String(input.currentUrl ?? "");
  const prev = String(input.prevUrl ?? "");
  const deliverable = /总结|分析|提取|告诉我|发给我|简化|理解|第一条|回复我/i.test(goal);
  const pending = listPendingWorkSteps(input.memory);

  // 仍有未验收工作：禁止催 finish（混合任务最关键）
  if (pending.length > 0) {
    return (
      `[SYSTEM ALERT]: 计划仍有未验收步骤「${pending.map((s) => s.id).join("、")}」。` +
      "禁止 finish_task。请只推进当前步骤并验收 expectedSignal。"
    );
  }

  // 简单打开站：已在目标域（含后续操作意图时禁止此短路，必须继续 Planner）
  if (goalIsNavigateOnly(goal)) {
    try {
      const host = new URL(url).hostname.replace(/^www\./i, "");
      if (host && goal.toLowerCase().includes(host.split(".")[0] || host)) {
        return (
          "[SYSTEM ALERT]: The page URL indicates successful navigation. " +
          "If the goal is met, call finish_task NOW. 禁止继续 read_page_content/分析。"
        );
      }
      if (/百度|baidu/i.test(goal) && /baidu\.com/i.test(url)) {
        return (
          "[SYSTEM ALERT]: 已打开百度。目标仅为打开站点时请立刻 finish_task，禁止继续分析。"
        );
      }
    } catch {
      /* ignore */
    }
  }

  // 提交/登录后跳出 login 路由（且无未完成步骤）
  if (
    prev &&
    /login|signin|sign-in|注册|register/i.test(prev) &&
    !/login|signin|sign-in|register|signup/i.test(url) &&
    /登录|注册|提交|填|sign\s*in|register|log\s*in/i.test(goal) &&
    !deliverable
  ) {
    return (
      "[SYSTEM ALERT]: The page URL indicates successful navigation/submission " +
      `(left auth route → ${url}). If the goal is met, call finish_task NOW. ` +
      "禁止为确认再 read_page_content。"
    );
  }

  return null;
}

/** finish 前验收：未完成步骤 / 空总结 / 未解私密 / 交付未就绪 → 拒绝 */
export function verifyBeforeFinish(input: {
  goal: string;
  summary: string;
  memory: WorkingMemory;
  reality?: PageReality | null;
}): { ok: boolean; reason: string } {
  const summary = String(input.summary ?? "").trim();
  if (!summary) {
    return { ok: false, reason: "finish_task.summary 为空" };
  }
  const pending = listPendingWorkSteps(input.memory);
  if (pending.length > 0) {
    return {
      ok: false,
      reason: `仍有未验收步骤：${pending.map((s) => `${s.id}(${s.intent})`).join("；")}。请先完成再 finish_task`,
    };
  }
  // 汇报类：有实质内容即过；放宽长度，避免「还要再分析」死循环
  if (/总结|分析|提取|告诉我|发给我/i.test(input.goal) && summary.length < 6) {
    return { ok: false, reason: "汇报类目标的 summary 过短，可能未真正交付" };
  }
  if (
    input.reality &&
    /总结|分析|提取|告诉我|发给我|第一条/i.test(input.goal)
  ) {
    const v = verifyExpect(input.reality, { kind: "delivery_ready" }, input.goal);
    if (!v.ok) {
      return { ok: false, reason: `交付现实未达标：${v.detail}` };
    }
  }
  const pendingSecrets = input.memory.lastJudgments.some((j) =>
    /user_secret|user_otp|幻想/.test(j),
  );
  if (pendingSecrets && /密码|验证码/.test(summary) && !/已请用户|用户已提供|ask_user/i.test(summary)) {
    return { ok: false, reason: "仍有未解决的私密字段判断，不能宣称完成" };
  }
  if (/尚无匹配目标的完成信号|待提交|未点击.*注册|未点击.*提交/i.test(summary)) {
    return {
      ok: false,
      reason: "summary 已表明提交/完成信号未就绪，禁止 finish_task",
    };
  }
  return { ok: true, reason: "分步验收通过：无未完成工作步骤" };
}

/** 卡住时：一次重规划（失败则返回启发式补丁说明） */
export async function replanAfterStuck(input: {
  goal: string;
  memory: WorkingMemory;
  pageUrl: string;
  perceiveHits: string[];
  lastToolName?: string;
  lastToolOk?: boolean;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
}): Promise<{ memory: WorkingMemory; coach: string }> {
  const mem = input.memory;
  mem.replanCount += 1;
  markCurrentStepFailed(mem, "同页卡住触发重规划");

  const fallbackCoach = [
    `【判断大脑·重规划 #${mem.replanCount}】`,
    `当前 URL=${input.pageUrl}`,
    `原步骤失败：${mem.plan.steps[mem.currentStepIndex]?.intent ?? "?"}`,
    "请换策略：改用 click_visible_text / 感知图短文案；私密字段 ask_user；验证码墙 handover。",
    "禁止重复无效点击；禁止幻想密码。",
  ].join("\n");

  if (!input.aiSettings.apiKey?.trim() || mem.replanCount > 3) {
    return { memory: mem, coach: fallbackCoach };
  }

  try {
    // 深度逻辑：卡住重规划属于核心推理纠偏
    const { route, client } = createModelRouter(input.aiSettings).forIntent(
      "logic",
      "大脑重规划：深度逻辑模型",
    );
    const model = route.model;
    input.logger.agentState("running", {
      step: 0,
      msg: `大脑重规划中… · ${model}`,
    });
    const response = await client.chat.completions.create({
      model,
      temperature: 0.3,
      max_tokens: 800,
      messages: [
        {
          role: "system",
          content:
            "你是浏览器任务纠偏器。根据卡住现场给出下一步具体方向（中文，短）。" +
            "不要输出密码幻想。可建议 click_visible_text / ask_user / handover / navigate。" +
            "同时可输出修订 steps JSON（可选）。",
        },
        {
          role: "user",
          content: [
            `目标：${input.goal}`,
            formatPlanForLlm(mem.plan),
            formatWorkingMemoryForLlm(mem),
            `URL=${input.pageUrl}`,
            `感知命中=${input.perceiveHits.join(",") || "无"}`,
            `上步工具=${input.lastToolName ?? "?"} ok=${input.lastToolOk ?? "?"}`,
            "请给出：1) 三句内具体下一步；2) 可选修订计划 JSON。",
          ].join("\n"),
        },
      ],
    });
    const content = extractAssistantContent(response).trim();
    const parsed = parsePlanJson(content);
    if (parsed) {
      // 保留已完成步骤事实，替换剩余计划
      const doneFacts = mem.plan.steps.filter((s) => s.status === "done").map((s) => `已完成:${s.intent}`);
      mem.plan = parsed;
      mem.currentStepIndex = 0;
      for (const f of doneFacts) {
        rememberFact(mem, f);
      }
    }
    input.logger.progress("brain_replan_done", {
      replanCount: mem.replanCount,
      model,
      replacedPlan: Boolean(parsed),
    });
    return {
      memory: mem,
      coach: `【判断大脑·重规划 #${mem.replanCount}】\n${truncateText(content, 600)}`,
    };
  } catch (error) {
    input.logger.warn("brain_replan_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { memory: mem, coach: fallbackCoach };
  }
}

export function planMonitorLine(plan: TaskPlan): string {
  const chain = plan.steps
    .filter((s) => !isTerminalPlanStep(s))
    .map((s) => s.id)
    .join("→");
  const tail = plan.steps.some(isTerminalPlanStep) ? "→finish" : "";
  return `计划就绪 · ${plan.taskKind} · ${plan.steps.length} 步（${plan.source}）· ${chain}${tail}`;
}

/** 跨任务同站控件记忆（见 cross_task_memory.ts） */
export {
  CONTROL_MEMORY_MARK,
  PER_DOMAIN_CAP,
  type ControlMemoryEntry,
} from "./cross_task_memory.js";

/**
 * 动作意图层：根据目标 + 控件类型，决定「该填还是该点」。
 * 规则优先于 LLM 空想，减少空转思考。
 */
import type { AgentLlmElement } from "./interactive_elements.js";
import {
  extractExplicitFormHints,
  extractSearchQueryFromGoal,
  extractUrlFromGoal,
} from "./agent_brain.js";
import { isLanguageSwitchGoal, resolveLanguageTarget } from "./language_switch.js";
import { serpQueryMatchesGoal } from "./page_read.js";

export { extractSearchQueryFromGoal };

export type ActionKind = "navigate" | "fill" | "click" | "read" | "finish";

export interface ProposedAction {
  kind: ActionKind;
  /** 具体工具名 */
  tool: string;
  confidence: number;
  /** 给执行层 / LLM 的参数草案 */
  args: Record<string, unknown>;
  reason: string;
  /** ≥0.9 且非私密时可由主循环自动执行一次 */
  autoExecutable: boolean;
}

export interface ActionIntentInput {
  goal: string;
  taskKind?: string;
  url: string;
  llmJson: AgentLlmElement[];
  perceiveGoalHits?: string[];
  pageReadingQuery?: string | null;
  pageReadingReady?: boolean;
  /** 本结构指纹是否已自动执行过，防死循环 */
  alreadyAutoRan?: boolean;
  /** 页面现实已匹配目标语言 → 禁止再点语言芯片 */
  langMatched?: boolean;
}

const FILLABLE_RE = /searchbox|textbox|combobox|input|textarea|password|email|tel|number|search/i;
const CLICKABLE_RE = /button|link|tab|menuitem|checkbox|radio|switch/i;

function normalizeId(id: unknown): string {
  return String(id ?? "").trim();
}

function elBlob(el: AgentLlmElement): string {
  return [el.text, el.placeholder, el.name, el.type, (el as { label?: string }).label]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function findSearchFillable(llmJson: AgentLlmElement[]): AgentLlmElement | null {
  const rows = Array.isArray(llmJson) ? llmJson : [];
  const AI_MODE_NOISE =
    /ai\s*mode|gemini|bard|copilot|chatgpt|人工智能模式|智能问答|问\s*ai|ask\s*ai/i;
  const blobOf = (el: AgentLlmElement) =>
    [el.text, el.placeholder, el.name, el.type].filter(Boolean).join(" ").toLowerCase();

  const scored = rows
    .filter((el) => FILLABLE_RE.test(String(el.type ?? "")))
    .map((el) => {
      const blob = blobOf(el);
      let score = 0;
      if (AI_MODE_NOISE.test(blob)) {
        score -= 50;
      }
      if (/searchbox/i.test(String(el.type ?? ""))) {
        score += 20;
      }
      if (/search|搜索|查找|query|wd\b|q\b|keyword|搜/i.test(blob)) {
        score += 12;
      }
      if (/^q$|^wd$/i.test(String(el.name ?? "").trim())) {
        score += 18;
      }
      return { el, score };
    })
    .filter((row) => row.score >= 8)
    .sort((a, b) => b.score - a.score);
  if (scored[0]) {
    return scored[0].el;
  }
  const boxes = rows.filter((el) => {
    if (!/textbox|searchbox|input/i.test(String(el.type ?? ""))) {
      return false;
    }
    return !AI_MODE_NOISE.test(blobOf(el));
  });
  return boxes.length === 1 ? boxes[0]! : boxes[0] ?? null;
}

export function findSubmitClickable(
  llmJson: AgentLlmElement[],
  goal: string,
): AgentLlmElement | null {
  const rows = Array.isArray(llmJson) ? llmJson : [];
  const prefer =
    /百度一下|搜索|search|submit|go|查找|登录|注册|提交|下一步|next|立即注册|马上注册|注册账号|sign\s*up|create\s*account|register(\s*now)?|join(\s*now)?|אישור|המשך|לתשלום|סיום|שלח|הירשמ|הרשמ|confirm/i;
  const scored = rows
    .filter((el) => CLICKABLE_RE.test(String(el.type ?? "")) || prefer.test(elBlob(el)))
    .map((el) => {
      const blob = elBlob(el);
      const type = String(el.type ?? "").toLowerCase();
      let score = 0;
      // 协议/条款链接：绝不能当提交钮（历史误点「开户协议」）
      if (
        isAgreementOrTermsClickLabel(blob) ||
        (/协议|条款|条约|agreement|treaty|terms|privacy|policy|知晓并同意|已阅读|תקנון|פרטיות|תנאי\s*שימוש|הסכם/i.test(blob) &&
          !isPrimarySubmitClickLabel(blob))
      ) {
        score -= 40;
      }
      if (/百度一下|google\s*search|search|搜索一下/i.test(blob)) {
        score += 10;
      }
      if (/立即注册|马上注册|注册账号|create\s*account|sign\s*up\s*now|register(\s*now)?|join(\s*now)?/i.test(blob)) {
        score += 18;
      }
      if (/אישור|המשך|לתשלום|סיום|שלח|הירשמ|הרשמ/i.test(blob)) {
        score += 16;
      }
      // 欢迎/条款确认弹窗按钮不是业务提交钮
      if (/^i\s*know$|^got\s*it$|אני\s*יודע|知道了|我知道了|仅关闭|close\s*dialog/i.test(blob) && !/注册|register|sign\s*up|הירשמ/i.test(blob)) {
        score -= 20;
      }
      if (
        (/提交|submit|登录|注册|下一步|confirm/i.test(blob) || /אישור|המשך/i.test(blob)) &&
        /填|登录|注册|表单|资料|结账|checkout/i.test(goal)
      ) {
        score += 8;
      }
      if (/button/i.test(type)) {
        score += 4;
      }
      if (/link/i.test(type) && isAgreementOrTermsClickLabel(blob)) {
        score -= 25;
      }
      if (/button/i.test(type) && isPrimarySubmitClickLabel(blob)) {
        score += 10;
      }
      return { el, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.el ?? null;
}

/** 主 CTA（提交/注册）——命中则绝不当成协议链接 */
export function isPrimarySubmitClickLabel(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) {
    return false;
  }
  return /立即注册|马上注册|提交注册|注册账号|sign\s*up(\s*now)?|create\s*account|register(\s*now)?|join(\s*now)?|登录|登入|提交|下一步|confirm|pay\s*now|checkout|אישור|המשך|לתשלום|סיום|שלח|הירשמ|הרשמ/i.test(
    t,
  );
}

/**
 * 点击目标是否像「协议/条款/隐私」文档链（非主提交钮）。
 * 覆盖 EN agreement/treaty/terms、中文协议/条款、希伯来 תקנון 等；禁止站点特例。
 */
export function isAgreementOrTermsClickLabel(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) {
    return false;
  }
  // 主 CTA 优先：即使文案里碰巧含 agree，也不当协议链
  if (isPrimarySubmitClickLabel(t)) {
    return false;
  }
  // 纯复选框确认短句（无文档名）允许点，用于勾选同意
  if (
    /^(i\s*(know\s+and\s+)?agree|agree|同意|我同意|已阅读并同意|אני\s*מסכים|מאשר)$/i.test(t) &&
    !/agreement|treaty|terms|privacy|policy|协议|条款|条约|תקנון|הסכם/i.test(t)
  ) {
    return false;
  }
  return /\bagreement\b|\btreat(?:y|ies)\b|\bterms(?:\s+of\s+(?:service|use|use\s+and\s+service))?\b|\bprivacy(?:\s+policy)?\b|\bpolicy\b|\beula\b|\btos\b|disclaimer|协议|条款|条约|开户协议|用户协议|服务协议|隐私(?:政策|权)?|知晓并同意|已阅读并同意|תקנון|פרטיות|תנאי\s*שימוש|הסכם/i.test(
    t,
  );
}

function hostMatchesGoalUrl(url: string, goalUrl: string): boolean {
  try {
    const a = new URL(url.includes("://") ? url : `https://${url}`);
    const b = new URL(goalUrl.includes("://") ? goalUrl : `https://${goalUrl}`);
    return a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");
  } catch {
    return url.toLowerCase().includes(
      goalUrl.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0] ?? "",
    );
  }
}

function isOnSerp(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("baidu.com") && (u.pathname.startsWith("/s") || u.searchParams.has("wd"))) {
      return true;
    }
    if (host.includes("google.") && (u.pathname.startsWith("/search") || u.searchParams.has("q"))) {
      return true;
    }
    if (host.includes("bing.com") && (u.pathname.startsWith("/search") || u.searchParams.has("q"))) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function countFillables(llmJson: AgentLlmElement[]): number {
  return llmJson.filter((el) => FILLABLE_RE.test(String(el.type ?? ""))).length;
}

/**
 * 提出 1~3 条下一步动作：明确「填」还是「点」。
 */
export function proposeNextActions(input: ActionIntentInput): ProposedAction[] {
  const goal = String(input.goal ?? "");
  const url = String(input.url ?? "");
  const llmJson = Array.isArray(input.llmJson) ? input.llmJson : [];
  const out: ProposedAction[] = [];
  const taskKind = String(input.taskKind ?? "");

  // 0) 导航：目标 URL 尚未到达
  const goalUrl = extractUrlFromGoal(goal);
  if (goalUrl && !hostMatchesGoalUrl(url, goalUrl)) {
    out.push({
      kind: "navigate",
      tool: "agent_navigate",
      confidence: 0.95,
      args: { url: goalUrl, reason: "目标站尚未打开" },
      reason: "输入框/按钮都还没意义：先打开目标站（navigate，禁止当地址栏填表）",
      autoExecutable: false, // 导航通常已 bootstrap；勿重复
    });
  }

  // 1) 交付：结果页已对齐 → 读/收工（点读不是填）
  const deliverable = /总结|分析|提取|告诉我|发给我|第一条|简化|理解/i.test(goal);
  if (
    deliverable &&
    (input.pageReadingReady ||
      (isOnSerp(url) && serpQueryMatchesGoal(goal, input.pageReadingQuery)))
  ) {
    out.push({
      kind: "read",
      tool: "read_page_content",
      confidence: 0.9,
      args: { reason: "结果页已就绪，读取后 finish" },
      reason: "已在正确结果页：应 read_page_content，再 finish_task（不要再填搜索框）",
      autoExecutable: false,
    });
    out.push({
      kind: "finish",
      tool: "finish_task",
      confidence: 0.85,
      args: { summary: "（根据页面阅读写入答案）" },
      reason: "交付类目标：答案写入 finish_task.summary",
      autoExecutable: false,
    });
    return out.slice(0, 3);
  }

  // 2) 切语言：只点不填（若还有注册/填表等后续，不在此提前 return）
  const followUpWork =
    /填|注册|登录|搜索|邀请码|表单|资料|结账|总结|分析|下载|checkout/i.test(goal) ||
    taskKind === "mixed" ||
    taskKind === "form";
  if ((isLanguageSwitchGoal(goal) || taskKind === "language") && !followUpWork) {
    if (input.langMatched) {
      out.push({
        kind: "finish",
        tool: "finish_task",
        confidence: 0.9,
        args: { summary: "界面语言已匹配目标语", success: true },
        reason: "语言信号已匹配：应 finish_task，禁止再点语言芯片",
        autoExecutable: false,
      });
      return out.slice(0, 3);
    }
    const target = resolveLanguageTarget(goal);
    const hit =
      (input.perceiveGoalHits ?? []).find((t) =>
        target.pickTexts.some((p) => t.toLowerCase().includes(p.toLowerCase())),
      ) ?? target.pickTexts[0];
    out.push({
      kind: "click",
      tool: "click_visible_text",
      confidence: 0.88,
      args: { text: hit, reason: `切到 ${target.label}` },
      reason: `切语言是点击任务：点「${hit}」/语言入口，禁止往输入框填语言名`,
      autoExecutable: false,
    });
    return out.slice(0, 3);
  }
  // 混合：语言 + 后续 → 仅当语言尚未匹配且表单未展开时先点语言
  if (isLanguageSwitchGoal(goal) && followUpWork && !input.langMatched && countFillables(llmJson) < 2) {
    const target = resolveLanguageTarget(goal);
    out.push({
      kind: "click",
      tool: "click_visible_text",
      confidence: 0.75,
      args: { text: target.pickTexts[0], reason: `若未切语言先点 ${target.label}` },
      reason: `混合任务：先确保语言为 ${target.label}（点击），验收后再【填写】注册/表单字段，禁止因语言完成而 finish`,
      autoExecutable: false,
    });
    // 继续往下提表单建议，不 return
  }

  // 3) 搜索：先填关键词 + Enter/提交键（禁止只点搜索框）
  const wantSearch =
    taskKind === "search_deliver" ||
    /搜索|查找|搜一下|百度|google|bing/i.test(goal);
  if (wantSearch && !isOnSerp(url)) {
    const query = extractSearchQueryFromGoal(goal);
    const box = findSearchFillable(llmJson);
    const submit = findSubmitClickable(llmJson, goal);
    if (query && box) {
      const boxId = normalizeId(box.id);
      const submitId = submit ? normalizeId(submit.id) : "";
      out.push({
        kind: "fill",
        tool: submitId ? "agent_fill_and_click" : "agent_batch_fill",
        confidence: 0.93,
        args: submitId
          ? {
              fill_data: [{ id: boxId, value: query, need_enter: false }],
              click_id: submitId,
              reason: `搜索「${query}」并点击提交`,
              confidence: 0.9,
            }
          : {
              fields: [{ short_id: boxId, value: query, need_enter: true }],
              reason: `搜索框填「${query}」并回车`,
              confidence: 0.9,
            },
        reason: `搜索框(id=${boxId},type=${box.type})必须【填写】「${query}」，禁止只点击输入框；${
          submitId ? `再【点击】提交 id=${submitId}` : "无提交钮则 need_enter=true 回车"
        }`,
        autoExecutable: !input.alreadyAutoRan,
      });
      return out.slice(0, 3);
    }
    if (query && !box) {
      out.push({
        kind: "click",
        tool: "click_visible_text",
        confidence: 0.55,
        args: { text: "搜索", reason: "未见搜索框，尝试点开搜索入口" },
        reason: `目标要搜「${query}」但控件 JSON 无 searchbox：可先点「搜索」入口，仍禁止把关键词当按钮点`,
        autoExecutable: false,
      });
    }
  }

  // 已在 SERP 但查询不符 → 重新填写
  if (wantSearch && isOnSerp(url) && input.pageReadingQuery && !serpQueryMatchesGoal(goal, input.pageReadingQuery)) {
    const query = extractSearchQueryFromGoal(goal);
    const box = findSearchFillable(llmJson);
    if (query && box) {
      out.push({
        kind: "fill",
        tool: "agent_batch_fill",
        confidence: 0.92,
        args: {
          fields: [{ short_id: normalizeId(box.id), value: query, need_enter: true }],
          reason: `页内词「${input.pageReadingQuery}」不符，重搜「${query}」`,
        },
        reason: `结果词不符：必须【重新填写】搜索框，禁止总结旧页`,
        autoExecutable: !input.alreadyAutoRan,
      });
      return out.slice(0, 3);
    }
  }

  // 4) 表单：多输入框 → 批量填；提交钮 → 点
  const fillCount = countFillables(llmJson);
  const wantForm =
    taskKind === "form" ||
    taskKind === "mixed" ||
    /填|注册|登录|表单|资料|结账|sign\s*up|login|register|checkout/i.test(goal);
  if (wantForm && fillCount >= 2) {
    const ids = llmJson
      .filter((el) => FILLABLE_RE.test(String(el.type ?? "")))
      .slice(0, 8)
      .map((el) => normalizeId(el.id));
    const submit = findSubmitClickable(llmJson, goal);
    const hints = extractExplicitFormHints(goal);
    const inviteHint = hints.find((h) => h.startsWith("邀请码="));
    const inviteVal = inviteHint?.split("=")[1] ?? "";
    const fields = ids.map((id) => {
      const el = llmJson.find((row) => normalizeId(row.id) === id);
      const blob = el ? elBlob(el) : "";
      const value =
        inviteVal && /邀请|invite|referral|code|推荐/i.test(blob) ? inviteVal : "";
      return { short_id: id, value };
    });
    out.push({
      kind: "fill",
      tool: "agent_batch_fill",
      confidence: input.langMatched || isLanguageSwitchGoal(goal) ? 0.88 : 0.8,
      args: {
        fields,
        click_id: submit ? normalizeId(submit.id) : undefined,
        reason: `多字段一次填完${hints.length ? `；${hints.join("；")}` : ""}${
          input.langMatched ? "；语言已就绪直接填" : ""
        }`,
        allow_hallucination_for_non_critical: /随机|其他随机|其余随机|资料/i.test(goal),
      },
      reason: `页面有 ${fillCount} 个输入框：必须 agent_batch_fill【填写】短id=[${ids.join(",")}]${
        inviteVal ? `；邀请码「${inviteVal}」写入匹配字段` : ""
      }；密码/OTP 用 ask_user；最后再【点击】提交（含 אישור）。未完成禁止 finish；禁止再点语言芯片`,
      autoExecutable: false,
    });
    return out.slice(0, 3);
  }

  // 5) 通用：有明显按钮文案命中目标 → 点；有单一输入且目标像填值 → 填
  const goalTokens = goal.match(/[\u4e00-\u9fff]{2,8}|[A-Za-z]{3,16}/g) ?? [];
  for (const el of llmJson) {
    if (!CLICKABLE_RE.test(String(el.type ?? ""))) {
      continue;
    }
    const blob = elBlob(el);
    if (goalTokens.some((t) => blob.includes(t.toLowerCase()) && t.length >= 2)) {
      out.push({
        kind: "click",
        tool: "agent_fill_and_click",
        confidence: 0.7,
        args: {
          fill_data: [],
          click_id: normalizeId(el.id),
          reason: `点击与目标相关的「${el.text || el.id}」`,
        },
        reason: `控件 id=${el.id} type=${el.type} 是按钮/链接 →【点击】，不要 fill`,
        autoExecutable: false,
      });
      break;
    }
  }

  if (out.length === 0 && fillCount === 1) {
    const box = findSearchFillable(llmJson);
    if (box) {
      out.push({
        kind: "fill",
        tool: "agent_fill_and_click",
        confidence: 0.6,
        args: { fill_data: [{ id: normalizeId(box.id), value: "" }], reason: "唯一输入框" },
        reason: `唯一输入框 id=${box.id} → 应【填写】，禁止只点击该框`,
        autoExecutable: false,
      });
    }
  }

  if (out.length === 0) {
    out.push({
      kind: "click",
      tool: "click_visible_text",
      confidence: 0.4,
      args: { text: "", reason: "根据感知图选择可见文案" },
      reason: "无高置信草案：对照【可见感知图】— 输入类填、按钮类点；禁止空转",
      autoExecutable: false,
    });
  }

  return out.slice(0, 3);
}

/** 注入 LLM 的硬决策块 */
export function formatActionIntentForLlm(actions: ProposedAction[]): string | null {
  if (!actions.length) {
    return null;
  }
  const lines = [
    "【动作决策·填还是点】",
    "硬规则：searchbox/textbox/input → 必须调用填表工具写入文字；button/link/短文案 → 点击；打开站 → agent_navigate；结果齐了 → read/finish。",
    "禁止：只点击搜索框却不填词；把关键词当成按钮文案去 click_visible_text。",
  ];
  actions.forEach((a, i) => {
    lines.push(
      `${i + 1}. [${a.kind}·${a.confidence.toFixed(2)}] ${a.tool} · ${a.reason}`,
    );
  });
  const top = actions[0];
  if (top && top.confidence >= 0.8) {
    lines.push(`本轮优先执行第 1 条（${top.kind}），必须 tool_call，禁止只思考。`);
  }
  return lines.join("\n");
}

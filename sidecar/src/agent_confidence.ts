/**
 * Agent 填表/点击置信度：≥ CONFIRM_SKIP_THRESHOLD 时跳过人工确认。
 */

import type { AgentFillAndClickArgs } from "./agent_tools.js";
import type { AgentExtractResult } from "./interactive_elements.js";

export const CONFIRM_SKIP_THRESHOLD = 0.55;

const CLICK_INTENT_RE =
  /注册|登录|提交|确认|下一步|发送|go\s*to\s*register|register|sign\s*up|login|submit|confirm|next|send|forgot\s*password|忘记密码/i;

const HOME_OR_LOGO_RE = /^(home|首页|主页|logo|返回首页|back\s*home)$/i;

const FIELD_HINTS: Array<{ keys: RegExp; valueFromGoal: RegExp }> = [
  {
    keys: /用户名|账号|account|username|user\s*name|手机|email|邮箱/i,
    valueFromGoal: /用户名[「"'：:\s]*([^\s「」"']+)/i,
  },
  {
    keys: /邀请码|invite|referral|code/i,
    valueFromGoal: /邀请码[「"'：:\s]*([A-Za-z0-9]+)/i,
  },
  {
    keys: /密码|password|pwd/i,
    valueFromGoal: /密码[「"'：:\s]*([^\s「」"']+)/i,
  },
];

function extractGoalValues(goal: string): string[] {
  const values: string[] = [];
  const patterns = [
    /用户名[「"'：:\s]*([^\s「」"']+)/i,
    /邀请码[「"'：:\s]*([A-Za-z0-9]+)/i,
    /密码[「"'：:\s]*([^\s「」"']+)/i,
    /[「"']([^「」"']+)[」"']/g,
    /https?:\/\/[^\s「」"']+/gi,
  ];
  for (const pattern of patterns) {
    if (pattern.global) {
      for (const match of goal.matchAll(pattern)) {
        if (match[1]) {
          values.push(match[1].trim());
        } else if (match[0]) {
          values.push(match[0].trim());
        }
      }
    } else {
      const match = goal.match(pattern);
      if (match?.[1]) {
        values.push(match[1].trim());
      }
    }
  }
  return values.filter((value) => value.length > 0);
}

export interface ConfidenceBreakdown {
  score: number;
  reasons: string[];
}

/**
 * 综合评分 0~1：id 有效、点击文案与目标匹配、填入值来自目标等。
 */
export function scoreAgentActionConfidence(
  goal: string,
  extract: AgentExtractResult,
  args: AgentFillAndClickArgs,
  llmConfidence?: number,
): ConfidenceBreakdown {
  const reasons: string[] = [];
  let score = 0.35; // 基线：工具调用本身有一定可信度

  const fillData = Array.isArray(args.fill_data) ? args.fill_data : [];
  const clickId = args.click_id?.trim() ?? "";
  const goalValues = extractGoalValues(goal);
  const goalLower = goal.toLowerCase();

  let allIdsValid = true;
  for (const item of fillData) {
    const id = String(item.id ?? "").trim();
    if (!extract.element_map.has(id)) {
      allIdsValid = false;
      break;
    }
  }
  if (clickId && !extract.element_map.has(clickId)) {
    allIdsValid = false;
  }
  if (!allIdsValid) {
    return { score: 0, reasons: ["存在无效元素 id"] };
  }
  score += 0.15;
  reasons.push("元素 id 均有效");

  if (clickId) {
    const clickRef = extract.element_map.get(clickId);
    const clickText = (clickRef?.text ?? "").trim();
    if (HOME_OR_LOGO_RE.test(clickText)) {
      return { score: 0.2, reasons: [`点击目标疑似首页/Logo：「${clickText}」`] };
    }
    if (CLICK_INTENT_RE.test(clickText)) {
      score += 0.25;
      reasons.push(`点击文案匹配操作意图：「${clickText}」`);
      if (CLICK_INTENT_RE.test(goal)) {
        score += 0.1;
        reasons.push("用户目标含注册/登录等动作词");
      }
    } else if (clickText) {
      score += 0.05;
      reasons.push(`点击文案一般：「${clickText}」`);
    }
  } else if (fillData.length > 0) {
    score += 0.05;
    reasons.push("仅填表无点击");
  }

  if (fillData.length > 0) {
    let matched = 0;
    for (const item of fillData) {
      const id = String(item.id ?? "").trim();
      const value = String(item.value ?? "").trim();
      const ref = extract.element_map.get(id);
      if (!value) {
        continue;
      }
      const inGoal =
        goalValues.some((candidate) => candidate === value || goal.includes(value)) ||
        goalLower.includes(value.toLowerCase());
      if (inGoal) {
        matched += 1;
        continue;
      }
      const blob = `${ref?.text ?? ""} ${ref?.tagName ?? ""}`;
      for (const hint of FIELD_HINTS) {
        if (hint.keys.test(blob) && hint.valueFromGoal.test(goal)) {
          matched += 0.5;
          break;
        }
      }
    }
    const ratio = matched / fillData.length;
    score += Math.min(0.25, ratio * 0.25);
    if (ratio >= 0.8) {
      reasons.push("多数填写值可在用户目标中找到");
    } else if (ratio >= 0.4) {
      reasons.push("部分填写值与目标相关");
    } else {
      reasons.push("填写值与目标关联较弱");
      score -= 0.1;
    }
  }

  // 纯点击「去注册」且目标也要求注册 → 高置信
  if (fillData.length === 0 && clickId) {
    const clickText = extract.element_map.get(clickId)?.text ?? "";
    if (/register|注册|go\s*to\s*register/i.test(clickText) && /注册|register/i.test(goal)) {
      score = Math.max(score, 0.88);
      reasons.push("纯点击注册入口且目标明确要求注册");
    }
  }

  if (typeof llmConfidence === "number" && Number.isFinite(llmConfidence)) {
    const clamped = Math.min(1, Math.max(0, llmConfidence));
    score = score * 0.7 + clamped * 0.3;
    reasons.push(`模型自报置信度 ${clamped.toFixed(2)}`);
  }

  score = Math.min(1, Math.max(0, score));
  return { score, reasons };
}

export function shouldSkipHumanConfirm(breakdown: ConfidenceBreakdown): boolean {
  return breakdown.score + 1e-9 >= CONFIRM_SKIP_THRESHOLD;
}

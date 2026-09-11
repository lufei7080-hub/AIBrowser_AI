/**
 * 验证码表单索引：从 selectorMap（与 browser_state [index] 同源）解析输入框/提交按钮。
 * 文本优先匹配，不因 tag/role 过严而漏掉「验证答案（我可以点击！！！）」一类 link。
 */
import type { IndexedElementRef } from "./views.js";

export type CaptchaFormHints = {
  inputIndex: number | null;
  submitIndex: number | null;
  inputLabel: string;
  submitLabel: string;
};

function blobOf(el: IndexedElementRef): string {
  return [el.text, el.placeholder, el.name, el.role, el.tagName, el.inputType ?? ""]
    .filter(Boolean)
    .join(" ");
}

function isInputish(el: IndexedElementRef): boolean {
  return (
    el.tagName === "input" ||
    el.tagName === "textarea" ||
    /textbox|input|searchbox/i.test(el.role ?? "") ||
    el.inputType === "text" ||
    el.inputType === "number" ||
    el.inputType === "search"
  );
}

/** 可点控件：含 a/button/role，以及任意带明确提交文案的交互节点 */
function isClickableSubmitCandidate(el: IndexedElementRef, blob: string): boolean {
  if (/提交参赛|参赛代码/i.test(blob)) return false;
  if (
    el.tagName === "button" ||
    el.tagName === "a" ||
    /button|link|submit/i.test(el.role ?? "")
  ) {
    return true;
  }
  // 文案已写明「验证答案」时，即使是 div/span 也视为可点（挑战站常见）
  if (/验证答案/i.test(blob)) return true;
  return false;
}

/**
 * @param mode math：优先「验证答案」；gif：验证码输入 + 提交/验证
 */
export function findCaptchaFormHints(
  selectorMap: Map<number, IndexedElementRef>,
  mode: "math" | "gif" = "gif",
): CaptchaFormHints {
  let inputIndex: number | null = null;
  let submitIndex: number | null = null;
  let inputLabel = "";
  let submitLabel = "";

  // 1) 提交：文本「验证答案」绝对优先（不依赖 buttonish）
  for (const [idx, el] of selectorMap) {
    const blob = blobOf(el);
    if (/验证答案/i.test(blob) && !/提交参赛/i.test(blob) && isClickableSubmitCandidate(el, blob)) {
      submitIndex = idx;
      submitLabel = blob;
      break;
    }
  }

  // 2) 回退：verify / 验证 / 提交（排除参赛）
  if (submitIndex == null) {
    for (const [idx, el] of selectorMap) {
      const blob = blobOf(el);
      if (!isClickableSubmitCandidate(el, blob)) continue;
      if (mode === "math") {
        if (/验证|verify|check\s*answer/i.test(blob) && !/提交参赛|参赛代码/i.test(blob)) {
          submitIndex = idx;
          submitLabel = blob;
          break;
        }
      } else if (
        /提交|确定|验证|confirm|submit|verify/i.test(blob) &&
        !/提交参赛|参赛代码/i.test(blob)
      ) {
        submitIndex = idx;
        submitLabel = blob;
        break;
      }
    }
  }

  // 3) 输入框
  const inputRe =
    mode === "math"
      ? /计算|结果|答案|answer|result|math|验证码|captcha/i
      : /验证码|captcha|code|校验/i;

  for (const [idx, el] of selectorMap) {
    if (!isInputish(el)) continue;
    if (el.inputType === "hidden" || el.inputType === "password") continue;
    const blob = blobOf(el);
    if (mode === "gif" && /短信|邮箱|otp|totp/i.test(blob)) continue;
    if (inputRe.test(blob)) {
      inputIndex = idx;
      inputLabel = blob;
      break;
    }
  }
  if (inputIndex == null) {
    for (const [idx, el] of selectorMap) {
      if (!isInputish(el)) continue;
      if (el.inputType === "hidden" || el.inputType === "password") continue;
      inputIndex = idx;
      inputLabel = el.placeholder || el.name || el.tagName;
      break;
    }
  }

  // 4) 提交仍空：首个 button（勿抢「提交参赛」）
  if (submitIndex == null) {
    for (const [idx, el] of selectorMap) {
      const blob = blobOf(el);
      if (/提交参赛|参赛代码/i.test(blob)) continue;
      if (el.tagName === "button" || /button|submit/i.test(el.role ?? "")) {
        submitIndex = idx;
        submitLabel = blob || el.tagName;
        break;
      }
    }
  }

  return { inputIndex, submitIndex, inputLabel, submitLabel };
}

/** 在 selectorMap 中按文案找可点 index（供 nudge / input 回执） */
export function findIndexByTextHint(
  selectorMap: Map<number, IndexedElementRef>,
  pattern: RegExp,
  exclude?: RegExp,
): { index: number; label: string } | null {
  for (const [idx, el] of selectorMap) {
    const blob = blobOf(el);
    if (exclude && exclude.test(blob)) continue;
    if (pattern.test(blob) && isClickableSubmitCandidate(el, blob)) {
      return { index: idx, label: (el.text || blob).slice(0, 80) };
    }
  }
  return null;
}

export function formatFormHintFallback(hints: CaptchaFormHints): string {
  const parts: string[] = [];
  if (hints.inputIndex != null) parts.push(`输入框 index=${hints.inputIndex}`);
  if (hints.submitIndex != null) {
    parts.push(
      `验证/提交 index=${hints.submitIndex}` +
        (hints.submitLabel ? `「${hints.submitLabel.slice(0, 40)}」` : ""),
    );
  }
  if (parts.length === 0) return "";
  return (
    `browser_state 已有：${parts.join("；")}。` +
    `若已能心算答案，下一轮 multi_act：input(答案) + click(提交 index)；禁止空等；勿再死磕同一读图。`
  );
}

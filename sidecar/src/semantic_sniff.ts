/**
 * 轨迹语义嗅探 — Label / inputType 结构化落盘，供沙盘展示与 JIT 造数约束
 *
 * 优先级（严格）：
 * 1. aria-label
 * 2. placeholder
 * 3. <label for="..."> / element.labels 的 innerText
 * 4. 相邻前置文本节点
 * 5. input type（email/tel/…）保底
 */
export type SemanticLabelSource =
  | "aria-label"
  | "placeholder"
  | "label-for"
  | "adjacent-text"
  | "input-type"
  | "agent-text"
  | "name"
  | "unknown";

export interface SemanticContext {
  /** 人类可读字段名 */
  label: string;
  /** 标签来源 */
  source: SemanticLabelSource;
  /** HTML input type / select / textarea */
  inputType?: string;
}

export interface SemanticSniffRaw {
  ariaLabel?: string | null;
  placeholder?: string | null;
  labelFor?: string | null;
  adjacentText?: string | null;
  inputType?: string | null;
  name?: string | null;
  agentText?: string | null;
}

function cleanLabel(value: unknown, max = 80): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return "";
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 由已提取的属性按规格优先级组装 semanticContext（Node 侧） */
export function buildSemanticContextFromRaw(raw: SemanticSniffRaw): SemanticContext {
  const inputType = cleanLabel(raw.inputType, 32).toLowerCase() || undefined;

  const aria = cleanLabel(raw.ariaLabel);
  if (aria) {
    return { label: aria, source: "aria-label", inputType };
  }

  const placeholder = cleanLabel(raw.placeholder);
  if (placeholder) {
    return { label: placeholder, source: "placeholder", inputType };
  }

  const labelFor = cleanLabel(raw.labelFor);
  if (labelFor) {
    return { label: labelFor, source: "label-for", inputType };
  }

  const adjacent = cleanLabel(raw.adjacentText);
  if (adjacent) {
    return { label: adjacent, source: "adjacent-text", inputType };
  }

  const name = cleanLabel(raw.name);
  if (name) {
    return { label: name, source: "name", inputType };
  }

  const agentText = cleanLabel(raw.agentText);
  if (agentText) {
    return { label: agentText, source: "agent-text", inputType };
  }

  if (inputType) {
    return { label: inputType, source: "input-type", inputType };
  }

  return { label: "字段", source: "unknown", inputType };
}

/**
 * 浏览器内嗅探脚本片段（注入 page.evaluate）。
 * 返回 { label, source, inputType, ariaLabel, placeholder, labelFor, adjacentText }
 */
export function createBrowserSemanticSniffFn(): string {
  return `function sniffSemanticContext(element) {
  function cleanText(value, max) {
    if (!value) return null;
    var normalized = String(value).replace(/\\s+/g, " ").trim();
    if (!normalized) return null;
    max = max || 80;
    return normalized.length > max ? normalized.slice(0, max - 1) + "…" : normalized;
  }
  function resolveInputType(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === "input") return (el.type || "text").toLowerCase();
    if (tag === "textarea") return "textarea";
    if (tag === "select") return el.multiple ? "select-multiple" : "select-one";
    if (el.isContentEditable) return "contenteditable";
    return tag;
  }
  function resolveLabelFor(el) {
    if (el.labels && el.labels.length) {
      for (var i = 0; i < el.labels.length; i++) {
        var t = cleanText(el.labels[i].textContent);
        if (t) return t;
      }
    }
    var id = (el.id || "").trim();
    if (id) {
      try {
        var linked = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        var linkedText = cleanText(linked && linked.textContent);
        if (linkedText) return linkedText;
      } catch (e) {}
    }
    return null;
  }
  function resolveAdjacentText(el) {
    var prev = el.previousSibling;
    var hops = 0;
    while (prev && hops < 6) {
      hops++;
      if (prev.nodeType === 3) {
        var textNode = cleanText(prev.textContent, 60);
        if (textNode && textNode.length >= 1) return textNode;
      } else if (prev.nodeType === 1) {
        var tag = prev.tagName && prev.tagName.toLowerCase();
        if (tag === "label" || tag === "span" || tag === "div" || tag === "p" || tag === "strong" || tag === "b") {
          var htmlText = cleanText(prev.textContent, 60);
          if (htmlText && htmlText.length <= 40) return htmlText;
        }
        break;
      }
      prev = prev.previousSibling;
    }
    var parent = el.parentElement;
    if (parent) {
      for (var c = 0; c < Math.min(parent.childNodes.length, 8); c++) {
        var child = parent.childNodes[c];
        if (child === el) break;
        if (child.nodeType === 3) {
          var siblingText = cleanText(child.textContent, 60);
          if (siblingText && siblingText.length <= 40) return siblingText;
        }
      }
    }
    return null;
  }
  var inputType = resolveInputType(element);
  var ariaLabel = cleanText(element.getAttribute("aria-label"));
  if (ariaLabel) {
    return { label: ariaLabel, source: "aria-label", inputType: inputType, ariaLabel: ariaLabel, placeholder: null, labelFor: null, adjacentText: null };
  }
  var placeholder = cleanText(element.getAttribute("placeholder"));
  if (placeholder) {
    return { label: placeholder, source: "placeholder", inputType: inputType, ariaLabel: null, placeholder: placeholder, labelFor: null, adjacentText: null };
  }
  var labelFor = resolveLabelFor(element);
  if (labelFor) {
    return { label: labelFor, source: "label-for", inputType: inputType, ariaLabel: null, placeholder: null, labelFor: labelFor, adjacentText: null };
  }
  var adjacentText = resolveAdjacentText(element);
  if (adjacentText) {
    return { label: adjacentText, source: "adjacent-text", inputType: inputType, ariaLabel: null, placeholder: null, labelFor: null, adjacentText: adjacentText };
  }
  return { label: inputType || "字段", source: inputType ? "input-type" : "unknown", inputType: inputType, ariaLabel: null, placeholder: null, labelFor: null, adjacentText: null };
}`;
}

/** 规范化任意轨迹步骤上的 semanticContext */
export function normalizeSemanticContext(raw: unknown, fallbackLabel?: string): SemanticContext | undefined {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const label = cleanLabel(record.label) || cleanLabel(fallbackLabel);
    if (!label) {
      return undefined;
    }
    const sourceRaw = String(record.source ?? "unknown").trim() as SemanticLabelSource;
    const allowed: SemanticLabelSource[] = [
      "aria-label",
      "placeholder",
      "label-for",
      "adjacent-text",
      "input-type",
      "agent-text",
      "name",
      "unknown",
    ];
    const source = allowed.includes(sourceRaw) ? sourceRaw : "unknown";
    const inputType = cleanLabel(record.inputType ?? record.input_type, 32).toLowerCase() || undefined;
    return { label, source, inputType };
  }
  const label = cleanLabel(fallbackLabel);
  if (!label) {
    return undefined;
  }
  return { label, source: "unknown" };
}

/** inputType → JIT Prompt 格式铁律 */
export function formatConstraintForInputType(inputType: string | null | undefined): string {
  const type = String(inputType ?? "")
    .trim()
    .toLowerCase();
  switch (type) {
    case "email":
      return "你必须只输出一个合法邮箱地址，绝对禁止包含说明性文字、引号或 Markdown。";
    case "tel":
    case "phone":
      return "你必须只输出电话号码（可含国家区号与空格/短横线），绝对禁止包含说明性文字。";
    case "number":
    case "numeric":
      return "你必须只输出纯数字，绝对禁止包含说明性文字、单位或符号（小数点除外）。";
    case "url":
      return "你必须只输出一个 URL，绝对禁止包含说明性文字。";
    case "date":
      return "你必须只输出日期（优先 YYYY-MM-DD），绝对禁止包含说明性文字。";
    case "password":
      return "你必须只输出密码字符串本身，绝对禁止包含说明性文字。";
    case "checkbox":
    case "radio":
      return "你必须只输出 yes/no 或选项值，绝对禁止包含说明性文字。";
    default:
      return "你必须只输出最终填入值本身，绝对禁止包含说明性文字、引号或 Markdown。";
  }
}

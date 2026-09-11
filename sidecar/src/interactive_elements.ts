import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BrowserContext, Page } from "playwright-core";

import { buildFillActionsFromRows } from "./fill_action_builder.js";
import type { JsonLogger } from "./json-logger.js";
import { CHAT_FILLABLE_CAP } from "./llm_budget.js";
import { buildElementFingerprint } from "./element_heal.js";
import {
  buildSemanticContextFromRaw,
  type SemanticContext,
} from "./semantic_sniff.js";

/** 结构化交互元素 — 仅保留 AI 填表判断所需字段，不含嵌套 HTML */
export interface InteractiveElement {
  tagName: string;
  inputType: string | null;
  id: string | null;
  name: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  role: string | null;
  label: string | null;
  selector: string;
  xpath: string;
  visible: boolean;
  hidden: boolean;
  disabled: boolean;
  readonly: boolean;
  likelyDynamic: boolean;
}

export interface InteractiveElementSnapshot {
  url: string;
  extractedAt: string;
  elements: InteractiveElement[];
}

export const INTERACTIVE_ELEMENTS_CACHE_FILENAME = "cloakforge-interactive-elements.json";
/** Agent llm_json / element_map 调试缓存文件名（已改为内存，保留常量兼容旧路径清理） */
export const AGENT_ELEMENTS_CACHE_FILENAME = "cloakforge-agent-elements.json";

/** 进程内最新提取结果（按 profile）；测试窗与填表均优先读内存，不再依赖磁盘 */
type MemoryExtractEntry = {
  fill: InteractiveElementSnapshot | null;
  agent: Record<string, unknown> | null;
  title: string;
  updatedAt: string;
};

const extractMemoryByProfile = new Map<string, MemoryExtractEntry>();

export function getExtractMemory(profileId?: string | null): MemoryExtractEntry | null {
  const key = String(profileId ?? "").trim() || "default";
  return extractMemoryByProfile.get(key) ?? null;
}

export function setExtractMemory(
  profileId: string | null | undefined,
  entry: Partial<MemoryExtractEntry>,
): void {
  const key = String(profileId ?? "").trim() || "default";
  const prev = extractMemoryByProfile.get(key) ?? {
    fill: null,
    agent: null,
    title: "",
    updatedAt: new Date().toISOString(),
  };
  extractMemoryByProfile.set(key, {
    fill: entry.fill !== undefined ? entry.fill : prev.fill,
    agent: entry.agent !== undefined ? entry.agent : prev.agent,
    title: entry.title !== undefined ? entry.title : prev.title,
    updatedAt: new Date().toISOString(),
  });
}

export function clearExtractMemory(profileId?: string | null): void {
  if (profileId?.trim()) {
    extractMemoryByProfile.delete(profileId.trim());
    return;
  }
  extractMemoryByProfile.clear();
}

const EXTRACT_INTERACTIVE_ELEMENTS_SCRIPT = () => {
  function cleanText(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 0 ? normalized : null;
  }

  function isHiddenByAncestors(element: HTMLElement): boolean {
    let current: HTMLElement | null = element;
    while (current) {
      if (current.getAttribute("aria-hidden") === "true") {
        return true;
      }
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function isVisible(element: HTMLElement): boolean {
    if (isHiddenByAncestors(element)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    if (element.getAttribute("hidden") !== null) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2 || rect.width * rect.height < 4) {
      return false;
    }
    return true;
  }

  function isDisabled(element: HTMLElement): boolean {
    if ("disabled" in element && Boolean((element as HTMLInputElement).disabled)) {
      return true;
    }
    if (element.getAttribute("aria-disabled") === "true") {
      return true;
    }
    return false;
  }

  function isReadonly(element: HTMLElement): boolean {
    if ("readOnly" in element && Boolean((element as HTMLInputElement).readOnly)) {
      return true;
    }
    if (element.getAttribute("aria-readonly") === "true") {
      return true;
    }
    return false;
  }

  function isLikelyDynamicField(id: string | null, name: string | null): boolean {
    const combined = `${id ?? ""} ${name ?? ""}`.toLowerCase();
    return /(?:^|[_-])(token|hash|signature|nonce|captcha|csrf|authenticity)(?:$|[_-])/.test(
      combined,
    );
  }

  function escapeAttr(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function buildXPath(element: Element): string {
    const segments: string[] = [];
    let current: Element | null = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const tag = current.tagName.toLowerCase();
      const parentElement: Element | null = current.parentElement;
      if (!parentElement) {
        segments.unshift(tag);
        break;
      }

      const siblings = Array.from(parentElement.children).filter(
        (child) => child.tagName.toLowerCase() === tag,
      );
      const index = siblings.indexOf(current as Element) + 1;
      segments.unshift(`${tag}[${index}]`);
      current = parentElement;
    }

    return `/${segments.join("/")}`;
  }

  function buildShortCssSelector(element: Element): string | null {
    const htmlElement = element as HTMLElement;
    const tag = element.tagName.toLowerCase();
    const id = cleanText(htmlElement.id);
    if (id) {
      return `#${CSS.escape(id)}`;
    }

    const name = cleanText(element.getAttribute("name"));
    if (name) {
      return `${tag}[name="${escapeAttr(name)}"]`;
    }

    const placeholder = cleanText(element.getAttribute("placeholder"));
    if (placeholder && (tag === "input" || tag === "textarea")) {
      const candidate = `${tag}[placeholder="${escapeAttr(placeholder)}"]`;
      if (document.querySelectorAll(candidate).length === 1) {
        return candidate;
      }
    }

    const ariaLabel = cleanText(element.getAttribute("aria-label"));
    if (ariaLabel) {
      const candidate = `${tag}[aria-label="${escapeAttr(ariaLabel)}"]`;
      if (document.querySelectorAll(candidate).length === 1) {
        return candidate;
      }
    }

    const role = cleanText(element.getAttribute("role"));
    if (role) {
      const candidate = `${tag}[role="${escapeAttr(role)}"]`;
      if (document.querySelectorAll(candidate).length === 1) {
        return candidate;
      }
    }

    if (tag === "input" || tag === "textarea" || tag === "select") {
      const formRoot =
        element.closest("form, uni-form, [role='form'], uni-page-body, body") ?? document.body;
      const peers = Array.from(
        formRoot.querySelectorAll(`${tag}:not([type='hidden'])`),
      ).filter((node) => node instanceof HTMLElement && isVisible(node as HTMLElement));
      const index = peers.indexOf(element);
      if (index >= 0 && peers.length <= 30) {
        return `${tag}:visible >> nth=${index}`;
      }
    }

    return null;
  }

  function buildSelector(element: Element): string {
    return buildShortCssSelector(element) ?? buildXPath(element);
  }

  function resolveLabel(element: HTMLElement): string | null {
    const chunks: string[] = [];

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
    ) {
      const labels = element.labels;
      if (labels) {
        for (const label of Array.from(labels)) {
          const text = cleanText(label.textContent);
          if (text) {
            chunks.push(text);
          }
        }
      }
    }

    const elementId = element.id.trim();
    if (elementId) {
      const linkedLabel = document.querySelector(`label[for="${CSS.escape(elementId)}"]`);
      const linkedText = cleanText(linkedLabel?.textContent ?? null);
      if (linkedText) {
        chunks.push(linkedText);
      }
    }

    let parent: HTMLElement | null = element.parentElement;
    for (let depth = 0; parent && depth < 4; depth += 1) {
      const parentLabel = parent.querySelector(":scope > label, :scope > .label, :scope > uni-text");
      const parentText = cleanText(parentLabel?.textContent ?? null);
      if (parentText && parentText.length <= 40) {
        chunks.push(parentText);
        break;
      }
      parent = parent.parentElement;
    }

    const ariaLabel = cleanText(element.getAttribute("aria-label"));
    if (ariaLabel) {
      chunks.push(ariaLabel);
    }

    const placeholder = cleanText(element.getAttribute("placeholder"));
    if (placeholder) {
      chunks.push(placeholder);
    }

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const node = document.getElementById(id);
        const text = cleanText(node?.textContent ?? null);
        if (text) {
          chunks.push(text);
        }
      }
    }

    const deduped = Array.from(new Set(chunks));
    return deduped.length > 0 ? deduped.join(" | ") : null;
  }

  function isLeafInteractive(element: HTMLElement): boolean {
    const tag = element.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") {
      return true;
    }
    return !element.querySelector("input, textarea, select");
  }

  function isInteractiveCandidate(element: Element): boolean {
    const tag = element.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea" || tag === "button") {
      return true;
    }

    if (element instanceof HTMLElement && element.isContentEditable) {
      return true;
    }

    if (tag === "a") {
      const htmlElement = element as HTMLElement;
      const className = htmlElement.className.toLowerCase();
      const role = (element.getAttribute("role") ?? "").toLowerCase();
      return (
        role === "button" ||
        className.includes("btn") ||
        className.includes("button") ||
        Boolean(cleanText(htmlElement.innerText || htmlElement.textContent))
      );
    }

    if (tag === "div" || tag === "span" || tag === "uni-button" || tag === "uni-view" || tag === "uni-image") {
      const role = (element.getAttribute("role") ?? "").toLowerCase();
      if (
        role === "button" ||
        role === "combobox" ||
        role === "checkbox" ||
        role === "radio" ||
        role === "link" ||
        role === "switch" ||
        role === "tab"
      ) {
        return true;
      }
      // 小图标宿主（语言球等）：无 role 也收
      if (tag === "uni-image" || tag === "uni-view") {
        const rect = (element as HTMLElement).getBoundingClientRect();
        if (rect.width >= 8 && rect.width <= 160 && rect.height >= 8 && rect.height <= 160) {
          return true;
        }
      }
      return false;
    }

    return false;
  }

  function shouldSkipInputType(inputType: string | null, tagName: string): boolean {
    const type = (inputType ?? "text").toLowerCase();
    if (type === "hidden" || type === "file") {
      return true;
    }
    if (tagName === "input" && (type === "submit" || type === "button" || type === "reset")) {
      return false;
    }
    return false;
  }

  const results: Array<{
    tagName: string;
    inputType: string | null;
    id: string | null;
    name: string | null;
    placeholder: string | null;
    ariaLabel: string | null;
    role: string | null;
    label: string | null;
    selector: string;
    xpath: string;
    visible: boolean;
    hidden: boolean;
    disabled: boolean;
    readonly: boolean;
    likelyDynamic: boolean;
  }> = [];

  const candidates = Array.from(
    document.querySelectorAll(
      "input, select, textarea, button, a, [contenteditable='true'], div[role], span[role], uni-button, uni-view[role], uni-image, img[onclick], uni-input input, uni-textarea textarea",
    ),
  );

  for (const element of candidates) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }
    if (!isInteractiveCandidate(element)) {
      continue;
    }
    if (!isLeafInteractive(element)) {
      continue;
    }

    const tagName = element.tagName.toLowerCase();
    let inputType: string | null = null;
    if (element instanceof HTMLInputElement) {
      inputType = element.type || "text";
    } else if (element instanceof HTMLSelectElement) {
      inputType = element.multiple ? "select-multiple" : "select-one";
    } else if (tagName === "textarea" || element.isContentEditable) {
      inputType = "textarea";
    } else if (tagName === "button" || tagName === "uni-button") {
      inputType = "button";
    } else if (tagName === "a") {
      inputType = "link";
    } else {
      inputType = element.getAttribute("role");
    }

    if (shouldSkipInputType(inputType, tagName) && inputType === "hidden") {
      continue;
    }

    const id = cleanText(element.id);
    const name = cleanText(element.getAttribute("name"));
    const placeholder = cleanText(element.getAttribute("placeholder"));
    const ariaLabel = cleanText(element.getAttribute("aria-label"));
    const role = cleanText(element.getAttribute("role"));
    const hidden =
      inputType === "hidden" ||
      element.getAttribute("type") === "hidden" ||
      element.getAttribute("aria-hidden") === "true";
    const visible = isVisible(element);
    const disabled = isDisabled(element);
    const readonly = isReadonly(element);

    results.push({
      tagName,
      inputType,
      id,
      name,
      placeholder,
      ariaLabel,
      role,
      label: resolveLabel(element),
      selector: buildSelector(element),
      xpath: buildXPath(element),
      visible,
      hidden,
      disabled,
      readonly,
      likelyDynamic: isLikelyDynamicField(id, name),
    });
  }

  return results;
};

export async function extractInteractiveElements(page: Page): Promise<InteractiveElement[]> {
  const elements: InteractiveElement[] = [];

  for (const frame of page.frames()) {
    const frameElements = await frame.evaluate(EXTRACT_INTERACTIVE_ELEMENTS_SCRIPT);
    elements.push(...frameElements);
  }

  return elements;
}

/** 筛出适合常规填表的表单控件（排除 hidden / 动态 token / 不可见 / 禁用） */
export function filterFillableElements(elements: InteractiveElement[]): InteractiveElement[] {
  return elements.filter((element) => {
    if (element.hidden || element.likelyDynamic || element.disabled) {
      return false;
    }
    if (!element.visible) {
      return false;
    }
    const tag = element.tagName.toLowerCase();
    if (tag !== "input" && tag !== "select" && tag !== "textarea") {
      return false;
    }
    if (tag === "input") {
      const type = (element.inputType ?? "text").toLowerCase();
      if (type === "hidden" || type === "file" || type === "submit" || type === "button") {
        return false;
      }
    }
    return true;
  });
}

/** 按标签/选择器去重，减少导航栏、页脚重复链接 */
export function dedupeInteractiveElements(elements: InteractiveElement[]): InteractiveElement[] {
  const seen = new Set<string>();
  const result: InteractiveElement[] = [];
  for (const element of elements) {
    const label = (element.label ?? element.ariaLabel ?? element.name ?? element.id ?? "").trim().toLowerCase();
    const key = `${element.tagName}:${label || element.selector}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(element);
  }
  return result;
}

function isVisibleInteractive(element: InteractiveElement): boolean {
  return element.visible && !element.hidden && !element.disabled;
}

function slugifyFieldKey(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return normalized.length > 0 ? normalized : "";
}

function buildStableFieldKey(
  element: InteractiveElement,
  index: number,
  usedKeys: Set<string>,
  prefix = "field",
): string {
  const candidates = [
    element.name?.trim(),
    element.id?.trim(),
    element.placeholder ? slugifyFieldKey(element.placeholder) : "",
    element.label ? slugifyFieldKey(element.label.split("|")[0] ?? "") : "",
    element.ariaLabel ? slugifyFieldKey(element.ariaLabel) : "",
  ].filter((value) => value && value.length > 0);

  for (const candidate of candidates) {
    const key = slugifyFieldKey(candidate!) || candidate!;
    if (!usedKeys.has(key)) {
      usedKeys.add(key);
      return key;
    }
    let suffix = 2;
    while (usedKeys.has(`${key}_${suffix}`)) {
      suffix += 1;
    }
    const deduped = `${key}_${suffix}`;
    usedKeys.add(deduped);
    return deduped;
  }

  const fallback = `${prefix}_${index + 1}`;
  usedKeys.add(fallback);
  return fallback;
}

function exportSelector(element: InteractiveElement): string {
  const selector = element.selector.trim();
  if (selector && !selector.startsWith("/")) {
    return selector;
  }
  return element.xpath.trim();
}

function isPrimaryActionButton(element: InteractiveElement): boolean {
  const text = (element.label ?? element.ariaLabel ?? element.placeholder ?? "").toLowerCase();
  return /(?:注册|登录|提交|确认|下一步|保存|继续|register|login|submit|sign\s*up|continue|next|confirm)/i.test(
    text,
  );
}

function pickActionButtons(buttons: InteractiveElement[]): InteractiveElement[] {
  const visibleButtons = dedupeInteractiveElements(buttons.filter(isVisibleInteractive));
  const primary = visibleButtons.filter(isPrimaryActionButton);
  const submitLike = visibleButtons.filter((element) => {
    const type = (element.inputType ?? "").toLowerCase();
    return type === "submit" || type === "button";
  });
  const merged: InteractiveElement[] = [];
  const seen = new Set<string>();
  for (const element of [...primary, ...submitLike, ...visibleButtons]) {
    const token = `${element.tagName}:${element.selector}`;
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    merged.push(element);
    if (merged.length >= 6) {
      break;
    }
  }
  return merged;
}

function isButtonLike(element: InteractiveElement): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === "button" || tag === "uni-button") {
    return true;
  }
  if (tag === "input") {
    const type = (element.inputType ?? "").toLowerCase();
    return type === "submit" || type === "button";
  }
  return element.role === "button" || element.inputType === "button";
}

function isLinkLike(element: InteractiveElement): boolean {
  return element.tagName.toLowerCase() === "a" || element.inputType === "link";
}

function elementFieldKey(element: InteractiveElement): string {
  return (
    element.name?.trim() ||
    element.id?.trim() ||
    slugifyFieldKey(element.label ?? element.placeholder ?? "") ||
    element.selector
  );
}

export interface VisibleUsableElementRow {
  category: "fillable" | "button" | "link" | "other";
  key: string;
  label: string | null;
  tag: string;
  type: string | null;
  selector: string;
  xpath: string;
  action: "fill" | "select" | "click";
  value: string;
}

/** 分组收集去重后的可见可用元素（摘要与导出共用） */
export function collectVisibleUsableGroups(snapshot: InteractiveElementSnapshot) {
  const all = snapshot.elements;
  const visible = dedupeInteractiveElements(all.filter(isVisibleInteractive));
  const fillable = filterFillableElements(all);
  const fillableKeys = new Set(fillable.map((element) => `${element.tagName}:${element.selector}`));

  const buttons = visible.filter(
    (element) => isButtonLike(element) && !fillableKeys.has(`${element.tagName}:${element.selector}`),
  );
  const links = visible.filter(
    (element) =>
      isLinkLike(element) && !isButtonLike(element) && !fillableKeys.has(`${element.tagName}:${element.selector}`),
  );
  const others = visible.filter(
    (element) =>
      !fillableKeys.has(`${element.tagName}:${element.selector}`) &&
      !isButtonLike(element) &&
      !isLinkLike(element),
  );

  return {
    all,
    visible,
    fillable,
    buttons,
    links,
    others,
    hiddenCount: all.filter(
      (element) => element.hidden || !element.visible || element.disabled,
    ).length,
  };
}

function toExportRow(
  element: InteractiveElement,
  category: VisibleUsableElementRow["category"],
  action: VisibleUsableElementRow["action"],
  key?: string,
): VisibleUsableElementRow {
  return {
    category,
    key: key ?? elementFieldKey(element),
    label: element.label ?? element.ariaLabel ?? element.placeholder,
    tag: element.tagName,
    type: element.inputType,
    selector: exportSelector(element),
    xpath: element.xpath,
    action,
    value: "",
  };
}

/** 精简填表导出：可填字段 + 主要操作按钮，短 key + 短 selector，节约 Token */
export interface SlimFillExport {
  version: 2;
  url: string;
  extractedAt: string;
  summary: {
    fillable: number;
    buttons: number;
    skippedHidden: number;
  };
  fillProfile: Record<string, string>;
  fields: Array<{
    key: string;
    label: string | null;
    tag: string;
    type: string | null;
    action: "fill" | "select" | "click";
  }>;
  fillActions: ReturnType<typeof buildFillActionsFromRows>;
}

/** 由快照生成精简填表 JSON（聊天「输出/导出/提取」与缓存写入） */
export function buildSlimFillExportJson(snapshot: InteractiveElementSnapshot): SlimFillExport {
  const groups = collectVisibleUsableGroups(snapshot);
  const usedKeys = new Set<string>();

  const fillableRows = groups.fillable.map((element, index) =>
    toExportRow(
      element,
      "fillable",
      element.tagName.toLowerCase() === "select" ? "select" : "fill",
      buildStableFieldKey(element, index, usedKeys, "field"),
    ),
  );

  const buttonRows = pickActionButtons(groups.buttons).map((element, index) =>
    toExportRow(
      element,
      "button",
      "click",
      buildStableFieldKey(element, fillableRows.length + index, usedKeys, "btn"),
    ),
  );

  const exportRows = [...fillableRows, ...buttonRows];
  const fillProfile: Record<string, string> = {};
  for (const row of exportRows) {
    fillProfile[row.key] = "";
  }

  const fillActions = buildFillActionsFromRows(exportRows, fillProfile).map((action) => {
    const row = exportRows.find((entry) => entry.key === action.field);
    const compact: typeof action = {
      field: action.field,
      selector: action.selector,
      action: action.action,
      value: action.value ?? "",
    };
    if (row && row.selector.startsWith("/") && row.xpath) {
      compact.xpath = row.xpath;
    }
    return compact;
  });

  return {
    version: 2,
    url: snapshot.url,
    extractedAt: snapshot.extractedAt,
    summary: {
      fillable: fillableRows.length,
      buttons: buttonRows.length,
      skippedHidden: groups.hiddenCount,
    },
    fillProfile,
    fields: exportRows.map((row) => ({
      key: row.key,
      label: row.label,
      tag: row.tag,
      type: row.type,
      action: row.action,
    })),
    fillActions,
  };
}

/** @deprecated 使用 buildSlimFillExportJson */
export function buildVisibleUsableElementsExportJson(snapshot: InteractiveElementSnapshot) {
  const slim = buildSlimFillExportJson(snapshot);
  const groups = collectVisibleUsableGroups(snapshot);
  return {
    ...slim,
    fillTemplate: { ...slim.fillProfile },
    summary: {
      total: groups.all.length,
      visibleUnique: groups.visible.length,
      hiddenOrInvisible: groups.hiddenCount,
      fillableCount: groups.fillable.length,
      buttonCount: groups.buttons.length,
      linkCount: groups.links.length,
      otherCount: groups.others.length,
      exportedCount: groups.fillable.length,
    },
    elements: groups.fillable.map((element) =>
      toExportRow(element, "fillable", element.tagName.toLowerCase() === "select" ? "select" : "fill"),
    ),
  };
}

export function slimInteractiveElement(element: InteractiveElement) {
  return {
    tag: element.tagName,
    type: element.inputType,
    label: element.label ?? element.ariaLabel ?? element.placeholder,
    name: element.name,
    id: element.id,
    selector: element.selector,
  };
}

function formatCompactElementLine(element: InteractiveElement): string {
  const label = element.label ?? element.ariaLabel ?? element.placeholder ?? element.name ?? element.id ?? "—";
  const parts: string[] = [`[${element.tagName}${element.inputType ? `/${element.inputType}` : ""}]`, label];
  if (element.name) {
    parts.push(`name=${element.name}`);
  }
  if (element.id) {
    parts.push(`#${element.id}`);
  }
  parts.push(element.selector);
  return parts.join(" · ");
}

function formatSection(title: string, items: InteractiveElement[], maxItems: number): string[] {
  if (items.length === 0) {
    return [];
  }
  const lines = [`\n**${title}**（${items.length}）`];
  for (const [index, element] of items.slice(0, maxItems).entries()) {
    lines.push(`${index + 1}. ${formatCompactElementLine(element)}`);
  }
  if (items.length > maxItems) {
    lines.push(`… 还有 ${items.length - maxItems} 个未展示`);
  }
  return lines;
}

export interface InteractiveElementsFormatOptions {
  maxButtons?: number;
  maxLinks?: number;
  maxOther?: number;
}

/** 人类可读的精简摘要（聊天「元素提取」默认输出） */
export function formatInteractiveElementsSummary(
  snapshot: InteractiveElementSnapshot,
  _options?: InteractiveElementsFormatOptions,
): string {
  const groups = collectVisibleUsableGroups(snapshot);
  const { fillable } = groups;

  const lines = [
    `已提取 **${fillable.length}** 个可填字段，**${groups.buttons.length}** 个可见按钮（导出含主要操作按钮）。`,
    `- URL: ${snapshot.url}`,
    `- 时间: ${snapshot.extractedAt}`,
    `- 已跳过隐藏/不可见: ${groups.hiddenCount} 个`,
  ];

  if (fillable.length > 0) {
    for (const [index, element] of fillable.slice(0, 8).entries()) {
      lines.push(`${index + 1}. ${formatCompactElementLine(element)}`);
    }
    if (fillable.length > 8) {
      lines.push(`… 还有 ${fillable.length - 8} 个字段`);
    }
  } else {
    lines.push("当前页面没有可填表字段，或页面仍在加载。");
  }

  lines.push("\n发送 **输出** / **导出** / **提取** 可获取填表 JSON。");
  return lines.join("\n");
}

/** LLM 工具调用用的精简结构（不含全量 elements） */
export function buildInteractiveElementsToolPayload(snapshot: InteractiveElementSnapshot) {
  const fillable = filterFillableElements(snapshot.elements).slice(0, CHAT_FILLABLE_CAP);
  const visible = dedupeInteractiveElements(snapshot.elements.filter(isVisibleInteractive));
  const buttons = visible.filter(isButtonLike).slice(0, 15).map(slimInteractiveElement);
  const links = visible.filter(isLinkLike).slice(0, 10).map(slimInteractiveElement);

  return {
    url: snapshot.url,
    extractedAt: snapshot.extractedAt,
    total: snapshot.elements.length,
    visibleUnique: visible.length,
    fillableCount: fillable.length,
    fillableElements: fillable.map(slimInteractiveElement),
    sampleButtons: buttons,
    sampleLinks: links,
    truncatedFillable: filterFillableElements(snapshot.elements).length > CHAT_FILLABLE_CAP,
  };
}

/** 精简填表 JSON（写入「原始填表数据」） */
export function formatInteractiveElementsFullJson(snapshot: InteractiveElementSnapshot): string {
  const payload = buildSlimFillExportJson(snapshot);
  return ["```json", JSON.stringify(payload, null, 2), "```"].join("\n");
}

export function cacheFilePath(userDataDir: string): string {
  return path.join(userDataDir, INTERACTIVE_ELEMENTS_CACHE_FILENAME);
}

export async function writeInteractiveElementCache(
  _userDataDir: string,
  snapshot: InteractiveElementSnapshot,
): Promise<void> {
  // 已改为内存：保留函数签名兼容旧调用，仅更新 default 槽
  setExtractMemory("default", { fill: snapshot, title: "" });
}

export function agentCacheFilePath(userDataDir: string): string {
  return path.join(userDataDir, AGENT_ELEMENTS_CACHE_FILENAME);
}

/** 将 Agent 提取结果序列化为可 JSON 推送的普通对象（不含 Map） */
export function serializeAgentExtractForDebug(extracted: AgentExtractResult): Record<string, unknown> {
  return {
    url: extracted.url,
    extractedAt: extracted.extractedAt,
    skipped: extracted.skipped,
    llm_json: extracted.llm_json,
    element_map: [...extracted.element_map.entries()].map(([id, ref]) => ({
      id,
      selector: ref.selector,
      xpath: ref.xpath,
      tagName: ref.tagName,
      inputType: ref.inputType,
      text: ref.text,
      frameUrl: ref.frameUrl ?? null,
      rect: ref.rect ?? null,
      semanticContext: ref.semanticContext ?? null,
    })),
  };
}

export async function writeAgentElementCache(
  _userDataDir: string,
  extracted: AgentExtractResult,
): Promise<Record<string, unknown>> {
  // 不再落盘
  return serializeAgentExtractForDebug(extracted);
}

/** IPC 用精简填表列表，避免 stdout 超大行被截断导致测试窗不刷新 */
function slimFillForIpc(snapshot: InteractiveElementSnapshot | null | undefined): unknown {
  if (!snapshot) {
    return null;
  }
  const max = 120;
  const elements = snapshot.elements.slice(0, max).map((el) => ({
    tagName: el.tagName,
    inputType: el.inputType,
    id: el.id,
    name: el.name,
    placeholder: el.placeholder,
    ariaLabel: el.ariaLabel,
    role: el.role,
    label: el.label,
    selector: el.selector,
    visible: el.visible,
    disabled: el.disabled,
  }));
  return {
    url: snapshot.url,
    extractedAt: snapshot.extractedAt,
    elements,
    truncated: Math.max(0, snapshot.elements.length - max),
    total: snapshot.elements.length,
  };
}

/** IPC 用精简 Agent 包：只推 llm_json，不推完整 element_map（防超大行丢事件） */
function slimAgentForIpc(extracted: AgentExtractResult | null | undefined): unknown {
  if (!extracted) {
    return null;
  }
  const max = 200;
  const llm_json = extracted.llm_json.slice(0, max);
  return {
    url: extracted.url,
    extractedAt: extracted.extractedAt,
    skipped: extracted.skipped,
    llm_json,
    truncated: Math.max(0, extracted.llm_json.length - max),
    total: extracted.llm_json.length,
    element_map_count: extracted.element_map.size,
  };
}

/**
 * 向主控台推送元素提取调试 JSON（填表快照 + Agent llm_json）— 仅内存 + stdout 事件。
 */
export async function emitInteractiveExtractDebug(
  logger: JsonLogger,
  options: {
    profileId?: string;
    source: "page_watcher" | "agent_loop" | "manual";
    fill?: InteractiveElementSnapshot | null;
    agent?: AgentExtractResult | null;
    userDataDir?: string | null;
    title?: string | null;
  },
): Promise<void> {
  const agentPayload = options.agent ? serializeAgentExtractForDebug(options.agent) : null;
  const title = String(options.title ?? "").trim();
  setExtractMemory(options.profileId, {
    fill: options.fill ?? null,
    agent: agentPayload,
    title,
  });

  logger.interactiveExtract({
    profile_id: options.profileId,
    source: options.source,
    url: options.fill?.url ?? options.agent?.url ?? "",
    title,
    extractedAt: new Date().toISOString(),
    fillCount: options.fill?.elements.length ?? 0,
    agentCount: options.agent?.llm_json.length ?? 0,
    // 精简 fill + agent，避免超大 stdout 行导致 Rust 丢事件、测试窗永不刷新
    fill: slimFillForIpc(options.fill ?? null),
    agent: slimAgentForIpc(options.agent ?? null),
  });
}

/** 将填表快照投影为 Agent 形 llm_json（仅调试兜底） */
export function projectFillSnapshotToAgentExtract(
  snapshot: InteractiveElementSnapshot,
): AgentExtractResult {
  const llm_json: AgentLlmElement[] = [];
  const element_map = new Map<string, AgentElementRef>();
  let index = 0;
  for (const el of snapshot.elements) {
    if (el.hidden || el.disabled) {
      continue;
    }
    if (!el.visible && !el.placeholder && !el.name && !el.label) {
      continue;
    }
    index += 1;
    if (index > 150) {
      break;
    }
    const id = String(index);
    const tag = String(el.tagName ?? "div").toLowerCase();
    const inputType = (el.inputType ?? "").toLowerCase();
    let type = "other";
    if (tag === "a") type = "link";
    else if (tag === "button") type = "button";
    else if (tag === "select") type = "combobox";
    else if (tag === "textarea" || inputType === "textarea") type = "textbox";
    else if (inputType === "password" || inputType === "email" || inputType === "tel" || inputType === "text" || tag === "input") {
      type = inputType === "search" ? "searchbox" : "textbox";
    } else if (el.role) type = String(el.role).toLowerCase();

    const text =
      el.label || el.ariaLabel || el.placeholder || el.name || el.id || tag;
    llm_json.push({
      id,
      type,
      text: String(text ?? "").slice(0, 60),
      ...(el.name ? { name: el.name.slice(0, 40) } : {}),
      ...(el.placeholder ? { placeholder: el.placeholder.slice(0, 40) } : {}),
      ...(el.role ? { role: el.role } : {}),
    });
    element_map.set(id, {
      id,
      selector: el.selector,
      xpath: el.xpath,
      tagName: el.tagName,
      inputType: el.inputType,
      text: String(text ?? ""),
      frameUrl: null,
      rect: null,
    });
  }
  return {
    url: snapshot.url,
    extractedAt: snapshot.extractedAt,
    llm_json,
    element_map,
    skipped: Math.max(0, snapshot.elements.length - llm_json.length),
  };
}

export async function readInteractiveElementCache(
  userDataDir: string,
  expectedUrl?: string,
): Promise<InteractiveElementSnapshot | null> {
  // 优先内存（按 default；带 profile 的调用方应改用 getExtractMemory）
  void userDataDir;
  const mem = getExtractMemory("default")?.fill ?? null;
  if (mem?.elements?.length) {
    if (expectedUrl && mem.url !== expectedUrl) {
      return null;
    }
    return mem;
  }
  return null;
}

export async function snapshotInteractiveElements(
  page: Page,
  userDataDir?: string | null,
): Promise<InteractiveElementSnapshot> {
  const elements = await extractInteractiveElements(page);
  const snapshot: InteractiveElementSnapshot = {
    url: page.url(),
    extractedAt: new Date().toISOString(),
    elements,
  };
  // 不再写磁盘；可选记住到 default（真正按 profile 的写入在 emit / watcher）
  if (userDataDir?.trim()) {
    setExtractMemory("default", { fill: snapshot });
  }
  return snapshot;
}

const watchedContexts = new WeakSet<BrowserContext>();

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}_timeout_${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 对单页立即提取并推送（fill 先推 + 投影 agent；再限时真树）。
 * watcher / extract_now 共用，保证测试窗与 Agent 同源。
 */
export async function pushInteractiveExtractForPage(
  page: Page,
  logger: JsonLogger,
  profileId?: string,
  source: "page_watcher" | "agent_loop" | "manual" = "page_watcher",
): Promise<void> {
  if (page.isClosed()) {
    return;
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => undefined);
  await page.waitForTimeout(150).catch(() => undefined);

  let title = "";
  try {
    title = await page.title();
  } catch {
    title = "";
  }

  try {
    const snapshot = await withTimeout(
      snapshotInteractiveElements(page, null),
      10_000,
      "fill_extract",
    );
    const projected = projectFillSnapshotToAgentExtract(snapshot);
    setExtractMemory(profileId, {
      fill: snapshot,
      agent: serializeAgentExtractForDebug(projected),
      title,
    });
    await emitInteractiveExtractDebug(logger, {
      profileId,
      source,
      fill: snapshot,
      agent: projected,
      userDataDir: null,
      title,
    });
    logger.progress("interactive_elements_pushed", {
      profileId,
      url: snapshot.url,
      fillCount: snapshot.elements.length,
      agentCount: projected.llm_json.length,
      source,
    });

    try {
      const agentExtract = await withTimeout(
        extractAgentInteractiveTree(page, { includeScreenshot: false }),
        5_000,
        "agent_extract",
      );
      if (agentExtract.llm_json.length > 0) {
        setExtractMemory(profileId, {
          fill: snapshot,
          agent: serializeAgentExtractForDebug(agentExtract),
          title,
        });
        await emitInteractiveExtractDebug(logger, {
          profileId,
          source,
          fill: snapshot,
          agent: agentExtract,
          userDataDir: null,
          title,
        });
      }
    } catch (agentError) {
      const agentMessage =
        agentError instanceof Error ? agentError.message : String(agentError);
      logger.warn("agent_elements_extract_failed", {
        profileId,
        error: agentMessage,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("interactive_elements_extract_failed", { profileId, error: message });
    try {
      const url = page.isClosed() ? "" : page.url();
      await emitInteractiveExtractDebug(logger, {
        profileId,
        source,
        fill: { url, extractedAt: new Date().toISOString(), elements: [] },
        agent: null,
        title: "",
      });
    } catch {
      /* ignore */
    }
  }
}

/** 对 context 所有未关闭页面推送（extract_now） */
export async function pushInteractiveExtractForContext(
  context: BrowserContext,
  logger: JsonLogger,
  profileId?: string,
): Promise<void> {
  const pages = context.pages().filter((p) => {
    try {
      return !p.isClosed();
    } catch {
      return false;
    }
  });
  if (!pages.length) {
    logger.warn("interactive_extract_no_pages", { profileId });
    await emitInteractiveExtractDebug(logger, {
      profileId,
      source: "manual",
      fill: { url: "", extractedAt: new Date().toISOString(), elements: [] },
      agent: null,
      title: "",
    });
    return;
  }
  // 优先最后一个活动页
  const target = pages[pages.length - 1]!;
  await pushInteractiveExtractForPage(target, logger, profileId, "manual");
}

/**
 * 页面加载 / URL 变化：先推 fill（秒级），再限时抽 Agent 树。
 * 始终挂载（enabled 仅作日志）；禁止等 Agent 树完成才推送。
 */
export async function attachInteractiveElementWatcher(
  context: BrowserContext,
  enabled: boolean,
  userDataDir: string,
  logger: JsonLogger,
  profileId?: string,
): Promise<void> {
  if (watchedContexts.has(context)) {
    return;
  }
  watchedContexts.add(context);
  void userDataDir;

  // 产品要求：测试窗/Agent 可观测性依赖推送；开关关闭时仍挂载轻量 watcher
  if (!enabled) {
    logger.warn("interactive_extract_watcher_forced_on", {
      profileId,
      note: "UI 开关为关，仍挂载内存推送以保证测试窗与调试可用",
    });
  }

  const debounceMs = 500;
  const timers = new WeakMap<Page, ReturnType<typeof setTimeout>>();

  const scheduleExtract = (page: Page): void => {
    const prev = timers.get(page);
    if (prev) {
      clearTimeout(prev);
    }
    const timer = setTimeout(() => {
      timers.delete(page);
      void pushInteractiveExtractForPage(page, logger, profileId, "page_watcher");
    }, debounceMs);
    timers.set(page, timer);
  };

  context.on("page", (page) => {
    page.on("load", () => scheduleExtract(page));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        scheduleExtract(page);
      }
    });
    scheduleExtract(page);
  });

  for (const page of context.pages()) {
    page.on("load", () => scheduleExtract(page));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        scheduleExtract(page);
      }
    });
    scheduleExtract(page);
  }
}

// ---------------------------------------------------------------------------
// Autonomous Agent 专用提取：llm_json（给模型）与 element_map（仅 Node 内存）
// 可见性：宽高>0 + display/visibility/opacity/aria-hidden；不按视口裁剪
// ---------------------------------------------------------------------------

export interface AgentLlmElement {
  id: string;
  type: string;
  text: string;
  name?: string;
  placeholder?: string;
  role?: string;
}

export interface AgentElementRef {
  id: string;
  selector: string;
  xpath: string;
  tagName: string;
  inputType: string | null;
  text: string;
  /** 语义嗅探（落盘到轨迹 fill 步） */
  semanticContext?: SemanticContext;
  /** 所属 frame URL；主文档为 null */
  frameUrl?: string | null;
  /** 视口坐标（主文档），供 SoM 与短 ID 对齐 */
  rect?: { x: number; y: number; w: number; h: number } | null;
  /** Milestone 5：自愈指纹（仅 Node 内存，不进 LLM JSON） */
  fingerprint?: import("./element_heal.js").ElementFingerprint;
}

export interface AgentExtractResult {
  url: string;
  extractedAt: string;
  llm_json: AgentLlmElement[];
  element_map: Map<string, AgentElementRef>;
  skipped: number;
  /** SoM 标注后的视口截图（jpeg base64，无 data: 前缀） */
  screenshotBase64?: string | null;
}

interface AgentRawElement {
  tagName: string;
  inputType: string | null;
  id: string | null;
  name: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  role: string | null;
  label: string | null;
  text: string | null;
  adjacentText?: string | null;
  semanticLabel?: string | null;
  semanticSource?: string | null;
  selector: string;
  xpath: string;
  /** Milestone 5：自愈用 class 提示 */
  className?: string | null;
  rect?: { x: number; y: number; w: number; h: number };
  frameUrl?: string | null;
}

const EXTRACT_AGENT_TREE_SCRIPT = () => {
  function cleanText(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 0 ? normalized.slice(0, 80) : null;
  }

  function isHiddenByAncestors(element: HTMLElement): boolean {
    let current: HTMLElement | null = element;
    while (current) {
      if (current.getAttribute("aria-hidden") === "true") {
        // 图标常被 aria-hidden：自身可点时不因该属性直接丢弃
        if (current === element) {
          const role = (current.getAttribute("role") ?? "").toLowerCase();
          const className =
            typeof current.className === "string"
              ? current.className
              : String(current.className ?? "");
          const looksClickable =
            role === "button" ||
            role === "link" ||
            role === "switch" ||
            /btn|button|icon|lang|kefu|locale/i.test(className) ||
            current.tagName.toLowerCase() === "img" ||
            current.tagName.toLowerCase() === "uni-image";
          if (looksClickable) {
            current = current.parentElement;
            continue;
          }
        } else {
          return true;
        }
      }
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") {
        return true;
      }
      const opacity = Number(style.opacity);
      if (Number.isFinite(opacity) && opacity < 0.05) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  /** 文档内可见即可（不要求在当前视口内；Playwright 会自动滚动） */
  function isDocumentVisible(element: HTMLElement): boolean {
    if (isHiddenByAncestors(element)) {
      return false;
    }
    if (element.getAttribute("hidden") !== null) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    // 全透明几乎不可点；半透明动画中的控件仍收录
    const opacity = Number(style.opacity);
    if (Number.isFinite(opacity) && opacity < 0.05) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2 && rect.width * rect.height >= 4;
  }

  function escapeAttr(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function buildXPath(element: Element): string {
    const segments: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const tag = current.tagName.toLowerCase();
      const parentElement: Element | null = current.parentElement;
      if (!parentElement) {
        segments.unshift(tag);
        break;
      }
      const siblings = Array.from(parentElement.children).filter(
        (child) => child.tagName.toLowerCase() === tag,
      );
      const index = siblings.indexOf(current as Element) + 1;
      segments.unshift(`${tag}[${index}]`);
      current = parentElement;
    }
    return `/${segments.join("/")}`;
  }

  function buildSelector(element: Element): string {
    const htmlElement = element as HTMLElement;
    const tag = element.tagName.toLowerCase();
    const id = cleanText(htmlElement.id);
    if (id) {
      return `#${CSS.escape(id)}`;
    }
    const name = cleanText(element.getAttribute("name"));
    if (name) {
      return `${tag}[name="${escapeAttr(name)}"]`;
    }
    const placeholder = cleanText(element.getAttribute("placeholder"));
    if (placeholder && (tag === "input" || tag === "textarea")) {
      const candidate = `${tag}[placeholder="${escapeAttr(placeholder)}"]`;
      if (document.querySelectorAll(candidate).length === 1) {
        return candidate;
      }
    }
    const ariaLabel = cleanText(element.getAttribute("aria-label"));
    if (ariaLabel) {
      const candidate = `${tag}[aria-label="${escapeAttr(ariaLabel)}"]`;
      if (document.querySelectorAll(candidate).length === 1) {
        return candidate;
      }
    }
    return buildXPath(element);
  }

  function resolveLabel(element: HTMLElement): string | null {
    const chunks: string[] = [];
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
    ) {
      const labels = element.labels;
      if (labels) {
        for (const label of Array.from(labels)) {
          const text = cleanText(label.textContent);
          if (text) {
            chunks.push(text);
          }
        }
      }
    }
    const elementId = element.id.trim();
    if (elementId) {
      const linked = document.querySelector(`label[for="${CSS.escape(elementId)}"]`);
      const linkedText = cleanText(linked?.textContent ?? null);
      if (linkedText) {
        chunks.push(linkedText);
      }
    }
    const ariaLabel = cleanText(element.getAttribute("aria-label"));
    if (ariaLabel) {
      chunks.push(ariaLabel);
    }
    const placeholder = cleanText(element.getAttribute("placeholder"));
    if (placeholder) {
      chunks.push(placeholder);
    }
    const inner = cleanText(element.innerText || element.textContent);
    if (inner && inner.length <= 40) {
      chunks.push(inner);
    }
    return chunks.length > 0 ? Array.from(new Set(chunks)).join(" | ") : null;
  }

  function isNativeInteractive(element: Element): boolean {
    const tag = element.tagName.toLowerCase();
    if (
      tag === "input" ||
      tag === "select" ||
      tag === "textarea" ||
      tag === "button" ||
      tag === "a" ||
      tag === "uni-button" ||
      tag === "summary" ||
      tag === "option"
    ) {
      return true;
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      return true;
    }
    const role = (element.getAttribute("role") ?? "").toLowerCase();
    return (
      role === "button" ||
      role === "checkbox" ||
      role === "radio" ||
      role === "combobox" ||
      role === "link" ||
      role === "tab" ||
      role === "menuitem" ||
      role === "switch" ||
      role === "slider" ||
      role === "option" ||
      role === "listbox" ||
      role === "treeitem" ||
      role === "spinbutton" ||
      role === "searchbox"
    );
  }

  /** 高频操作文案（忽略大小写 / 空白折叠）— 移动端 H5 纯文本按钮兜底 */
  const ACTION_TEXT_SET = new Set(
    [
      "login",
      "log in",
      "sign in",
      "signin",
      "register",
      "sign up",
      "signup",
      "go to register",
      "forgot password",
      "forget password",
      "submit",
      "confirm",
      "next",
      "send",
      "ok",
      "cancel",
      "continue",
      "get code",
      "send code",
      "verify",
      "agree",
      "accept",
      "more",
      "details",
      "expand",
      "collapse",
      "switch",
      "toggle",
      "close",
      "back",
      "home",
      "open account",
      "claim",
      "try free",
      "customer service",
      "contact us",
      "en",
      "eng",
      "english",
      "he",
      "iw",
      "cn",
      "zh",
      "jp",
      "ja",
      "ko",
      "ar",
      "hebrew",
      "language",
      "登录",
      "登陆",
      "注册",
      "去注册",
      "忘记密码",
      "提交",
      "确认",
      "下一步",
      "发送",
      "确定",
      "取消",
      "继续",
      "获取验证码",
      "验证码",
      "同意",
      "立即注册",
      "立即登录",
      "马上注册",
      "免费注册",
      "开户",
      "领取",
      "试用",
      "切换",
      "展开",
      "收起",
      "更多",
      "详情",
      "客服",
      "在线客服",
      "咨询",
      "联系我们",
      "中文",
      "繁體",
      "繁体",
      "简体",
      "语言",
      "語系",
      "返回",
      "关闭",
    ].map((value) => value.toLowerCase()),
  );

  const ACTION_TEXT_RE =
    /立即|马上|免费|开户|领取|试用|切换|展开|收起|更多|详情|客服|咨询|注册|登录|登陆|找回|验证码|同意|协议|下一步|提交|确认|联系|支持|语言|english|register|login|signup|sign\s*up|forgot|password|verify|continue|submit/i;

  function normalizeActionText(value: string): string {
    return value.replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isActionTextHit(text: string): boolean {
    const n = normalizeActionText(text);
    if (!n || n.length > 40) {
      return false;
    }
    if (ACTION_TEXT_SET.has(n)) {
      return true;
    }
    if (n.length <= 28) {
      for (const key of ACTION_TEXT_SET) {
        if (key.length >= 2 && (n.includes(key) || (key.length <= 12 && key.includes(n)))) {
          return true;
        }
      }
    }
    return ACTION_TEXT_RE.test(n);
  }

  function isLocaleChipText(text: string): boolean {
    const t = text.trim();
    if (!t || t.length > 16) {
      return false;
    }
    return /^(en|eng|english|he|iw|ar|zh|cn|jp|ja|ko|ru|fr|de|es|pt|th|vi|id|ms|繁|简|中文|繁體|繁体|简体|עברית|العربية|🇺🇸|🇨🇳|🇮🇱)$/i.test(
      t,
    );
  }

  function isTextLeafLike(element: HTMLElement): boolean {
    // 叶子：无元素子节点，或子节点仅含纯文本包装（无再嵌套可交互结构）
    const elementChildren = Array.from(element.children).filter(
      (child) => child instanceof HTMLElement,
    );
    if (elementChildren.length === 0) {
      return true;
    }
    // 允许仅一层文本包装：所有子节点自身无元素子节点
    return elementChildren.every((child) => child.children.length === 0);
  }

  function hasButtonSemanticClass(element: HTMLElement): boolean {
    const className =
      typeof element.className === "string" ? element.className : String(element.className ?? "");
    return (
      /(?:^|\s)[^\s]*(?:btn|button|link|tab|cta|action|tap|click|kefu|lang|locale|icon)[^\s]*(?:\s|$)/i.test(
        className,
      ) || /btn|button|link|tab|cta|clickable|tap-|kefu|lang|locale/i.test(className)
    );
  }

  function isFrameworkHostTag(tag: string): boolean {
    return (
      tag === "uni-view" ||
      tag === "uni-text" ||
      tag === "uni-button" ||
      tag === "uni-image" ||
      tag === "uni-icons" ||
      tag === "view" ||
      tag === "text" ||
      tag === "image"
    );
  }

  function resolveMediaLabel(element: HTMLElement): string | null {
    const aria = cleanText(element.getAttribute("aria-label"));
    if (aria) return aria;
    const title = cleanText(element.getAttribute("title"));
    if (title) return title;
    const alt = cleanText(element.getAttribute("alt"));
    if (alt) return alt;
    const img =
      element.tagName.toLowerCase() === "img"
        ? element
        : (element.querySelector("img") as HTMLElement | null);
    const src = String(
      img?.getAttribute("src") || element.getAttribute("src") || "",
    );
    const cls = `${typeof element.className === "string" ? element.className : ""} ${
      element.parentElement && typeof element.parentElement.className === "string"
        ? element.parentElement.className
        : ""
    } ${src}`;
    if (/lang|locale|\ben\b|zh|中文|hebrew|\bhe\b/i.test(cls)) return "language";
    if (/kefu|service|support|headset|客服|my00\d|topright|head/i.test(cls)) {
      return "support";
    }
    const base = src.split(/[/\\]/).pop()?.replace(/\.\w+$/, "") || "";
    if (base && base.length <= 20) return `icon:${base}`;
    return "icon";
  }

  /** 无文字图标钮（uni-image / img / 小 uni-view 包图） */
  function isIconOnlyHost(element: HTMLElement): boolean {
    const tag = element.tagName.toLowerCase();
    if (
      tag === "html" ||
      tag === "body" ||
      tag === "script" ||
      tag === "style" ||
      tag === "video" ||
      tag === "canvas"
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 6 || rect.height < 6 || rect.width > 160 || rect.height > 160) {
      return false;
    }
    const text = cleanText(element.innerText || element.textContent);
    if (text && text.length > 12) {
      return false;
    }
    if (tag === "img" || tag === "uni-image" || tag === "image" || tag === "svg" || tag === "i") {
      return true;
    }
    if (isFrameworkHostTag(tag) || tag === "div" || tag === "span" || tag === "a") {
      if (element.querySelector("img, uni-image, image, svg, i, [class*='icon']")) {
        return true;
      }
      // 背景图标（无 <img> 子节点）
      try {
        const bg = window.getComputedStyle(element).backgroundImage || "";
        if (bg && bg !== "none" && /url\(/i.test(bg)) {
          return true;
        }
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  function hasClickSignal(element: HTMLElement): boolean {
    if (typeof element.onclick === "function") {
      return true;
    }
    if (
      element.hasAttribute("onclick") ||
      element.hasAttribute("ng-click") ||
      element.hasAttribute("data-action") ||
      element.hasAttribute("data-click") ||
      element.getAttribute("data-event") === "click"
    ) {
      return true;
    }
    const parent = element.parentElement;
    if (parent && typeof parent.onclick === "function") {
      return true;
    }
    return false;
  }

  /**
   * 伪装可点击（移动端 H5 / Vue / uni-app）：
   * - cursor:pointer / 有效 tabindex
   * - 按钮语义 class（btn/button/link/tab）
   * - 框架宿主标签 + 可见短文本
   * - 高频行为文案精确/模糊匹配
   * - 无文字小图标（语言球 / 客服头像）
   * - 小热区 + pointer-events 可点
   */
  function isHeuristicClickable(element: HTMLElement): boolean {
    if (isNativeInteractive(element)) {
      return false;
    }
    const tag = element.tagName.toLowerCase();
    if (
      tag === "html" ||
      tag === "body" ||
      tag === "script" ||
      tag === "style" ||
      tag === "path" ||
      tag === "video" ||
      tag === "canvas" ||
      tag === "input" ||
      tag === "select" ||
      tag === "textarea"
    ) {
      return false;
    }

    const text = cleanText(element.innerText || element.textContent);
    const tabindexRaw = element.getAttribute("tabindex");
    const hasTabIndex =
      tabindexRaw !== null && tabindexRaw.trim() !== "" && tabindexRaw.trim() !== "-1";
    const style = window.getComputedStyle(element);
    if (style.pointerEvents === "none") {
      // 事件可能在父级：若自身 pointer-events:none 且无点击信号，跳过
      if (!hasClickSignal(element) && !(element.parentElement && hasClickSignal(element.parentElement))) {
        return false;
      }
    }
    const parent = element.parentElement;
    const parentPointer =
      parent != null && window.getComputedStyle(parent).cursor === "pointer";
    const hasPointer = style.cursor === "pointer" || parentPointer;
    const hasSemanticClass = hasButtonSemanticClass(element);
    const frameworkHost = isFrameworkHostTag(tag);
    const iconOnly = isIconOnlyHost(element);
    const clickSignal = hasClickSignal(element);
    const rectEarly = element.getBoundingClientRect();
    const smallHot =
      rectEarly.width > 0 &&
      rectEarly.height > 0 &&
      rectEarly.width <= 160 &&
      rectEarly.height <= 160;

    // 图标钮：无 DOM 文案（EN 画在 PNG 上）也必须收录
    if (iconOnly) {
      const clickish =
        hasPointer ||
        hasTabIndex ||
        hasSemanticClass ||
        frameworkHost ||
        clickSignal ||
        tag === "img" ||
        tag === "uni-image" ||
        tag === "image" ||
        Boolean(parent && isFrameworkHostTag(parent.tagName.toLowerCase()));
      return clickish;
    }

    // 小热区 + 可点信号（无文案也可）
    if (!text && smallHot && (hasPointer || hasTabIndex || hasSemanticClass || clickSignal)) {
      return true;
    }

    if (!text || text.length > 80) {
      return false;
    }

    const actionTextHit = isActionTextHit(text);
    const localeChip = isLocaleChipText(text);
    const smallChip = rectEarly.width > 0 && rectEarly.width <= 88 && rectEarly.height <= 88;

    // 语言球 / 短圆钮：即使无 pointer class 也收录
    if (localeChip && (smallChip || hasPointer || hasTabIndex || isTextLeafLike(element) || frameworkHost)) {
      return true;
    }

    // 文案兜底：必须近似叶子，避免整页容器
    if (actionTextHit) {
      if (!isTextLeafLike(element) && !frameworkHost && !hasSemanticClass) {
        if (!isTextLeafLike(element)) {
          const deepLeaves = Array.from(element.querySelectorAll("*")).filter(
            (node): node is HTMLElement => node instanceof HTMLElement,
          );
          for (const leaf of deepLeaves) {
            if (!isDocumentVisible(leaf) || !isTextLeafLike(leaf)) {
              continue;
            }
            const leafText = cleanText(leaf.innerText || leaf.textContent);
            if (leafText && isActionTextHit(leafText)) {
              return false;
            }
          }
        }
      }
      return true;
    }

    if (!hasPointer && !hasTabIndex && !hasSemanticClass && !frameworkHost && !clickSignal) {
      return false;
    }

    // 框架宿主标签本身不够：还需 pointer / tabindex / 语义 class / 点击信号
    if (frameworkHost && !hasPointer && !hasTabIndex && !hasSemanticClass && !clickSignal) {
      return false;
    }

    // pointer / tabindex / class：叶子优先，避免巨型父级
    if ((hasPointer || hasTabIndex || hasSemanticClass || clickSignal) && !isTextLeafLike(element)) {
      const descendants = Array.from(
        element.querySelectorAll(
          "div, span, p, li, label, a, button, section, uni-view, uni-text, uni-button, uni-image, view, text, image, img, [class*='btn'], [class*='button'], [class*='link']",
        ),
      );
      for (const child of descendants) {
        if (!(child instanceof HTMLElement) || child === element) {
          continue;
        }
        if (!isDocumentVisible(child)) {
          continue;
        }
        const childText = cleanText(child.innerText || child.textContent);
        if (!childText && !isIconOnlyHost(child)) {
          continue;
        }
        const childTab = child.getAttribute("tabindex");
        const childHasTab =
          childTab !== null && childTab.trim() !== "" && childTab.trim() !== "-1";
        const childPointer = window.getComputedStyle(child).cursor === "pointer";
        const childClass = hasButtonSemanticClass(child);
        if (
          childPointer ||
          childHasTab ||
          childClass ||
          isNativeInteractive(child) ||
          (childText && isActionTextHit(childText)) ||
          isIconOnlyHost(child)
        ) {
          return false;
        }
      }
    }

    return hasPointer || hasTabIndex || hasSemanticClass || clickSignal;
  }

  function overlapsCollected(element: HTMLElement, collected: HTMLElement[]): boolean {
    for (const existing of collected) {
      if (existing === element || existing.contains(element) || element.contains(existing)) {
        return true;
      }
    }
    return false;
  }

  function resolveAdjacentText(element: HTMLElement): string | null {
    let prev: ChildNode | null = element.previousSibling;
    let hops = 0;
    while (prev && hops < 6) {
      hops += 1;
      if (prev.nodeType === Node.TEXT_NODE) {
        const textNode = cleanText(prev.textContent);
        if (textNode) {
          return textNode.slice(0, 60);
        }
      } else if (prev.nodeType === Node.ELEMENT_NODE) {
        const el = prev as HTMLElement;
        const tag = el.tagName.toLowerCase();
        if (tag === "label" || tag === "span" || tag === "div" || tag === "p" || tag === "strong" || tag === "b") {
          const htmlText = cleanText(el.textContent);
          if (htmlText && htmlText.length <= 40) {
            return htmlText;
          }
        }
        break;
      }
      prev = prev.previousSibling;
    }
    const parent = element.parentElement;
    if (parent) {
      for (let index = 0; index < Math.min(parent.childNodes.length, 8); index += 1) {
        const child = parent.childNodes[index];
        if (child === element) {
          break;
        }
        if (child.nodeType === Node.TEXT_NODE) {
          const siblingText = cleanText(child.textContent);
          if (siblingText && siblingText.length <= 40) {
            return siblingText;
          }
        }
      }
    }
    return null;
  }

  /** 规格优先级：aria-label → placeholder → label-for → adjacent → input-type */
  function sniffSemantic(element: HTMLElement, inputType: string | null): {
    label: string;
    source: string;
    adjacentText: string | null;
  } {
    const ariaLabel = cleanText(element.getAttribute("aria-label"));
    if (ariaLabel) {
      return { label: ariaLabel, source: "aria-label", adjacentText: null };
    }
    const placeholder = cleanText(element.getAttribute("placeholder"));
    if (placeholder) {
      return { label: placeholder, source: "placeholder", adjacentText: null };
    }
    const labelFor = resolveLabel(element);
    // resolveLabel 含 aria/placeholder 混入；此处再单独取 label[for]
    let labelOnly: string | null = null;
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
    ) {
      const labels = element.labels;
      if (labels) {
        for (const label of Array.from(labels)) {
          const text = cleanText(label.textContent);
          if (text) {
            labelOnly = text;
            break;
          }
        }
      }
    }
    if (!labelOnly) {
      const elementId = element.id.trim();
      if (elementId) {
        try {
          const linked = document.querySelector(`label[for="${CSS.escape(elementId)}"]`);
          labelOnly = cleanText(linked?.textContent ?? null);
        } catch {
          labelOnly = null;
        }
      }
    }
    if (labelOnly) {
      return { label: labelOnly, source: "label-for", adjacentText: null };
    }
    const adjacentText = resolveAdjacentText(element);
    if (adjacentText) {
      return { label: adjacentText, source: "adjacent-text", adjacentText };
    }
    if (labelFor) {
      return { label: labelFor, source: "label-for", adjacentText: null };
    }
    const type = (inputType ?? "").trim() || "字段";
    return { label: type, source: inputType ? "input-type" : "unknown", adjacentText: null };
  }

  function pushResult(
    element: HTMLElement,
    inputType: string | null,
    collected: HTMLElement[],
    results: Array<{
      tagName: string;
      inputType: string | null;
      id: string | null;
      name: string | null;
      placeholder: string | null;
      ariaLabel: string | null;
      role: string | null;
      label: string | null;
      text: string | null;
      adjacentText?: string | null;
      semanticLabel?: string | null;
      semanticSource?: string | null;
      selector: string;
      xpath: string;
      className?: string | null;
    }>,
  ): void {
    const tagName = element.tagName.toLowerCase();
    const label = resolveLabel(element);
    const sniffed = sniffSemantic(element, inputType);
    let text =
      cleanText(element.innerText || element.textContent) ||
      sniffed.label ||
      label ||
      cleanText(element.getAttribute("aria-label"));
    if (!text) {
      text = resolveMediaLabel(element);
    }
    results.push({
      tagName,
      inputType,
      id: cleanText(element.id),
      name: cleanText(element.getAttribute("name")),
      placeholder: cleanText(element.getAttribute("placeholder")),
      ariaLabel: cleanText(element.getAttribute("aria-label")),
      role: cleanText(element.getAttribute("role")),
      label: label || text,
      text,
      adjacentText: sniffed.adjacentText,
      semanticLabel: sniffed.label || text,
      semanticSource: sniffed.source || (text ? "media" : null),
      selector: buildSelector(element),
      xpath: buildXPath(element),
      className:
        typeof element.className === "string"
          ? element.className.slice(0, 120)
          : String(element.className ?? "").slice(0, 120),
    });
    collected.push(element);
  }

  const nativeCandidates: HTMLElement[] = [];
  const heuristicCandidates: HTMLElement[] = [];

  /** Shadow DOM + 同源 iframe 递归穿透 */
  function collectDeepElements(root: Document | ShadowRoot | DocumentFragment): void {
    const visit = (node: Node): void => {
      if (node instanceof HTMLElement) {
        const tag = node.tagName.toLowerCase();
        if (isNativeInteractive(node)) {
          nativeCandidates.push(node);
        } else if (
          tag === "div" ||
          tag === "span" ||
          tag === "p" ||
          tag === "li" ||
          tag === "label" ||
          tag === "section" ||
          tag === "article" ||
          tag.startsWith("h") ||
          tag === "i" ||
          tag === "em" ||
          tag === "strong" ||
          tag === "b" ||
          tag === "u" ||
          tag === "img" ||
          tag === "svg" ||
          isFrameworkHostTag(tag) ||
          node.hasAttribute("tabindex") ||
          hasButtonSemanticClass(node)
        ) {
          heuristicCandidates.push(node);
        }

        if (node.shadowRoot) {
          try {
            collectDeepElements(node.shadowRoot);
          } catch {
            // closed shadow / 异常忽略
          }
        }
        // iframe：由 extractAgentInteractiveTree 对 page.frames() 逐个 evaluate（try/catch）穿透
      }

      const children = node.childNodes;
      for (let i = 0; i < children.length; i += 1) {
        visit(children[i]!);
      }
    };

    try {
      visit(root);
    } catch {
      // 防御性：遍历失败不阻断
    }
  }

  try {
    collectDeepElements(document);
  } catch {
    // fallback: 浅层 querySelector
    document
      .querySelectorAll(
        "input, select, textarea, button, a, [role='button'], uni-button, [class*='btn']",
      )
      .forEach((node) => {
        if (node instanceof HTMLElement) {
          nativeCandidates.push(node);
        }
      });
  }

  const results: Array<{
    tagName: string;
    inputType: string | null;
    id: string | null;
    name: string | null;
    placeholder: string | null;
    ariaLabel: string | null;
    role: string | null;
    label: string | null;
    text: string | null;
    selector: string;
    xpath: string;
    rect?: { x: number; y: number; w: number; h: number };
  }> = [];
  const collected: HTMLElement[] = [];
  const resultElements: HTMLElement[] = [];

  let skipped = 0;
  for (const element of nativeCandidates) {
    if (!(element instanceof HTMLElement) || !isNativeInteractive(element)) {
      continue;
    }
    if (!isDocumentVisible(element)) {
      skipped += 1;
      continue;
    }
    if ("disabled" in element && Boolean((element as HTMLInputElement).disabled)) {
      skipped += 1;
      continue;
    }
    if (overlapsCollected(element, collected)) {
      skipped += 1;
      continue;
    }

    const tagName = element.tagName.toLowerCase();
    let inputType: string | null = null;
    if (element instanceof HTMLInputElement) {
      inputType = element.type || "text";
      if (inputType === "hidden") {
        skipped += 1;
        continue;
      }
    } else if (element instanceof HTMLSelectElement) {
      inputType = element.multiple ? "select-multiple" : "select-one";
    } else if (tagName === "textarea" || element.isContentEditable) {
      inputType = "textarea";
    } else if (tagName === "button" || tagName === "uni-button") {
      inputType = "button";
    } else if (tagName === "a") {
      inputType = "link";
    } else {
      inputType = element.getAttribute("role") || "button";
    }

    pushResult(element, inputType, collected, results);
    resultElements.push(element);
  }

  for (const element of heuristicCandidates) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }
    if (!isHeuristicClickable(element)) {
      continue;
    }
    if (!isDocumentVisible(element)) {
      skipped += 1;
      continue;
    }
    if (overlapsCollected(element, collected)) {
      skipped += 1;
      continue;
    }
    pushResult(element, "button", collected, results);
    resultElements.push(element);
  }

  // 附带视口坐标，供 SoM 标注
  for (let i = 0; i < results.length; i += 1) {
    const el = resultElements[i];
    if (!el) {
      continue;
    }
    try {
      const rect = el.getBoundingClientRect();
      results[i]!.rect = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
    } catch {
      // ignore
    }
  }

  return { elements: results, skipped };
};

function mapAgentType(raw: AgentRawElement): string {
  const tag = raw.tagName.toLowerCase();
  const type = (raw.inputType ?? "").toLowerCase();
  const role = (raw.role ?? "").toLowerCase();
  if (role === "iframe" || tag === "iframe") {
    return "iframe";
  }
  if (tag === "select" || type.startsWith("select") || role === "combobox" || role === "listbox") {
    return "combobox";
  }
  if (tag === "textarea" || type === "textarea") {
    return "textbox";
  }
  if (type === "search" || role === "searchbox") {
    return "searchbox";
  }
  if (
    type === "text" ||
    type === "email" ||
    type === "password" ||
    type === "tel" ||
    type === "number" ||
    type === "url" ||
    type === "" ||
    type === "null"
  ) {
    if (tag === "input" || role === "textbox" || role === "spinbutton") {
      return "textbox";
    }
  }
  if (tag === "input" && (!type || type === "text")) {
    return "textbox";
  }
  if (tag === "button" || tag === "uni-button" || type === "button" || type === "submit" || role === "button") {
    return "button";
  }
  if (tag === "a" || type === "link" || role === "link") {
    return "link";
  }
  if (type === "checkbox" || role === "checkbox") {
    return "checkbox";
  }
  if (type === "radio" || role === "radio") {
    return "radio";
  }
  if (role === "tab") {
    return "tab";
  }
  if (role === "menuitem") {
    return "menuitem";
  }
  // 语言球 / 客服图标 / 合成标签
  const label = (raw.text || raw.label || "").trim();
  if (
    label.length > 0 &&
    label.length <= 16 &&
    /^(en|eng|english|he|iw|ar|zh|cn|jp|ja|ko|ru|fr|de|es|pt|中文|繁|简|繁體|繁体|简体|language|support|icon[:.].+)$/i.test(
      label,
    )
  ) {
    return "button";
  }
  if (role === "switch" || role === "slider") {
    return "button";
  }
  if (type) {
    return `input:${type}`;
  }
  return tag || "other";
}

const CLEAR_AND_INJECT_SOM_SCRIPT = (marks: Array<{ id: string; x: number; y: number }>) => {
  try {
    document.querySelectorAll("[data-agent-som]").forEach((node) => {
      try {
        node.remove();
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }

  for (const mark of marks) {
    try {
      const badge = document.createElement("div");
      badge.setAttribute("data-agent-som", mark.id);
      badge.textContent = mark.id.replace(/^e/i, "") || mark.id;
      badge.style.cssText = [
        "position:fixed",
        `left:${Math.max(0, mark.x)}px`,
        `top:${Math.max(0, mark.y)}px`,
        "z-index:2147483646",
        "background:#e11d48",
        "color:#fff",
        "font:700 11px/1.2 monospace",
        "padding:2px 4px",
        "border-radius:3px",
        "pointer-events:none",
        "box-shadow:0 0 0 1px #fff",
      ].join(";");
      document.documentElement.appendChild(badge);
    } catch {
      /* ignore single mark */
    }
  }
  return true;
};

const CLEAR_SOM_SCRIPT = () => {
  try {
    document.querySelectorAll("[data-agent-som]").forEach((node) => node.remove());
  } catch {
    /* ignore */
  }
  return true;
};

export interface ExtractAgentTreeOptions {
  /** When false, skip SoM injection and JPEG capture (text-first / economy). */
  includeScreenshot?: boolean;
}

/** Agent 提取：Shadow/iframe 穿透；截图按需（默认仍拍，调用方可关） */
export async function extractAgentInteractiveTree(
  page: Page,
  options: ExtractAgentTreeOptions = {},
): Promise<AgentExtractResult> {
  const includeScreenshot = options.includeScreenshot !== false;
  const rawElements: AgentRawElement[] = [];
  let skipped = 0;
  const seenKeys = new Set<string>();

  const ingest = (list: AgentRawElement[], frameUrl: string | null) => {
    for (const item of list) {
      const key = `${frameUrl ?? ""}::${item.selector}::${item.xpath}::${item.text ?? ""}`;
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      rawElements.push({
        ...item,
        frameUrl,
      });
    }
  };

  // 穿透：对每个 frame 独立 evaluate（含同源 iframe）；跨域 / 超时跳过
  const FRAME_EVAL_MS = 2_500;
  for (const frame of page.frames()) {
    try {
      const evaluated = await Promise.race([
        frame.evaluate(EXTRACT_AGENT_TREE_SCRIPT),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), FRAME_EVAL_MS);
        }),
      ]);
      if (!evaluated) {
        skipped += 1;
        continue;
      }
      const isMain = frame === page.mainFrame();
      ingest((evaluated?.elements ?? []) as AgentRawElement[], isMain ? null : frame.url());
      skipped += Number(evaluated?.skipped ?? 0);
    } catch {
      // 跨域 / 卸载中的 frame：忽略（可 request_vision 兜底）
    }
  }

  // 跨域 iframe 占位：让模型知道有嵌套框，可开眼或 handover
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) {
      continue;
    }
    const frameUrl = frame.url();
    if (!frameUrl || frameUrl === "about:blank") {
      continue;
    }
    const already = rawElements.some((item) => item.frameUrl === frameUrl);
    if (already) {
      continue;
    }
    try {
      await frame.evaluate(() => document.body?.tagName);
    } catch {
      rawElements.push({
        tagName: "IFRAME",
        inputType: null,
        id: null,
        name: null,
        placeholder: null,
        ariaLabel: null,
        role: "iframe",
        label: null,
        text: `跨域框架 ${frameUrl.slice(0, 60)}`,
        selector: "iframe",
        xpath: "",
        frameUrl,
      });
      skipped += 1;
    }
  }

  // Canvas 占位：DOM 无法索引画布内控件，提示走视觉
  try {
    const canvasHints = await page.evaluate(() => {
      const out: Array<{ w: number; h: number; index: number }> = [];
      const nodes = Array.from(document.querySelectorAll("canvas"));
      nodes.forEach((node, index) => {
        if (!(node instanceof HTMLElement)) return;
        const rect = node.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 40) return;
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return;
        out.push({
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          index,
        });
      });
      return out.slice(0, 3);
    });
    for (const hint of canvasHints) {
      rawElements.push({
        tagName: "CANVAS",
        inputType: null,
        id: null,
        name: null,
        placeholder: null,
        ariaLabel: null,
        role: "img",
        label: null,
        text: `画布控件 ${hint.w}x${hint.h}（需视觉定位）`,
        selector: `canvas >> nth=${hint.index}`,
        xpath: "",
        frameUrl: null,
        rect: undefined,
      });
    }
  } catch {
    /* ignore */
  }

  const llm_json: AgentLlmElement[] = [];
  const element_map = new Map<string, AgentElementRef>();
  const somMarks: Array<{ id: string; x: number; y: number }> = [];

  rawElements.forEach((raw, index) => {
    const id = `e${index + 1}`;
    const semanticContext = buildSemanticContextFromRaw({
      ariaLabel: raw.ariaLabel,
      placeholder: raw.placeholder,
      labelFor: raw.semanticSource === "label-for" ? raw.semanticLabel : raw.label,
      adjacentText: raw.adjacentText ?? (raw.semanticSource === "adjacent-text" ? raw.semanticLabel : null),
      inputType: raw.inputType,
      name: raw.name,
      agentText: raw.semanticLabel ?? raw.text,
    });
    // 若浏览器已给出优先序结果，覆盖 source/label
    if (raw.semanticLabel && raw.semanticSource) {
      semanticContext.label = raw.semanticLabel.slice(0, 80);
      semanticContext.source = raw.semanticSource as SemanticContext["source"];
      semanticContext.inputType = (raw.inputType ?? "").toLowerCase() || semanticContext.inputType;
    }

    let text =
      semanticContext.label ||
      raw.text?.trim() ||
      raw.label?.trim() ||
      raw.placeholder?.trim() ||
      raw.name?.trim() ||
      raw.id?.trim() ||
      mapAgentType(raw);
    const inputType = (raw.inputType ?? "").toLowerCase();
    if (inputType === "password" && !/密码|password|pwd/i.test(text)) {
      text = `${text} password`.trim();
    }
    if ((inputType === "email" || inputType === "tel") && !/邮箱|email|手机|mobile|phone|tel/i.test(text)) {
      text = `${text} ${inputType}`.trim();
    }

    const llmItem: AgentLlmElement = {
      id,
      type: mapAgentType(raw),
      text: text.slice(0, 80),
    };
    if (raw.name) {
      llmItem.name = raw.name;
    }
    if (raw.placeholder) {
      llmItem.placeholder = raw.placeholder;
    }
    if (raw.role) {
      llmItem.role = raw.role;
    }
    llm_json.push(llmItem);

    element_map.set(id, {
      id,
      selector: raw.selector,
      xpath: raw.xpath,
      tagName: raw.tagName,
      inputType: raw.inputType,
      text: llmItem.text,
      semanticContext,
      frameUrl: raw.frameUrl ?? null,
      rect: raw.rect && raw.rect.w > 0 && raw.rect.h > 0 && !raw.frameUrl ? raw.rect : null,
      fingerprint: buildElementFingerprint({
        tagName: raw.tagName,
        text: llmItem.text,
        inputType: raw.inputType,
        name: raw.name,
        placeholder: raw.placeholder,
        role: raw.role,
        ariaLabel: raw.ariaLabel,
        className: raw.className,
        xpath: raw.xpath,
        selector: raw.selector,
      }),
    });

    if (raw.rect && raw.rect.w > 0 && raw.rect.h > 0 && !raw.frameUrl) {
      somMarks.push({ id, x: raw.rect.x, y: raw.rect.y });
    }
  });

  let screenshotBase64: string | null = null;
  if (includeScreenshot) {
    try {
      await page.evaluate(CLEAR_AND_INJECT_SOM_SCRIPT, somMarks.slice(0, 80));
    } catch {
      /* SoM 失败不阻断 */
    }

    try {
      const buffer = await page.screenshot({
        type: "jpeg",
        quality: 50,
      });
      screenshotBase64 = Buffer.from(buffer).toString("base64");
    } catch {
      screenshotBase64 = null;
    }

    try {
      await page.evaluate(CLEAR_SOM_SCRIPT);
    } catch {
      /* ignore */
    }
  }

  return {
    url: page.url(),
    extractedAt: new Date().toISOString(),
    llm_json,
    element_map,
    skipped,
    screenshotBase64,
  };
}

/**
 * 按已蒸馏短 ID 注入 SoM 并截图（保证角标数字与 llm_json.id 一致）。
 */
export async function captureSomScreenshotForMap(
  page: Page,
  elementMap: Map<string, AgentElementRef>,
  llmJson: AgentLlmElement[],
): Promise<string | null> {
  const marks: Array<{ id: string; x: number; y: number }> = [];
  for (const item of llmJson.slice(0, 80)) {
    const ref = elementMap.get(item.id);
    const rect = ref?.rect;
    if (!rect || rect.w <= 0 || rect.h <= 0) {
      continue;
    }
    marks.push({ id: item.id, x: rect.x, y: rect.y });
  }
  if (marks.length === 0) {
    try {
      const buffer = await page.screenshot({ type: "jpeg", quality: 50 });
      return Buffer.from(buffer).toString("base64");
    } catch {
      return null;
    }
  }
  try {
    await page.evaluate(CLEAR_AND_INJECT_SOM_SCRIPT, marks);
  } catch {
    /* ignore */
  }
  let screenshotBase64: string | null = null;
  try {
    const buffer = await page.screenshot({ type: "jpeg", quality: 50 });
    screenshotBase64 = Buffer.from(buffer).toString("base64");
  } catch {
    screenshotBase64 = null;
  }
  try {
    await page.evaluate(CLEAR_SOM_SCRIPT);
  } catch {
    /* ignore */
  }
  return screenshotBase64;
}

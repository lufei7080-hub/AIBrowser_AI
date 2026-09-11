import type { Page } from "playwright-core";
import {
  extractAgentInteractiveTree,
  type AgentElementRef,
  type AgentExtractResult,
} from "../interactive_elements.js";
import type { BrowserStateSummary, IndexedElementRef } from "./views.js";

/**
 * 将现有 Agent 短 ID 树转为 browser-use 风格 [index] XML + selector_map
 */
export async function captureBrowserState(
  page: Page,
  options: {
    previousIndexes?: Set<number>;
    previousUrl?: string | null;
    includeScreenshot?: boolean;
    maxChars?: number;
  } = {},
): Promise<BrowserStateSummary> {
  const extracted = await extractAgentInteractiveTree(page, {
    includeScreenshot: options.includeScreenshot === true,
  });
  return buildBrowserStateFromExtract(page, extracted, options);
}

export async function buildBrowserStateFromExtract(
  page: Page,
  extracted: AgentExtractResult,
  options: {
    previousIndexes?: Set<number>;
    previousUrl?: string | null;
    maxChars?: number;
  } = {},
): Promise<BrowserStateSummary> {
  const maxChars = options.maxChars ?? 40000;
  const selectorMap = new Map<number, IndexedElementRef>();
  const lines: string[] = [];
  const urlChanged =
    Boolean(options.previousUrl) && options.previousUrl !== extracted.url;

  let index = 1;
  for (const el of extracted.llm_json) {
    const ref = extracted.element_map.get(el.id);
    if (!ref) continue;
    const mapped = toIndexedRef(index, el.id, ref, el);
    selectorMap.set(index, mapped);
    const isNew =
      !urlChanged &&
      options.previousIndexes &&
      options.previousIndexes.size > 0 &&
      !options.previousIndexes.has(index);
    // 新元素标记：用 shortId 集合对比更稳——上一步保存的是 index，同页重排时可能漂移；
    // 同时用 text+tag 指纹辅助：若 previousIndexes 按「位置」对比，首轮不标星。
    const star = isNew ? "*" : "";
    const attrs: string[] = [];
    if (el.type && el.type !== "other") attrs.push(`type=${escapeAttr(el.type)}`);
    if (el.placeholder) attrs.push(`placeholder=${escapeAttr(el.placeholder)}`);
    if (el.name) attrs.push(`name=${escapeAttr(el.name)}`);
    if (el.role) attrs.push(`role=${escapeAttr(el.role)}`);
    const tag = (ref.tagName || "div").toLowerCase();
    const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";
    lines.push(`${star}[${index}]<${tag}${attrStr} id="${el.id}" />`);
    if (el.text?.trim()) {
      lines.push(`\t${truncate(el.text.trim(), 120)}`);
    }
    index += 1;
  }

  let tree = lines.join("\n");
  if (tree.length > maxChars) {
    tree = `${tree.slice(0, maxChars)}\n…(truncated ${tree.length - maxChars} chars)`;
  }

  const pages = await page.evaluate(() => {
    const doc = document.documentElement;
    const scrollTop = window.scrollY || doc.scrollTop || 0;
    const view = window.innerHeight || 1;
    const height = Math.max(doc.scrollHeight, doc.clientHeight);
    return {
      pagesAbove: Math.max(0, scrollTop / view),
      pagesBelow: Math.max(0, (height - scrollTop - view) / view),
    };
  });

  const tabs = await listTabs(page);
  const title = await page.title().catch(() => "");

  return {
    url: extracted.url || page.url(),
    title,
    tabs,
    interactiveTree: tree || "(no interactive elements in viewport)",
    elementCount: selectorMap.size,
    selectorMap,
    screenshotBase64: extracted.screenshotBase64 ?? null,
    pageInfo: {
      pagesAbove: Number(pages.pagesAbove.toFixed(2)),
      pagesBelow: Number(pages.pagesBelow.toFixed(2)),
    },
  };
}

function toIndexedRef(
  index: number,
  shortId: string,
  ref: AgentElementRef,
  el: { type: string; text: string; name?: string; placeholder?: string; role?: string },
): IndexedElementRef {
  return {
    index,
    shortId,
    selector: ref.selector,
    xpath: ref.xpath,
    tagName: ref.tagName,
    inputType: ref.inputType,
    text: el.text || ref.text,
    role: el.role,
    placeholder: el.placeholder,
    name: el.name,
    rect: ref.rect ?? null,
  };
}

async function listTabs(page: Page): Promise<Array<{ id: string; url: string; title: string }>> {
  const context = page.context();
  const pages = context.pages();
  const out: Array<{ id: string; url: string; title: string }> = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]!;
    const id = String(i + 1).padStart(4, "0").slice(-4);
    let title = "";
    try {
      title = await p.title();
    } catch {
      title = "";
    }
    out.push({ id, url: p.url(), title });
  }
  return out;
}

function escapeAttr(v: string): string {
  return `"${v.replace(/"/g, "'").slice(0, 80)}"`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** 用 shortId 集合标记新元素更稳：比较上一步 shortId */
export function buildBrowserStateWithShortIdDiff(
  page: Page,
  extracted: AgentExtractResult,
  previousShortIds: Set<string> | null,
  previousUrl: string | null,
  maxChars = 40000,
): Promise<BrowserStateSummary> {
  const max = maxChars;
  const selectorMap = new Map<number, IndexedElementRef>();
  const lines: string[] = [];
  const urlChanged = Boolean(previousUrl) && previousUrl !== extracted.url;
  let index = 1;
  for (const el of extracted.llm_json) {
    const ref = extracted.element_map.get(el.id);
    if (!ref) continue;
    selectorMap.set(index, toIndexedRef(index, el.id, ref, el));
    const isNew =
      !urlChanged && previousShortIds && previousShortIds.size > 0 && !previousShortIds.has(el.id);
    const star = isNew ? "*" : "";
    const attrs: string[] = [];
    if (el.type && el.type !== "other") attrs.push(`type=${escapeAttr(el.type)}`);
    if (el.placeholder) attrs.push(`placeholder=${escapeAttr(el.placeholder)}`);
    if (el.name) attrs.push(`name=${escapeAttr(el.name)}`);
    if (el.role) attrs.push(`role=${escapeAttr(el.role)}`);
    const tag = (ref.tagName || "div").toLowerCase();
    const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";
    lines.push(`${star}[${index}]<${tag}${attrStr} id="${el.id}" />`);
    if (el.text?.trim()) lines.push(`\t${truncate(el.text.trim(), 120)}`);
    index += 1;
  }
  let tree = lines.join("\n");
  if (tree.length > max) tree = `${tree.slice(0, max)}\n…(truncated)`;

  return (async () => {
    const pages = await page.evaluate(() => {
      const doc = document.documentElement;
      const scrollTop = window.scrollY || doc.scrollTop || 0;
      const view = window.innerHeight || 1;
      const height = Math.max(doc.scrollHeight, doc.clientHeight);
      return {
        pagesAbove: Math.max(0, scrollTop / view),
        pagesBelow: Math.max(0, (height - scrollTop - view) / view),
      };
    });
    const tabs = await listTabs(page);
    const title = await page.title().catch(() => "");
    return {
      url: extracted.url || page.url(),
      title,
      tabs,
      interactiveTree: tree || "(no interactive elements in viewport)",
      elementCount: selectorMap.size,
      selectorMap,
      screenshotBase64: extracted.screenshotBase64 ?? null,
      pageInfo: {
        pagesAbove: Number(pages.pagesAbove.toFixed(2)),
        pagesBelow: Number(pages.pagesBelow.toFixed(2)),
      },
    };
  })();
}

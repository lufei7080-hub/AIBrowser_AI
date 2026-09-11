/**
 * 全面网页感知（对标 browser-use / a11y 树 + 几何）：
 * - 可见文字 + 包围盒（脚本抽取，无需 OCR）
 * - 可点击候选（含短语言码 EN/HE 等伪按钮）
 * Token 友好：压缩为索引行，坐标用相对视口百分比。
 */
import type { Page } from "playwright-core";

export { isLanguageSwitchGoal } from "./language_switch.js";
import { isLanguageSwitchGoal } from "./language_switch.js";
import { isFillLocaleGoal } from "./fill_locale.js";

export interface PerceiveItem {
  id: number;
  kind: "click" | "text" | "input";
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PagePerceiveResult {
  url: string;
  viewport: { width: number; height: number };
  items: PerceiveItem[];
  /** 目标关键词是否命中可见文案 */
  goalHits: string[];
}

/**
 * 仅「切 UI 语言」任务才提取语言芯片关键词。
 * 「用希伯来语填写」不得把 HE/עברית 当目标命中，否则会误判 missGoal → 烧 vision。
 */
export function extractGoalKeywords(goal: string): string[] {
  const raw = String(goal ?? "");
  if (isFillLocaleGoal(raw) && !isLanguageSwitchGoal(raw)) {
    return [];
  }
  if (!isLanguageSwitchGoal(raw)) {
    return [];
  }
  const keys = new Set<string>();
  for (const m of raw.matchAll(
    /Hebrew|עברית|English|中文|繁體|简体|العربية|语言|語|language|locale|EN\b|HE\b|CN\b/gi,
  )) {
    keys.add(m[0]);
  }
  if (/希伯来|希伯來|hebrew/i.test(raw)) {
    keys.add("Hebrew");
    keys.add("HE");
    keys.add("EN");
  }
  if (/英语|英文|english|设置成英文|设成英文/i.test(raw)) {
    keys.add("EN");
    keys.add("English");
    keys.add("语言");
    keys.add("Language");
  }
  return [...keys];
}

export function controlsMissGoalKeywords(
  controlTexts: string[],
  goal: string,
): boolean {
  const keys = extractGoalKeywords(goal);
  if (keys.length === 0) {
    return false;
  }
  const blob = controlTexts.join("\n").toLowerCase();
  return !keys.some((key) => blob.includes(key.toLowerCase()));
}

/** 目标暗示需要视觉/空间（图标、验证码图等）——仅用于卡住开眼提示，不每轮强制截图 */
export function goalSuggestsVision(goal: string): boolean {
  return /图标|地球仪|验证码|图片|截图|看图|canvas|地图选点|language\s*icon/i.test(
    String(goal ?? ""),
  );
}

export async function extractPagePerceive(
  page: Page,
  goal?: string,
): Promise<PagePerceiveResult> {
  const keywords = extractGoalKeywords(goal ?? "");
  const data = await page.evaluate((goalKeys: string[]) => {
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const items: Array<{
      id: number;
      kind: "click" | "text" | "input";
      text: string;
      x: number;
      y: number;
      w: number;
      h: number;
    }> = [];

    const clean = (value: string) => value.replace(/\s+/g, " ").trim();
    const seen = new Set<string>();
    let nextId = 1;

    const push = (
      el: Element,
      kind: "click" | "text" | "input",
      textRaw: string,
    ) => {
      const text = clean(textRaw).slice(0, 48);
      if (!text || text.length > 48) {
        return;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) {
        return;
      }
      if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) {
        return;
      }
      const key = `${kind}|${text}|${Math.round(rect.left)}|${Math.round(rect.top)}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      items.push({
        id: nextId++,
        kind,
        text,
        x: Math.round((rect.left / vw) * 1000) / 10,
        y: Math.round((rect.top / vh) * 1000) / 10,
        w: Math.round((rect.width / vw) * 1000) / 10,
        h: Math.round((rect.height / vh) * 1000) / 10,
      });
    };

    const isVisible = (el: Element) => {
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    // 1) 原生可交互
    document
      .querySelectorAll("a, button, input, select, textarea, [role='button'], [onclick]")
      .forEach((node) => {
        if (!(node instanceof HTMLElement) || !isVisible(node)) {
          return;
        }
        const tag = node.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") {
          const label =
            (node as HTMLInputElement).placeholder ||
            (node as HTMLInputElement).name ||
            node.getAttribute("aria-label") ||
            tag;
          push(node, "input", label);
          return;
        }
        push(node, "click", node.innerText || node.textContent || tag);
      });

    // 2) 短文案芯片（语言码 EN/HE 等）— 即使无 role=button
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let current: Node | null = walker.currentNode;
    while (current) {
      const el = current;
      current = walker.nextNode();
      if (!(el instanceof HTMLElement) || !isVisible(el)) {
        continue;
      }
      const text = clean(el.innerText || el.textContent || "");
      if (!text || text.length > 12) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      const small = rect.width <= 72 && rect.height <= 72;
      const locale =
        /^(en|he|iw|ar|zh|cn|jp|ja|ko|ru|fr|de|es|pt|th|vi|id|ms|繁|简|中文)$/i.test(text);
      const style = window.getComputedStyle(el);
      const pointer = style.cursor === "pointer";
      const roundish =
        parseFloat(style.borderRadius) >= Math.min(rect.width, rect.height) * 0.35;
      if ((locale || (small && (pointer || roundish))) && text.length <= 8) {
        // 优先叶子
        if (el.children.length > 2) {
          continue;
        }
        push(el, "click", text);
      }
    }

    // 3) 目标关键词相关可见文字（只读，供定位）
    if (goalKeys.length > 0) {
      const lowerKeys = goalKeys.map((k) => k.toLowerCase());
      document.querySelectorAll("div, span, p, a, button, label, li").forEach((node) => {
        if (!(node instanceof HTMLElement) || !isVisible(node)) {
          return;
        }
        const text = clean(node.innerText || "");
        if (!text || text.length > 40) {
          return;
        }
        if (!lowerKeys.some((k) => text.toLowerCase().includes(k))) {
          return;
        }
        push(node, "text", text);
      });
    }

    // 控制体量
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    return {
      viewport: { width: vw, height: vh },
      items: items.slice(0, 90),
    };
  }, keywords);

  const goalHits = keywords.filter((key) =>
    data.items.some((item) => item.text.toLowerCase().includes(key.toLowerCase())),
  );

  return {
    url: page.url(),
    viewport: data.viewport,
    items: data.items,
    goalHits,
  };
}

export function formatPerceiveForLlm(result: PagePerceiveResult): string {
  const lines = [
    "【可见感知图·脚本坐标·无需 OCR】单位=视口%（x,y,w,h）。click=可点，input=输入，text=相关文案。",
    `URL=${result.url} · 命中目标词=[${result.goalHits.join(",") || "无"}]`,
  ];
  for (const item of result.items.slice(0, 70)) {
    lines.push(
      `[${item.id}] ${item.kind} "${item.text}" @(${item.x},${item.y},${item.w},${item.h})`,
    );
  }
  lines.push(
    "操作：优先用 agent_fill_and_click 的短 id；若控件 JSON 没有目标，用 click_visible_text(text)；语言入口常见地球仪图标或 Language/EN 等短文案。",
  );
  return lines.join("\n");
}

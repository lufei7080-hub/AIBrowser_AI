/**
 * Milestone 5：多 Tab 上下文感知
 *
 * Working Memory 注入 tabs_state；agent_switch_tab 切页后下一轮重新 DOM 蒸馏。
 * 点击弹出新窗口时由 context.on("page") + 本模块快照共同更新感知流。
 */
import type { BrowserContext, Page } from "playwright-core";

export interface TabStateEntry {
  /** 稳定短 ID：t1 / t2 …（按打开顺序） */
  tabId: string;
  title: string;
  url: string;
  active: boolean;
}

function safeTitle(page: Page): Promise<string> {
  return page.title().catch(() => "");
}

/** 列举当前 context 下所有未关闭页面 */
export async function snapshotTabsState(
  context: BrowserContext,
  activePage: Page,
): Promise<TabStateEntry[]> {
  const pages = context.pages().filter((p) => !p.isClosed());
  const entries: TabStateEntry[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    const p = pages[i]!;
    const title = (await safeTitle(p)).trim() || "(无标题)";
    const url = (() => {
      try {
        return p.url();
      } catch {
        return "";
      }
    })();
    entries.push({
      tabId: `t${i + 1}`,
      title: title.slice(0, 80),
      url: url.slice(0, 200),
      active: p === activePage,
    });
  }
  // 若 active 不在列表（极少见），标第一个
  if (entries.length > 0 && !entries.some((e) => e.active)) {
    entries[0]!.active = true;
  }
  return entries;
}

export function formatTabsStateForLlm(tabs: TabStateEntry[]): string {
  if (!tabs.length) {
    return "tabs_state: []";
  }
  const lines = tabs.map((t) => {
    const mark = t.active ? "◀当前" : "";
    return `  - ${t.tabId} ${mark}「${t.title}」 ${t.url || "(about:blank)"}`;
  });
  return ["tabs_state:", ...lines, "切换：agent_switch_tab({ tabId:\"t2\" })"].join("\n");
}

export function resolvePageByTabId(
  context: BrowserContext,
  tabId: string,
): Page | null {
  const id = String(tabId ?? "").trim().toLowerCase();
  const pages = context.pages().filter((p) => !p.isClosed());
  if (!pages.length) {
    return null;
  }
  // 支持 t1 / 1 / tab-1
  const match = id.match(/^(?:t|tab-?)?(\d+)$/i);
  if (match) {
    const index = Number(match[1]) - 1;
    if (index >= 0 && index < pages.length) {
      return pages[index] ?? null;
    }
  }
  // 按 title/url 弱匹配
  for (const p of pages) {
    try {
      if (p.url().toLowerCase().includes(id)) {
        return p;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 点击后短等新窗口（target=_blank / window.open） */
export async function awaitPopupPage(
  context: BrowserContext,
  timeoutMs = 1_800,
): Promise<Page | null> {
  try {
    const page = await context.waitForEvent("page", { timeout: timeoutMs });
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    return page;
  } catch {
    return null;
  }
}

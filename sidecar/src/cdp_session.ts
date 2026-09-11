import { chromium, type Browser, type Page } from "playwright-core";

import type { JsonLogger } from "./json-logger.js";

const DEFAULT_CDP_TIMEOUT_MS = 15_000;

/** 导航强制上限：仅等 DOM/commit，禁止无超时的 networkidle */
export const NAV_DOM_TIMEOUT_MS = 15_000;
/** networkidle 软等待：超时忽略，避免 SPA/长连接卡死 */
export const NAV_NETWORKIDLE_SOFT_MS = 5_000;
/** 代理场景下优先 commit（响应已到），再软等 DOM */
const NAV_COMMIT_TIMEOUT_MS = 12_000;

/**
 * Step 1: session-bound active page.
 * Do not pick "first non-blank" blindly (multi-tab crosstalk).
 */
let boundActivePage: Page | null = null;
let boundPageTargetId: string | null = null;

export function bindActivePage(page: Page | null): void {
  boundActivePage = page && !page.isClosed() ? page : null;
  boundPageTargetId = null;
  if (boundActivePage) {
    void refreshBoundTargetId(boundActivePage).catch(() => undefined);
  }
}

export function getBoundActivePage(): Page | null {
  if (boundActivePage && !boundActivePage.isClosed()) {
    return boundActivePage;
  }
  return null;
}

async function refreshBoundTargetId(page: Page): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page);
    const info = (await session.send("Target.getTargetInfo")) as {
      targetInfo?: { targetId?: string };
    };
    boundPageTargetId = String(info?.targetInfo?.targetId ?? "").trim() || null;
    await session.detach().catch(() => undefined);
  } catch {
    boundPageTargetId = null;
  }
}

function isUsableContentUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed || trimmed === "about:blank") {
    return false;
  }
  if (
    trimmed.startsWith("chrome://") ||
    trimmed.startsWith("chrome-error://") ||
    trimmed.startsWith("devtools://") ||
    trimmed.startsWith("edge://")
  ) {
    return false;
  }
  return true;
}

function rankPage(page: Page): number {
  const url = page.url().trim().toLowerCase();
  if (!isUsableContentUrl(url)) {
    return -100;
  }
  let score = 10;
  if (url.startsWith("https://") || url.startsWith("http://")) {
    score += 20;
  }
  if (url.includes("browserscan.net")) {
    score -= 5;
  }
  if (boundActivePage === page) {
    score += 1000;
  }
  return score;
}

/** Interrupt a stuck prior navigation */
async function stopInFlightNavigation(page: Page): Promise<void> {
  try {
    const client = await page.context().newCDPSession(page);
    await client.send("Page.stopLoading").catch(() => undefined);
  } catch {
    // ignore
  }
  try {
    await page.evaluate(() => {
      try {
        window.stop();
      } catch {
        /* ignore */
      }
    });
  } catch {
    // ignore
  }
}

function urlLooksReached(current: string, target: string): boolean {
  const normalize = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/\/+$/, "")
      .replace(/^https?:\/\//, "");
  const a = normalize(current);
  const b = normalize(target);
  if (!a || a === "about:blank" || a.startsWith("chrome-error")) {
    return false;
  }
  return (
    a === b ||
    a.startsWith(`${b}/`) ||
    a.startsWith(`${b}?`) ||
    a.startsWith(`${b}#`) ||
    b.startsWith(a)
  );
}

async function documentHasBody(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => Boolean(document.body && document.body.childElementCount >= 0));
  } catch {
    return false;
  }
}

/**
 * Robust navigation (CloakBrowser = Playwright API).
 * Stop stuck nav -> prefer commit -> soft DOM -> optional short networkidle.
 */
export async function safeGoto(
  page: Page,
  url: string,
  options?: { softNetworkIdle?: boolean; retries?: number },
): Promise<void> {
  const maxAttempts = Math.max(1, (options?.retries ?? 2) + 1);
  const softNetworkIdle = options?.softNetworkIdle === true;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await stopInFlightNavigation(page);
    try {
      try {
        await page.goto(url, {
          waitUntil: "commit",
          timeout: NAV_COMMIT_TIMEOUT_MS,
        });
      } catch (commitError) {
        const current = page.url().trim();
        if (urlLooksReached(current, url) && (await documentHasBody(page))) {
          bindActivePage(page);
          return;
        }
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: NAV_DOM_TIMEOUT_MS,
        });
        void commitError;
      }
      await page
        .waitForLoadState("domcontentloaded", { timeout: 5_000 })
        .catch(() => undefined);
      if (softNetworkIdle) {
        await page
          .waitForLoadState("networkidle", { timeout: NAV_NETWORKIDLE_SOFT_MS })
          .catch(() => undefined);
      }
      bindActivePage(page);
      return;
    } catch (error) {
      lastError = error;
      const current = page.url().trim();
      if (urlLooksReached(current, url) && (await documentHasBody(page))) {
        bindActivePage(page);
        return;
      }
      if (attempt >= maxAttempts) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`safeGoto failed for ${url}: ${String(lastError)}`);
}

export async function softSettleAfterNavigation(
  page: Page,
  options?: { softNetworkIdle?: boolean; domTimeoutMs?: number },
): Promise<void> {
  const domTimeout = options?.domTimeoutMs ?? 3_000;
  await page.waitForLoadState("domcontentloaded", { timeout: domTimeout }).catch(() => undefined);
  if (options?.softNetworkIdle) {
    await page
      .waitForLoadState("networkidle", { timeout: NAV_NETWORKIDLE_SOFT_MS })
      .catch(() => undefined);
  }
}

/**
 * Resolve active page: bound page first, then URL score. Never blindly first non-blank.
 */
export function resolveActivePageFromList(pages: Page[]): Page | null {
  const open = pages.filter((page) => !page.isClosed());
  if (open.length === 0) {
    return null;
  }

  if (boundActivePage && !boundActivePage.isClosed() && open.includes(boundActivePage)) {
    return boundActivePage;
  }

  const preferredTarget = String(process.env.CLOAKFORGE_CDP_TARGET_ID ?? "").trim();
  if (preferredTarget && preferredTarget === boundPageTargetId && boundActivePage) {
    if (!boundActivePage.isClosed() && open.includes(boundActivePage)) {
      return boundActivePage;
    }
  }

  const ranked = [...open].sort((a, b) => rankPage(b) - rankPage(a));
  const best = ranked[0] ?? null;
  if (best && rankPage(best) > 0) {
    return best;
  }
  return open[0] ?? null;
}

export function resolveActivePageFromBrowser(browser: Browser): Page {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = resolveActivePageFromList(pages);
  if (!page) {
    throw new Error("no active page connected over CDP");
  }
  bindActivePage(page);
  return page;
}

export async function withActivePageViaCdp<T>(
  cdpPort: number,
  logger: JsonLogger,
  statusMessage: string,
  action: (page: Page) => Promise<T>,
): Promise<T> {
  logger.chatStatus(statusMessage, { cdpPort });

  let browser: Browser | null = null;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, {
      timeout: DEFAULT_CDP_TIMEOUT_MS,
    });

    const contexts = browser.contexts();
    const pages = contexts.flatMap((context) => context.pages());
    let page = resolveActivePageFromList(pages);
    if (!page) {
      const context = contexts[0];
      if (!context) {
        throw new Error("browser has no available context/tab");
      }
      page = await context.newPage();
    }
    bindActivePage(page);
    return await action(page);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.chatStatus(`nav/page action failed: ${message}`, { cdpPort, error: message });
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

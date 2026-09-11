import type { Page } from "playwright-core";

import { NAV_DOM_TIMEOUT_MS, safeGoto, softSettleAfterNavigation } from "./cdp_session.js";
import { resolveGateway } from "./core/action_gateway.js";
import type { JsonLogger } from "./json-logger.js";

export type SearchEngine = "google" | "bing" | "baidu";

export interface SearchNavigationResult {
  engine: SearchEngine;
  startUrl: string;
  finalUrl: string;
  googleSorry: boolean;
  usedFallback: boolean;
}

/** Google /sorry/ 或同类验证拦截页 */
export function isGoogleSorryOrCaptchaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      /(^|\.)google\.(com|[a-z.]{2,})$/i.test(parsed.hostname) &&
      (parsed.pathname.includes("/sorry") || parsed.pathname.includes("/sorry/"))
    );
  } catch {
    return /google\.[^/]+\/sorry/i.test(url);
  }
}

export function isGoogleSearchResolvedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)google\.(com|[a-z.]{2,})$/i.test(parsed.hostname) && parsed.pathname.includes("/search");
  } catch {
    return false;
  }
}

/** 目标是否为可直接 goto 的网址（非搜索关键词） */
export function looksLikeDirectNavigateTarget(target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) {
    return false;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return true;
  }
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return true;
  }
  return /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/i.test(trimmed);
}

export function shouldUseHumanSearchFlow(
  mode: "auto" | "url" | "search",
  rawTarget: string,
): boolean {
  if (mode === "url") {
    return false;
  }
  if (mode === "search") {
    return true;
  }
  return !looksLikeDirectNavigateTarget(rawTarget);
}

function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

export function pickFallbackSearchEngine(query: string, locale: string | null): "bing" | "baidu" {
  const normalizedLocale = (locale ?? "").trim().toLowerCase();
  if (hasCjk(query) || normalizedLocale.startsWith("zh")) {
    return "baidu";
  }
  return "bing";
}

export function buildDirectSearchUrl(
  engine: SearchEngine,
  query: string,
  locale?: string | null,
): string {
  const encoded = encodeURIComponent(query);
  if (engine === "baidu") {
    return `https://www.baidu.com/s?wd=${encoded}`;
  }
  if (engine === "bing") {
    return `https://www.bing.com/search?q=${encoded}`;
  }

  const params = new URLSearchParams({ q: query });
  const normalizedLocale = (locale ?? "").trim();
  if (normalizedLocale.startsWith("zh")) {
    params.set("hl", "zh-CN");
    params.set("gl", "CN");
  } else if (/^[a-z]{2}-[A-Z]{2}$/i.test(normalizedLocale)) {
    const [lang, region] = normalizedLocale.split("-");
    if (lang) {
      params.set("hl", normalizedLocale);
    }
    if (region) {
      params.set("gl", region.toUpperCase());
    }
  }
  return `https://www.google.com/search?${params.toString()}`;
}

async function nativeSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readPageLocale(page: Page): Promise<string | null> {
  try {
    const locale = await page.evaluate(() => navigator.language || null);
    return typeof locale === "string" && locale.trim() ? locale.trim() : null;
  } catch {
    return null;
  }
}

const GOOGLE_SEARCH_SELECTOR = 'textarea[name="q"], input[name="q"]';

const GOOGLE_SUBMIT_SELECTOR =
  'input[name="btnK"], button[name="btnK"], input[type="submit"][value*="搜"], input[type="submit"][value*="Search"]';

/**
 * 固定 Google：首页 → 填表输入 q → 点击「Google 搜尋」提交（禁止 goto SERP URL）。
 * CloakBrowser 建议先停留首页；输入用 pressSequentially 拟人键入，提交走表单按钮。
 */
export async function performGoogleFormSearch(
  page: Page,
  query: string,
  logger: JsonLogger,
): Promise<SearchNavigationResult> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error("搜索关键词不能为空");
  }

  const locale = await readPageLocale(page);
  const googleHome = "https://www.google.com/";

  try {
    await safeGoto(page, googleHome);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`打开 Google 首页失败（${NAV_DOM_TIMEOUT_MS}ms）: ${message}`);
  }
  await nativeSleep(1_500 + Math.floor(Math.random() * 1_000));

  const searchBox = page.locator(GOOGLE_SEARCH_SELECTOR).first();
  await searchBox.waitFor({ state: "visible", timeout: NAV_DOM_TIMEOUT_MS });
  const gw = resolveGateway(page);
  const noRecord = { record: false as const, skipSettle: true };
  await gw.click(searchBox, { ...noRecord, semanticLabel: "Google search box" });
  await nativeSleep(250 + Math.floor(Math.random() * 350));

  await gw.fill(searchBox, trimmedQuery, {
    ...noRecord,
    humanLike: true,
    semanticLabel: "Google search query",
  });
  await nativeSleep(400 + Math.floor(Math.random() * 500));

  const submitButton = page.locator(GOOGLE_SUBMIT_SELECTOR).first();
  const hasSubmit = await submitButton.isVisible({ timeout: 2_000 }).catch(() => false);
  if (hasSubmit) {
    await gw.click(submitButton, { ...noRecord, semanticLabel: "Google search submit" });
  } else {
    await gw.executeKeyPress("Enter", noRecord);
  }

  await softSettleAfterNavigation(page);
  await nativeSleep(600);

  const finalUrl = page.url();
  const googleSorry = isGoogleSorryOrCaptchaUrl(finalUrl);

  logger.progress(googleSorry ? "search_google_sorry_detected" : "search_google_form_ok", {
    query: trimmedQuery,
    finalUrl,
    locale,
    usedFormSubmit: hasSubmit,
  });

  return {
    engine: "google",
    startUrl: googleHome,
    finalUrl,
    googleSorry,
    usedFallback: false,
  };
}

/** @deprecated 使用 performGoogleFormSearch；保留别名兼容旧引用 */
export const performSearchWithFallback = performGoogleFormSearch;

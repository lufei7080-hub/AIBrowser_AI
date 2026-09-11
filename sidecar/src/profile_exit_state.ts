import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** 指纹浏览器默认首页 / 新标签目标 */
export const DEFAULT_HOMEPAGE_URL = "https://www.browserscan.net/zh";

/**
 * 上次进程被强杀时 Chromium 会在 Preferences 中留下 exit_type=Crashed，
 * 导致每次启动弹出 “Restore pages?” 且自动化环境下 Restore 无效。
 * 同时注入 Google 默认搜索引擎与首页，避免地址栏关键词被当成主机名。
 */
export async function sanitizeProfileExitState(userDataDir: string): Promise<void> {
  await ensureDefaultSearchAndExitState(path.join(userDataDir, "Default", "Preferences"));
  await sanitizeLocalStateFile(path.join(userDataDir, "Local State"));
}

function buildGoogleSearchProviderData(): Record<string, unknown> {
  return {
    template_url_data: {
      short_name: "Google",
      keyword: "google.com",
      favicon_url: "https://www.google.com/favicon.ico",
      url: "https://www.google.com/search?q={searchTerms}&ie={inputEncoding}",
      suggestions_url: "https://www.google.com/complete/search?client=chrome&q={searchTerms}",
      image_url: "https://www.google.com/searchbyimage/upload",
      new_tab_url: DEFAULT_HOMEPAGE_URL,
      contextual_search_url: "",
      image_url_post_params: "",
      search_url_post_params: "",
      suggestions_url_post_params: "",
      alternate_urls: [
        "https://www.google.com/#q={searchTerms}",
        "https://www.google.com/search?q={searchTerms}",
      ],
      prepopulate_id: 1,
      created_by_policy: false,
      safe_for_autoreplace: true,
      date_created: "0",
      last_modified: "0",
    },
  };
}

function ensureObjectRecord(
  parent: Record<string, unknown>,
  key: string,
): { record: Record<string, unknown>; changed: boolean } {
  const current = parent[key];
  if (typeof current === "object" && current !== null && !Array.isArray(current)) {
    return { record: current as Record<string, unknown>, changed: false };
  }
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return { record: created, changed: true };
}

async function ensureDefaultSearchAndExitState(prefsPath: string): Promise<void> {
  try {
    await mkdir(path.dirname(prefsPath), { recursive: true });

    let prefs: Record<string, unknown> = {};
    try {
      const raw = await readFile(prefsPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        prefs = parsed as Record<string, unknown>;
      }
    } catch {
      // 首次启动：Preferences 尚不存在，写入完整默认值
    }

    let changed = false;

    const profile = prefs.profile;
    if (typeof profile === "object" && profile !== null && !Array.isArray(profile)) {
      const profileRecord = profile as Record<string, unknown>;
      const exitType = String(profileRecord.exit_type ?? "");
      if (exitType && exitType !== "Normal") {
        profileRecord.exit_type = "Normal";
        changed = true;
      }
    } else {
      prefs.profile = { exit_type: "Normal" };
      changed = true;
    }

    // 强制 Google 为默认搜索，修复无搜索引擎时地址栏把关键词当主机名导航
    const nextSearchData = buildGoogleSearchProviderData();
    const prevSearchData = prefs.default_search_provider_data;
    const prevUrl =
      typeof prevSearchData === "object" &&
      prevSearchData !== null &&
      !Array.isArray(prevSearchData) &&
      typeof (prevSearchData as Record<string, unknown>).template_url_data === "object"
        ? String(
            (
              (prevSearchData as Record<string, unknown>).template_url_data as Record<
                string,
                unknown
              >
            ).url ?? "",
          )
        : "";
    if (!prevUrl.includes("google.com/search")) {
      prefs.default_search_provider_data = nextSearchData;
      changed = true;
    } else {
      // 同步 new_tab_url 到首页
      const template = (prevSearchData as Record<string, unknown>).template_url_data as Record<
        string,
        unknown
      >;
      if (template.new_tab_url !== DEFAULT_HOMEPAGE_URL) {
        template.new_tab_url = DEFAULT_HOMEPAGE_URL;
        changed = true;
      }
    }

    const provider = prefs.default_search_provider;
    if (typeof provider !== "object" || provider === null || Array.isArray(provider)) {
      prefs.default_search_provider = { enabled: true };
      changed = true;
    } else if ((provider as Record<string, unknown>).enabled !== true) {
      (provider as Record<string, unknown>).enabled = true;
      changed = true;
    }

    const search = prefs.search;
    if (typeof search !== "object" || search === null || Array.isArray(search)) {
      prefs.search = { suggest_enabled: true };
      changed = true;
    } else if ((search as Record<string, unknown>).suggest_enabled !== true) {
      (search as Record<string, unknown>).suggest_enabled = true;
      changed = true;
    }

    // 首页 + 启动打开 Google（restore_on_startup=4 打开指定 URL 列表）
    if (prefs.homepage !== DEFAULT_HOMEPAGE_URL) {
      prefs.homepage = DEFAULT_HOMEPAGE_URL;
      changed = true;
    }
    if (prefs.homepage_is_newtabpage !== false) {
      prefs.homepage_is_newtabpage = false;
      changed = true;
    }

    const browserEns = ensureObjectRecord(prefs, "browser");
    changed = changed || browserEns.changed;
    if (browserEns.record.show_home_button !== true) {
      browserEns.record.show_home_button = true;
      changed = true;
    }

    const sessionEns = ensureObjectRecord(prefs, "session");
    changed = changed || sessionEns.changed;
    if (sessionEns.record.restore_on_startup !== 4) {
      sessionEns.record.restore_on_startup = 4;
      changed = true;
    }
    const startupUrls = sessionEns.record.startup_urls;
    const urlsOk =
      Array.isArray(startupUrls) &&
      startupUrls.length === 1 &&
      String(startupUrls[0]) === DEFAULT_HOMEPAGE_URL;
    if (!urlsOk) {
      sessionEns.record.startup_urls = [DEFAULT_HOMEPAGE_URL];
      changed = true;
    }

    if (changed) {
      await writeFile(prefsPath, JSON.stringify(prefs));
    }
  } catch {
    // Preferences 读写失败时不阻断启动
  }
}

async function sanitizeLocalStateFile(localStatePath: string): Promise<void> {
  try {
    const raw = await readFile(localStatePath, "utf8");
    const state = JSON.parse(raw) as Record<string, unknown>;
    let changed = false;

    if (state.exited_cleanly === false) {
      state.exited_cleanly = true;
      changed = true;
    }

    if (changed) {
      await writeFile(localStatePath, JSON.stringify(state));
    }
  } catch {
    // 忽略
  }
}

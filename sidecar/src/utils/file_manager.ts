/**
 * Dual-track download path resolver.
 * Roots come from global settings (via launch / agent payload); profileId isolates concurrent envs.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export type DownloadTrack = "browser" | "scraper";

const DEFAULT_REL: Record<DownloadTrack, string> = {
  browser: path.join("downloads", "browser"),
  scraper: path.join("downloads", "scraper"),
};

let configuredRoots: Partial<Record<DownloadTrack, string>> = {};

/** Apply absolute roots from Rust / agent payload (empty clears back to defaults). */
export function configureDownloadRoots(roots: {
  browserDownloadDir?: string | null;
  scraperDownloadDir?: string | null;
  browser?: string | null;
  scraper?: string | null;
}): void {
  const browser = String(roots.browserDownloadDir ?? roots.browser ?? "").trim();
  const scraper = String(roots.scraperDownloadDir ?? roots.scraper ?? "").trim();
  configuredRoots = {
    ...(browser ? { browser } : {}),
    ...(scraper ? { scraper } : {}),
  };
}

function sanitizeProfileId(profileId: string): string {
  const raw = String(profileId ?? "").trim() || "unknown";
  return raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 64);
}

export function sanitizeDownloadFilename(name: string): string {
  const base = path
    .basename(String(name || "").trim())
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "") // block "." / ".." / ".hidden-as-traversal"
    .replace(/\s+/g, " ")
    .trim();
  return base.length > 0 ? base.slice(0, 180) : `file-${Date.now()}`;
}

function resolveRoot(type: DownloadTrack): string {
  const configured = configuredRoots[type]?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(process.cwd(), DEFAULT_REL[type]);
}

/**
 * Resolve `{root}/{profileId}/[filename]`, creating directories as needed.
 */
export function getResolvedDownloadPath(
  type: DownloadTrack,
  profileId: string,
  filename?: string,
): string {
  const root = resolveRoot(type);
  const dir = path.join(root, sanitizeProfileId(profileId));
  mkdirSync(dir, { recursive: true });
  if (filename === undefined || filename === null || String(filename).trim() === "") {
    return dir;
  }
  return path.join(dir, sanitizeDownloadFilename(filename));
}

/**
 * Like getResolvedDownloadPath but appends ` (n)` before ext when the file already exists.
 */
export function getUniqueResolvedDownloadPath(
  type: DownloadTrack,
  profileId: string,
  filename: string,
): string {
  const dir = getResolvedDownloadPath(type, profileId);
  const safe = sanitizeDownloadFilename(filename);
  let candidate = path.join(dir, safe);
  if (!existsSync(candidate)) {
    return candidate;
  }
  const ext = path.extname(safe);
  const stem = path.basename(safe, ext) || "file";
  let index = 1;
  while (existsSync(candidate)) {
    candidate = path.join(dir, sanitizeDownloadFilename(`${stem} (${index})${ext}`));
    index += 1;
  }
  return candidate;
}

export function getConfiguredDownloadRoots(): { browser: string; scraper: string } {
  return {
    browser: resolveRoot("browser"),
    scraper: resolveRoot("scraper"),
  };
}

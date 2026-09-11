import { access, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BrowserContext, Download } from "playwright-core";

import type { JsonLogger } from "./json-logger.js";

/** 系统用户 Downloads 目录（Windows: C:\Users\<name>\Downloads） */
export function resolveUserDownloadsDir(): string {
  return path.join(os.homedir(), "Downloads");
}

function sanitizeFilename(name: string): string {
  const base = path
    .basename(String(name || "").trim())
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return base.length > 0 ? base.slice(0, 180) : `download-${Date.now()}`;
}

async function resolveUniqueTargetPath(dir: string, filename: string): Promise<string> {
  const safe = sanitizeFilename(filename);
  let target = path.join(dir, safe);
  const ext = path.extname(safe);
  const stem = path.basename(safe, ext) || "download";
  let index = 1;
  while (true) {
    try {
      await access(target);
      target = path.join(dir, `${stem} (${index})${ext}`);
      index += 1;
    } catch {
      return target;
    }
  }
}

async function persistDownload(
  download: Download,
  downloadsDir: string,
  logger: JsonLogger,
  profileId: string,
): Promise<void> {
  try {
    await mkdir(downloadsDir, { recursive: true });
    const suggested = download.suggestedFilename();
    const target = await resolveUniqueTargetPath(downloadsDir, suggested);
    await download.saveAs(target);
    logger.progress("download_saved", {
      profileId,
      suggested,
      path: target,
      url: download.url(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("download_save_failed", {
      profileId,
      error: message,
      suggested: download.suggestedFilename(),
      url: download.url(),
    });
  }
}

const DOWNLOAD_AUTOSAVE_FLAG = Symbol.for("cloakforge.downloadAutosaveInstalled");

/**
 * Playwright 默认把下载存成临时 UUID 无扩展名文件；监听 download 并用真实文件名 saveAs。
 * 幂等：同一 context 重复调用不会叠加监听器。
 */
export function installDownloadAutoSave(
  context: BrowserContext,
  logger: JsonLogger,
  profileId: string,
  downloadsDir: string = resolveUserDownloadsDir(),
): void {
  const flagged = context as BrowserContext & { [DOWNLOAD_AUTOSAVE_FLAG]?: boolean };
  if (flagged[DOWNLOAD_AUTOSAVE_FLAG]) {
    return;
  }
  flagged[DOWNLOAD_AUTOSAVE_FLAG] = true;

  context.on("download", (download) => {
    void persistDownload(download, downloadsDir, logger, profileId);
  });
}

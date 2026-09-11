/**
 * Seed bundled Browse/chromium-151…-pro into ~/.cloakbrowser before ensureBinary.
 * Does not touch fingerprint Preferences — binary tree only.
 */
import { cp, access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

export const BUNDLED_PRO_VERSION = "151.0.7922.108.3";
export const BUNDLED_PRO_DIR = `chromium-${BUNDLED_PRO_VERSION}-pro`;

function cloakCacheRoot(): string {
  return path.join(homedir(), ".cloakbrowser");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve Browse root: launch config override, then cwd / sibling paths. */
export function resolveBrowseRootCandidates(explicit?: string | null): string[] {
  const out: string[] = [];
  const push = (p: string | null | undefined) => {
    const t = String(p ?? "").trim();
    if (t && !out.includes(t)) out.push(t);
  };
  push(explicit);
  push(process.env.CLOAKFORGE_BROWSE_ROOT);
  push(path.join(process.cwd(), "Browse"));
  push(path.join(process.cwd(), "..", "Browse"));
  // portable: sidecar/dist → ../../Browse or ../Browse
  push(path.resolve(path.dirname(process.argv[1] || ""), "..", "..", "Browse"));
  push(path.resolve(path.dirname(process.argv[1] || ""), "..", "Browse"));
  push(path.resolve(path.dirname(process.argv[1] || ""), "..", "..", "..", "Browse"));
  return out;
}

/**
 * If launching 151-pro and cache missing chrome.exe, copy from bundled Browse/.
 * Returns note for logs; never throws on soft miss.
 */
export async function seedBundledProKernel(input: {
  browserVersion?: string | null;
  bundledBrowseRoot?: string | null;
  logger?: { progress?: (event: string, data?: Record<string, unknown>) => void };
}): Promise<{ seeded: boolean; detail: string }> {
  const pin = String(input.browserVersion ?? "").trim();
  if (pin !== BUNDLED_PRO_VERSION && !pin.startsWith(BUNDLED_PRO_VERSION)) {
    return { seeded: false, detail: "skip_not_pro_pin" };
  }

  const destDir = path.join(cloakCacheRoot(), BUNDLED_PRO_DIR);
  const destChrome = path.join(destDir, "chrome.exe");
  if (existsSync(destChrome) || (await pathExists(destChrome))) {
    return { seeded: false, detail: "already_cached" };
  }

  for (const root of resolveBrowseRootCandidates(input.bundledBrowseRoot)) {
    const srcDir = path.join(root, BUNDLED_PRO_DIR);
    const srcChrome = path.join(srcDir, "chrome.exe");
    if (!(await pathExists(srcChrome))) {
      continue;
    }
    try {
      await cp(srcDir, destDir, { recursive: true, force: false, errorOnExist: false });
      input.logger?.progress?.("bundled_pro_kernel_seeded", {
        from: srcDir,
        to: destDir,
      });
      return { seeded: true, detail: `seeded_from:${srcDir}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      input.logger?.progress?.("bundled_pro_kernel_seed_failed", {
        from: srcDir,
        error: message,
      });
      return { seeded: false, detail: `seed_failed:${message}` };
    }
  }

  return { seeded: false, detail: "bundle_not_found" };
}

export function isFingerprintOnlyKernelPin(browserVersion?: string | null): boolean {
  const v = String(browserVersion ?? "").trim();
  return Boolean(v) && (v === BUNDLED_PRO_VERSION || v.startsWith(BUNDLED_PRO_VERSION));
}

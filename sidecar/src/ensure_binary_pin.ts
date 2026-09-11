/**
 * CloakBrowser ensureBinary 在「有效 License（含 Free Key）」时会走 ensureProBinary，
 * 并丢弃 free 档的 version pin，强制下「最新」（见 node_modules/cloakbrowser/dist/download.js）。
 * 用户显式 pin 免费核（如 146.x）时必须暂时卸掉 Key（env + license.key 文件），
 * 才能按 pin 从 GitHub 下免费包，避免误下 151-pro 浪费流量。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureBinary } from "cloakbrowser";

import { isValidBrowserVersionPin } from "./license_resolver.js";
import { isFingerprintOnlyKernelPin } from "./kernel_seed.js";

/** 与 cloakbrowser CHROMIUM_VERSION / 产品「免费核」预设一致 */
export const FREE_CHROMIUM_PIN = "146.0.7680.177.5";

const LICENSE_KEY_BAK_SUFFIX = ".cloakforge-free-pin-bak";

function cloakbrowserCacheDir(): string {
  const fromEnv = process.env.CLOAKBROWSER_CACHE_DIR?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), ".cloakbrowser");
}

/**
 * 明确要走「免费 GitHub 二进制 + pin」路径（禁止带 Key 的 Pro/最新路由）。
 */
export function wantsKeylessFreePinDownload(browserVersion?: string | null): boolean {
  const pin = String(browserVersion ?? "").trim();
  if (!pin || !isValidBrowserVersionPin(pin)) {
    return false;
  }
  if (isFingerprintOnlyKernelPin(pin)) {
    return false;
  }
  // 官方免费核为 146.x；带 Free/Pro Key 调用 ensureBinary 会忽略 pin 去拉最新
  return pin === FREE_CHROMIUM_PIN || pin.startsWith("146.");
}

/**
 * ensureBinary 的 resolveLicenseKey：param > env > ~/.cloakbrowser/license.key。
 * 免费 pin 必须临时隐藏 env 与 license.key，否则仍会走 ensureProBinary。
 */
async function ensureBinaryWithoutAnyLicenseKey(
  pin: string | undefined,
  releaseChannel?: string,
): Promise<string> {
  const prevEnv = process.env.CLOAKBROWSER_LICENSE_KEY;
  delete process.env.CLOAKBROWSER_LICENSE_KEY;

  const keyFile = path.join(cloakbrowserCacheDir(), "license.key");
  const backupFile = `${keyFile}${LICENSE_KEY_BAK_SUFFIX}`;
  let parkedKeyFile = false;

  try {
    if (fs.existsSync(keyFile)) {
      try {
        if (fs.existsSync(backupFile)) {
          fs.unlinkSync(backupFile);
        }
      } catch {
        // ignore stale bak cleanup
      }
      fs.renameSync(keyFile, backupFile);
      parkedKeyFile = true;
    }
    return await ensureBinary(undefined, pin, releaseChannel);
  } finally {
    if (parkedKeyFile) {
      try {
        if (fs.existsSync(backupFile)) {
          if (fs.existsSync(keyFile)) {
            fs.unlinkSync(keyFile);
          }
          fs.renameSync(backupFile, keyFile);
        }
      } catch {
        // 恢复失败时不吞掉 ensure 结果；下次启动仍可从设置页 Key 注入
      }
    }
    if (prevEnv !== undefined) {
      process.env.CLOAKBROWSER_LICENSE_KEY = prevEnv;
    } else {
      delete process.env.CLOAKBROWSER_LICENSE_KEY;
    }
  }
}

/**
 * 按产品语义 ensure：免费 pin → 无 Key + 固定版本；否则原样传 Key（Pro/自动最新）。
 */
export async function ensureBinaryHonoringVersionPin(
  licenseKey: string | undefined,
  browserVersion: string | undefined,
  releaseChannel?: string,
): Promise<{ chromePath: string; usedKeylessFreePin: boolean }> {
  const pin = String(browserVersion ?? "").trim() || undefined;
  const keyless = wantsKeylessFreePinDownload(pin);

  if (!keyless) {
    const chromePath = await ensureBinary(licenseKey, pin, releaseChannel);
    return { chromePath, usedKeylessFreePin: false };
  }

  const chromePath = await ensureBinaryWithoutAnyLicenseKey(pin, releaseChannel);
  return { chromePath, usedKeylessFreePin: true };
}

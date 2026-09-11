import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateLicense } from "cloakbrowser";

export type ReleaseChannel = "stable" | "preview";
export type LicenseKeySource = "param" | "env" | "file" | "none";
export type LicenseSourcePolicy = "app" | "cli";

export interface PickedLicenseKey {
  key?: string;
  hadConfiguredKey: boolean;
  source: LicenseKeySource;
}

export interface ResolvedLicense {
  licenseKey?: string;
  hadConfiguredKey: boolean;
  source: LicenseKeySource;
  fallbackReason?: string;
  plan?: string | null;
}

function readDefaultLicenseKeyFile(): string | undefined {
  try {
    const keyFile = path.join(os.homedir(), ".cloakbrowser", "license.key");
    const content = fs.readFileSync(keyFile, "utf8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

export function pickCandidateKey(
  explicitKey?: string | null,
  policy: LicenseSourcePolicy = "app",
): PickedLicenseKey {
  if (policy === "app") {
    if (explicitKey == null) {
      return { hadConfiguredKey: false, source: "none" };
    }
    const trimmed = explicitKey.trim();
    if (!trimmed) {
      return { hadConfiguredKey: true, source: "none" };
    }
    return { key: trimmed, hadConfiguredKey: true, source: "param" };
  }

  if (explicitKey != null) {
    const trimmed = explicitKey.trim();
    if (trimmed) {
      return { key: trimmed, hadConfiguredKey: true, source: "param" };
    }
    return { hadConfiguredKey: true, source: "none" };
  }

  const fromEnv = process.env.CLOAKBROWSER_LICENSE_KEY?.trim();
  if (fromEnv) {
    return { key: fromEnv, hadConfiguredKey: true, source: "env" };
  }

  const fromFile = readDefaultLicenseKeyFile();
  if (fromFile) {
    return { key: fromFile, hadConfiguredKey: true, source: "file" };
  }

  return { hadConfiguredKey: false, source: "none" };
}

export function clearLicenseEnv(): void {
  delete process.env.CLOAKBROWSER_LICENSE_KEY;
}

function normalizeReleaseChannel(raw?: string | null): ReleaseChannel {
  const value = raw?.trim().toLowerCase();
  if (value === "preview") {
    return "preview";
  }
  return "stable";
}

export function resolveReleaseChannel(_licenseKey?: string | null): ReleaseChannel {
  const fromEnv = process.env.CLOAKBROWSER_RELEASE_CHANNEL?.trim();
  if (fromEnv) {
    return normalizeReleaseChannel(fromEnv);
  }
  return "stable";
}

/** CloakBrowser 要求完整版本号：4 或 5 段数字，如 146.0.7680.177.5 */
const BROWSER_VERSION_PIN_RE = /^[0-9]+(?:\.[0-9]+){3,4}$/;

export function isValidBrowserVersionPin(value: string | null | undefined): boolean {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 && BROWSER_VERSION_PIN_RE.test(trimmed);
}

export function resolveBrowserVersionPin(explicit?: string | null): string | undefined {
  const fromParam = explicit?.trim();
  if (fromParam) {
    return isValidBrowserVersionPin(fromParam) ? fromParam : undefined;
  }
  const fromEnv = process.env.CLOAKBROWSER_VERSION?.trim();
  if (fromEnv && isValidBrowserVersionPin(fromEnv)) {
    return fromEnv;
  }
  return undefined;
}

export async function resolveEffectiveLicenseKey(
  explicitKey?: string | null,
  policy: LicenseSourcePolicy = "app",
): Promise<ResolvedLicense> {
  const picked = pickCandidateKey(explicitKey, policy);
  if (!picked.key) {
    clearLicenseEnv();
    return {
      hadConfiguredKey: picked.hadConfiguredKey,
      source: picked.source,
    };
  }

  const info = await validateLicense(picked.key);
  if (info?.valid) {
    process.env.CLOAKBROWSER_LICENSE_KEY = picked.key;
    return {
      licenseKey: picked.key,
      hadConfiguredKey: picked.hadConfiguredKey,
      source: picked.source,
      plan: info.plan ?? null,
    };
  }

  clearLicenseEnv();

  if (info && !info.valid) {
    return {
      hadConfiguredKey: picked.hadConfiguredKey,
      source: picked.source,
      plan: info.plan ?? null,
      fallbackReason: `License 无效或已过期 (plan=${info.plan})，已自动使用 Free 内核。请在设置中清空 License Key 或填写有效密钥。`,
    };
  }

  return {
    hadConfiguredKey: picked.hadConfiguredKey,
    source: picked.source,
    fallbackReason:
      "License 无法在线验证且无有效缓存，已自动使用 Free 内核。请检查网络或清空 License Key。",
  };
}

export function isLicenseKeyError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("license key is invalid") ||
    lower.includes("license could not be validated") ||
    lower.includes("cloakbrowser pro") ||
    lower.includes("无效密钥") ||
    lower.includes("session seat") ||
    lower.includes("concurrent session")
  );
}

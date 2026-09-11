/**
 * Dual-kernel policy: free Chromium via ensureBinary; bundled 151-pro for fingerprint.
 * Free Key: AI only on free kernel, max 1 parallel. Pro Key: AI parallel ≤ seats.
 * Opening browsers is unlimited on both tiers.
 */
export const FREE_CHROMIUM_VERSION = "146.0.7680.177.5";
/** Packaged offline Pro pin (Browse/chromium-151.0.7922.108.3-pro). */
export const BUNDLED_PRO_CHROMIUM_VERSION = "151.0.7922.108.3";
export const BUNDLED_PRO_DIR_NAME = `chromium-${BUNDLED_PRO_CHROMIUM_VERSION}-pro`;

export type KernelPresetId = "auto" | "free" | "pro_fingerprint";

export interface KernelPresetOption {
  id: KernelPresetId;
  /** Empty string = leave pin blank (CloakBrowser latest for current license). */
  browserVersion: string;
  label: string;
  hint: string;
}

export const KERNEL_PRESET_OPTIONS: KernelPresetOption[] = [
  {
    id: "auto",
    browserVersion: "",
    label: "自动（按 License 最新）",
    hint: "免费 Key → 官方免费核；Pro Key → 最新 Pro。适合大多数场景。",
  },
  {
    id: "free",
    browserVersion: FREE_CHROMIUM_VERSION,
    label: `免费核 ${FREE_CHROMIUM_VERSION}`,
    hint: "官方 ensureBinary 下载。免费 Key 下可进行 AI/Agent/填表（并行限 1）。",
  },
  {
    id: "pro_fingerprint",
    browserVersion: BUNDLED_PRO_CHROMIUM_VERSION,
    label: `151-pro（仅指纹）${BUNDLED_PRO_CHROMIUM_VERSION}`,
    hint: "打包离线内核。免费 Key 下仅允许打开指纹浏览器，禁止 AI/Agent/填表。",
  },
];

/** True when this pin is the bundled Pro fingerprint kernel. */
export function isFingerprintOnlyKernelPin(browserVersion: string | null | undefined): boolean {
  const v = String(browserVersion ?? "").trim();
  if (!v) return false;
  return v === BUNDLED_PRO_CHROMIUM_VERSION || v.startsWith(`${BUNDLED_PRO_CHROMIUM_VERSION}`);
}

/** Free Key + fingerprint-only pin → AI must be blocked. */
export function isAiBlockedForKernel(
  isProLicense: boolean,
  browserVersion: string | null | undefined,
): boolean {
  if (isProLicense) return false;
  return isFingerprintOnlyKernelPin(browserVersion);
}

export function aiBlockedKernelMessage(browserVersion: string | null | undefined): string {
  const pin = String(browserVersion ?? "").trim() || BUNDLED_PRO_CHROMIUM_VERSION;
  return (
    `免费 License 下内核 ${pin} 仅允许指纹浏览，不可进行 AI / Agent / 智能填表。` +
    `请将环境改为免费核（${FREE_CHROMIUM_VERSION}）或升级 Pro 后再试。打开浏览器数量不受限制。`
  );
}

export function presetIdFromBrowserVersion(browserVersion: string | null | undefined): KernelPresetId | "custom" {
  const v = String(browserVersion ?? "").trim();
  if (!v) return "auto";
  if (v === FREE_CHROMIUM_VERSION) return "free";
  if (isFingerprintOnlyKernelPin(v)) return "pro_fingerprint";
  return "custom";
}

export function browserVersionFromPreset(id: KernelPresetId): string {
  const hit = KERNEL_PRESET_OPTIONS.find((o) => o.id === id);
  return hit?.browserVersion ?? "";
}

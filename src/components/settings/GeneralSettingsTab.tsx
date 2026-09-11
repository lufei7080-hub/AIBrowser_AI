import { Cpu, Download, FileKey, FolderOpen, Power, RefreshCw, Search, SlidersHorizontal, Stethoscope, Trash2, Zap } from "lucide-react";
import { useEffect, useState } from "react";

import {
  cleanupCloakBinary,
  clearCloakLicenseKey,
  detectCloakPath,
  diagnoseCloakBinary,
  downloadCloakBinary,
  fetchSettings,
  formatInvokeError,
  getCloakBinaryStatus,
  pickDirectory,
  purgeAutomationCache,
  setCloakLicenseKey,
  stopAllProfiles,
  testCloakPath,
  updateCloakBinary,
  updateSetting,
} from "../../lib/tauri";
import type { AppSettings, CloakBinaryStatus, ConnectivityStatus } from "../../types";
import { createToast } from "../../lib/toast";
import type { ToastMessage } from "../../lib/toast";
import { useAppDialog } from "../AppDialogProvider";
import { ConnectivityIndicator } from "./ConnectivityIndicator";
import { SettingsSection } from "./SettingsSection";
import { KernelVersionSelect } from "../KernelVersionSelect";
import {
  BUNDLED_PRO_CHROMIUM_VERSION,
  FREE_CHROMIUM_VERSION,
} from "../../lib/kernelPolicy";

const BROWSER_VERSION_PIN_RE = /^\d+(?:\.\d+){3,4}$/;

function normalizeKernelPin(raw: string | null | undefined): string {
  return String(raw ?? "").trim();
}

function assertKernelPinOrEmpty(pin: string): void {
  if (!pin) {
    return;
  }
  if (!BROWSER_VERSION_PIN_RE.test(pin)) {
    throw new Error(
      `内核版本无效「${pin}」。请填写完整 Chromium pin（4~5 段），例如 ${FREE_CHROMIUM_VERSION}`,
    );
  }
}
interface GeneralSettingsTabProps {
  settings: AppSettings;
  pathStatus: ConnectivityStatus;
  keyStatus: ConnectivityStatus;
  saving: boolean;
  onSettingsChange: (next: AppSettings) => void;
  onPathStatusChange: (status: ConnectivityStatus) => void;
  onKeyStatusChange: (status: ConnectivityStatus) => void;
  onSavingChange: (saving: boolean) => void;
  onToast: (toast: ToastMessage) => void;
  onError: (message: string) => void;
  onEntitlementChange: () => void;
}

/** Strip whitespace from email paste (e.g. `cb_ xxx yyy`). */
function normalizeCloakLicenseKey(raw: string): string {
  return raw.replace(/\s+/g, "").trim();
}

function isSessionSeatsFull(status: CloakBinaryStatus | null): boolean {
  const active = status?.sessionSeatsActive;
  const limit = status?.sessionSeatsLimit;
  return (
    typeof active === "number" &&
    typeof limit === "number" &&
    limit > 0 &&
    active >= limit
  );
}

/** 全局兼容/调试旗标开关行：标题 + 说明 + ui-switch。 */
function FlagToggle({
  checked,
  disabled,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <div className="text-xs font-medium text-foreground">{label}</div>
        {hint ? <p className="text-[11px] leading-4 text-muted-foreground">{hint}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={`ui-switch shrink-0 ${checked ? "bg-primary" : "bg-muted"}`}
        onClick={() => onChange(!checked)}
      >
        <span className={`ui-switch-knob ${checked ? "translate-x-3.5" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}

export function GeneralSettingsTab({
  settings,
  pathStatus,
  keyStatus,
  saving,
  onSettingsChange,
  onPathStatusChange,
  onKeyStatusChange,
  onSavingChange,
  onToast,
  onError,
  onEntitlementChange,
}: GeneralSettingsTabProps) {
  const { confirm } = useAppDialog();
  const [binaryStatus, setBinaryStatus] = useState<CloakBinaryStatus | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [binaryBusy, setBinaryBusy] = useState(false);
  const [diagnoseBusy, setDiagnoseBusy] = useState(false);
  const [killBusy, setKillBusy] = useState(false);
  const [licenseKeyDraft, setLicenseKeyDraft] = useState(settings.cloak_license_key);

  useEffect(() => {
    setLicenseKeyDraft(settings.cloak_license_key);
  }, [settings.cloak_license_key]);

  const hasLicenseKey = Boolean(normalizeCloakLicenseKey(settings.cloak_license_key));

  const applyBinaryResult = async (
    status: CloakBinaryStatus,
    successToast: string,
    baseSettings: AppSettings = settings,
  ) => {
    setBinaryStatus(status);
    const chromePath = status.binaryPath?.trim();
    if (chromePath) {
      const nextSettings = { ...baseSettings, cloak_path: chromePath };
      onSettingsChange(nextSettings);
      try {
        await updateSetting("cloak_path", chromePath);
        await testCloakPath(chromePath);
        onPathStatusChange("success");
      } catch {
        onPathStatusChange("idle");
      }
    }
    onToast(createToast("success", successToast));
    if (status.licenseFallbackReason?.trim()) {
      onToast(createToast("info", status.licenseFallbackReason));
    }
    onError("");
  };

  const refreshBinaryStatus = async (licenseKey?: string, browserVersion?: string) => {
    try {
      const key = licenseKey ?? settings.cloak_license_key;
      const pin =
        browserVersion !== undefined
          ? normalizeKernelPin(browserVersion)
          : normalizeKernelPin(settings.default_browser_version);
      const status = await getCloakBinaryStatus(key, pin || undefined);
      setBinaryStatus(status);
      return status;
    } catch {
      setBinaryStatus(null);
      return null;
    }
  };

  useEffect(() => {
    void refreshBinaryStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePathChange = (value: string) => {
    onSettingsChange({ ...settings, cloak_path: value });
    onPathStatusChange("idle");
  };

  const handleAutoDetectPath = async () => {
    onSavingChange(true);
    onPathStatusChange("testing");
    try {
      const path = await detectCloakPath();
      onSettingsChange({ ...settings, cloak_path: path });
      await testCloakPath(path);
      onPathStatusChange("success");
      onToast(createToast("success", `已自动检测到浏览器：${path}`));
      onError("");
      await refreshBinaryStatus();
    } catch (error) {
      onPathStatusChange("error");
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const handleTestPath = async () => {
    if (!settings.cloak_path.trim()) {
      onToast(createToast("error", "请先填写浏览器路径"));
      return;
    }
    onSavingChange(true);
    onPathStatusChange("testing");
    try {
      await testCloakPath(settings.cloak_path);
      onPathStatusChange("success");
      onToast(createToast("success", "浏览器路径有效"));
      onError("");
    } catch (error) {
      onPathStatusChange("error");
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const handleSaveLicenseKey = async () => {
    const normalized = normalizeCloakLicenseKey(licenseKeyDraft);
    if (!normalized) {
      onToast(createToast("error", "请粘贴 CloakBrowser 邮件中的 cb_ 开头 License Key"));
      return;
    }
    onSavingChange(true);
    onKeyStatusChange("testing");
    try {
      const result = await setCloakLicenseKey(normalized);
      const nextSettings = await fetchSettings();
      onSettingsChange(nextSettings);
      setLicenseKeyDraft(nextSettings.cloak_license_key);
      onKeyStatusChange(result.isValid ? "success" : "error");
      onToast(createToast(result.isValid ? "success" : "error", result.message));
      onError(result.isValid ? "" : result.message);
      onEntitlementChange();
      await refreshBinaryStatus(nextSettings.cloak_license_key);
    } catch (error) {
      onKeyStatusChange("error");
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const handleClearLicenseKey = async () => {
    onSavingChange(true);
    try {
      const result = await clearCloakLicenseKey();
      const nextSettings = await fetchSettings();
      onSettingsChange(nextSettings);
      setLicenseKeyDraft("");
      onKeyStatusChange("idle");
      onToast(createToast("success", result.message));
      onError("");
      onEntitlementChange();
      await refreshBinaryStatus("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const handleKillAllRunningBrowsers = async () => {
    const seatsHint =
      binaryStatus?.sessionSeatsActive != null && binaryStatus?.sessionSeatsLimit != null
        ? `（当前授权席位 ${binaryStatus.sessionSeatsActive}/${binaryStatus.sessionSeatsLimit}）`
        : "";
    const ok = await confirm({
      title: "一键强杀全部运行中浏览器",
      description:
        `将强制结束本机所有天枢台环境浏览器（含占席位的幽灵进程）${seatsHint}，并停止相关 Agent/Sidecar。` +
        "授权服务器席位通常会在进程退出后很快释放；若仍显示占满，请点「检查更新」刷新席位。是否继续？",
      confirmLabel: "强杀全部",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) {
      return;
    }
    setKillBusy(true);
    onSavingChange(true);
    try {
      const stopped = await stopAllProfiles();
      // 给授权端一点时间回收席位后再查
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const status = await refreshBinaryStatus();
      const seats =
        status?.sessionSeatsActive != null && status?.sessionSeatsLimit != null
          ? ` · 席位 ${status.sessionSeatsActive}/${status.sessionSeatsLimit}`
          : "";
      onToast(
        createToast(
          "success",
          stopped > 0
            ? `已强杀 ${stopped} 个浏览器进程树${seats}`
            : `未发现本地运行中进程（若席位仍满，请再点检查更新或稍候）${seats}`,
        ),
      );
      onError("");
      onEntitlementChange();
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      setKillBusy(false);
      onSavingChange(false);
    }
  };

  const handleDownloadBinary = async () => {
    setBinaryBusy(true);
    onSavingChange(true);
    try {
      const pin = normalizeKernelPin(settings.default_browser_version);
      assertKernelPinOrEmpty(pin);
      // 先落盘默认 pin，避免「输入了却仍按最新下载」
      await updateSetting("default_browser_version", pin);
      const latest = await fetchSettings();
      onSettingsChange({
        ...latest,
        default_browser_version: pin,
      });
      const status = await downloadCloakBinary(latest.cloak_license_key, pin || undefined);
      const tip =
        status.message?.trim() ||
        (pin
          ? `内核已按固定版本就绪：${status.version || pin}`
          : status.version
            ? `内核已就绪（最新）：${status.version}`
            : "内核下载完成");
      await applyBinaryResult(status, tip, {
        ...latest,
        default_browser_version: pin,
      });
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      setBinaryBusy(false);
      onSavingChange(false);
    }
  };

  const handleUpdateBinary = async () => {
    setBinaryBusy(true);
    onSavingChange(true);
    try {
      const pin = normalizeKernelPin(settings.default_browser_version);
      assertKernelPinOrEmpty(pin);
      await updateSetting("default_browser_version", pin);
      const latest = await fetchSettings();
      onSettingsChange({
        ...latest,
        default_browser_version: pin,
      });
      const status = await updateCloakBinary(latest.cloak_license_key, pin || undefined);
      const tip =
        status.message?.trim() ||
        (pin
          ? status.version
            ? `已确保固定版本 ${status.version}（未跳到最新）`
            : `已按固定版本 ensure：${pin}`
          : status.updated
            ? `已更新到 ${status.updatedTo || status.version || "新版本"}`
            : `已是最新${status.version ? `（${status.version}）` : ""}`);
      await applyBinaryResult(status, tip, {
        ...latest,
        default_browser_version: pin,
      });
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      setBinaryBusy(false);
      onSavingChange(false);
    }
  };

  const handleCleanupBinary = async () => {
    setBinaryBusy(true);
    onSavingChange(true);
    try {
      const pin = normalizeKernelPin(settings.default_browser_version);
      assertKernelPinOrEmpty(pin);
      const latest = await fetchSettings();
      onSettingsChange(latest);
      const status = await cleanupCloakBinary(latest.cloak_license_key, pin || undefined);
      setBinaryStatus(status);
      if (status.binaryPath?.trim()) {
        const nextSettings = { ...latest, cloak_path: status.binaryPath.trim() };
        onSettingsChange(nextSettings);
        await updateSetting("cloak_path", status.binaryPath.trim());
      }
      onToast(
        createToast(
          "success",
          `已清理 ${status.removedCount ?? 0} 个旧内核目录`,
        ),
      );
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      setBinaryBusy(false);
      onSavingChange(false);
    }
  };

  const handlePurgeAutomationCache = async () => {
    const confirmed = await confirm({
      title: "清理自动化缓存",
      description:
        "将删除：爬虫/Agent 下载的图片与验证码帧、以及已从环境列表删除但仍残留的 profile 目录与下载子目录。仍在列表中的环境配置不会删除。确定继续？",
      confirmLabel: "清理",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    setCacheBusy(true);
    onSavingChange(true);
    try {
      const report = await purgeAutomationCache();
      const mb = (report.freedBytes / (1024 * 1024)).toFixed(2);
      onToast(
        createToast(
          "success",
          `已清理目录 ${report.removedDirs}、文件 ${report.removedFiles}（约 ${mb} MB）`,
        ),
      );
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      setCacheBusy(false);
      onSavingChange(false);
    }
  };

  const handleDiagnoseBinary = async () => {
    setDiagnoseBusy(true);
    onSavingChange(true);
    try {
      const pin = normalizeKernelPin(settings.default_browser_version);
      assertKernelPinOrEmpty(pin);
      const latest = await fetchSettings();
      onSettingsChange(latest);
      const status = await diagnoseCloakBinary(latest.cloak_license_key, pin || undefined);
      setBinaryStatus(status);
      const summary = status.diagnosticSummary?.trim() || "诊断完成";
      onToast(
        createToast(
          status.diagnosticOk === false ? "error" : "success",
          summary,
        ),
      );
      onError(status.diagnosticOk === false ? summary : "");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      setDiagnoseBusy(false);
      onSavingChange(false);
    }
  };

  const handleSave = async () => {
    onSavingChange(true);
    try {
      await updateSetting("cloak_path", settings.cloak_path);
      await updateSetting("browser_download_dir", settings.browser_download_dir.trim());
      await updateSetting("scraper_download_dir", settings.scraper_download_dir.trim());
      await updateSetting("license_through_proxy", settings.license_through_proxy ? "true" : "false");
      await updateSetting(
        "allow_third_party_cookies",
        settings.allow_third_party_cookies ? "true" : "false",
      );
      await updateSetting("fingerprint_off", settings.fingerprint_off ? "true" : "false");
      await updateSetting(
        "default_browser_version",
        (settings.default_browser_version ?? "").trim(),
      );
      // Re-hydrate from SQLite so UI matches what was actually persisted
      const latest = await fetchSettings();
      onSettingsChange(latest);
      onToast(createToast("success", "常规设置已保存"));
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const handlePickDownloadDir = async (key: "browser_download_dir" | "scraper_download_dir") => {
    try {
      const title =
        key === "browser_download_dir" ? "选择常规浏览器下载目录" : "选择爬虫抓取下载目录";
      const picked = await pickDirectory(title);
      if (!picked?.trim()) {
        return;
      }
      onSettingsChange({ ...settings, [key]: picked.trim() });
    } catch (error) {
      onToast(createToast("error", formatInvokeError(error)));
    }
  };

  const binarySummary = binaryStatus
    ? binaryStatus.installed
      ? `已安装 ${binaryStatus.version ?? "未知"} · ${binaryStatus.tier ?? "free"}${
          binaryStatus.wrapperVersion ? ` · 封装 ${binaryStatus.wrapperVersion}` : ""
        }${
          binaryStatus.releaseChannel ? ` · ${binaryStatus.releaseChannel}` : ""
        }${
          binaryStatus.sessionSeatsActive != null && binaryStatus.sessionSeatsLimit != null
            ? ` · 席位 ${binaryStatus.sessionSeatsActive}/${binaryStatus.sessionSeatsLimit}`
            : ""
        }${
          (binaryStatus.unusedCount ?? 0) > 0 ? ` · 可清理 ${binaryStatus.unusedCount} 个旧版` : ""
        }`
      : "未安装，点击「下载内核」"
    : "读取中…";

  const kernelSectionDescription = (() => {
    if (binaryStatus?.tier === "pro") {
      return "当前已启用 Pro 内核，可下载并使用最新版本（Stable Pro 151）。";
    }
    if (hasLicenseKey && binaryStatus?.licenseValid === false) {
      return "已保存 License Key，但在线验证未通过（无效/过期/网络不可达）。可开启下方「授权检查走代理」后重试。";
    }
    if (hasLicenseKey) {
      return "已保存 CloakBrowser License。若状态仍显示 free，请点「检查更新」拉取 Pro 内核 151。";
    }
    return "未配置 License 时使用 Free 内核（最新免费版 146）。粘贴 CloakBrowser Pro 邮件中的 cb_ 密钥后，可下载 Stable Pro 151。";
  })();

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={<Search size={15} className="text-primary" />}
        title="浏览器路径"
        description="浏览器内核的可执行文件路径，支持自动检测与有效性校验。"
      >
        <label className="field-label">
          浏览器路径
          <input
            className="field-input font-mono text-xs"
            value={settings.cloak_path}
            onChange={(event) => handlePathChange(event.target.value)}
            placeholder="C:\\Users\\...\\.cloakbrowser\\chromium-...\\chrome.exe"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <ConnectivityIndicator status={pathStatus} />
          <button
            className="btn btn-outline"
            disabled={saving || pathStatus === "testing"}
            onClick={() => void handleAutoDetectPath()}
          >
            <Search size={14} className={pathStatus === "testing" ? "animate-pulse" : ""} />
            {pathStatus === "testing" ? "检测中..." : "自动获取路径"}
          </button>
          <button
            className="btn btn-outline"
            disabled={saving || pathStatus === "testing"}
            onClick={() => void handleTestPath()}
          >
            <Zap size={14} className={pathStatus === "testing" ? "animate-pulse" : ""} />
            {pathStatus === "testing" ? "测试中..." : "测试路径有效性"}
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={<Cpu size={15} className="text-primary" />}
        title="指纹浏览器内核"
        description={kernelSectionDescription}
      >
        <p className="text-xs text-muted-foreground">{binarySummary}</p>
        {isSessionSeatsFull(binaryStatus) ? (
          <div className="space-y-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-2">
            <p className="text-[11px] leading-4 text-red-700 dark:text-red-400">
              内核会话席位已占满（{binaryStatus?.sessionSeatsActive}/{binaryStatus?.sessionSeatsLimit}
              ）。此为 CloakBrowser 授权并发（常见于 Pro 核），与「AI 并行上限」不同：本应用不限制打开指纹浏览器个数。可强杀幽灵进程，或等待约 15 分钟超时。
            </p>
            <button
              type="button"
              className="btn btn-outline border-red-500/40 text-red-700 hover:bg-red-500/10 dark:text-red-400"
              disabled={saving || binaryBusy || diagnoseBusy || killBusy}
              onClick={() => void handleKillAllRunningBrowsers()}
            >
              <Power size={14} className={killBusy ? "animate-pulse" : ""} />
              {killBusy ? "强杀中…" : "一键强杀全部运行中浏览器"}
            </button>
          </div>
        ) : null}
        {binaryStatus?.tier === "free" ? (
          <p className="rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
            免费 License：CloakBrowser 官方免费档内核并发=1，再开第二个指纹窗会被内核闪退关掉（非本应用 BUG）。
            AI/Agent/填表并行亦限 1（且须免费核）。多开指纹窗请升级 Pro。点「下载内核/检查更新」可拉取官方免费核。
            {binaryStatus.proLatestVersion
              ? ` 服务端最新 Pro：${binaryStatus.proLatestVersion}。`
              : ""}
          </p>
        ) : null}
        {binaryStatus?.tier === "pro" ? (
          <p className="rounded-md border border-border bg-secondary/20 px-2.5 py-1.5 text-[11px] leading-4 text-muted-foreground">
            Pro License：指纹窗并发与 AI 并行均不超过授权席位（如 Solo=5）。可用打包 {BUNDLED_PRO_CHROMIUM_VERSION}
            -pro 或在线更新。
          </p>
        ) : null}
        <div className="rounded-md border border-border px-3 py-2.5">
          <p className="mb-2 text-xs font-medium text-foreground">新建环境默认内核</p>
          <KernelVersionSelect
            value={settings.default_browser_version ?? ""}
            onChange={(next) =>
              onSettingsChange({ ...settings, default_browser_version: next })
            }
            disabled={saving}
          />
          <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
            「下载内核 / 检查更新」会按此处版本 pin 执行；留空=跟随 License 最新。选「免费核」
            （{FREE_CHROMIUM_VERSION}）时即使填了 Free Key 也只下该免费包，不会误拉最新 Pro
            zip。自定义须为完整 4~5 段号。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="btn btn-outline"
            disabled={saving || binaryBusy || diagnoseBusy || killBusy}
            onClick={() => void handleDownloadBinary()}
          >
            <Download size={14} className={binaryBusy ? "animate-pulse" : ""} />
            {binaryBusy ? "处理中…" : "下载内核"}
          </button>
          <button
            className="btn btn-outline"
            disabled={saving || binaryBusy || diagnoseBusy || killBusy}
            onClick={() => void handleUpdateBinary()}
          >
            <RefreshCw size={14} className={binaryBusy ? "animate-spin" : ""} />
            检查更新
          </button>
          <button
            className="btn btn-outline"
            disabled={saving || binaryBusy || diagnoseBusy || killBusy}
            onClick={() => void handleCleanupBinary()}
          >
            <Trash2 size={14} />
            清理旧版本
          </button>
          <button
            className="btn btn-outline"
            disabled={saving || binaryBusy || diagnoseBusy || killBusy}
            onClick={() => void handleDiagnoseBinary()}
            title="等价官方 cloakbrowser info：检查内核、License、席位、GeoIP 依赖等"
          >
            <Stethoscope size={14} className={diagnoseBusy ? "animate-pulse" : ""} />
            {diagnoseBusy ? "诊断中…" : "一键诊断"}
          </button>
          <button
            className="btn btn-outline border-red-500/35 text-red-700 hover:bg-red-500/10 dark:text-red-400"
            disabled={saving || binaryBusy || diagnoseBusy || killBusy}
            onClick={() => void handleKillAllRunningBrowsers()}
            title="强制结束全部天枢台环境浏览器与幽灵进程，用于释放 Pro 会话席位"
          >
            <Power size={14} className={killBusy ? "animate-pulse" : ""} />
            {killBusy ? "强杀中…" : "一键强杀运行中浏览器"}
          </button>
        </div>
        {Array.isArray(binaryStatus?.checks) && binaryStatus.checks.length > 0 ? (
          <ul className="space-y-1.5 rounded-md border border-border bg-background px-2.5 py-2">
            {binaryStatus.checks.map((check) => (
              <li key={check.id} className="text-[11px] leading-4">
                <span className={check.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
                  {check.ok ? "✓" : "✗"} {check.title}
                </span>
                <span className="mt-0.5 block text-muted-foreground">{check.detail}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsSection>

      <SettingsSection
        icon={<FileKey size={15} className="text-primary" />}
        title="浏览器内核密钥"
      >
        <label className="field-label">
          <input
            className="field-input font-mono text-xs"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={licenseKeyDraft}
            onChange={(event) => setLicenseKeyDraft(event.target.value)}
            placeholder="cb_xxxxxxxx（从订阅邮件复制，空格可忽略）"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <ConnectivityIndicator status={keyStatus} />
          <button
            className="btn btn-primary"
            disabled={saving || keyStatus === "testing" || !normalizeCloakLicenseKey(licenseKeyDraft)}
            onClick={() => void handleSaveLicenseKey()}
          >
            <Zap size={14} className={keyStatus === "testing" ? "animate-pulse" : ""} />
            {keyStatus === "testing" ? "验证中..." : "保存并验证"}
          </button>
          <button
            className="btn btn-outline"
            disabled={saving || !hasLicenseKey}
            onClick={() => void handleClearLicenseKey()}
          >
            <Trash2 size={14} />
            清除 License
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={<Download size={15} className="text-primary" />}
        title="存储与下载"
        description="区分两条路径避免混杂：常规浏览器点击下载 / Cookie·CSV 导出 vs AI/爬虫抓取媒体。留空则使用应用数据目录下 downloads/browser 与 downloads/scraper；落盘时会再按环境 ID 建子目录。"
      >
        <label className="field-label">
          常规浏览器下载目录
          <div className="mt-1 flex gap-2">
            <input
              className="field-input font-mono text-xs flex-1"
              value={settings.browser_download_dir}
              onChange={(event) =>
                onSettingsChange({ ...settings, browser_download_dir: event.target.value })
              }
              placeholder="默认：应用数据/downloads/browser"
            />
            <button
              type="button"
              className="btn btn-outline shrink-0"
              disabled={saving}
              onClick={() => void handlePickDownloadDir("browser_download_dir")}
            >
              <FolderOpen size={14} />
              浏览
            </button>
          </div>
        </label>
        <label className="field-label">
          爬虫数据抓取目录
          <div className="mt-1 flex gap-2">
            <input
              className="field-input font-mono text-xs flex-1"
              value={settings.scraper_download_dir}
              onChange={(event) =>
                onSettingsChange({ ...settings, scraper_download_dir: event.target.value })
              }
              placeholder="默认：应用数据/downloads/scraper"
            />
            <button
              type="button"
              className="btn btn-outline shrink-0"
              disabled={saving}
              onClick={() => void handlePickDownloadDir("scraper_download_dir")}
            >
              <FolderOpen size={14} />
              浏览
            </button>
          </div>
        </label>
        <div className="mt-3 rounded border border-border/70 bg-muted/20 p-3">
          <div className="text-sm font-medium text-foreground">缓存清理</div>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            清理自动化下载的图片、Agent 验证码帧（~/.cloakforge/agent_fs）、以及已从列表删除但仍残留的
            profile-{"{id}"} 环境目录与下载子目录。不会删除仍存在于环境列表中的浏览器配置。
          </p>
          <button
            type="button"
            className="btn btn-outline mt-2"
            disabled={saving || cacheBusy}
            onClick={() => void handlePurgeAutomationCache()}
          >
            <Trash2 size={14} className={cacheBusy ? "animate-pulse" : ""} />
            {cacheBusy ? "清理中…" : "清理自动化缓存与孤儿环境"}
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={<SlidersHorizontal size={15} className="text-primary" />}
        title="高级 · 兼容与调试"
        description="按需旗标；默认全部关闭，仅在特定场景临时开启，保存后对新建环境生效。"
      >
        <FlagToggle
          checked={settings.license_through_proxy}
          onChange={(next) => onSettingsChange({ ...settings, license_through_proxy: next })}
          label="授权检查走代理"
          hint="企业网 / 受限网络直连授权服务器失败导致环境启动几秒后秒退时开启"
        />
        <FlagToggle
          checked={settings.allow_third_party_cookies}
          onChange={(next) =>
            onSettingsChange({ ...settings, allow_third_party_cookies: next })
          }
          label="允许第三方 Cookie"
          hint="登录 / 支付 / reCAPTCHA v3 / SSO 等嵌入式验证一直无法完成时按需开启"
        />
        <FlagToggle
          checked={settings.fingerprint_off}
          onChange={(next) => {
            void (async () => {
              if (next && !settings.fingerprint_off) {
                const ok = await confirm({
                  title: "极度危险：关闭全部指纹伪装",
                  description:
                    "此操作将暴露本机真实硬件指纹与真实 IP / WebRTC 出口，极易导致账号风控与封禁。仅限本地开发调试；生产多开环境严禁开启。保存并启动后，所有环境将以真实机器身份上网。",
                  confirmLabel: "我已知晓风险，仍要开启",
                  cancelLabel: "取消，保持伪装",
                  tone: "danger",
                });
                if (!ok) {
                  return;
                }
              }
              onSettingsChange({ ...settings, fingerprint_off: next });
            })();
          }}
          label="关闭指纹伪装（Windows 调试）"
          hint="开启后环境列表将高亮「危险：指纹已关闭」。诊断网站异常时临时关闭 spoofing；用完请立即关闭并保存。"
        />
      </SettingsSection>

      <div className="flex justify-end">
        <button className="btn btn-primary" disabled={saving} onClick={() => void handleSave()}>
          保存常规设置
        </button>
      </div>
    </div>
  );
}

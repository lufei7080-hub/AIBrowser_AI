import { listen } from "@tauri-apps/api/event";
import { TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  batchDeleteProfiles,
  checkLicenseEntitlement,
  deleteProfile,
  exportProfileCookies,
  fetchProfiles,
  fetchSettings,
  formatInvokeError,
  importProfileCookies,
  setProfileAgentPanorama,
  setProfileInteractiveExtract,
  startProfile,
  stopProfile,
} from "../lib/tauri";
import { saveTextToDownloadDir } from "../lib/nativeFsExport";
import type { Profile, ProfileIpGeo, SidecarLogPayload, TerminalLine } from "../types";
import { AIFillDrawer } from "./AIFillDrawer";
import { useAppDialog } from "./AppDialogProvider";
import { BatchCreateModal } from "./BatchCreateModal";
import { ElementExtractDebugPanel } from "./ElementExtractDebugPanel";
import { useGlobalBanner } from "./GlobalBannerProvider";
import { ProfileFormModal } from "./ProfileFormModal";
import { ProfileTable } from "./ProfileTable";
import { SettingsModal } from "./SettingsModal";
import { createToast, type ToastMessage } from "../lib/toast";

function makeLine(tone: TerminalLine["tone"], text: string): TerminalLine {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toLocaleTimeString(),
    tone,
    text,
  };
}

function toneFromSidecarPayload(payload: SidecarLogPayload): TerminalLine["tone"] {
  const parsed = payload.parsed;
  if (!parsed) {
    return "info";
  }

  if (parsed.type === "progress") {
    return "progress";
  }
  if (parsed.kind === "error" || parsed.level === "error") {
    return "error";
  }
  if (parsed.kind === "result" || parsed.ok === true) {
    return "success";
  }
  if (parsed.kind === "log" && parsed.level === "warn") {
    return "warn";
  }
  return "info";
}

function textFromSidecarPayload(payload: SidecarLogPayload): string | null {
  const parsed = payload.parsed;
  if (parsed?.type === "page_url" || parsed?.type === "interactive_extract") {
    return null;
  }

  if (parsed?.type === "progress" && typeof parsed.field === "string") {
    const stage = typeof parsed.stage === "string" ? parsed.stage : "update";
    const ok = parsed.ok;
    const suffix =
      ok === true ? "ok" : ok === false ? `fail(${String(parsed.error ?? "error")})` : stage;
    return `[fill] ${parsed.field} · ${suffix}`;
  }

  if (typeof parsed?.message === "string") {
    return parsed.message;
  }

  return payload.line;
}

function humanizeLaunchError(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes("session seat") ||
    lower.includes("concurrent session") ||
    lower.includes("session limit") ||
    message.includes("席位") ||
    /exit(?:\s*code)?\s*[:\s]*76\b/.test(lower)
  ) {
    return "CloakBrowser 内核会话席位已满：官方免费档仅允许 1 个并发指纹窗。请先停止已开环境或升级 Pro；幽灵占用可强杀后重试。";
  }
  return message;
}

export function AppLayout() {
  const { confirm } = useAppDialog();
  const { error: bannerError, showError, clearError } = useGlobalBanner();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showProBadge, setShowProBadge] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [batchCreateOpen, setBatchCreateOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [ipGeoOverrides, setIpGeoOverrides] = useState<Map<string, ProfileIpGeo>>(() => new Map());
  /** 全局调试旗标：关闭指纹伪装时环境列表高亮警示 */
  const [fingerprintSpoofingDisabled, setFingerprintSpoofingDisabled] = useState(false);
  const [extractDebugProfileId, setExtractDebugProfileId] = useState<string | null>(null);

  const refreshFingerprintFlag = useCallback(async () => {
    try {
      const next = await fetchSettings();
      setFingerprintSpoofingDisabled(Boolean(next.fingerprint_off));
    } catch {
      // 设置读取失败不阻断主界面
    }
  }, []);

  useEffect(() => {
    void refreshFingerprintFlag();
  }, [refreshFingerprintFlag]);

  useEffect(() => {
    if (!settingsOpen) {
      void refreshFingerprintFlag();
    }
  }, [settingsOpen, refreshFingerprintFlag]);

  const mergeIpGeoOverride = useCallback((entry: ProfileIpGeo) => {
    const profileId = entry.profile_id?.trim();
    if (!profileId) {
      return;
    }
    setIpGeoOverrides((current) => {
      const next = new Map(current);
      next.set(profileId, entry);
      return next;
    });
  }, []);

  /** 兼容子组件 onError(string)：空串清栏，否则写入红色通知 */
  const handleBannerError = useCallback(
    (message: string) => {
      if (!message.trim()) {
        clearError();
        return;
      }
      showError(message);
    },
    [clearError, showError],
  );

  const showToast = useCallback(
    (message: ToastMessage) => {
      if (message.tone === "error") {
        showError(message.text);
      }
    },
    [showError],
  );

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const refreshEntitlement = useCallback(async () => {
    try {
      const entitlement = await checkLicenseEntitlement();
      setShowProBadge(entitlement.isPro && entitlement.isValid);
    } catch {
      setShowProBadge(false);
    }
  }, []);

  useEffect(() => {
    void refreshEntitlement();
  }, [refreshEntitlement]);

  const pushTerminalLine = useCallback((line: TerminalLine) => {
    setTerminalLines((current) => [...current, line].slice(-400));
  }, []);

  const refreshProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchProfiles();
      setProfiles(next);
      clearError();
    } catch (error) {
      showError(formatInvokeError(error));
    } finally {
      setLoading(false);
    }
  }, [clearError, showError]);

  // closeSettings 依赖 refreshProfiles / refreshEntitlement — 修正闭包
  const closeSettingsStable = useCallback(() => {
    setSettingsOpen(false);
    void refreshEntitlement();
    void refreshProfiles();
  }, [refreshEntitlement, refreshProfiles]);

  useEffect(() => {
    void refreshProfiles();
  }, [refreshProfiles]);

  const handleToggleInteractiveExtract = useCallback(
    async (profileId: string, enabled: boolean) => {
      try {
        const updated = await setProfileInteractiveExtract(profileId, enabled);
        setProfiles((current) =>
          current.map((profile) => (String(profile.id) === profileId ? updated : profile)),
        );
        pushTerminalLine(
          makeLine(
            "success",
            enabled
              ? `环境 #${profileId} 已开启元素提取（填表缓存+Agent 蒸馏增强；重新启动后生效）`
              : `环境 #${profileId} 已关闭元素提取（Agent 仍可实时提取；智能填表将不可用）`,
          ),
        );
      } catch (error) {
        showToast(createToast("error", formatInvokeError(error)));
      }
    },
    [pushTerminalLine, showToast],
  );

  const handleToggleAgentPanorama = useCallback(
    async (profileId: string, enabled: boolean) => {
      try {
        const updated = await setProfileAgentPanorama(profileId, enabled);
        setProfiles((current) =>
          current.map((profile) => (String(profile.id) === profileId ? updated : profile)),
        );
        pushTerminalLine(
          makeLine(
            "success",
            enabled
              ? `环境 #${profileId} 已开启 Agent 全景截图（多帧低质量，AI 调用后销毁）`
              : `环境 #${profileId} 已关闭 Agent 全景截图（仅 JSON 观察）`,
          ),
        );
      } catch (error) {
        showToast(createToast("error", formatInvokeError(error)));
      }
    },
    [pushTerminalLine, showToast],
  );

  useEffect(() => {
    let isCancelled = false;
    const unlistenFns: Array<() => void> = [];

    const track = (promise: Promise<() => void>) => {
      void promise.then((fn) => {
        if (isCancelled) {
          fn();
        } else {
          unlistenFns.push(fn);
        }
      });
    };

    track(
      listen<SidecarLogPayload>("sidecar-log", (event) => {
        const text = textFromSidecarPayload(event.payload);
        if (!text) {
          return;
        }
        pushTerminalLine(makeLine(toneFromSidecarPayload(event.payload), text));
      }),
    );

    track(
      listen<ProfileIpGeo>("profile-ip-geo-updated", (event) => {
        mergeIpGeoOverride(event.payload);
      }),
    );

    track(
      listen<{ profileId?: string; profile_id?: string; status?: string; cdpPort?: number; cdp_port?: number }>(
        "browser-status",
        (event) => {
          const payload = event.payload;
          const profileId = payload.profileId ?? payload.profile_id ?? "?";
          const status = payload.status ?? "unknown";
          const cdpPort = payload.cdpPort ?? payload.cdp_port;
          pushTerminalLine(
            makeLine(
              status === "running" ? "success" : "info",
              `[browser] profile=${profileId} status=${status}${cdpPort ? ` cdp=${cdpPort}` : ""}`,
            ),
          );
          if (profileId !== "?") {
            setProfiles((current) =>
              current.map((profile) =>
                String(profile.id) === profileId
                  ? {
                      ...profile,
                      status: status === "running" || status === "stopped" ? status : profile.status,
                      cdp_port: status === "stopped" ? null : (cdpPort ?? profile.cdp_port),
                    }
                  : profile,
              ),
            );
          }
          void refreshProfiles();
        },
      ),
    );

    return () => {
      isCancelled = true;
      for (const unlisten of unlistenFns) {
        unlisten();
      }
    };
  }, [mergeIpGeoOverride, pushTerminalLine, refreshProfiles]);

  const withBusy = async (
    id: string,
    task: () => Promise<void>,
    errorPrefix?: string,
  ): Promise<boolean> => {
    setBusyIds((current) => [...current, id]);
    clearError();
    try {
      await task();
      await refreshProfiles();
      return true;
    } catch (error) {
      const message = formatInvokeError(error);
      const readable = errorPrefix ? `${errorPrefix}: ${message}` : message;
      showError(readable);
      return false;
    } finally {
      setBusyIds((current) => current.filter((item) => item !== id));
    }
  };

  const handleToggle = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  // 单击行（非勾选框区域）→ 单选：仅选中该环境
  const handleSelect = (id: string) => {
    setSelectedIds([id]);
  };

  const handleToggleAll = () => {
    if (profiles.length === 0) {
      return;
    }
    const allIds = profiles.map((profile) => String(profile.id));
    setSelectedIds((current) => (current.length === allIds.length ? [] : allIds));
  };

  const handleStart = (id: string) =>
    withBusy(
      id,
      async () => {
        try {
          const result = await startProfile(id);
          if (result.ip_geo) {
            mergeIpGeoOverride(result.ip_geo);
          }
          pushTerminalLine(makeLine("success", `[start] profile=${id} cdp=${result.cdp_port}`));
        } catch (error) {
          throw new Error(humanizeLaunchError(formatInvokeError(error)));
        }
      },
      "启动失败",
    );

  const handleStop = (id: string) =>
    withBusy(
      id,
      async () => {
        await stopProfile(id);
        pushTerminalLine(makeLine("info", `[stop] profile=${id}`));
      },
      "停止失败",
    );

  const handleDelete = async (id: string) => {
    const confirmed = await confirm({
      title: "删除环境",
      description: "确定删除该环境？此操作不可撤销。",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    void withBusy(id, async () => {
      await deleteProfile(id);
      setSelectedIds((current) => current.filter((item) => item !== id));
      pushTerminalLine(makeLine("warn", `[delete] profile=${id}`));
    });
  };

  const handleBatchStart = async () => {
    clearError();
    for (const id of selectedIds) {
      const profile = profiles.find((item) => String(item.id) === id);
      if (profile?.status === "running") {
        continue;
      }
      await handleStart(id);
    }
  };

  const handleBatchDelete = async () => {
    if (selectedIds.length === 0) {
      return;
    }
    const confirmed = await confirm({
      title: "批量删除环境",
      description: `确定删除已选的 ${selectedIds.length} 个环境？此操作不可撤销。`,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }

    clearError();
    try {
      const result = await batchDeleteProfiles(selectedIds);
      setSelectedIds((current) =>
        current.filter((id) => !result.deleted_ids.includes(id)),
      );
      for (const id of result.deleted_ids) {
        pushTerminalLine(makeLine("warn", `[delete] profile=${id}`));
      }
      await refreshProfiles();
      if (result.skipped_running_ids.length > 0) {
        showError(
          `已删除 ${result.deleted_ids.length} 个环境；以下运行中环境已跳过：${result.skipped_running_ids.join(", ")}`,
        );
      }
    } catch (error) {
      showError(formatInvokeError(error));
    }
  };

  const handleExportCookies = async (id: string) => {
    clearError();
    try {
      const result = await exportProfileCookies(id, "json");
      const savedPath = await saveTextToDownloadDir({
        content: result.content,
        filename: `profile-${id}-cookies.json`,
        profileId: id,
        track: "browser",
        openAfter: true,
      });
      pushTerminalLine(
        makeLine(
          "success",
          `[cookies] 已导出 ${result.count} 条 · profile=${id} · ${savedPath}`,
        ),
      );
    } catch (error) {
      showError(formatInvokeError(error));
    }
  };

  const handleImportCookies = async (id: string, payload: string) => {
    clearError();
    try {
      const result = await importProfileCookies(id, payload);
      if (result.appliedNow) {
        pushTerminalLine(
          makeLine("success", `[cookies] 已即时导入 ${result.count} 条 · profile=${id}`),
        );
      } else {
        pushTerminalLine(
          makeLine(
            "warn",
            `[cookies] 已暂存 ${result.count} 条，下次启动环境时自动注入 · profile=${id}`,
          ),
        );
      }
    } catch (error) {
      showError(formatInvokeError(error));
    }
  };

  const runningCount = useMemo(
    () => profiles.filter((profile) => profile.status === "running").length,
    [profiles],
  );

  return (
    <div className="flex h-screen w-full min-w-0 bg-background">
      {/* 左列：Logo/状态 + 环境列表（约 45% 宽，弹性下限 520px） */}
      <div className="flex h-full w-[calc(45%+200px)] min-w-[720px] max-w-[920px] shrink-0 flex-col border-r border-border bg-card">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
          <div className="flex items-center gap-1.5">
            <h1 className="text-base font-semibold tracking-tight">天枢台</h1>
            {showProBadge ? (
              <span className="text-[11px] font-medium text-sky-500">Pro</span>
            ) : null}
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
              runningCount > 0
                ? "border-success/20 bg-success/10 text-success"
                : "border-border bg-secondary text-muted-foreground"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                runningCount > 0 ? "bg-success" : "bg-muted-foreground/50"
              }`}
            />
            运行中 {runningCount}/{profiles.length}
          </span>
        </header>

        {bannerError ? (
          <div className="banner shrink-0 border-x-0 border-t-0" role="alert">
            <span className="flex min-w-0 items-center gap-2">
              <TriangleAlert size={14} className="shrink-0" />
              <span className="truncate">{bannerError}</span>
            </span>
            <button
              type="button"
              className="icon-button shrink-0 text-destructive"
              onClick={clearError}
              aria-label="关闭提示"
            >
              <X size={14} />
            </button>
          </div>
        ) : null}

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ProfileTable
            profiles={profiles}
            selectedIds={selectedIds}
            busyIds={busyIds}
            ipGeoOverrides={ipGeoOverrides}
            onToggle={handleToggle}
            onSelect={handleSelect}
            onToggleAll={handleToggleAll}
            onStart={handleStart}
            onStop={handleStop}
            onEdit={setEditingProfile}
            onDelete={handleDelete}
            onCreate={() => setCreateOpen(true)}
            onBatchCreate={() => setBatchCreateOpen(true)}
            onOpenSettings={openSettings}
            onRefresh={() => void refreshProfiles()}
            refreshing={loading}
            onBatchStart={() => void handleBatchStart()}
            onBatchDelete={() => void handleBatchDelete()}
            onExportCookies={(id) => void handleExportCookies(id)}
            onImportCookies={(id, payload) => void handleImportCookies(id, payload)}
            onToggleInteractiveExtract={(id, enabled) =>
              void handleToggleInteractiveExtract(id, enabled)
            }
            onToggleAgentPanorama={(id, enabled) => void handleToggleAgentPanorama(id, enabled)}
            onOpenExtractDebug={(id) => setExtractDebugProfileId(id)}
            fingerprintSpoofingDisabled={fingerprintSpoofingDisabled}
          />
        </main>
      </div>

      {/* 右列：AI 中枢顶天立地（弹性扩容至窗口最底） */}
      <AIFillDrawer
        profiles={profiles}
        selectedIds={selectedIds}
        busyIds={busyIds}
        lines={terminalLines}
        onLog={pushTerminalLine}
        onError={handleBannerError}
        onStartBrowser={handleStart}
        onStopBrowser={handleStop}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={closeSettingsStable}
        onError={handleBannerError}
        onToast={showToast}
        onEntitlementChange={() => void refreshEntitlement()}
      />

      <ProfileFormModal
        open={createOpen}
        mode="create"
        onClose={() => setCreateOpen(false)}
        onSuccess={() => void refreshProfiles()}
        onError={handleBannerError}
      />

      <ProfileFormModal
        open={editingProfile != null}
        mode="edit"
        profile={editingProfile}
        onClose={() => setEditingProfile(null)}
        onSuccess={() => void refreshProfiles()}
        onError={handleBannerError}
      />

      <BatchCreateModal
        open={batchCreateOpen}
        onClose={() => setBatchCreateOpen(false)}
        onSuccess={() => void refreshProfiles()}
        onError={handleBannerError}
      />

      {extractDebugProfileId ? (
        <ElementExtractDebugPanel
          profileId={extractDebugProfileId}
          profileName={
            profiles.find((p) => String(p.id) === extractDebugProfileId)?.name
          }
          extractEnabled={
            profiles.find((p) => String(p.id) === extractDebugProfileId)
              ?.interactive_element_extract_enabled === true
          }
          onClose={() => setExtractDebugProfileId(null)}
        />
      ) : null}
    </div>
  );
}

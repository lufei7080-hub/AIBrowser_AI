import { Bot, SlidersHorizontal, Server } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchProxies, fetchSettings, formatInvokeError } from "../lib/tauri";
import type { AppSettings, ConnectivityStatus, Proxy } from "../types";
import { Modal } from "./Modal";
import { AiSettingsTab } from "./settings/AiSettingsTab";
import { GeneralSettingsTab } from "./settings/GeneralSettingsTab";
import { ProxyPoolTab } from "./settings/ProxyPoolTab";
import type { ToastMessage } from "../lib/toast";

type SettingsTab = "ai" | "general" | "proxies";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onError: (message: string) => void;
  onToast: (message: ToastMessage) => void;
  onEntitlementChange: () => void;
}

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Bot; hint: string }> = [
  { id: "ai", label: "AI 设置", icon: Bot, hint: "模型、连接与风控 API" },
  { id: "general", label: "常规设置", icon: SlidersHorizontal, hint: "内核与下载" },
  { id: "proxies", label: "代理池", icon: Server, hint: "代理管理" },
];

export function SettingsModal({
  open,
  onClose,
  onError,
  onToast,
  onEntitlementChange,
}: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>("ai");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [saving, setSaving] = useState(false);
  const [aiStatus, setAiStatus] = useState<ConnectivityStatus>("idle");
  const [pathStatus, setPathStatus] = useState<ConnectivityStatus>("idle");
  const [keyStatus, setKeyStatus] = useState<ConnectivityStatus>("idle");
  const onErrorRef = useRef(onError);
  const aiFlushSaveRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const load = useCallback(async () => {
    try {
      const [nextSettings, nextProxies] = await Promise.all([fetchSettings(), fetchProxies()]);
      setSettings(nextSettings);
      setProxies(nextProxies);
      onErrorRef.current("");
    } catch (error) {
      onErrorRef.current(formatInvokeError(error));
    }
  }, []);

  useEffect(() => {
    if (open) {
      setAiStatus("idle");
      setPathStatus("idle");
      setKeyStatus("idle");
      void load();
    }
  }, [open, load]);

  const handleDone = async () => {
    try {
      if (aiFlushSaveRef.current) {
        await aiFlushSaveRef.current();
      }
    } catch {
      // 错误已在子组件 toast；仍允许关闭以免卡死
    }
    onClose();
  };

  return (
    <Modal open={open} title="全局设置" onClose={() => void handleDone()} widthClass="max-w-4xl">
      {/* 顶部分区导航：图标 + 标题 + 副标题 */}
      <div className="mb-5 grid grid-cols-3 gap-2">
        {TABS.map(({ id, label, icon: Icon, hint }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                active
                  ? "border-primary bg-primary/[0.04]"
                  : "border-border hover:bg-secondary/50"
              }`}
              onClick={() => setTab(id)}
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
                  active ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
                }`}
              >
                <Icon size={15} />
              </span>
              <span className="min-w-0">
                <span
                  className={`block text-xs font-semibold ${
                    active ? "text-foreground" : "text-foreground/80"
                  }`}
                >
                  {label}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">{hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="max-h-[60vh] overflow-y-auto pr-1">
        {!settings ? (
          <div className="py-8 text-center text-sm text-muted-foreground">加载设置中...</div>
        ) : tab === "ai" ? (
          <AiSettingsTab
            settings={settings}
            aiStatus={aiStatus}
            saving={saving}
            onSettingsChange={setSettings}
            onAiStatusChange={setAiStatus}
            onSavingChange={setSaving}
            onToast={onToast}
            onError={onError}
            registerFlushSave={(flush) => {
              aiFlushSaveRef.current = flush;
            }}
          />
        ) : tab === "general" ? (
          <GeneralSettingsTab
            settings={settings}
            pathStatus={pathStatus}
            keyStatus={keyStatus}
            saving={saving}
            onSettingsChange={setSettings}
            onPathStatusChange={setPathStatus}
            onKeyStatusChange={setKeyStatus}
            onSavingChange={setSaving}
            onToast={onToast}
            onError={onError}
            onEntitlementChange={onEntitlementChange}
          />
        ) : (
          <ProxyPoolTab
            proxies={proxies}
            onReload={load}
            onToast={onToast}
            onError={onError}
          />
        )}
      </div>

      <div className="mt-5 flex justify-end border-t border-border pt-4">
        <button
          type="button"
          className="btn btn-primary"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void handleDone();
          }}
        >
          完成
        </button>
      </div>
    </Modal>
  );
}

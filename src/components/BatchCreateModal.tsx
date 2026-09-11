import { useEffect, useMemo, useState } from "react";

import { batchCreateProfiles, fetchProxies, fetchSettings, formatInvokeError, proxyLabel } from "../lib/tauri";
import type { Proxy, ProxyStrategy, StealthPreset, WebglMode } from "../types";
import { STEALTH_PRESET_OPTIONS, THEME_COLORS, WEBGL_MODE_OPTIONS } from "../types";
import { KernelVersionSelect } from "./KernelVersionSelect";
import { Modal } from "./Modal";
import { serializeStartupUrls, StartupUrlsEditor } from "./StartupUrlsEditor";

interface BatchCreateModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  onError: (message: string) => void;
}

export function BatchCreateModal({ open, onClose, onSuccess, onError }: BatchCreateModalProps) {
  const [prefix, setPrefix] = useState("Profile");
  const [count, setCount] = useState(5);
  const [themeColor, setThemeColor] = useState<string>(THEME_COLORS[0]);
  const [proxyStrategy, setProxyStrategy] = useState<ProxyStrategy>("none");
  const [proxyId, setProxyId] = useState<string>("");
  const [sequentialHost, setSequentialHost] = useState("127.0.0.1");
  const [sequentialStartPort, setSequentialStartPort] = useState(5500);
  const [sequentialProxyType, setSequentialProxyType] = useState<"HTTP" | "SOCKS5">("HTTP");
  const [webglMode, setWebglMode] = useState<WebglMode>("local");
  const [stealthPreset, setStealthPreset] = useState<StealthPreset>("default");
  const [startupUrls, setStartupUrls] = useState<string[]>([]);
  const [browserVersion, setBrowserVersion] = useState("");
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    void fetchProxies()
      .then(setProxies)
      .catch((error) => onError(formatInvokeError(error)));
    void fetchSettings()
      .then((settings) => {
        const def = (settings.default_browser_version ?? "").trim();
        if (/^\d+(?:\.\d+){3,4}$/.test(def) || def === "") {
          setBrowserVersion(def);
        }
      })
      .catch(() => undefined);
  }, [open, onError]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setStartupUrls([]);
  }, [open]);

  const sequentialPreview = useMemo(() => {
    if (proxyStrategy !== "sequential_ports") {
      return [];
    }
    return Array.from({ length: Math.min(count, 5) }, (_, index) => {
      const port = sequentialStartPort + index;
      return `${sequentialHost}:${port}`;
    });
  }, [proxyStrategy, count, sequentialHost, sequentialStartPort]);

  const handleSubmit = async () => {
    if (!prefix.trim()) {
      onError("前缀名不能为空");
      return;
    }
    if (proxyStrategy === "pool_shared" && !proxyId) {
      onError("共享代理策略需要选择一个代理池条目");
      return;
    }

    setSaving(true);
    try {
      await batchCreateProfiles({
        prefix: prefix.trim(),
        count,
        theme_color: themeColor,
        proxy_strategy: proxyStrategy,
        proxy_id: proxyStrategy === "pool_shared" && proxyId ? Number(proxyId) : null,
        sequential_host: proxyStrategy === "sequential_ports" ? sequentialHost.trim() : undefined,
        sequential_start_port:
          proxyStrategy === "sequential_ports" ? sequentialStartPort : undefined,
        sequential_proxy_type:
          proxyStrategy === "sequential_ports" ? sequentialProxyType : undefined,
        webgl_mode: webglMode,
        stealth_preset: stealthPreset,
        startup_urls: serializeStartupUrls(startupUrls),
        browser_version: browserVersion.trim() || undefined,
      });
      onError("");
      onSuccess();
      onClose();
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title="批量新建环境"
      description="按前缀与序号批量创建；启动开页设置将应用到本批所有环境。"
      onClose={onClose}
      widthClass="max-w-4xl"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="field-label">
              前缀名
              <input
                className="field-input"
                value={prefix}
                onChange={(event) => setPrefix(event.target.value)}
                placeholder="TikTok_US"
              />
            </label>
            <label className="field-label">
              生成数量 (1-100)
              <input
                className="field-input"
                type="number"
                min={1}
                max={100}
                value={count}
                onChange={(event) => setCount(Number(event.target.value))}
              />
            </label>
          </div>

          <div className="space-y-2">
            <span className="field-label">主题色</span>
            <div className="flex flex-wrap gap-2">
              {THEME_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`h-8 w-8 rounded-full border-2 transition-transform ${
                    themeColor === color ? "scale-110 border-foreground" : "border-transparent"
                  }`}
                  style={{ backgroundColor: color }}
                  onClick={() => setThemeColor(color)}
                  aria-label={`选择主题色 ${color}`}
                />
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <span className="field-label">WebGL 指纹</span>
            <div className="flex gap-1 rounded-md border border-border bg-secondary/30 p-1">
              {WEBGL_MODE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`flex-1 rounded px-2 py-1.5 text-xs font-medium ${
                    webglMode === option.value
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground"
                  }`}
                  onClick={() => setWebglMode(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {WEBGL_MODE_OPTIONS.find((option) => option.value === webglMode)?.hint}
            </p>
          </div>

          <KernelVersionSelect value={browserVersion} onChange={setBrowserVersion} />

          <label className="field-label">
            反检测预设 (Stealth Preset)
            <select
              className="field-input"
              value={stealthPreset}
              onChange={(event) => setStealthPreset(event.target.value as StealthPreset)}
            >
              {STEALTH_PRESET_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <p className="-mt-2 text-[11px] text-muted-foreground">
            {STEALTH_PRESET_OPTIONS.find((option) => option.value === stealthPreset)?.hint}
          </p>
        </div>

        <div className="space-y-4">
          <StartupUrlsEditor urls={startupUrls} onChange={setStartupUrls} disabled={saving} />

          <div className="space-y-2">
            <span className="field-label">代理分配策略</span>
            <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-secondary/30 p-1">
              {([
                ["none", "不使用代理"],
                ["pool_random", "随机分配(代理池)"],
                ["pool_shared", "共享代理(代理池)"],
                ["sequential_ports", "本地端口递增"],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`rounded px-2 py-1.5 text-xs font-medium ${
                    proxyStrategy === id
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground"
                  }`}
                  onClick={() => setProxyStrategy(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {proxyStrategy === "pool_shared" || proxyStrategy === "pool_random" ? (
            <label className="field-label">
              {proxyStrategy === "pool_random" ? "随机来源代理池" : "共享代理"}
              <select
                className="field-input"
                value={proxyId}
                onChange={(event) => setProxyId(event.target.value)}
              >
                <option value="">
                  {proxyStrategy === "pool_random" ? "从全部静态代理中随机" : "请选择代理"}
                </option>
                {proxies
                  .filter((proxy) => proxy.type !== "DYNAMIC_API")
                  .map((proxy) => (
                    <option key={proxy.id} value={proxy.id}>
                      #{proxy.id} · {proxyLabel(proxy)}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}

          {proxyStrategy === "sequential_ports" ? (
            <div className="grid grid-cols-2 gap-3 rounded-md border border-border bg-secondary/20 p-3">
              <label className="field-label col-span-2">
                代理协议
                <select
                  className="field-input"
                  value={sequentialProxyType}
                  onChange={(event) =>
                    setSequentialProxyType(event.target.value as "HTTP" | "SOCKS5")
                  }
                >
                  <option value="HTTP">HTTP</option>
                  <option value="SOCKS5">SOCKS5</option>
                </select>
              </label>
              <label className="field-label">
                主机 IP
                <input
                  className="field-input"
                  value={sequentialHost}
                  onChange={(event) => setSequentialHost(event.target.value)}
                />
              </label>
              <label className="field-label">
                起始端口
                <input
                  className="field-input"
                  type="number"
                  value={sequentialStartPort}
                  onChange={(event) => setSequentialStartPort(Number(event.target.value))}
                />
              </label>
              <p className="col-span-2 text-[11px] text-muted-foreground">
                预览：{sequentialPreview.join(" · ")}
                {count > 5 ? ` … 共 ${count} 个` : ""}
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving}
          onClick={() => void handleSubmit()}
        >
          批量创建
        </button>
      </div>
    </Modal>
  );
}

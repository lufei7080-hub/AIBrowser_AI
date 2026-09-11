import { useMemo, useState } from "react";
import { GitBranch, List, Plus, Upload, Webhook } from "lucide-react";

import {
  addDynamicApiProxy,
  addProxy,
  batchAddProxies,
  batchDeleteProxies,
  formatInvokeError,
  proxyLabel,
} from "../../lib/tauri";
import { applyRegionToApiUrl, parseBatchProxyLines, PROXY_REGION_OPTIONS } from "../../lib/proxy";
import type { AddProxyInput, Proxy } from "../../types";
import { createToast } from "../../lib/toast";
import type { ToastMessage } from "../../lib/toast";
import { useAppDialog } from "../AppDialogProvider";

type ProxyMode = "list" | "single" | "batch" | "range" | "dynamic_api";

interface ProxyPoolTabProps {
  proxies: Proxy[];
  onReload: () => Promise<void>;
  onToast: (toast: ToastMessage) => void;
  onError: (message: string) => void;
}

function parseBatchProxyLinesLocal(raw: string, proxyType: AddProxyInput["type"]) {
  return parseBatchProxyLines(raw, proxyType === "SOCKS5" ? "SOCKS5" : "HTTP");
}

export function ProxyPoolTab({ proxies, onReload, onToast, onError }: ProxyPoolTabProps) {
  const { confirm } = useAppDialog();
  const [mode, setMode] = useState<ProxyMode>("list");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [proxyType, setProxyType] = useState<AddProxyInput["type"]>("HTTP");
  const [singleForm, setSingleForm] = useState<AddProxyInput>({
    type: "HTTP",
    host: "127.0.0.1",
    port: 7890,
    username: "",
    password: "",
  });
  const [batchText, setBatchText] = useState("");
  const [rangeHost, setRangeHost] = useState("127.0.0.1");
  const [rangeStart, setRangeStart] = useState(5500);
  const [rangeEnd, setRangeEnd] = useState(5510);
  const [apiUrl, setApiUrl] = useState("");
  const [apiProtocol, setApiProtocol] = useState<"HTTP" | "SOCKS5">("HTTP");
  const [apiRegion, setApiRegion] = useState("hk");
  const [apiLabel, setApiLabel] = useState("API 动态提取");

  const allSelected = proxies.length > 0 && selectedIds.length === proxies.length;

  const parsedBatchPreview = useMemo(
    () => parseBatchProxyLinesLocal(batchText, proxyType),
    [batchText, proxyType],
  );

  const apiPreviewUrl = useMemo(
    () => (apiUrl.trim() ? applyRegionToApiUrl(apiUrl, apiRegion) : ""),
    [apiUrl, apiRegion],
  );

  const toggleSelect = (id: number) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? [] : proxies.map((proxy) => proxy.id));
  };

  const handleBatchDelete = async () => {
    if (selectedIds.length === 0) {
      return;
    }
    const confirmed = await confirm({
      title: "删除代理",
      description: `确定删除 ${selectedIds.length} 条代理记录？此操作不可撤销。`,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    setSaving(true);
    try {
      const deleted = await batchDeleteProxies(selectedIds);
      setSelectedIds([]);
      await onReload();
      onToast(createToast("success", `已删除 ${deleted} 条代理`));
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      setSaving(false);
    }
  };

  const submitProxies = async (items: AddProxyInput[], successLabel: string) => {
    if (items.length === 0) {
      onToast(createToast("error", "没有可导入的代理数据"));
      return;
    }
    setSaving(true);
    try {
      let inserted = 0;
      if (items.length === 1) {
        await addProxy(items[0]);
        inserted = 1;
      } else {
        inserted = await batchAddProxies(items);
      }
      await onReload();
      onToast(createToast("success", `${successLabel}：${inserted} 条`));
      onError("");
      setMode("list");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleSingleSubmit = async () => {
    await submitProxies(
      [
        {
          type: singleForm.type,
          host: singleForm.host.trim(),
          port: Number(singleForm.port),
          username: singleForm.username?.trim() || null,
          password: singleForm.password?.trim() || null,
        },
      ],
      "已新增代理",
    );
  };

  const handleBatchImport = async () => {
    await submitProxies(parsedBatchPreview, "批量导入完成");
  };

  const handleRangeGenerate = async () => {
    if (rangeStart > rangeEnd) {
      onToast(createToast("error", "起始端口不能大于结束端口"));
      return;
    }
    if (rangeEnd - rangeStart + 1 > 500) {
      onToast(createToast("error", "单次最多生成 500 个端口代理"));
      return;
    }
    const items: AddProxyInput[] = [];
    for (let port = rangeStart; port <= rangeEnd; port += 1) {
      items.push({ type: proxyType, host: rangeHost.trim(), port, username: null, password: null });
    }
    await submitProxies(items, "端口段生成完成");
  };

  const handleDynamicApiSubmit = async () => {
    if (!apiUrl.trim()) {
      onToast(createToast("error", "请填写 API 提取链接"));
      return;
    }
    setSaving(true);
    try {
      await addDynamicApiProxy({
        api_url: apiUrl.trim(),
        protocol: apiProtocol,
        region: apiRegion,
        label: apiLabel.trim() || "API 动态提取",
      });
      await onReload();
      onToast(createToast("success", "API 动态代理已保存到代理池"));
      onError("");
      setMode("list");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface-muted p-1">
        {([
          ["list", "列表视图", List],
          ["single", "单条新增", Plus],
          ["batch", "批量导入", Upload],
          ["range", "端口段生成", GitBranch],
          ["dynamic_api", "API 动态提取", Webhook],
        ] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === id
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setMode(id)}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      {mode === "list" ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">共 {proxies.length} 条 · 已选 {selectedIds.length}</p>
            <button
              className="btn btn-danger"
              disabled={saving || selectedIds.length === 0}
              onClick={() => void handleBatchDelete()}
            >
              批量删除
            </button>
          </div>
          <div className="max-h-56 overflow-auto rounded-md border border-border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-secondary/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      aria-label="全选代理"
                    />
                  </th>
                  <th className="px-3 py-2">ID</th>
                  <th className="px-3 py-2">类型</th>
                  <th className="px-3 py-2">地址</th>
                </tr>
              </thead>
              <tbody>
                {proxies.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                      暂无代理，请切换至其他模式新增
                    </td>
                  </tr>
                ) : (
                  proxies.map((proxy) => (
                    <tr key={proxy.id} className="border-t border-border/70">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(proxy.id)}
                          onChange={() => toggleSelect(proxy.id)}
                          aria-label={`选择代理 ${proxy.id}`}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono">{proxy.id}</td>
                      <td className="px-3 py-2">{proxy.type}</td>
                      <td className="px-3 py-2 font-mono">
                        {proxy.type === "DYNAMIC_API" ? proxyLabel(proxy) : proxyLabel(proxy)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {mode === "single" ? (
        <div className="grid grid-cols-2 gap-3">
          <label className="field-label">
            类型
            <select
              className="field-input"
              value={singleForm.type}
              onChange={(event) =>
                setSingleForm((current) => ({
                  ...current,
                  type: event.target.value as AddProxyInput["type"],
                }))
              }
            >
              <option value="HTTP">HTTP</option>
              <option value="SOCKS5">SOCKS5</option>
            </select>
          </label>
          <label className="field-label">
            端口
            <input
              className="field-input"
              type="number"
              value={singleForm.port}
              onChange={(event) =>
                setSingleForm((current) => ({ ...current, port: Number(event.target.value) }))
              }
            />
          </label>
          <label className="field-label col-span-2">
            主机 IP
            <input
              className="field-input"
              value={singleForm.host}
              onChange={(event) => setSingleForm((current) => ({ ...current, host: event.target.value }))}
            />
          </label>
          <label className="field-label">
            账号
            <input
              className="field-input"
              value={singleForm.username ?? ""}
              onChange={(event) =>
                setSingleForm((current) => ({ ...current, username: event.target.value }))
              }
            />
          </label>
          <label className="field-label">
            密码
            <input
              className="field-input"
              type="password"
              value={singleForm.password ?? ""}
              onChange={(event) =>
                setSingleForm((current) => ({ ...current, password: event.target.value }))
              }
            />
          </label>
          <button className="btn btn-primary col-span-2" disabled={saving} onClick={() => void handleSingleSubmit()}>
            新增单条代理
          </button>
        </div>
      ) : null}

      {mode === "batch" ? (
        <div className="space-y-3">
          <label className="field-label">
            代理类型
            <select
              className="field-input"
              value={proxyType}
              onChange={(event) => setProxyType(event.target.value as AddProxyInput["type"])}
            >
              <option value="HTTP">HTTP</option>
              <option value="SOCKS5">SOCKS5</option>
            </select>
          </label>
          <label className="field-label">
            批量粘贴 (每行 IP:Port:Username:Password)
            <textarea
              className="min-h-[140px] w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none ring-primary/20 focus:ring-2"
              value={batchText}
              onChange={(event) => setBatchText(event.target.value)}
              placeholder={"127.0.0.1:7890:user:pass\n127.0.0.1:7891::"}
            />
          </label>
          <p className="text-xs text-muted-foreground">已解析 {parsedBatchPreview.length} 条有效代理</p>
          <button className="btn btn-primary w-full" disabled={saving} onClick={() => void handleBatchImport()}>
            批量导入代理
          </button>
        </div>
      ) : null}

      {mode === "range" ? (
        <div className="grid grid-cols-2 gap-3">
          <label className="field-label col-span-2">
            代理类型
            <select
              className="field-input"
              value={proxyType}
              onChange={(event) => setProxyType(event.target.value as AddProxyInput["type"])}
            >
              <option value="HTTP">HTTP</option>
              <option value="SOCKS5">SOCKS5</option>
            </select>
          </label>
          <label className="field-label col-span-2">
            主机 IP
            <input className="field-input" value={rangeHost} onChange={(event) => setRangeHost(event.target.value)} />
          </label>
          <label className="field-label">
            起始端口
            <input
              className="field-input"
              type="number"
              value={rangeStart}
              onChange={(event) => setRangeStart(Number(event.target.value))}
            />
          </label>
          <label className="field-label">
            结束端口
            <input
              className="field-input"
              type="number"
              value={rangeEnd}
              onChange={(event) => setRangeEnd(Number(event.target.value))}
            />
          </label>
          <p className="col-span-2 text-xs text-muted-foreground">
            将生成 {Math.max(0, rangeEnd - rangeStart + 1)} 条代理（单次上限 500）
          </p>
          <button className="btn btn-primary col-span-2" disabled={saving} onClick={() => void handleRangeGenerate()}>
            生成端口段代理
          </button>
        </div>
      ) : null}

      {mode === "dynamic_api" ? (
        <div className="space-y-3">
          <label className="field-label">
            API 提取链接
            <input
              className="field-input font-mono text-xs"
              value={apiUrl}
              onChange={(event) => setApiUrl(event.target.value)}
              placeholder="https://provider.example.com/get?key=..."
            />
          </label>
          <label className="field-label">
            代理协议
            <select
              className="field-input"
              value={apiProtocol}
              onChange={(event) => setApiProtocol(event.target.value as "HTTP" | "SOCKS5")}
            >
              <option value="HTTP">HTTP</option>
              <option value="SOCKS5">SOCKS5</option>
            </select>
          </label>
          <label className="field-label">
            国家/地区 (Region)
            <select
              className="field-input"
              value={apiRegion}
              onChange={(event) => setApiRegion(event.target.value)}
            >
              {PROXY_REGION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            显示名称
            <input
              className="field-input"
              value={apiLabel}
              onChange={(event) => setApiLabel(event.target.value)}
            />
          </label>
          {apiPreviewUrl ? (
            <p className="text-[11px] text-muted-foreground">
              实际请求 URL：{apiPreviewUrl}
            </p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            启动前会请求该 API，将返回的 IP:Port 注入浏览器。
          </p>
          <button
            className="btn btn-primary w-full"
            disabled={saving}
            onClick={() => void handleDynamicApiSubmit()}
          >
            保存 API 动态代理
          </button>
        </div>
      ) : null}
    </div>
  );
}

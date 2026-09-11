import {
  Check,
  Download,
  LayoutGrid,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Settings,
  ShieldAlert,
  Square,
  Trash2,
  Upload,
  Braces,
  X,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import type { Profile, ProfileIpGeo } from "../types";
import { useProfileIpGeo } from "../hooks/useProfileIpGeo";
import { formatProfileIpCell } from "../lib/ipGeo";

interface ProfileTableProps {
  profiles: Profile[];
  selectedIds: string[];
  busyIds: string[];
  ipGeoOverrides?: Map<string, ProfileIpGeo>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onToggleAll: () => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onEdit: (profile: Profile) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  onBatchCreate: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  refreshing?: boolean;
  onBatchStart: () => void;
  onBatchDelete: () => void;
  onExportCookies: (id: string) => void;
  onImportCookies: (id: string, payload: string) => void;
  onToggleInteractiveExtract: (id: string, enabled: boolean) => void;
  /** Agent 全景多帧截图开关 */
  onToggleAgentPanorama?: (id: string, enabled: boolean) => void;
  /** 打开元素提取 JSON 测试窗 */
  onOpenExtractDebug?: (id: string) => void;
  /** 全局「关闭指纹伪装」已开启：列表高亮危险 Tag */
  fingerprintSpoofingDisabled?: boolean;
}

function statusLabel(status: string): string {
  return status === "running" ? "运行中" : "已停止";
}

interface RowActionProps {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}

function RowAction({ label, danger, disabled, onClick, children }: RowActionProps) {
  return (
    <button
      type="button"
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        danger
          ? "text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
      }`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}

export function ProfileTable({
  profiles,
  selectedIds,
  busyIds,
  onToggle,
  onSelect,
  onToggleAll,
  onStart,
  onStop,
  onEdit,
  onDelete,
  onCreate,
  onBatchCreate,
  onOpenSettings,
  onRefresh,
  refreshing = false,
  onBatchStart,
  onBatchDelete,
  onExportCookies,
  onImportCookies,
  onToggleInteractiveExtract,
  onToggleAgentPanorama,
  onOpenExtractDebug,
  ipGeoOverrides,
  fingerprintSpoofingDisabled = false,
}: ProfileTableProps) {
  const cookieFileRef = useRef<HTMLInputElement>(null);
  const [importTargetId, setImportTargetId] = useState<string | null>(null);
  const { map: ipGeoMap } = useProfileIpGeo(profiles, ipGeoOverrides);
  const allSelected =
    profiles.length > 0 && profiles.every((profile) => selectedIds.includes(String(profile.id)));
  const runningCount = profiles.filter((profile) => profile.status === "running").length;

  const handleImportClick = (id: string) => {
    setImportTargetId(id);
    cookieFileRef.current?.click();
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-card">
      {fingerprintSpoofingDisabled ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-[12px] font-medium text-destructive"
          role="alert"
        >
          <ShieldAlert size={14} className="shrink-0" />
          <span>
            全局调试：指纹伪装已关闭 — 所有环境将暴露本机真实硬件指纹与真实 IP。用完请立即到设置中关闭。
          </span>
        </div>
      ) : null}
      {/* 标题 + 主操作 */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight">环境列表</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {profiles.length} 个环境 · 运行中 {runningCount}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <button type="button" className="btn btn-primary" onClick={onCreate}>
            <Plus size={14} />
            新建环境
          </button>
          <button type="button" className="btn btn-outline" onClick={onBatchCreate}>
            <LayoutGrid size={14} />
            批量新建
          </button>
          <button type="button" className="btn btn-outline" onClick={onOpenSettings}>
            <Settings size={14} />
            全局设置
          </button>
          <button type="button" className="btn" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
            刷新
          </button>
        </div>
      </div>

      {/* 选中后浮现的批量上下文工具条 */}
      {selectedIds.length > 0 ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-primary/10 bg-primary/[0.03] px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-[11px] font-medium text-foreground">已选 {selectedIds.length} 项</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              onClick={onToggleAll}
            >
              <X size={12} />
              清空
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" className="btn btn-outline py-1" onClick={onBatchStart}>
              <Play size={13} />
              批量启动
            </button>
            <button type="button" className="btn btn-danger py-1" onClick={onBatchDelete}>
              <Trash2 size={13} />
              批量删除
            </button>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
            <tr className="border-b border-border bg-secondary/35 text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="w-11 px-2 py-2.5 text-center">
                <button
                  type="button"
                  className={`checkbox ${allSelected ? "checkbox-checked" : ""}`}
                  onClick={onToggleAll}
                  aria-label="全选"
                >
                  {allSelected && <Check size={12} />}
                </button>
              </th>
              <th className="w-14 px-3 py-2.5 text-left font-medium">ID</th>
              <th className="min-w-[8rem] px-2 py-2 text-left font-medium">环境名称</th>
              <th className="w-28 px-2 py-2.5 text-center font-medium">元素提取</th>
              <th className="w-24 px-2 py-2.5 text-center font-medium">全景截图</th>
              <th className="min-w-[9rem] px-2 py-2.5 text-center font-medium">国家</th>
              <th className="w-24 whitespace-nowrap px-2 py-2.5 text-center font-medium">状态</th>
              <th className="w-[13.5rem] px-3 py-2.5 text-center font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {profiles.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-16 text-center text-sm text-muted-foreground">
                  暂无环境数据。点击「新建环境」或「批量新建」创建本地环境。
                </td>
              </tr>
            ) : (
              profiles.map((profile) => {
                const id = String(profile.id);
                const selected = selectedIds.includes(id);
                const running = profile.status === "running";
                const busy = busyIds.includes(id);
                const ipCell = formatProfileIpCell(ipGeoMap.get(id), {
                  loading: busy,
                });

                return (
                  <tr
                    key={profile.id}
                    className={`group transition-colors hover:bg-secondary/25 ${
                      selected ? "bg-primary/[0.035]" : ""
                    }`}
                  >
                    <td className="px-2 py-2.5 text-center align-middle">
                      <button
                        type="button"
                        className={`checkbox ${selected ? "checkbox-checked" : ""}`}
                        onClick={() => onToggle(id)}
                        aria-label={`选择 ${profile.name}`}
                      >
                        {selected && <Check size={12} />}
                      </button>
                    </td>
                    <td
                      className="cursor-pointer px-3 py-2.5 text-left align-middle font-mono text-xs text-muted-foreground"
                      onClick={() => onSelect(id)}
                    >
                      {profile.id}
                    </td>
                    <td
                      className="min-w-[8rem] cursor-pointer px-2 py-2 text-left align-middle"
                      onClick={() => onSelect(id)}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full border border-border/50"
                          style={{ backgroundColor: profile.theme_color }}
                        />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium" title={profile.name}>
                            {profile.name}
                          </div>
                          {fingerprintSpoofingDisabled ? (
                            <span className="mt-0.5 inline-flex max-w-full items-center rounded border border-destructive/50 bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-destructive">
                              危险：指纹已关闭
                            </span>
                          ) : null}
                          {profile.cdp_port ? (
                            <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                              CDP :{profile.cdp_port}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-2.5 text-center align-middle">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={profile.interactive_element_extract_enabled === true}
                          aria-label={`${profile.name} 交互元素提取`}
                          title={
                            profile.interactive_element_extract_enabled
                              ? "已开启：后台缓存交互元素（智能填表/聊天可用）；浏览器 Agent 每轮仍会实时蒸馏短 ID。重新启动后生效"
                              : "已关闭：智能填表需开启。浏览器 Agent 仍可实时提取；开启可加速填表缓存。点击开启（需重新启动环境）"
                          }
                          className={`ui-switch ${
                            profile.interactive_element_extract_enabled ? "bg-primary" : "bg-muted"
                          }`}
                          onClick={() =>
                            onToggleInteractiveExtract(
                              id,
                              !profile.interactive_element_extract_enabled,
                            )
                          }
                        >
                          <span
                            className={`ui-switch-knob ${
                              profile.interactive_element_extract_enabled
                                ? "translate-x-3.5"
                                : "translate-x-0.5"
                            }`}
                          />
                        </button>
                        {onOpenExtractDebug ? (
                          <button
                            type="button"
                            className="icon-button"
                            title="打开元素提取 JSON 测试窗（导航/刷新自动更新）"
                            aria-label={`${profile.name} 元素提取测试`}
                            onClick={() => onOpenExtractDebug(id)}
                          >
                            <Braces size={13} />
                          </button>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2 py-2.5 text-center align-middle">
                      <div className="flex justify-center">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={profile.agent_panorama_enabled === true}
                          aria-label={`${profile.name} Agent 全景截图`}
                          title={
                            profile.agent_panorama_enabled
                              ? "已开启：Agent 每步多帧低质量视口截图 + JSON，调用后销毁"
                              : "已关闭：Agent 仅使用索引 DOM JSON，不截图"
                          }
                          className={`ui-switch ${
                            profile.agent_panorama_enabled ? "bg-primary" : "bg-muted"
                          }`}
                          onClick={() =>
                            onToggleAgentPanorama?.(id, !profile.agent_panorama_enabled)
                          }
                          disabled={!onToggleAgentPanorama}
                        >
                          <span
                            className={`ui-switch-knob ${
                              profile.agent_panorama_enabled
                                ? "translate-x-3.5"
                                : "translate-x-0.5"
                            }`}
                          />
                        </button>
                      </div>
                    </td>
                    <td
                      className="min-w-[9rem] cursor-pointer px-2 py-2.5 text-center align-middle"
                      onClick={() => onSelect(id)}
                    >
                      <div className="mx-auto min-w-0 max-w-full" title={ipCell.title}>
                        <div className="truncate font-mono text-xs text-foreground">
                          {ipCell.primary}
                        </div>
                        {ipCell.secondary ? (
                          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                            {ipCell.secondary}
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td
                      className="cursor-pointer whitespace-nowrap px-2 py-2.5 text-center align-middle"
                      onClick={() => onSelect(id)}
                    >
                      <div className="flex items-center justify-center gap-1.5 text-xs">
                        <span
                          className={`status-dot ${running ? "status-running" : "status-stopped"}`}
                        />
                        {statusLabel(profile.status)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-center align-middle">
                      <div className="inline-flex items-center justify-center gap-0.5">
                        {running ? (
                          <RowAction
                            label="停止"
                            disabled={busy}
                            onClick={() => onStop(id)}
                          >
                            <Square size={14} />
                          </RowAction>
                        ) : (
                          <RowAction
                            label={busy ? "启动中" : "启动"}
                            disabled={busy}
                            onClick={() => onStart(id)}
                          >
                            {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                          </RowAction>
                        )}
                        <RowAction
                          label={running ? "导出 Cookie" : "请先启动环境"}
                          disabled={busy || !running}
                          onClick={() => onExportCookies(id)}
                        >
                          <Download size={14} />
                        </RowAction>
                        <RowAction
                          label="导入 Cookie（未运行时下次启动注入）"
                          disabled={busy}
                          onClick={() => handleImportClick(id)}
                        >
                          <Upload size={14} />
                        </RowAction>
                        <RowAction label="编辑" disabled={busy} onClick={() => onEdit(profile)}>
                          <Pencil size={14} />
                        </RowAction>
                        <RowAction
                          label={running ? "运行中无法删除" : "删除"}
                          danger
                          disabled={busy || running}
                          onClick={() => onDelete(id)}
                        >
                          <Trash2 size={14} />
                        </RowAction>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* 表尾汇总栏 */}
      <div className="flex shrink-0 items-center justify-between border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>
          共 {profiles.length} 个环境 · 运行中 {runningCount} · 已停止{" "}
          {profiles.length - runningCount}
        </span>
        <span className="hidden sm:inline">勾选框多选 · 点击行内区域单选</span>
      </div>

      <input
        ref={cookieFileRef}
        type="file"
        accept=".json,.txt,.cookies,text/plain,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file || !importTargetId) {
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const text = typeof reader.result === "string" ? reader.result : "";
            onImportCookies(importTargetId, text);
          };
          reader.readAsText(file);
        }}
      />
    </div>
  );
}

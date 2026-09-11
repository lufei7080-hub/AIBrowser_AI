import { Modal } from "./Modal";

export interface AgentConfirmActionRow {
  kind: "fill" | "click" | string;
  id: string;
  text: string;
  value?: string;
}

interface AgentConfirmModalProps {
  open: boolean;
  loading: boolean;
  url: string;
  reason?: string;
  actions: AgentConfirmActionRow[];
  fillValues: Record<string, string>;
  onFillValueChange: (id: string, value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function AgentConfirmModal({
  open,
  loading,
  url,
  reason,
  actions,
  fillValues,
  onFillValueChange,
  onConfirm,
  onCancel,
}: AgentConfirmModalProps) {
  const fillCount = actions.filter((action) => action.kind === "fill").length;
  const title =
    fillCount >= 2
      ? `人工确认 · 批量填表（${fillCount} 个字段）`
      : "人工确认 · Agent 拟执行动作";
  return (
    <Modal
      open={open}
      title={title}
      description={
        fillCount >= 2
          ? "请一次性核对并修改所有字段，确认后整批写入浏览器（不会再逐个弹窗）。"
          : "确认无误后再写入浏览器；可修改填写值。取消将回传给 Agent。"
      }
      onClose={onCancel}
      widthClass="max-w-2xl"
    >
      <div className="space-y-3">
        {url ? (
          <p className="truncate text-[11px] text-muted-foreground" title={url}>
            页面：{url}
          </p>
        ) : null}
        {reason ? <p className="text-xs text-foreground">意图：{reason}</p> : null}

        <div className="max-h-[360px] space-y-2 overflow-y-auto rounded-md border border-border p-2">
          {actions.map((action) => (
            <div
              key={`${action.kind}-${action.id}`}
              className="rounded border border-border/70 bg-secondary/20 px-2.5 py-2"
            >
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>
                  {action.kind === "click" ? "点击" : "填写"} · {action.id}
                </span>
                <span className="truncate font-medium text-foreground">{action.text}</span>
              </div>
              {action.kind === "fill" ? (
                <input
                  className="field-input mt-1.5 font-mono text-xs"
                  value={fillValues[action.id] ?? action.value ?? ""}
                  onChange={(event) => onFillValueChange(action.id, event.target.value)}
                  disabled={loading}
                />
              ) : null}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button type="button" className="btn btn-outline px-4" onClick={onCancel} disabled={loading}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary px-4"
            onClick={onConfirm}
            disabled={loading || actions.length === 0}
          >
            {loading ? "提交中…" : "确认并执行"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

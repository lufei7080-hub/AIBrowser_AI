import { Pause, RefreshCw, Save } from "lucide-react";

interface RpaControlsProps {
  rpaState: "idle" | "running" | "paused" | "complete";
  rpaMessage: string;
  currentActionsCount: number;
  controlBusy: boolean;
  onPause: () => void;
  onRescan: () => void;
  onResume: () => void;
  onSaveTemplateOpen: () => void;
  embedded?: boolean;
}

function isErrorPause(state: RpaControlsProps["rpaState"], message: string): boolean {
  if (state !== "paused") {
    return false;
  }
  const normalized = message.toLowerCase();
  return (
    normalized.includes("失败") ||
    normalized.includes("error") ||
    normalized.includes("intercept") ||
    normalized.includes("不可见") ||
    normalized.includes("不存在")
  );
}

export function RpaControls({
  rpaState,
  rpaMessage,
  currentActionsCount,
  controlBusy,
  onPause,
  onRescan,
  onResume,
  onSaveTemplateOpen,
  embedded = false,
}: RpaControlsProps) {
  if (rpaState === "idle") {
    return null;
  }

  const showError = isErrorPause(rpaState, rpaMessage);

  return (
    <div className={embedded ? "space-y-2" : "shrink-0 space-y-2 border-t border-border bg-card px-3 py-2.5"}>
      {showError && rpaMessage ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
          {rpaMessage}
        </div>
      ) : rpaMessage ? (
        <p className="text-[11px] text-muted-foreground">
          状态 · {rpaState}
          {rpaMessage ? ` · ${rpaMessage}` : ""}
        </p>
      ) : null}

      <div className="rounded-md border border-border bg-secondary/20 p-2">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          RPA 录制控制
        </div>
        <div className="flex flex-wrap gap-2">
          {rpaState === "running" ? (
            <button
              type="button"
              className="btn btn-outline px-3 py-1.5 text-xs"
              disabled={controlBusy}
              onClick={onPause}
            >
              <Pause size={13} />
              暂停/手动操作
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-outline px-3 py-1.5 text-xs"
            disabled={controlBusy}
            onClick={onRescan}
          >
            <RefreshCw size={13} />
            重新扫描此页
          </button>
          {rpaState === "paused" ? (
            <button
              type="button"
              className="btn btn-primary px-3 py-1.5 text-xs"
              disabled={controlBusy}
              onClick={onResume}
            >
              继续执行
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-outline px-3 py-1.5 text-xs"
            disabled={controlBusy || currentActionsCount === 0}
            onClick={onSaveTemplateOpen}
          >
            <Save size={13} />
            保存为模板
          </button>
        </div>
      </div>
    </div>
  );
}

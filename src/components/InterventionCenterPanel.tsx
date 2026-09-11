import { Hand, MonitorUp, Play, Square, TriangleAlert, X } from "lucide-react";

import { useInterventionCenter, type BlockedTask } from "./InterventionCenterProvider";

function shortUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return "（无 URL）";
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname}${parsed.pathname.length > 40 ? `${parsed.pathname.slice(0, 37)}…` : parsed.pathname}`;
  } catch {
    return trimmed.length > 48 ? `${trimmed.slice(0, 45)}…` : trimmed;
  }
}

function BlockedCard({
  task,
  busy,
  onGo,
  onResume,
  onAbort,
  onDismiss,
}: {
  task: BlockedTask;
  busy: boolean;
  onGo: () => void;
  onResume: () => void;
  onAbort: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-md border border-amber-500/40 bg-background/95 p-3 shadow-lg backdrop-blur-sm">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-amber-700 dark:text-amber-400">
          <Hand className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">环境 #{task.profileId} 需人工接管</span>
        </div>
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="从队列移除（不中止 Agent）"
          onClick={onDismiss}
          disabled={busy}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mb-1 truncate text-[10px] text-muted-foreground" title={task.url}>
        {shortUrl(task.url)}
      </p>
      <p className="mb-3 line-clamp-3 text-[11px] leading-5 text-foreground">
        {task.reason || "AI 遇到验证码或无法继续，请手动处理后恢复。"}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className="btn btn-outline inline-flex h-7 items-center gap-1 px-2 text-[11px]"
          onClick={onGo}
          disabled={busy}
          title="唤起该环境浏览器到前台"
        >
          <MonitorUp className="h-3 w-3" />
          去处理
        </button>
        <button
          type="button"
          className="btn btn-primary inline-flex h-7 items-center gap-1 px-2 text-[11px]"
          onClick={onResume}
          disabled={busy}
        >
          <Play className="h-3 w-3" />
          {busy ? "…" : "恢复执行"}
        </button>
        <button
          type="button"
          className="btn btn-outline inline-flex h-7 items-center gap-1 px-2 text-[11px] text-destructive"
          onClick={onAbort}
          disabled={busy}
        >
          <Square className="h-3 w-3" />
          中止
        </button>
      </div>
    </div>
  );
}

/** 左下角全局任务接管中心：切 Tab 仍常驻 */
export function InterventionCenterPanel() {
  const { blockedQueue, busyKeys, resumeTask, abortTask, goHandle, dismissTask } =
    useInterventionCenter();

  if (blockedQueue.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-[80] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-300">
        <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
        任务接管中心 · {blockedQueue.length} 个环境阻塞
      </div>
      <div className="pointer-events-auto flex max-h-[min(52vh,420px)] flex-col gap-2 overflow-y-auto pr-0.5">
        {blockedQueue.map((task) => {
          const key = `${task.profileId}::${task.requestId}`;
          return (
            <BlockedCard
              key={key}
              task={task}
              busy={Boolean(busyKeys[key])}
              onGo={() => void goHandle(task)}
              onResume={() => void resumeTask(task)}
              onAbort={() => void abortTask(task)}
              onDismiss={() => dismissTask(task)}
            />
          );
        })}
      </div>
    </div>
  );
}

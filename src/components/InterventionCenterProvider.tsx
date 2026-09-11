import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";

import { createLogger } from "../lib/logger";
import {
  abortAutonomousAgent,
  bringProfileToFront,
  continueAgentHandover,
  formatInvokeError,
} from "../lib/tauri";

const logger = createLogger("InterventionCenter");

/** Milestone 4：全局阻塞任务队列项 */
export interface BlockedTask {
  profileId: string;
  requestId: string;
  url: string;
  reason: string;
  pausedAt: string;
}

interface InterventionCenterValue {
  blockedQueue: BlockedTask[];
  busyKeys: Record<string, boolean>;
  resumeTask: (task: BlockedTask) => Promise<void>;
  abortTask: (task: BlockedTask) => Promise<void>;
  goHandle: (task: BlockedTask) => Promise<void>;
  dismissTask: (task: BlockedTask) => void;
}

const InterventionCenterContext = createContext<InterventionCenterValue | null>(null);

function taskKey(task: Pick<BlockedTask, "profileId" | "requestId">): string {
  return `${task.profileId}::${task.requestId}`;
}

function attachListen<T>(
  eventName: string,
  handler: (event: { payload: T }) => void,
  cancelled: () => boolean,
  unlistenFns: Array<() => void>,
): void {
  void listen<T>(eventName, handler)
    .then((fn) => {
      if (cancelled()) {
        fn();
      } else {
        unlistenFns.push(fn);
      }
    })
    .catch((error) => {
      logger.error(`listen ${eventName} failed`, error);
    });
}

export function InterventionCenterProvider({ children }: { children: ReactNode }) {
  const [blockedQueue, setBlockedQueue] = useState<BlockedTask[]>([]);
  const [busyKeys, setBusyKeys] = useState<Record<string, boolean>>({});

  const upsertBlocked = useCallback((incoming: BlockedTask) => {
    if (!incoming.profileId || !incoming.requestId) {
      return;
    }
    setBlockedQueue((current) => {
      const key = taskKey(incoming);
      const without = current.filter((item) => taskKey(item) !== key);
      return [...without, incoming];
    });
  }, []);

  const removeBlocked = useCallback((profileId: string, requestId?: string | null) => {
    setBlockedQueue((current) => {
      if (!requestId) {
        return current.filter((item) => item.profileId !== profileId);
      }
      return current.filter(
        (item) => !(item.profileId === profileId && item.requestId === requestId),
      );
    });
    // 同步清理 busy 标记，避免僵尸按钮态
    setBusyKeys((current) => {
      const next = { ...current };
      for (const key of Object.keys(next)) {
        if (requestId) {
          if (key === taskKey({ profileId, requestId })) {
            delete next[key];
          }
        } else if (key.startsWith(`${profileId}::`)) {
          delete next[key];
        }
      }
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unlistenFns: Array<() => void> = [];
    const isCancelled = () => cancelled;

    attachListen<{
      profileId?: string;
      requestId?: string;
      url?: string;
      reason?: string;
      pausedAt?: string;
    }>(
      "agent-task-blocked",
      (event) => {
        const profileId = String(event.payload.profileId ?? "").trim();
        const requestId = String(event.payload.requestId ?? "").trim();
        if (!profileId || !requestId) {
          logger.warn("agent-task-blocked missing profileId/requestId, ignored");
          return;
        }
        upsertBlocked({
          profileId,
          requestId,
          url: String(event.payload.url ?? "").trim(),
          reason: String(event.payload.reason ?? "需要人工接管").trim(),
          pausedAt: String(event.payload.pausedAt ?? new Date().toISOString()),
        });
      },
      isCancelled,
      unlistenFns,
    );

    // 兼容：仅收到旧 handover 事件时也入队（IPC/stdout 双路径可能只发其一）
    attachListen<{
      profileId?: string;
      requestId?: string;
      url?: string;
      reason?: string;
      pausedAt?: string;
    }>(
      "agent-handover-required",
      (event) => {
        const profileId = String(event.payload.profileId ?? "").trim();
        const requestId = String(event.payload.requestId ?? "").trim();
        if (!profileId || !requestId) {
          logger.warn("agent-handover-required missing profileId/requestId, ignored");
          return;
        }
        upsertBlocked({
          profileId,
          requestId,
          url: String(event.payload.url ?? "").trim(),
          reason: String(event.payload.reason ?? "需要人工接管").trim(),
          pausedAt: String(event.payload.pausedAt ?? new Date().toISOString()),
        });
      },
      isCancelled,
      unlistenFns,
    );

    attachListen<{
      profileId?: string;
      requestId?: string | null;
      aborted?: boolean;
    }>(
      "agent-task-resumed",
      (event) => {
        const profileId = String(event.payload.profileId ?? "").trim();
        if (!profileId) {
          logger.warn("agent-task-resumed missing profileId, ignored");
          return;
        }
        const requestId = event.payload.requestId
          ? String(event.payload.requestId).trim()
          : null;
        removeBlocked(profileId, requestId);
      },
      isCancelled,
      unlistenFns,
    );

    attachListen<{
      profileId?: string;
      state?: string;
      msg?: string;
    }>(
      "agent-state",
      (event) => {
        const profileId = String(event.payload.profileId ?? "").trim();
        const state = String(event.payload.state ?? "");
        if (!profileId) {
          logger.warn("agent-state missing profileId, ignored");
          return;
        }
        if (
          state === "complete" ||
          state === "failed" ||
          state === "aborted" ||
          state === "stopped"
        ) {
          removeBlocked(profileId, null);
        }
      },
      isCancelled,
      unlistenFns,
    );

    // RPA/Sidecar 异常退出（Phase 1 emit failed）或会话结束：清理僵尸接管项
    attachListen<{
      profileId?: string;
      profile_id?: string;
      state?: string;
    }>(
      "rpa-state",
      (event) => {
        const profileId = String(
          event.payload.profileId ?? event.payload.profile_id ?? "",
        ).trim();
        const state = String(event.payload.state ?? "").toLowerCase();
        if (!profileId) {
          logger.warn("rpa-state missing profileId, ignored");
          return;
        }
        if (
          state === "failed" ||
          state === "aborted" ||
          state === "complete" ||
          state === "stopped" ||
          state === "error"
        ) {
          removeBlocked(profileId, null);
        }
      },
      isCancelled,
      unlistenFns,
    );

    // 浏览器进程已停：接管队列对该环境无意义，一并剔除
    attachListen<{
      profileId?: string;
      status?: string;
    }>(
      "browser-status",
      (event) => {
        const profileId = String(event.payload.profileId ?? "").trim();
        const status = String(event.payload.status ?? "").toLowerCase();
        if (!profileId) {
          logger.warn("browser-status missing profileId, ignored");
          return;
        }
        if (status === "stopped" || status === "exited" || status === "crashed") {
          removeBlocked(profileId, null);
        }
      },
      isCancelled,
      unlistenFns,
    );

    return () => {
      cancelled = true;
      for (const fn of unlistenFns) {
        fn();
      }
    };
  }, [removeBlocked, upsertBlocked]);

  const withBusy = useCallback(async (task: BlockedTask, work: () => Promise<void>) => {
    const key = taskKey(task);
    setBusyKeys((current) => ({ ...current, [key]: true }));
    try {
      await work();
    } finally {
      setBusyKeys((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }, []);

  const resumeTask = useCallback(
    async (task: BlockedTask) => {
      await withBusy(task, async () => {
        await continueAgentHandover(task.profileId, task.requestId);
        removeBlocked(task.profileId, task.requestId);
      });
    },
    [removeBlocked, withBusy],
  );

  const abortTask = useCallback(
    async (task: BlockedTask) => {
      await withBusy(task, async () => {
        await abortAutonomousAgent(task.profileId);
        removeBlocked(task.profileId, task.requestId);
      });
    },
    [removeBlocked, withBusy],
  );

  const goHandle = useCallback(async (task: BlockedTask) => {
    try {
      await bringProfileToFront(task.profileId);
    } catch (error) {
      logger.warn("bring to front failed", formatInvokeError(error));
    }
  }, []);

  const dismissTask = useCallback(
    (task: BlockedTask) => {
      removeBlocked(task.profileId, task.requestId);
    },
    [removeBlocked],
  );

  const value = useMemo(
    () => ({
      blockedQueue,
      busyKeys,
      resumeTask,
      abortTask,
      goHandle,
      dismissTask,
    }),
    [abortTask, blockedQueue, busyKeys, dismissTask, goHandle, resumeTask],
  );

  return (
    <InterventionCenterContext.Provider value={value}>
      {children}
    </InterventionCenterContext.Provider>
  );
}

export function useInterventionCenter(): InterventionCenterValue {
  const ctx = useContext(InterventionCenterContext);
  if (!ctx) {
    throw new Error("useInterventionCenter must be used within InterventionCenterProvider");
  }
  return ctx;
}

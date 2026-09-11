import {
  AtSign,
  Calendar,
  Copy,
  Hash,
  Link2,
  Loader2,
  Lock,
  Mail,
  Phone,
  Square,
  Type,
  Wand2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
  abortAutonomousAgent,
  formatInvokeError,
  isBenignAgentStopError,
  replayAgentTrajectory,
} from "../lib/tauri";
import type {
  AgentTrajectory,
  PlanBatchDataResult,
  Profile,
  SandboxFieldMode,
  SandboxFieldOverride,
  SandboxFormField,
} from "../types";
import { Modal } from "./Modal";

const MAGIC_VARS = [
  { token: "persona.name", label: "人设姓名" },
  { token: "persona.email", label: "人设邮箱" },
  { token: "persona.phone", label: "人设电话" },
  { token: "persona.city", label: "人设城市" },
  { token: "persona.postalCode", label: "人设邮编" },
  { token: "geoip.city", label: "出口城市" },
  { token: "geoip.region", label: "出口省/州" },
  { token: "geoip.country", label: "出口国家" },
  { token: "geoip.countryCode", label: "国家代码" },
  { token: "geoip.exitIp", label: "出口 IP" },
] as const;

interface BatchReplaySandboxProps {
  open: boolean;
  trajectory: AgentTrajectory | null;
  profiles: Profile[];
  busyEnvIds: string[];
  onClose: () => void;
  onError: (message: string) => void;
  onLog: (tone: "info" | "success" | "error" | "warn", text: string) => void;
  onEnvTrajectoryBusy: (profileId: string, busy: boolean) => void;
  /** 并发派发开始（用于列表「执行→停止」与关闭沙盘） */
  onDispatchStart?: (trajectoryId: number) => void;
  /** 并发派发全部结束 */
  onDispatchEnd?: (trajectoryId: number) => void;
}

function parseTrajectoryActions(trajectory: AgentTrajectory): unknown[] {
  try {
    const parsed = JSON.parse(trajectory.actions) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function shortSelector(selector: string, max = 28): string {
  if (selector.length <= max) {
    return selector;
  }
  return `${selector.slice(0, max - 1)}…`;
}

function deriveFieldLabel(step: Record<string, unknown>, selector: string): string {
  // 1) 网关落盘的 semanticLabel（最高优先级）
  const semanticLabel = String(step.semanticLabel ?? "").trim();
  if (semanticLabel) {
    return semanticLabel;
  }
  // 2) 兼容顶层 label
  const topLabel = String(step.label ?? "").trim();
  if (topLabel) {
    return topLabel;
  }
  // 3) semanticContext.label
  const semantic = step.semanticContext;
  if (semantic && typeof semantic === "object") {
    const label = String((semantic as { label?: unknown }).label ?? "").trim();
    if (label) {
      return label;
    }
  }
  // 4) placeholder / aria-label 等可读降级
  for (const key of [
    "name",
    "text",
    "placeholder",
    "ariaLabel",
    "aria-label",
    "dataKey",
    "intent",
    "hint",
  ]) {
    const value = String(step[key] ?? "").trim();
    if (value) {
      return value;
    }
  }
  const nameMatch = selector.match(/name\s*=\s*['"]([^'"]+)['"]/i);
  if (nameMatch?.[1]) {
    return nameMatch[1];
  }
  const placeholderMatch = selector.match(/placeholder\s*=\s*['"]([^'"]+)['"]/i);
  if (placeholderMatch?.[1]) {
    return placeholderMatch[1];
  }
  const ariaMatch = selector.match(/aria-label\s*=\s*['"]([^'"]+)['"]/i);
  if (ariaMatch?.[1]) {
    return ariaMatch[1];
  }
  const idMatch = selector.match(/#([A-Za-z_][\w-]*)/);
  if (idMatch?.[1]) {
    return idMatch[1];
  }
  return shortSelector(selector);
}

function deriveInputType(step: Record<string, unknown>): string | undefined {
  const top = String(step.inputType ?? "").trim();
  if (top) {
    return top.toLowerCase();
  }
  const semantic = step.semanticContext;
  if (semantic && typeof semantic === "object") {
    const typed = String((semantic as { inputType?: unknown }).inputType ?? "").trim();
    if (typed) {
      return typed.toLowerCase();
    }
  }
  return undefined;
}

function deriveSemanticSource(step: Record<string, unknown>): string | undefined {
  const semantic = step.semanticContext;
  if (semantic && typeof semantic === "object") {
    const source = String((semantic as { source?: unknown }).source ?? "").trim();
    return source || undefined;
  }
  return undefined;
}

function pushField(
  out: SandboxFormField[],
  seen: Set<string>,
  key: string,
  label: string,
  recordedValue: string,
  inputType?: string,
  semanticSource?: string,
): void {
  const selector = key.trim();
  if (!selector || seen.has(selector)) {
    return;
  }
  seen.add(selector);
  out.push({
    key: selector,
    label: label.trim() || shortSelector(selector),
    recordedValue: recordedValue.trim(),
    inputType,
    semanticSource,
  });
}

export function extractSandboxFieldsFromActions(actions: unknown[]): SandboxFormField[] {
  const seen = new Set<string>();
  const out: SandboxFormField[] = [];

  for (const raw of actions) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const step = raw as Record<string, unknown>;
    const type = String(step.type ?? step.action ?? step.kind ?? "")
      .trim()
      .toLowerCase();

    if (type === "agent_batch_fill") {
      const fields = Array.isArray(step.fields) ? step.fields : [];
      for (const entry of fields) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const field = entry as Record<string, unknown>;
        const selector = String(field.selector ?? field.key ?? field.short_id ?? "").trim();
        if (!selector) {
          continue;
        }
        pushField(
          out,
          seen,
          selector,
          deriveFieldLabel(field, selector),
          String(field.value ?? ""),
          deriveInputType(field),
          deriveSemanticSource(field),
        );
      }
      continue;
    }

    if (type !== "fill" && type !== "select") {
      continue;
    }
    const selector = String(step.selector ?? "").trim();
    if (!selector) {
      continue;
    }
    pushField(
      out,
      seen,
      selector,
      deriveFieldLabel(step, selector),
      String(step.value ?? step.data ?? ""),
      deriveInputType(step),
      deriveSemanticSource(step),
    );
  }

  return out;
}

function defaultOverride(field: SandboxFormField, mode: SandboxFieldMode = "fixed"): SandboxFieldOverride {
  return {
    mode,
    value: mode === "fixed" ? field.recordedValue : "",
    label: field.label,
    inputType: field.inputType,
  };
}

function emptyOverrides(fields: SandboxFormField[], mode: SandboxFieldMode = "fixed"): Record<string, SandboxFieldOverride> {
  const overrides: Record<string, SandboxFieldOverride> = {};
  for (const field of fields) {
    overrides[field.key] = defaultOverride(field, mode);
  }
  return overrides;
}

function buildInitialPlan(envIds: string[], fields: SandboxFormField[]): PlanBatchDataResult {
  return {
    summary: `语义字段 ${fields.length} 个 · 固定值支持 {{变量}} · AI 盲盒运行时 JIT 生成`,
    planMatrix: envIds.map((envId) => ({
      envId,
      valueOverrides: Object.fromEntries(fields.map((field) => [field.key, field.recordedValue])),
      fieldOverrides: emptyOverrides(fields, "fixed"),
    })),
  };
}

function TypeIcon({ inputType }: { inputType?: string }) {
  const type = (inputType ?? "text").toLowerCase();
  const props = { size: 12 as const, className: "shrink-0 text-muted-foreground" };
  if (type === "email") {
    return <Mail {...props} />;
  }
  if (type === "tel" || type === "phone") {
    return <Phone {...props} />;
  }
  if (type === "password") {
    return <Lock {...props} />;
  }
  if (type === "url") {
    return <Link2 {...props} />;
  }
  if (type === "number" || type === "numeric") {
    return <Hash {...props} />;
  }
  if (type === "date" || type === "datetime-local") {
    return <Calendar {...props} />;
  }
  if (type.includes("mail")) {
    return <AtSign {...props} />;
  }
  return <Type {...props} />;
}

function MagicVariableInput({
  value,
  disabled,
  placeholder,
  aiMode,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  placeholder?: string;
  aiMode?: boolean;
  onChange: (next: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const suggestions = useMemo(() => {
    const q = filter.toLowerCase();
    return MAGIC_VARS.filter(
      (item) => !q || item.token.toLowerCase().includes(q) || item.label.includes(filter),
    );
  }, [filter]);

  const detectMention = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const match = before.match(/\{\{([\w.]*)$/);
    if (!match) {
      setOpen(false);
      setFilter("");
      return;
    }
    setFilter(match[1] ?? "");
    setOpen(true);
    setActiveIndex(0);
  };

  const insertToken = (token: string) => {
    const el = inputRef.current;
    if (!el) {
      onChange(`${value}{{${token}}}`);
      setOpen(false);
      return;
    }
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const replaced = before.replace(/\{\{[\w.]*$/, `{{${token}}}`);
    const next = `${replaced}${after}`;
    onChange(next);
    setOpen(false);
    requestAnimationFrame(() => {
      const pos = replaced.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertToken(suggestions[activeIndex]?.token ?? suggestions[0].token);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative min-w-0 flex-1">
      <input
        ref={inputRef}
        className={`w-full rounded-md border px-2.5 py-1.5 text-xs outline-none ring-primary/20 focus:ring-2 ${
          aiMode
            ? "border-amber-500/50 bg-amber-500/10 text-foreground"
            : "border-border bg-background"
        }`}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next);
          if (!aiMode) {
            detectMention(next, event.target.selectionStart ?? next.length);
          } else {
            setOpen(false);
          }
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 120);
        }}
      />
      {open && !aiMode && suggestions.length > 0 ? (
        <div className="absolute left-0 right-0 z-20 mt-1 max-h-40 overflow-auto rounded-md border border-border bg-background shadow-md">
          {suggestions.map((item, index) => (
            <button
              key={item.token}
              type="button"
              className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[11px] ${
                index === activeIndex ? "bg-primary/10 text-primary" : "hover:bg-secondary/50"
              }`}
              onMouseDown={(event) => {
                event.preventDefault();
                insertToken(item.token);
              }}
            >
              <span className="font-mono">{`{{${item.token}}}`}</span>
              <span className="text-muted-foreground">{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 轨迹反推动态表单沙盘：双模（固定值 / AI 盲盒）+ 魔法变量 + 延迟生成
 */
export function BatchReplaySandbox({
  open,
  trajectory,
  profiles,
  busyEnvIds,
  onClose,
  onError,
  onLog,
  onEnvTrajectoryBusy,
  onDispatchStart,
  onDispatchEnd,
}: BatchReplaySandboxProps) {
  const abortRequestedRef = useRef(false);
  const activeEnvIdsRef = useRef<string[]>([]);
  const trajectoryIdRef = useRef<number | null>(null);

  const [selectedEnvIds, setSelectedEnvIds] = useState<string[]>([]);
  const [activeEnvId, setActiveEnvId] = useState<string>("");
  const [dispatching, setDispatching] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [plan, setPlan] = useState<PlanBatchDataResult | null>(null);
  /** 沙盘内轻提示（字段同步 / 全局工具栏） */
  const [toastText, setToastText] = useState<string | null>(null);

  const runningProfiles = useMemo(
    () => profiles.filter((profile) => profile.status === "running"),
    [profiles],
  );

  const fields = useMemo(() => {
    if (!trajectory) {
      return [];
    }
    return extractSandboxFieldsFromActions(parseTrajectoryActions(trajectory));
  }, [trajectory]);

  const busySet = useMemo(() => new Set(busyEnvIds.map(String)), [busyEnvIds]);

  const activeRow = useMemo(() => {
    if (!plan || !activeEnvId) {
      return null;
    }
    return plan.planMatrix.find((row) => row.envId === activeEnvId) ?? null;
  }, [plan, activeEnvId]);

  useEffect(() => {
    if (!open || !trajectory) {
      return;
    }
    const nextId = trajectory.id;
    if (trajectoryIdRef.current === nextId) {
      return;
    }
    trajectoryIdRef.current = nextId;
    abortRequestedRef.current = false;
    activeEnvIdsRef.current = [];
    setDispatching(false);
    setStopping(false);
    const runningIds = profiles
      .filter((profile) => profile.status === "running")
      .map((profile) => String(profile.id));
    setSelectedEnvIds(runningIds);
    setActiveEnvId(runningIds[0] ?? "");
    const extracted = extractSandboxFieldsFromActions(parseTrajectoryActions(trajectory));
    setPlan(runningIds.length > 0 ? buildInitialPlan(runningIds, extracted) : null);
  }, [open, trajectory, profiles]);

  useEffect(() => {
    if (!open) {
      trajectoryIdRef.current = null;
      setToastText(null);
    }
  }, [open]);

  useEffect(() => {
    if (!toastText) {
      return;
    }
    const timer = window.setTimeout(() => setToastText(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toastText]);

  useEffect(() => {
    if (!open || fields.length === 0) {
      return;
    }
    setPlan((current) => {
      const byEnv = new Map(
        (current?.planMatrix ?? []).map((row) => [row.envId, row] as const),
      );
      return {
        summary:
          current?.summary ??
          `语义字段 ${fields.length} 个 · 固定值支持 {{变量}} · AI 盲盒运行时 JIT 生成`,
        planMatrix: selectedEnvIds.map((envId) => {
          const existing = byEnv.get(envId);
          if (existing?.fieldOverrides) {
            return {
              envId,
              valueOverrides: existing.valueOverrides ?? {},
              fieldOverrides: {
                ...emptyOverrides(fields, "fixed"),
                ...existing.fieldOverrides,
              },
            };
          }
          return {
            envId,
            valueOverrides: Object.fromEntries(fields.map((field) => [field.key, field.recordedValue])),
            fieldOverrides: emptyOverrides(fields, "fixed"),
          };
        }),
      };
    });
    setActiveEnvId((current) =>
      selectedEnvIds.includes(current) ? current : selectedEnvIds[0] ?? "",
    );
  }, [open, selectedEnvIds, fields]);

  const toggleEnv = (id: string) => {
    setSelectedEnvIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const showToast = (text: string) => {
    setToastText(text);
  };

  const patchOverride = (
    envId: string,
    fieldKey: string,
    patch: Partial<SandboxFieldOverride>,
  ) => {
    setPlan((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        planMatrix: current.planMatrix.map((row) => {
          if (row.envId !== envId) {
            return row;
          }
          const field = fields.find((item) => item.key === fieldKey);
          const prev = row.fieldOverrides?.[fieldKey] ?? defaultOverride(field ?? {
            key: fieldKey,
            label: fieldKey,
            recordedValue: "",
          });
          const next: SandboxFieldOverride = {
            ...prev,
            ...patch,
            label: patch.label ?? prev.label ?? field?.label,
            inputType: patch.inputType ?? prev.inputType ?? field?.inputType,
          };
          return {
            ...row,
            fieldOverrides: { ...(row.fieldOverrides ?? {}), [fieldKey]: next },
            valueOverrides: {
              ...(row.valueOverrides ?? {}),
              [fieldKey]: next.value,
            },
          };
        }),
      };
    });
  };

  /**
   * 字段级同步：把当前 Tab 该字段的 value + mode 深拷贝到所有已勾选环境。
   */
  const applyFieldToAllSelected = (fieldKey: string) => {
    if (!plan || !activeEnvId) {
      return;
    }
    if (selectedEnvIds.length <= 1) {
      showToast("当前仅勾选一个环境，无需同步");
      return;
    }
    const sourceRow = plan.planMatrix.find((row) => row.envId === activeEnvId);
    const field = fields.find((item) => item.key === fieldKey);
    const source =
      sourceRow?.fieldOverrides?.[fieldKey] ??
      (field ? defaultOverride(field, "fixed") : null);
    if (!source) {
      return;
    }
    const snapshot: SandboxFieldOverride = {
      mode: source.mode,
      value: source.value,
      label: source.label ?? field?.label,
      inputType: source.inputType ?? field?.inputType,
    };
    const selectedSet = new Set(selectedEnvIds);
    setPlan((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        planMatrix: current.planMatrix.map((row) => {
          if (!selectedSet.has(row.envId)) {
            return row;
          }
          return {
            ...row,
            fieldOverrides: {
              ...(row.fieldOverrides ?? {}),
              [fieldKey]: { ...snapshot },
            },
            valueOverrides: {
              ...(row.valueOverrides ?? {}),
              [fieldKey]: snapshot.value,
            },
          };
        }),
      };
    });
    showToast("该字段已同步至所有选中的环境");
  };

  /** 全局工具栏：穿透所有已勾选环境（planMatrix 内选中行） */
  const setAllModes = (mode: SandboxFieldMode) => {
    const selectedSet = new Set(selectedEnvIds);
    setPlan((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        summary:
          mode === "ai_prompt"
            ? "全部字段已开启 AI 盲盒（运行时 JIT · fast_text）· 已应用到所有选中环境"
            : "全部字段已设为固定值（支持 {{persona.*}} / {{geoip.*}}）· 已应用到所有选中环境",
        planMatrix: current.planMatrix.map((row) => {
          if (!selectedSet.has(row.envId)) {
            return row;
          }
          const fieldOverrides: Record<string, SandboxFieldOverride> = {};
          for (const field of fields) {
            const prev = row.fieldOverrides?.[field.key];
            fieldOverrides[field.key] = {
              mode,
              value:
                mode === "ai_prompt"
                  ? prev?.mode === "ai_prompt"
                    ? prev.value
                    : ""
                  : prev?.value || field.recordedValue,
              label: field.label,
              inputType: field.inputType,
            };
          }
          return {
            ...row,
            fieldOverrides,
            valueOverrides: Object.fromEntries(
              Object.entries(fieldOverrides).map(([key, spec]) => [key, spec.value]),
            ),
          };
        }),
      };
    });
    showToast(
      mode === "ai_prompt"
        ? `已为 ${selectedEnvIds.length} 个选中环境开启 AI 盲盒`
        : `已为 ${selectedEnvIds.length} 个选中环境设为固定值`,
    );
  };

  const handleStopDispatch = async () => {
    if (!dispatching || stopping) {
      return;
    }
    abortRequestedRef.current = true;
    setStopping(true);
    const targets = [...activeEnvIdsRef.current];
    onLog("info", `正在停止多环境回放 · ${targets.length} 个环境…`);
    await Promise.allSettled(
      targets.map(async (envId) => {
        try {
          await abortAutonomousAgent(envId);
        } catch (error) {
          if (!isBenignAgentStopError(error)) {
            onLog("warn", `环境 #${envId} 停止指令：${formatInvokeError(error)}`);
          }
        }
      }),
    );
  };

  const handleDispatch = async () => {
    if (!trajectory || !plan || plan.planMatrix.length === 0) {
      onError("请先勾选环境并确认字段值");
      return;
    }
    if (fields.length === 0) {
      onError("该轨迹没有 fill / agent_batch_fill 字段");
      return;
    }
    if (dispatching) {
      return;
    }

    const trajectoryId = trajectory.id;
    const preBusy = new Set(busyEnvIds.map(String));
    abortRequestedRef.current = false;
    activeEnvIdsRef.current = [];
    setDispatching(true);
    setStopping(false);
    onError("");
    onDispatchStart?.(trajectoryId);
    // 启动后立刻关沙盘，回放进度看列表「停止」与回放日志
    onClose();
    onLog("info", `▶ 并发派发「${trajectory.title}」· ${plan.planMatrix.length} 环境（延迟生成）`);

    const actions = parseTrajectoryActions(trajectory);
    try {
      const settled = await Promise.allSettled(
        plan.planMatrix.map(async (row) => {
          const envId = String(row.envId);
          const profile = profiles.find((item) => String(item.id) === envId);
          if (!profile || profile.status !== "running") {
            onLog("warn", `环境 #${envId} 未运行，已跳过`);
            return { envId, skipped: true as const, stopped: false, ok: false };
          }
          if (preBusy.has(envId)) {
            onLog("warn", `环境 #${envId} 正忙，已跳过`);
            return { envId, skipped: true as const, stopped: false, ok: false };
          }
          if (abortRequestedRef.current) {
            return { envId, skipped: true as const, stopped: true, ok: false };
          }

          activeEnvIdsRef.current = [...activeEnvIdsRef.current, envId];
          onEnvTrajectoryBusy(envId, true);
          try {
            const fieldOverrides = row.fieldOverrides ?? emptyOverrides(fields, "fixed");
            const result = await replayAgentTrajectory(envId, {
              filePath: trajectory.file_path,
              actions: trajectory.file_path ? null : actions,
              title: `${trajectory.title} · #${envId}`,
              goal: trajectory.goal || trajectory.title,
              valueOverrides: fieldOverrides,
            });
            const msg = result.msg || "";
            const stopped =
              abortRequestedRef.current ||
              (result.state === "failed" && isBenignAgentStopError(msg));
            const ok = result.state === "complete";
            if (stopped) {
              onLog("info", `环境 #${envId} 回放已停止`);
              return { envId, skipped: false as const, stopped: true, ok: false };
            }
            onLog(
              ok ? "success" : "error",
              ok
                ? `环境 #${envId} 回放成功：${msg || `共 ${result.step} 步`}`
                : `环境 #${envId} 回放结束：${msg || result.state}`,
            );
            return { envId, skipped: false as const, stopped: false, ok };
          } catch (error) {
            const message = formatInvokeError(error);
            if (
              isBenignAgentStopError(error) ||
              isBenignAgentStopError(message) ||
              abortRequestedRef.current
            ) {
              onLog("info", `环境 #${envId} 回放已停止`);
              return { envId, skipped: false as const, stopped: true, ok: false };
            }
            onLog("error", `环境 #${envId} 回放失败：${message}`);
            throw error;
          } finally {
            onEnvTrajectoryBusy(envId, false);
            activeEnvIdsRef.current = activeEnvIdsRef.current.filter((id) => id !== envId);
          }
        }),
      );

      let okCount = 0;
      let skipCount = 0;
      let failCount = 0;
      let stopCount = 0;
      for (const item of settled) {
        if (item.status === "rejected") {
          failCount += 1;
          onLog("error", `派发异常：${formatInvokeError(item.reason)}`);
          continue;
        }
        if (item.value.skipped) {
          if (item.value.stopped) {
            stopCount += 1;
          } else {
            skipCount += 1;
          }
        } else if (item.value.stopped) {
          stopCount += 1;
        } else if (item.value.ok) {
          okCount += 1;
        } else {
          failCount += 1;
        }
      }

      onLog(
        failCount > 0 ? "warn" : "success",
        `并发派发结束 · 成功 ${okCount} · 跳过 ${skipCount} · 停止 ${stopCount} · 失败 ${failCount}`,
      );
    } finally {
      abortRequestedRef.current = false;
      activeEnvIdsRef.current = [];
      setStopping(false);
      setDispatching(false);
      onDispatchEnd?.(trajectoryId);
    }
  };

  if (!trajectory) {
    return null;
  }

  const locked = dispatching;

  return (
    <Modal
      open={open}
      title="多环境数据沙盘"
      description={`轨迹：${trajectory.title} · ${fields.length} 个语义字段 · 延迟生成 / 变量注入`}
      onClose={() => {
        if (!locked) {
          onClose();
        }
      }}
      widthClass="max-w-3xl"
      layer="elevated"
    >
      <div className="relative flex max-h-[78vh] flex-col gap-3 overflow-hidden">
        {toastText ? (
          <div
            role="status"
            className="pointer-events-none absolute left-1/2 top-0 z-[60] -translate-x-1/2 rounded-md border border-border bg-card px-3 py-1.5 text-[11px] font-medium text-foreground shadow-md"
          >
            {toastText}
          </div>
        ) : null}
        <div className="shrink-0 space-y-2">
          <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            目标环境（运行中）
          </label>
          {runningProfiles.length === 0 ? (
            <p className="text-xs text-muted-foreground">暂无运行中的环境，请先在左侧启动浏览器。</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {runningProfiles.map((profile) => {
                const id = String(profile.id);
                const checked = selectedEnvIds.includes(id);
                const busy = busySet.has(id);
                return (
                  <label
                    key={id}
                    className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${
                      checked ? "border-primary bg-primary/10 text-primary" : "border-border"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={locked}
                      onChange={() => toggleEnv(id)}
                    />
                    #{id}
                    {profile.name ? ` · ${profile.name}` : ""}
                    {busy ? " · 忙" : ""}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {selectedEnvIds.length > 0 ? (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border pb-2">
            {selectedEnvIds.map((id) => {
              const active = id === activeEnvId;
              return (
                <button
                  key={id}
                  type="button"
                  disabled={locked}
                  className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-secondary/40"
                  }`}
                  onClick={() => setActiveEnvId(id)}
                >
                  环境 #{id}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-outline px-3 py-2 text-xs"
            disabled={locked || fields.length === 0}
            onClick={() => setAllModes("fixed")}
          >
            全部设为固定值
          </button>
          <button
            type="button"
            className="btn btn-outline px-3 py-2 text-xs"
            disabled={locked || fields.length === 0}
            onClick={() => setAllModes("ai_prompt")}
          >
            <Wand2 size={13} />
            全部开启 AI 盲盒
          </button>
          {dispatching ? (
            <button
              type="button"
              className="btn px-3 py-2 text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={stopping}
              onClick={() => void handleStopDispatch()}
            >
              {stopping ? <Loader2 size={13} className="animate-spin" /> : <Square size={13} />}
              {stopping ? "停止中…" : "停止派发"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary px-3 py-2 text-xs"
              disabled={locked || !plan || plan.planMatrix.length === 0 || fields.length === 0}
              onClick={() => void handleDispatch()}
            >
              确认并并发启动
            </button>
          )}
        </div>

        {fields.length === 0 ? (
          <p className="text-[11px] leading-5 text-muted-foreground">
            该轨迹没有 fill / select / agent_batch_fill 步骤。请用 Agent 重新录制（新录制会写入 semanticContext）。
          </p>
        ) : !activeEnvId || !activeRow ? (
          <p className="text-[11px] leading-5 text-muted-foreground">
            请勾选至少一个运行中的环境以编辑字段。
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border">
            <div className="shrink-0 border-b border-border bg-secondary/40 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
              {plan?.summary} · 编辑{" "}
              <span className="font-medium text-foreground">#{activeEnvId}</span>
              。固定值可输入 <code className="rounded bg-background px-1">{`{{geoip.city}}`}</code>；勾选 AI
              盲盒后，填表前一秒由 fast_text 生成。
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
              {fields.map((field) => {
                const override =
                  activeRow.fieldOverrides?.[field.key] ?? defaultOverride(field, "fixed");
                const aiMode = override.mode === "ai_prompt";
                return (
                  <div
                    key={field.key}
                    className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(8rem,10.5rem)_minmax(0,1fr)_auto_auto]"
                  >
                    <div className="flex min-w-0 items-start gap-1.5" title={field.key}>
                      <TypeIcon inputType={field.inputType ?? override.inputType} />
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-foreground">{field.label}</div>
                        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                          {field.inputType ? `${field.inputType} · ` : ""}
                          {field.semanticSource ? `${field.semanticSource} · ` : ""}
                          {shortSelector(field.key, 22)}
                        </div>
                      </div>
                    </div>
                    <MagicVariableInput
                      value={override.value}
                      disabled={locked}
                      aiMode={aiMode}
                      placeholder={
                        aiMode
                          ? "留空按 Label 自动生成，或输入具体指令 (如: 生成 44 开头的手机号)"
                          : `固定值，可插入 {{persona.name}} / {{geoip.city}}`
                      }
                      onChange={(next) => patchOverride(activeEnvId, field.key, { value: next })}
                    />
                    <label
                      className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] ${
                        aiMode
                          ? "border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                          : "border-border text-muted-foreground"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={aiMode}
                        disabled={locked}
                        onChange={(event) =>
                          patchOverride(activeEnvId, field.key, {
                            mode: event.target.checked ? "ai_prompt" : "fixed",
                            value: event.target.checked
                              ? override.mode === "ai_prompt"
                                ? override.value
                                : ""
                              : override.value || field.recordedValue,
                          })
                        }
                      />
                      AI 自动生成
                    </label>
                    <button
                      type="button"
                      className="btn btn-outline h-8 shrink-0 gap-1 px-2 text-[10px] text-muted-foreground hover:text-primary"
                      disabled={locked || selectedEnvIds.length <= 1}
                      title="将当前字段的值与模式同步到所有已勾选环境"
                      aria-label="应用到全部选中环境"
                      onClick={() => applyFieldToAllSelected(field.key)}
                    >
                      <Copy size={12} />
                      <span className="hidden sm:inline">应用到全部</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

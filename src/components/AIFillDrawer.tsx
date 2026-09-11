import {
  Bot,
  History,
  PenLine,
  Play,
  Sparkles,
  Square,
  Wand2,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { extractFillDataTextFromReply, extractJsonFromAiReply, normalizeFillInputForExecution } from "../lib/aiReplyJson";
import {
  resolveAgentTargets,
  resolveAgentMaxAllowed,
  normalizeAgentGoalKey,
  type AgentRouteMode,
  type AgentSeatPolicy,
} from "../lib/agentGoalRouter";
import {
  aiBlockedKernelMessage,
  isAiBlockedForKernel,
} from "../lib/kernelPolicy";
import {
  buildPendingHuman,
  formatAgentRouteBadge,
  mergeConfirmActions,
  mergeFillValues,
  mergeIntoActiveCohort,
  takeNextHumanCohort,
  type PendingAgentHuman,
} from "../lib/agentHumanQueue";
import { buildChatHistoryFromLines } from "../lib/chat_history";
import { normalizeScrapedRows } from "../lib/csvExport";
import { domainMatchesTemplate, normalizeDomain } from "../lib/domain";
import { createLogger } from "../lib/logger";
import {
  fetchTemplatesByDomain,
  formatInvokeError,
  focusProfileBrowser,
  getProfilePageUrl,
  checkLicenseEntitlement,
  getCloakBinaryStatus,
  fetchSettings,
  isBenignAgentStopError,
  listAgentTrajectories,
  deleteAgentTrajectory,
  previewAiFill,
  runDirectFill,
  runSmartFill,
  runRpaFill,
  replayAgentTrajectory,
  sendAiChat,
  startAutonomousAgent,
  confirmAgentAction,
  cancelAgentAction,
  replyAgentAsk,
  continueAgentHandover,
  abortAutonomousAgent,
} from "../lib/tauri";
import type {
  AgentTrajectory,
  CloakBinaryStatus,
  FormTemplate,
  Profile,
  RpaAction,
  RpaStatePayload,
  TerminalLine,
} from "../types";
import { resolveTaskModel } from "../types";
import { AIChatPanel } from "./AIChatPanel";
import { AgentConfirmModal, type AgentConfirmActionRow } from "./AgentConfirmModal";
import { AgentHandoverModal } from "./AgentHandoverModal";
import { ScraperDataPanel } from "./ScraperDataPanel";
import { useAppDialog } from "./AppDialogProvider";
import { FillConfirmModal } from "./FillConfirmModal";
import { AgentThoughtChain } from "./AgentThoughtChain";
import { TrajectoryMemoryPanel } from "./TrajectoryMemoryPanel";
import { inferAgentLineKind } from "../lib/agentThoughtChain";

const logger = createLogger("AIFillDrawer");

interface AIFillDrawerProps {
  profiles: Profile[];
  selectedIds: string[];
  busyIds?: string[];
  lines: TerminalLine[];
  onLog: (line: TerminalLine) => void;
  onError: (message: string) => void;
  /** 控制浏览器启动（与 Agent 启停分离）；返回 false 表示失败 */
  onStartBrowser?: (profileId: string) => void | Promise<void | boolean>;
  /** 控制浏览器停止 */
  onStopBrowser?: (profileId: string) => void | Promise<void | boolean>;
}

interface QuickCommand {
  id: string;
  label: string;
  prompt: string;
  fillOnly?: boolean;
}

type DrawerTab = "agent" | "ai" | "trajectory";

const QUICK_COMMANDS_STORAGE_KEY = "cloakforge-quick-commands";
/** Agent 轨迹录制偏好：默认关闭，勾选后写入 localStorage */
const AGENT_ENABLE_RECORDING_KEY = "cloakforge-agent-enable-recording";

const BUILTIN_QUICK_COMMANDS: QuickCommand[] = [
  {
    id: "form-json-template",
    label: "提取表单 JSON",
    prompt:
      "请调用 get_interactive_elements 工具扫描当前页面的交互元素。将所有可填写的 input/select/textarea 整理成一个标准的 JSON 填表键值对模板发给我。所有的 value 请留空，只需确保 key (name/id 属性) 与页面绝对一致。",
  },
  {
    id: "form-fraud-audit",
    label: "风控字段排查",
    prompt:
      '请调用 get_page_form_schema 工具扫描当前页面表单，帮我进行自动化填表的风控排查。列出所有 type="hidden" 的隐藏字段，并告诉我哪些字段是必须由浏览器 JavaScript 动态生成的（比如带有 token、hash、signature 字眼的字段，或工具返回 likelyDynamic 为 true 的字段），千万不要把这些字段加到你给我的常规 JSON 填表模板里，防止触发机器校验。',
  },
];

function pickFillProfileId(profiles: Profile[], selectedIds: string[]): string | null {
  const runningSelected = selectedIds.find((id) => {
    const profile = profiles.find((item) => String(item.id) === id);
    return profile?.status === "running";
  });
  if (runningSelected) {
    return runningSelected;
  }
  const firstRunning = profiles.find((profile) => profile.status === "running");
  return firstRunning ? String(firstRunning.id) : selectedIds[0] ?? null;
}

function loadAgentEnableRecording(): boolean {
  try {
    return localStorage.getItem(AGENT_ENABLE_RECORDING_KEY) === "true";
  } catch {
    return false;
  }
}

function persistAgentEnableRecording(enabled: boolean): void {
  try {
    localStorage.setItem(AGENT_ENABLE_RECORDING_KEY, enabled ? "true" : "false");
  } catch {
    /* ignore quota / private mode */
  }
}

function loadCustomQuickCommands(): QuickCommand[] {
  try {
    const raw = localStorage.getItem(QUICK_COMMANDS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as QuickCommand[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item) =>
        typeof item.id === "string" &&
        typeof item.label === "string" &&
        typeof item.prompt === "string" &&
        item.label.trim() &&
        item.prompt.trim(),
    );
  } catch {
    return [];
  }
}

function saveCustomQuickCommands(commands: QuickCommand[]) {
  localStorage.setItem(QUICK_COMMANDS_STORAGE_KEY, JSON.stringify(commands));
}

function formatPreviewJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function buildDirectPreviewJson(rawInput: string): string {
  const extracted = extractJsonFromAiReply(rawInput);
  if (extracted) {
    return JSON.stringify(extracted, null, 2);
  }
  return rawInput.trim();
}

function parseTemplateActions(raw: string): RpaAction[] {
  try {
    const parsed = JSON.parse(raw) as RpaAction[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sortTemplatesForDomain(templates: FormTemplate[], domain: string): FormTemplate[] {
  return [...templates].sort((left, right) => {
    const leftMatch = domainMatchesTemplate(domain, left.domain);
    const rightMatch = domainMatchesTemplate(domain, right.domain);
    if (leftMatch !== rightMatch) {
      return leftMatch ? -1 : 1;
    }
    if (left.auto_apply !== right.auto_apply) {
      return left.auto_apply ? -1 : 1;
    }
    return right.created_at.localeCompare(left.created_at);
  });
}

export function AIFillDrawer({
  profiles,
  selectedIds,
  busyIds = [],
  lines,
  onLog,
  onError,
  onStartBrowser,
  onStopBrowser,
}: AIFillDrawerProps) {
  const { prompt, confirm } = useAppDialog();
  const [activeTab, setActiveTab] = useState<DrawerTab>("agent");
  /** Tab 输入与提交态隔离，避免交叉污染 */
  const [aiRawInput, setAiRawInput] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [agentGoal, setAgentGoal] = useState("");
  /** 是否落盘执行轨迹（沙盘回放）；默认关，偏好记入 localStorage */
  const [enableRecording, setEnableRecording] = useState(loadAgentEnableRecording);
  /** 按环境隔离的 Agent 监控日志，切换左侧环境时无缝切换 */
  const [agentLinesByEnv, setAgentLinesByEnv] = useState<Record<string, TerminalLine[]>>({});
  /** 按环境隔离的爬虫采集结果 */
  const [scrapedDataByEnv, setScrapedDataByEnv] = useState<
    Record<
      string,
      {
        rows: Array<Record<string, unknown>>;
        mode?: string;
        url?: string;
        count?: number;
        localPath?: string;
      }
    >
  >({});
  const [aiSubmitting, setAiSubmitting] = useState(false);
  const [directFillSubmitting, setDirectFillSubmitting] = useState(false);
  const [smartFillSubmitting, setSmartFillSubmitting] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [quickMenuOpen, setQuickMenuOpen] = useState(false);
  const [customCommands, setCustomCommands] = useState<QuickCommand[]>(() => loadCustomQuickCommands());
  const [skipHybrid, setSkipHybrid] = useState(false);
  const [forceHumanConfirm, setForceHumanConfirm] = useState(true);
  const [pressEnterAfterFill, setPressEnterAfterFill] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmJson, setConfirmJson] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [templates, setTemplates] = useState<FormTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | "">("");
  const [currentDomain, setCurrentDomain] = useState("");
  const [autoTrust, setAutoTrust] = useState(false);
  const [currentActions, setCurrentActions] = useState<RpaAction[]>([]);
  const [, setRpaState] = useState<"idle" | "running" | "paused" | "complete">("idle");
  const [, setRpaMessage] = useState("");
  const [agentBusyEnvIds, setAgentBusyEnvIds] = useState<string[]>([]);
  const [rpaBusyEnvIds, setRpaBusyEnvIds] = useState<string[]>([]);
  const [agentConfirmOpen, setAgentConfirmOpen] = useState(false);
  const [agentConfirmLoading, setAgentConfirmLoading] = useState(false);
  const [, setAgentConfirmRequestId] = useState("");
  const [agentConfirmUrl, setAgentConfirmUrl] = useState("");
  const [agentConfirmReason, setAgentConfirmReason] = useState("");
  const [agentConfirmActions, setAgentConfirmActions] = useState<AgentConfirmActionRow[]>([]);
  const [agentFillValues, setAgentFillValues] = useState<Record<string, string>>({});
  const [agentHandoverOpen, setAgentHandoverOpen] = useState(false);
  const [agentHandoverLoading, setAgentHandoverLoading] = useState(false);
  const [, setAgentHandoverRequestId] = useState("");
  const [agentHandoverUrl, setAgentHandoverUrl] = useState("");
  const [agentHandoverReason, setAgentHandoverReason] = useState("");
  const [trajectories, setTrajectories] = useState<AgentTrajectory[]>([]);
  const [selectedTrajectoryId, setSelectedTrajectoryId] = useState<number | null>(null);
  const [trajectoryBusyEnvIds, setTrajectoryBusyEnvIds] = useState<string[]>([]);
  const [executingTrajectoryId, setExecutingTrajectoryId] = useState<number | null>(null);
  /** 回放专用日志（与 Agent Monitor 分流） */
  const [replayLinesByEnv, setReplayLinesByEnv] = useState<Record<string, TerminalLine[]>>({});
  /** 多环境回放时合并展示的环境（派发结束后仍保留，直到清空日志） */
  const [replayWatchEnvIds, setReplayWatchEnvIds] = useState<string[]>([]);
  const trajectoryBusyEnvIdsRef = useRef<string[]>([]);
  /** Current Agent fan-out batch (broadcast / named). */
  const [agentBatchIds, setAgentBatchIds] = useState<string[]>([]);
  const [agentRouteMode, setAgentRouteMode] = useState<AgentRouteMode | "idle">("idle");
  const [agentGoalByEnv, setAgentGoalByEnv] = useState<Record<string, string>>({});
  const [activeHumanCohort, setActiveHumanCohort] = useState<PendingAgentHuman[]>([]);
  const [humanCohortLabel, setHumanCohortLabel] = useState("");
  const [agentSeatPolicy, setAgentSeatPolicy] = useState<AgentSeatPolicy>({ isPro: false, seatLimit: 1 });
  const [agentSeatsSummary, setAgentSeatsSummary] = useState("");
  const quickMenuRef = useRef<HTMLDivElement>(null);
  const pendingHumanRef = useRef<PendingAgentHuman[]>([]);
  const activeHumanCohortRef = useRef<PendingAgentHuman[]>([]);
  const humanGateBusyRef = useRef(false);
  const agentGoalByEnvRef = useRef<Record<string, string>>({});
  const drainHumanQueueRef = useRef<() => void>(() => undefined);

  const targetProfileId = useMemo(
    () => pickFillProfileId(profiles, selectedIds),
    [profiles, selectedIds],
  );

  const targetProfile = useMemo(
    () => profiles.find((profile) => String(profile.id) === targetProfileId) ?? null,
    [profiles, targetProfileId],
  );
  const browserRunning = targetProfile?.status === "running";
  const anyAgentBusy = agentBusyEnvIds.length > 0;
  const agentBusy = Boolean(targetProfileId && agentBusyEnvIds.includes(targetProfileId));
  const rpaBusy = Boolean(targetProfileId && rpaBusyEnvIds.includes(targetProfileId));
  const trajectoryBusy = Boolean(
    targetProfileId && trajectoryBusyEnvIds.includes(targetProfileId),
  );
  /** 与 Sidecar 引擎互斥对齐：Agent / RPA 填表 / 轨迹回放 */
  const envExecuting = agentBusy || rpaBusy || trajectoryBusy;
  const envBusyReason = agentBusy
    ? "Agent 运行中"
    : trajectoryBusy
      ? "轨迹回放中"
      : rpaBusy
        ? "RPA 填表中"
        : "";
  const runningProfileIds = useMemo(
    () => profiles.filter((profile) => profile.status === "running").map((profile) => String(profile.id)),
    [profiles],
  );
  const selectedRunningIds = useMemo(
    () => selectedIds.filter((id) => runningProfileIds.includes(id)),
    [runningProfileIds, selectedIds],
  );
  const agentMaxAllowed = useMemo(() => resolveAgentMaxAllowed(agentSeatPolicy), [agentSeatPolicy]);
  const agentRouteBadge = useMemo(
    () => formatAgentRouteBadge(agentRouteMode, agentBatchIds, targetProfileId),
    [agentBatchIds, agentRouteMode, targetProfileId],
  );

  const refreshAgentSeatPolicy = useCallback(async () => {
    try {
      const [entitlement, settings] = await Promise.all([checkLicenseEntitlement(), fetchSettings()]);
      let status: CloakBinaryStatus | null = null;
      try {
        status = await getCloakBinaryStatus(settings.cloak_license_key);
      } catch {
        status = null;
      }
      const isPro = Boolean(
        (entitlement.isPro && entitlement.isValid) ||
          status?.tier === "pro" ||
          (status?.licenseValid && String(status.licensePlan ?? "").toLowerCase().includes("pro")),
      );
      const seatLimit =
        typeof status?.sessionSeatsLimit === "number" && status.sessionSeatsLimit > 0
          ? status.sessionSeatsLimit
          : isPro
            ? null
            : 1;
      const policy: AgentSeatPolicy = { isPro, seatLimit };
      setAgentSeatPolicy(policy);
      // 不把 CloakBrowser 内核会话 active/limit 标成「AI席位」（易被理解成不能多开浏览器）
      const aiCap = resolveAgentMaxAllowed(policy);
      if (!isPro) {
        setAgentSeatsSummary("AI并行≤1 · 内核免费档并发=1");
      } else if (aiCap != null) {
        setAgentSeatsSummary(`AI并行≤${aiCap} · 内核并发≤${aiCap}`);
      } else {
        setAgentSeatsSummary("Pro · AI/内核并发跟席位");
      }
      return policy;
    } catch {
      const fallback: AgentSeatPolicy = { isPro: false, seatLimit: 1 };
      setAgentSeatPolicy(fallback);
      setAgentSeatsSummary("AI并行≤1 · 内核免费档并发=1");
      return fallback;
    }
  }, []);

  useEffect(() => {
    void refreshAgentSeatPolicy();
  }, [refreshAgentSeatPolicy]);

  const allBusyEnvIds = useMemo(() => {
    const set = new Set<string>([
      ...agentBusyEnvIds,
      ...rpaBusyEnvIds,
      ...trajectoryBusyEnvIds,
    ]);
    return [...set];
  }, [agentBusyEnvIds, rpaBusyEnvIds, trajectoryBusyEnvIds]);

  const browserTargetIds = useMemo(
    () => (selectedIds.length > 0 ? selectedIds : targetProfileId ? [targetProfileId] : []),
    [selectedIds, targetProfileId],
  );
  const selectedStoppedCount = useMemo(
    () =>
      browserTargetIds.filter((id) => {
        const profile = profiles.find((item) => String(item.id) === id);
        return profile != null && profile.status !== "running";
      }).length,
    [browserTargetIds, profiles],
  );
  const selectedRunningCount = useMemo(
    () =>
      browserTargetIds.filter((id) => {
        const profile = profiles.find((item) => String(item.id) === id);
        return profile?.status === "running";
      }).length,
    [browserTargetIds, profiles],
  );
  const browserTargetsBusy = useMemo(
    () => browserTargetIds.some((id) => busyIds.includes(id)),
    [browserTargetIds, busyIds],
  );

  const smartFillEnabled =
    targetProfile?.status === "running" &&
    targetProfile.interactive_element_extract_enabled === true;

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  );

  const quickCommands = useMemo(
    () => [...BUILTIN_QUICK_COMMANDS, ...customCommands],
    [customCommands],
  );

  const pushLine = useCallback(
    (tone: TerminalLine["tone"], text: string, role?: TerminalLine["role"]) => {
      onLog({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toLocaleTimeString(),
        tone,
        text,
        role,
      });
    },
    [onLog],
  );

  const agentLines = useMemo(() => {
    const ids =
      agentBatchIds.length > 0
        ? agentBatchIds
        : anyAgentBusy
          ? agentBusyEnvIds
          : targetProfileId
            ? [targetProfileId]
            : [];
    if (ids.length === 0) {
      return [];
    }
    if (ids.length === 1) {
      return agentLinesByEnv[ids[0]] ?? [];
    }
    const merged: TerminalLine[] = [];
    for (const id of ids) {
      for (const line of agentLinesByEnv[id] ?? []) {
        const prefix = `#${id} · `;
        merged.push({
          ...line,
          text: line.text.startsWith(prefix) ? line.text : `${prefix}${line.text}`,
        });
      }
    }
    return merged.sort((left, right) => left.id.localeCompare(right.id));
  }, [agentBatchIds, agentBusyEnvIds, agentLinesByEnv, anyAgentBusy, targetProfileId]);
  const scrapedData = targetProfileId ? scrapedDataByEnv[targetProfileId] ?? null : null;

  useEffect(() => {
    agentGoalByEnvRef.current = agentGoalByEnv;
  }, [agentGoalByEnv]);

  useEffect(() => {
    trajectoryBusyEnvIdsRef.current = trajectoryBusyEnvIds;
  }, [trajectoryBusyEnvIds]);

  useEffect(() => {
    activeHumanCohortRef.current = activeHumanCohort;
  }, [activeHumanCohort]);

  const pushAgentLineFor = useCallback(
    (
      profileId: string,
      tone: TerminalLine["tone"],
      text: string,
      extra?: Pick<TerminalLine, "kind" | "meta">,
    ) => {
      if (!profileId) {
        return;
      }
      setAgentLinesByEnv((current) => ({
        ...current,
        [profileId]: [
          ...(current[profileId] ?? []),
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            ts: new Date().toLocaleTimeString(),
            tone,
            text,
            kind: extra?.kind,
            meta: extra?.meta,
          },
        ].slice(-400),
      }));
    },
    [],
  );

  const pushReplayLineFor = useCallback((profileId: string, tone: TerminalLine["tone"], text: string) => {
    if (!profileId) {
      return;
    }
    const cleaned = String(text ?? "")
      .replace(/\u001b\[[0-9;]*m/g, "")
      .replace(/\x1b\[[0-9;]*m/g, "")
      .trim();
    if (!cleaned) {
      return;
    }
    setReplayLinesByEnv((current) => ({
      ...current,
      [profileId]: [
        ...(current[profileId] ?? []),
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ts: new Date().toLocaleTimeString(),
          tone,
          text: cleaned,
        },
      ].slice(-400),
    }));
  }, []);

  const pushAgentLine = useCallback(
    (tone: TerminalLine["tone"], text: string) => {
      if (!targetProfileId) {
        return;
      }
      pushAgentLineFor(targetProfileId, tone, text);
    },
    [pushAgentLineFor, targetProfileId],
  );

  const pushReplayLine = useCallback(
    (tone: TerminalLine["tone"], text: string) => {
      if (!targetProfileId) {
        return;
      }
      pushReplayLineFor(targetProfileId, tone, text);
    },
    [pushReplayLineFor, targetProfileId],
  );

  const replayLines = useMemo(() => {
    const ids = [
      ...new Set([
        ...(targetProfileId ? [targetProfileId] : []),
        ...trajectoryBusyEnvIds,
        ...replayWatchEnvIds,
      ]),
    ];
    if (ids.length === 0) {
      return [];
    }
    if (ids.length === 1) {
      return replayLinesByEnv[ids[0]] ?? [];
    }
    const merged: TerminalLine[] = [];
    for (const id of ids) {
      for (const line of replayLinesByEnv[id] ?? []) {
        const prefix = `[#${id}] `;
        merged.push({
          ...line,
          text: line.text.startsWith(prefix) ? line.text : `${prefix}${line.text}`,
        });
      }
    }
    return merged.sort((left, right) => left.id.localeCompare(right.id));
  }, [replayLinesByEnv, replayWatchEnvIds, targetProfileId, trajectoryBusyEnvIds]);

  const closeHumanModals = useCallback(() => {
    setAgentConfirmOpen(false);
    setAgentHandoverOpen(false);
    setActiveHumanCohort([]);
    activeHumanCohortRef.current = [];
    setHumanCohortLabel("");
    humanGateBusyRef.current = false;
  }, []);

  const drainHumanQueue = useCallback(() => {
    if (humanGateBusyRef.current) {
      return;
    }
    const { cohort, rest } = takeNextHumanCohort(pendingHumanRef.current);
    pendingHumanRef.current = rest;
    if (cohort.length === 0) {
      return;
    }

    humanGateBusyRef.current = true;
    activeHumanCohortRef.current = cohort;
    setActiveHumanCohort(cohort);
    const representative = cohort[0];
    const idsLabel = cohort.map((item) => `#${item.profileId}`).join("、");
    setHumanCohortLabel(
      cohort.length > 1
        ? `同站同任务合并 · ${idsLabel}`
        : `环境 #${representative.profileId}`,
    );

    void focusProfileBrowser(representative.profileId).catch((error) => {
      pushAgentLineFor(
        representative.profileId,
        "warn",
        `置顶浏览器窗口失败：${formatInvokeError(error)}`,
      );
    });

    if (representative.kind === "confirm") {
      setAgentConfirmRequestId(representative.requestId);
      setAgentConfirmUrl(representative.url);
      setAgentConfirmReason(representative.reason ?? "");
      setAgentConfirmActions(representative.actions ?? []);
      setAgentFillValues(representative.fillValues ?? {});
      setAgentConfirmOpen(true);
      for (const item of cohort) {
        const actionSummary = (item.actions ?? [])
          .slice(0, 4)
          .map((action) =>
            action.kind === "fill"
              ? `填写「${action.text || action.id}」`
              : `点击「${action.text || action.id}」`,
          )
          .join(" · ");
        pushAgentLineFor(
          item.profileId,
          "warn",
          `等待人工确认 · ${(item.actions ?? []).length} 个动作${
            cohort.length > 1 ? `（合并 ${cohort.length} 环境）` : ""
          }${actionSummary ? `\n${actionSummary}` : ""}`,
          {
            kind: "alert",
            meta: {
              tool: "confirm",
              detail: item.reason || actionSummary || undefined,
              target: item.actions?.[0]?.text,
            },
          },
        );
      }
      return;
    }

    if (representative.kind === "handover") {
      // Milestone 4：handover 改由全局 Intervention Center 左下角队列处理，不再弹模态
      setAgentHandoverRequestId(representative.requestId);
      setAgentHandoverUrl(representative.url);
      setAgentHandoverReason(
        representative.reason ??
          "AI 已连续尝试 3 次失败，页面卡死。请手动完成当前页面的操作，完成后点击继续。",
      );
      setAgentHandoverOpen(false);
      // 清空本 cohort，避免抽屉队列反复 drain；恢复/中止由 Intervention Center 负责
      activeHumanCohortRef.current = [];
      setHumanCohortLabel("");
      for (const item of cohort) {
        pushAgentLineFor(
          item.profileId,
          "warn",
          `等待人工接管（见左下角接管中心）${cohort.length > 1 ? ` · 合并 ${cohort.length} 环境` : ""}${
            item.reason ? `\n${item.reason}` : ""
          }`,
          {
            kind: "alert",
            meta: {
              tool: "handover",
              detail: item.reason || undefined,
              url: item.url,
            },
          },
        );
      }
      return;
    }

    // ask: one prompt for the whole cohort
    void (async () => {
      const question = representative.question ?? "请补充信息";
      for (const item of cohort) {
        pushAgentLineFor(
          item.profileId,
          "warn",
          `等待人工补充信息${cohort.length > 1 ? `（合并 ${cohort.length} 环境）` : ""}\n${question}`,
          {
            kind: "alert",
            meta: {
              tool: "ask",
              detail: question,
            },
          },
        );
      }
      const answer = await prompt({
        title:
          cohort.length > 1
            ? `Agent 需要信息（${idsLabel}）`
            : `Agent 需要你的信息 · #${representative.profileId}`,
        description: question,
        placeholder: "短信/邮箱验证码或其他信息…",
        confirmLabel: "发送给 Agent",
      });
      const text = answer?.trim() || "";
      await Promise.allSettled(
        cohort.map(async (item) => {
          try {
            await replyAgentAsk(item.profileId, item.requestId, text);
            pushAgentLineFor(item.profileId, "info", `已回复：${question.slice(0, 40)}`);
          } catch (error) {
            onError(formatInvokeError(error));
          }
        }),
      );
      closeHumanModals();
      drainHumanQueueRef.current();
    })();
  }, [closeHumanModals, onError, prompt, pushAgentLineFor]);

  useEffect(() => {
    drainHumanQueueRef.current = drainHumanQueue;
  }, [drainHumanQueue]);

  const enqueueHuman = useCallback(
    (item: PendingAgentHuman) => {
      if (!item.profileId || !item.requestId) {
        return;
      }
      // 同一环境已打开确认窗：合并字段到一张表，避免逐字段弹窗
      if (
        item.kind === "confirm" &&
        agentConfirmOpen &&
        activeHumanCohortRef.current.some(
          (row) => row.kind === "confirm" && row.profileId === item.profileId,
        )
      ) {
        const mergedActions = mergeConfirmActions(agentConfirmActions, item.actions);
        const mergedFills = mergeFillValues(agentFillValues, item.fillValues);
        setAgentConfirmActions(mergedActions);
        setAgentFillValues(mergedFills);
        setAgentConfirmReason(
          [agentConfirmReason, item.reason].filter(Boolean).join(" · ") ||
            `批量填表确认（${mergedActions.filter((a) => a.kind === "fill").length} 字段）`,
        );
        activeHumanCohortRef.current = [...activeHumanCohortRef.current, item];
        setActiveHumanCohort(activeHumanCohortRef.current);
        pushAgentLineFor(item.profileId, "info", "已合并到当前批量确认表单（同环境）", {
          kind: "alert",
          meta: { tool: "confirm", detail: "同环境字段合并" },
        });
        return;
      }
      const merged = mergeIntoActiveCohort(activeHumanCohortRef.current, item);
      if (merged) {
        activeHumanCohortRef.current = merged;
        setActiveHumanCohort(merged);
        setHumanCohortLabel(
          merged.length > 1
            ? `同站同任务合并 · ${merged.map((row) => `#${row.profileId}`).join("、")}`
            : `环境 #${merged[0]?.profileId ?? ""}`,
        );
        pushAgentLineFor(item.profileId, "info", "已并入当前确认队列（同站同任务）", {
          kind: "alert",
          meta: { tool: "confirm", detail: "同站同任务合并入队" },
        });
        return;
      }
      pendingHumanRef.current = [...pendingHumanRef.current, item];
      drainHumanQueueRef.current();
    },
    [
      agentConfirmActions,
      agentConfirmOpen,
      agentConfirmReason,
      agentFillValues,
      pushAgentLineFor,
    ],
  );

  const setEnvAgentBusy = useCallback((profileId: string, busy: boolean) => {
    setAgentBusyEnvIds((current) => {
      if (busy) {
        return current.includes(profileId) ? current : [...current, profileId];
      }
      return current.filter((id) => id !== profileId);
    });
  }, []);

  const setEnvTrajectoryBusy = useCallback((profileId: string, busy: boolean) => {
    setTrajectoryBusyEnvIds((current) => {
      if (busy) {
        return current.includes(profileId) ? current : [...current, profileId];
      }
      return current.filter((id) => id !== profileId);
    });
    if (busy) {
      setReplayWatchEnvIds((current) =>
        current.includes(profileId) ? current : [...current, profileId],
      );
    }
  }, []);

  const setEnvRpaBusy = useCallback((profileId: string, busy: boolean) => {
    setRpaBusyEnvIds((current) => {
      if (busy) {
        return current.includes(profileId) ? current : [...current, profileId];
      }
      return current.filter((id) => id !== profileId);
    });
  }, []);

  const clearEnvExecutionBusy = useCallback((profileId: string) => {
    setEnvAgentBusy(profileId, false);
    setEnvRpaBusy(profileId, false);
    setEnvTrajectoryBusy(profileId, false);
    if (targetProfileId === profileId) {
      setExecutingTrajectoryId(null);
    }
  }, [setEnvAgentBusy, setEnvRpaBusy, setEnvTrajectoryBusy, targetProfileId]);

  const refreshTrajectories = useCallback(async () => {
    try {
      // 全局资产库：不按当前站过滤；同站置顶仅在面板内排序
      const rows = await listAgentTrajectories("");
      setTrajectories(rows);
      setSelectedTrajectoryId((current) =>
        current != null && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null,
      );
    } catch (error) {
      onError(formatInvokeError(error));
    }
  }, [onError]);

  const refreshTemplates = useCallback(async (domain: string) => {
    try {
      const rows = await fetchTemplatesByDomain(domain);
      setTemplates(rows);
      return rows;
    } catch (error) {
      onError(formatInvokeError(error));
      return [];
    }
  }, [onError]);

  const applyDomainFromUrl = useCallback(
    async (url: string) => {
      const domain = normalizeDomain(url);
      if (!domain) {
        return;
      }
      setCurrentDomain(domain);
      const rows = await refreshTemplates(domain);
      const matched = sortTemplatesForDomain(rows, domain);
      const autoTemplate = matched.find(
        (template) => template.auto_apply && domainMatchesTemplate(domain, template.domain),
      );
      if (autoTemplate && autoTrust) {
        setSelectedTemplateId(autoTemplate.id);
        setCurrentActions(parseTemplateActions(autoTemplate.actions));
      } else if (!selectedTemplateId && matched.length > 0) {
        setSelectedTemplateId(matched[0].id);
        setCurrentActions(parseTemplateActions(matched[0].actions));
      }
    },
    [autoTrust, refreshTemplates, selectedTemplateId],
  );

  useEffect(() => {
    if (!targetProfileId) {
      return;
    }
    if (targetProfile?.status !== "running") {
      clearEnvExecutionBusy(targetProfileId);
    }
  }, [clearEnvExecutionBusy, targetProfile?.status, targetProfileId]);

  useEffect(() => {
    if (!targetProfileId || targetProfile?.status !== "running") {
      setCurrentDomain("");
      return;
    }

    let isCancelled = false;
    let unlistenFn: (() => void) | undefined;

    void getProfilePageUrl(targetProfileId)
      .then((url) => {
        if (!isCancelled && url.trim()) {
          void applyDomainFromUrl(url).catch((error) => {
            logger.error("applyDomainFromUrl failed", error);
          });
        }
      })
      .catch((error) => {
        logger.error("getProfilePageUrl failed", error);
      });

    void listen<{ profileId?: string; profile_id?: string; url?: string }>("page-url-changed", (event) => {
      const eventProfileId = String(
        event.payload.profileId ?? event.payload.profile_id ?? "",
      ).trim();
      // 严防串号：无 profileId 或与当前 Tab 不符一律忽略
      if (!eventProfileId || eventProfileId !== targetProfileId) {
        return;
      }
      const url = event.payload.url?.trim();
      if (url) {
        void applyDomainFromUrl(url).catch((error) => {
          logger.error("applyDomainFromUrl failed", error);
        });
      }
    })
      .then((fn) => {
        if (isCancelled) {
          fn();
        } else {
          unlistenFn = fn;
        }
      })
      .catch((error) => {
        logger.error("listen page-url-changed failed", error);
      });

    return () => {
      isCancelled = true;
      unlistenFn?.();
    };
  }, [applyDomainFromUrl, targetProfile?.status, targetProfileId]);

  useEffect(() => {
    void refreshTrajectories();
  }, [refreshTrajectories]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<{
      profileId?: string;
      id?: number;
      domain?: string;
      title?: string;
    }>("agent-trajectory-saved", (event) => {
      const eventProfileId = String(event.payload.profileId ?? "").trim();
      // 严防串号：禁止回退到当前 Tab 的 targetProfileId
      if (!eventProfileId) {
        logger.warn("agent-trajectory-saved missing profileId, ignored");
        return;
      }
      const title = event.payload.title ?? "未命名";
      const domain = event.payload.domain ?? "";
      pushAgentLineFor(
        eventProfileId,
        "success",
        `轨迹已记忆：${title}${domain ? `（${domain}）` : ""} · 已写入「轨迹记忆」，可单开回放 / 沙盘`,
      );
      if (typeof event.payload.id === "number" && Number.isFinite(event.payload.id)) {
        setSelectedTrajectoryId(event.payload.id);
      }
      // 同域资产跨环境共享：任意环境落盘后刷新当前列表
      void refreshTrajectories().catch((error) => {
        logger.error("refreshTrajectories failed", error);
      });
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((error) => {
        logger.error("listen agent-trajectory-saved failed", error);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [pushAgentLineFor, refreshTrajectories]);

  useEffect(() => {
    let isCancelled = false;
    let unlistenFn: (() => void) | undefined;

    void listen<RpaStatePayload>("rpa-state", (event) => {
      const eventProfileId = String(
        event.payload.profile_id ?? (event.payload as { profileId?: string }).profileId ?? "",
      ).trim();
      if (!eventProfileId) {
        logger.warn("rpa-state missing profileId, ignored");
        return;
      }

      const state = String(event.payload.state ?? "").toLowerCase();
      const terminal =
        state === "complete" ||
        state === "paused" ||
        state === "failed" ||
        state === "aborted" ||
        state === "stopped" ||
        state === "error";

      // 始终按 profile 跟踪 RPA 忙闲（与引擎互斥对齐），不依赖当前 Tab
      if (state === "running") {
        setEnvRpaBusy(eventProfileId, true);
      } else if (terminal) {
        setEnvRpaBusy(eventProfileId, false);
      }

      if (targetProfileId && eventProfileId !== targetProfileId) {
        return;
      }

      if (state === "complete") {
        setRpaState("complete");
      } else if (state === "paused") {
        setRpaState("paused");
      } else if (terminal) {
        // failed / aborted / stopped：强制清进度与幽灵 busy
        setRpaState("idle");
        setRpaMessage(event.payload.msg ?? "");
      } else if (state === "running") {
        setRpaState("running");
      }

      if (event.payload.msg && !terminal) {
        setRpaMessage(event.payload.msg);
      }
      if (event.payload.actions && Array.isArray(event.payload.actions)) {
        setCurrentActions(event.payload.actions);
      }
      const busyReject =
        typeof event.payload.msg === "string" &&
        event.payload.msg.includes("当前环境正忙");
      if (
        event.payload.msg &&
        (busyReject ||
          state === "failed" ||
          state === "aborted" ||
          (state === "paused" && event.payload.msg.includes("失败")))
      ) {
        pushLine("error", `[RPA] ${event.payload.msg}`);
        if (busyReject || state === "failed" || state === "aborted") {
          onError(event.payload.msg);
        }
      }
    })
      .then((fn) => {
        if (isCancelled) {
          fn();
        } else {
          unlistenFn = fn;
        }
      })
      .catch((error) => {
        logger.error("listen rpa-state failed", error);
      });

    return () => {
      isCancelled = true;
      unlistenFn?.();
    };
  }, [onError, pushLine, setEnvRpaBusy, targetProfileId]);

  useEffect(() => {
    let isCancelled = false;
    const unlistenFns: Array<() => void> = [];

    void listen<{
      profileId?: string;
      requestId?: string;
      url?: string;
      reason?: string;
      actions?: AgentConfirmActionRow[];
    }>("agent-confirm-required", (event) => {
      const profileId = String(event.payload.profileId ?? "").trim();
      const requestId = String(event.payload.requestId ?? "").trim();
      if (!profileId || !requestId) {
        logger.warn("agent-confirm-required missing profileId/requestId, ignored");
        return;
      }
      const actions = Array.isArray(event.payload.actions) ? event.payload.actions : [];
      const fillValues: Record<string, string> = {};
      for (const action of actions) {
        if (action.kind === "fill") {
          fillValues[action.id] = action.value ?? "";
        }
      }
      enqueueHuman(
        buildPendingHuman({
          profileId,
          kind: "confirm",
          requestId,
          url: event.payload.url,
          goalKey: agentGoalByEnvRef.current[profileId] ?? "",
          reason: event.payload.reason,
          actions,
          fillValues,
        }),
      );
    })
      .then((fn) => {
        if (isCancelled) {
          fn();
        } else {
          unlistenFns.push(fn);
        }
      })
      .catch((error) => {
        logger.error("listen agent-confirm-required failed", error);
      });

    void listen<{ profileId?: string; requestId?: string; question?: string; url?: string }>(
      "agent-ask-user",
      (event) => {
        const profileId = String(event.payload.profileId ?? "").trim();
        const requestId = String(event.payload.requestId ?? "").trim();
        if (!profileId || !requestId) {
          logger.warn("agent-ask-user missing profileId/requestId, ignored");
          return;
        }
        enqueueHuman(
          buildPendingHuman({
            profileId,
            kind: "ask",
            requestId,
            url: event.payload.url,
            goalKey: agentGoalByEnvRef.current[profileId] ?? "",
            question: event.payload.question ?? "请补充信息",
          }),
        );
      },
    )
      .then((fn) => {
        if (isCancelled) {
          fn();
        } else {
          unlistenFns.push(fn);
        }
      })
      .catch((error) => {
        logger.error("listen agent-ask-user failed", error);
      });

    void listen<{ profileId?: string; requestId?: string; url?: string; reason?: string }>(
      "agent-handover-required",
      (event) => {
        const profileId = String(event.payload.profileId ?? "").trim();
        const requestId = String(event.payload.requestId ?? "").trim();
        if (!profileId || !requestId) {
          logger.warn("agent-handover-required missing profileId/requestId, ignored");
          return;
        }
        enqueueHuman(
          buildPendingHuman({
            profileId,
            kind: "handover",
            requestId,
            url: event.payload.url,
            goalKey: agentGoalByEnvRef.current[profileId] ?? "",
            reason: event.payload.reason,
          }),
        );
      },
    )
      .then((fn) => {
        if (isCancelled) {
          fn();
        } else {
          unlistenFns.push(fn);
        }
      })
      .catch((error) => {
        logger.error("listen agent-handover-required failed", error);
      });

    void listen<{
      profileId?: string;
      state?: string;
      msg?: string;
      step?: number;
      engine?: string;
    }>(
      "agent-state",
      (event) => {
        const eventProfileId = String(event.payload.profileId ?? "").trim();
        // 严防串号：禁止回退到当前 Tab
        if (!eventProfileId) {
          logger.warn("agent-state missing profileId, ignored");
          return;
        }
        const state = event.payload.state ?? "";
        const msg = event.payload.msg ?? "";
        const engine = String(event.payload.engine ?? "");
        const isTrajectory =
          engine === "trajectory_replay" ||
          trajectoryBusyEnvIdsRef.current.includes(eventProfileId);

        if (state === "running") {
          if (isTrajectory) {
            setEnvTrajectoryBusy(eventProfileId, true);
          } else {
            setEnvAgentBusy(eventProfileId, true);
          }
        }
        if (
          state === "complete" ||
          state === "failed" ||
          state === "aborted" ||
          state === "stopped"
        ) {
          if (isTrajectory) {
            setEnvTrajectoryBusy(eventProfileId, false);
            setExecutingTrajectoryId(null);
          } else {
            setEnvAgentBusy(eventProfileId, false);
            pendingHumanRef.current = pendingHumanRef.current.filter(
              (item) => item.profileId !== eventProfileId,
            );
            if (activeHumanCohortRef.current.some((item) => item.profileId === eventProfileId)) {
              const remaining = activeHumanCohortRef.current.filter(
                (item) => item.profileId !== eventProfileId,
              );
              if (remaining.length === 0) {
                closeHumanModals();
                drainHumanQueueRef.current();
              } else {
                activeHumanCohortRef.current = remaining;
                setActiveHumanCohort(remaining);
              }
            }
          }
        }
        if (msg) {
          const benignStop =
            (state === "failed" || state === "aborted") && isBenignAgentStopError(msg);
          const tone: TerminalLine["tone"] = benignStop
            ? "info"
            : state === "failed" || state === "aborted"
              ? "error"
              : state === "complete"
                ? "success"
                : "info";
          const text = benignStop
            ? isTrajectory
              ? `回放已手动停止：${msg}`
              : `Agent 已手动停止：${msg}`
            : msg;
          if (isTrajectory) {
            pushReplayLineFor(eventProfileId, tone, text);
          } else {
            const kindExtra = inferAgentLineKind(text, tone, state);
            pushAgentLineFor(eventProfileId, tone, text, kindExtra);
          }
        }
      },
    )
      .then((fn) => {
        if (isCancelled) {
          fn();
        } else {
          unlistenFns.push(fn);
        }
      })
      .catch((error) => {
        logger.error("listen agent-state failed", error);
      });

    return () => {
      isCancelled = true;
      for (const unlisten of unlistenFns) {
        unlisten();
      }
    };
  }, [
    closeHumanModals,
    enqueueHuman,
    pushAgentLineFor,
    pushReplayLineFor,
    setEnvAgentBusy,
    setEnvTrajectoryBusy,
  ]);

  // Always listen — drawer may be closed / on another tab when scrape finishes.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void listen<{
      profileId?: string;
      data?: unknown;
      mode?: string;
      url?: string;
      count?: number;
      append?: boolean;
      localPath?: string;
    }>("scraper-data-collected", (event) => {
      const eventProfileId = String(event.payload.profileId ?? "").trim();
      if (!eventProfileId) {
        logger.warn("scraper-data-collected missing profileId, ignored");
        return;
      }
      const rows = normalizeScrapedRows(event.payload.data);
      const append = Boolean(event.payload.append);
      setScrapedDataByEnv((current) => {
        const prev = current[eventProfileId];
        const mergedRows = append && prev?.rows?.length ? [...prev.rows, ...rows] : rows;
        return {
          ...current,
          [eventProfileId]: {
            rows: mergedRows,
            mode: event.payload.mode ?? prev?.mode,
            url: event.payload.url ?? prev?.url,
            count: mergedRows.length,
            localPath: event.payload.localPath ?? prev?.localPath,
          },
        };
      });
      pushAgentLineFor(
        eventProfileId,
        "success",
        append
          ? `追加采集 ${rows.length} 条（合计已更新）`
          : event.payload.localPath
            ? `文件已保存：${event.payload.localPath}`
            : `已采集 ${event.payload.count ?? rows.length} 条数据${event.payload.mode ? ` · ${event.payload.mode}` : ""}`,
      );
      // Surface the panel: open drawer conceptually via agent tab when user already has console open
      setActiveTab("agent");
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((error) => {
        logger.error("listen scraper-data-collected failed", error);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [pushAgentLineFor]);

  useEffect(() => {
    if (!quickMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (quickMenuRef.current && !quickMenuRef.current.contains(event.target as Node)) {
        setQuickMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [quickMenuOpen]);

  useEffect(() => {
    if (!selectedTemplate) {
      return;
    }
    setCurrentActions(parseTemplateActions(selectedTemplate.actions));
    setAutoTrust(selectedTemplate.auto_apply);
  }, [selectedTemplate]);

  const applyAiReplyToFormData = useCallback(
    (reply: string) => {
      const fillText = extractFillDataTextFromReply(reply);
      if (fillText) {
        setAiRawInput(fillText);
        pushLine("success", "[填表] 已提取 JSON 并写入「原始填表数据」");
        return true;
      }
      const extracted = extractJsonFromAiReply(reply);
      if (!extracted) {
        return false;
      }
      setAiRawInput(JSON.stringify(extracted, null, 2));
      pushLine("success", "[填表] 已提取 JSON 并写入「原始填表数据」");
      return true;
    },
    [pushLine],
  );

  const runChatPrompt = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || chatLoading) {
        return;
      }

      setChatLoading(true);
      onError("");
      const history = buildChatHistoryFromLines(lines);
      pushLine("info", trimmed, "user");

      try {
        const reply = await sendAiChat(trimmed, targetProfileId ?? undefined, history);
        pushLine("success", reply, "assistant");
        applyAiReplyToFormData(reply);
      } catch (error) {
        const message = formatInvokeError(error);
        pushLine("error", `对话失败: ${message}`, "assistant");
        onError(message);
      } finally {
        setChatLoading(false);
      }
    },
    [applyAiReplyToFormData, chatLoading, lines, onError, pushLine, targetProfileId],
  );

  const handleSendChat = async () => {
    const text = chatInput.trim();
    if (!text) {
      return;
    }
    setChatInput("");
    await runChatPrompt(text);
  };

  const handleStartBrowser = async () => {
    const targetIds =
      selectedIds.length > 0 ? selectedIds : targetProfileId ? [targetProfileId] : [];
    if (targetIds.length === 0) {
      onError("请先在左侧选择一个或多个环境");
      return;
    }
    if (!onStartBrowser) {
      onError("浏览器启动接口未接入");
      return;
    }

    const toStart = targetIds.filter((id) => {
      const profile = profiles.find((item) => String(item.id) === id);
      return profile != null && profile.status !== "running";
    });
    if (toStart.length === 0) {
      onError("所选环境均已在运行");
      return;
    }

    onError("");
    let okCount = 0;
    let failCount = 0;
    for (const id of toStart) {
      pushAgentLineFor(id, "info", `▶ 启动浏览器 · 环境 #${id}`);
      try {
        const ok = await onStartBrowser(id);
        if (ok === false) {
          failCount += 1;
          pushAgentLineFor(id, "error", `启动浏览器失败 · #${id}`);
          continue;
        }
        okCount += 1;
        pushAgentLineFor(id, "success", `浏览器已启动 · #${id}`);
      } catch (error) {
        failCount += 1;
        const message = formatInvokeError(error);
        pushAgentLineFor(id, "error", `启动浏览器失败：${message}`);
        onError(message);
      }
    }
    if (toStart.length > 1) {
      pushAgentLine(
        failCount > 0 ? "warn" : "success",
        `批量启动结束 · 成功 ${okCount} · 失败 ${failCount} · 共 ${toStart.length}`,
      );
    }
  };

  const handleStopBrowser = async () => {
    const targetIds =
      selectedIds.length > 0 ? selectedIds : targetProfileId ? [targetProfileId] : [];
    if (targetIds.length === 0) {
      onError("请先在左侧选择一个或多个环境");
      return;
    }
    if (!onStopBrowser) {
      onError("浏览器停止接口未接入");
      return;
    }

    const toStop = targetIds.filter((id) => {
      const profile = profiles.find((item) => String(item.id) === id);
      return profile?.status === "running";
    });
    if (toStop.length === 0) {
      onError("所选环境均未运行");
      return;
    }

    if (agentBusy && targetProfileId && toStop.includes(targetProfileId)) {
      await handleAbortAgent();
    }

    onError("");
    let okCount = 0;
    let failCount = 0;
    for (const id of toStop) {
      pushAgentLineFor(id, "info", `▶ 停止浏览器 · 环境 #${id}`);
      try {
        const ok = await onStopBrowser(id);
        clearEnvExecutionBusy(id);
        if (ok === false) {
          failCount += 1;
          pushAgentLineFor(id, "error", `停止浏览器失败 · #${id}`);
          continue;
        }
        okCount += 1;
        pushAgentLineFor(id, "info", `浏览器已停止 · #${id}`);
      } catch (error) {
        clearEnvExecutionBusy(id);
        failCount += 1;
        const message = formatInvokeError(error);
        if (isBenignAgentStopError(error) || isBenignAgentStopError(message)) {
          okCount += 1;
          failCount -= 1;
          pushAgentLineFor(id, "info", `浏览器已停止 · #${id}`);
          onError("");
        } else {
          pushAgentLineFor(id, "error", `停止浏览器失败：${message}`);
          onError(message);
        }
      }
    }
    if (toStop.length > 1) {
      pushAgentLine(
        failCount > 0 ? "warn" : "info",
        `批量停止结束 · 成功 ${okCount} · 失败 ${failCount} · 共 ${toStop.length}`,
      );
    }
  };

  const handleStartAgent = async () => {
    const goal = agentGoal.trim();
    if (!goal) {
      onError("请填写 Agent 目标（例如：打开百度并搜索天气；或 #2 开百度 #5 开谷歌）");
      return;
    }

    const policy = await refreshAgentSeatPolicy();
    const routed = resolveAgentTargets({
      goal,
      selectedIds,
      runningIds: runningProfileIds,
      policy,
    });
    if (routed.error) {
      onError(routed.error);
      return;
    }

    // Free Key + 151-pro fingerprint pin：跳过不可 AI 的环境
    const allowedAssignments = routed.assignments.filter((item) => {
      const profile = profiles.find((p) => String(p.id) === item.profileId);
      if (isAiBlockedForKernel(policy.isPro, profile?.browser_version)) {
        pushLine("warn", `#${item.profileId} ${aiBlockedKernelMessage(profile?.browser_version)}`);
        return false;
      }
      return true;
    });
    if (allowedAssignments.length === 0) {
      onError(
        routed.assignments.length > 0
          ? aiBlockedKernelMessage(
              profiles.find((p) => String(p.id) === routed.assignments[0]?.profileId)
                ?.browser_version,
            )
          : "没有可启动 Agent 的环境",
      );
      return;
    }

    const targets = allowedAssignments.filter(
      (item) =>
        !agentBusyEnvIds.includes(item.profileId) &&
        !trajectoryBusyEnvIds.includes(item.profileId) &&
        !rpaBusyEnvIds.includes(item.profileId),
    );
    if (targets.length === 0) {
      onError("目标环境均正忙（Agent / 填表 / 轨迹回放），请先停止后再启动 Agent");
      return;
    }

    setAgentGoal("");
    onError("");
    setAgentRouteMode(routed.mode);
    setAgentBatchIds(targets.map((item) => item.profileId));

    const goalMap: Record<string, string> = { ...agentGoalByEnv };
    for (const item of targets) {
      goalMap[item.profileId] = normalizeAgentGoalKey(item.goal);
    }
    setAgentGoalByEnv(goalMap);
    agentGoalByEnvRef.current = goalMap;

    if (routed.skippedNotRunning.length > 0) {
      pushLine(
        "warn",
        `已忽略未打开环境：#${routed.skippedNotRunning.join("、#")}`,
      );
    }
    if (routed.skippedOverCap.length > 0) {
      const capLabel = !policy.isPro
        ? "免费版 AI 限 1 个免费核"
        : `AI 席位上限 ${routed.maxAllowed ?? "?"}`;
      pushLine(
        "warn",
        `${capLabel}（打开浏览器不限），已跳过：#${routed.skippedOverCap.join("、#")}`,
      );
    }

    const modeLabel = routed.mode === "broadcast" ? "广播" : "分派";
    pushLine(
      "info",
      `▶ Agent ${modeLabel} ${targets.length} 个环境：#${targets.map((item) => item.profileId).join("、#")}${
        agentSeatsSummary ? ` · ${agentSeatsSummary}` : ""
      }${routed.maxAllowed != null ? ` · 上限 ${routed.maxAllowed}` : ""}`,
    );
    if (enableRecording) {
      pushLine("info", "轨迹录制已开启：任务成功结束后将写入「轨迹记忆」");
    } else {
      pushLine(
        "warn",
        "未勾选「录制执行轨迹」：本次即使成功也不会写入轨迹记忆（可在启动前勾选）",
      );
    }

    const settingsSnap = await fetchSettings().catch(() => null);
    const thinkingModel =
      settingsSnap != null
        ? resolveTaskModel(settingsSnap, "agent")
        : "";

    for (const item of targets) {
      setEnvAgentBusy(item.profileId, true);
      pushAgentLineFor(
        item.profileId,
        "info",
        `▶ 启动 Agent：${item.goal.slice(0, 80)}${item.goal.length > 80 ? "…" : ""}`,
        { kind: "system" },
      );
      pushAgentLineFor(
        item.profileId,
        "info",
        thinkingModel
          ? `已提交任务分析（模型 ${thinkingModel}）· 等待 sidecar 阶段回传…`
          : "已提交任务分析 · 等待 sidecar 阶段回传…",
        { kind: "thought" },
      );
    }

    const settled = await Promise.allSettled(
      targets.map(async (item) => {
        try {
          const result = await startAutonomousAgent(
            item.profileId,
            item.goal,
            15,
            "balanced",
            enableRecording,
          );
          const msg = result.msg || result.state;
          // 终态文案已由 agent-state 推入 Monitor，此处仅汇总 ok，避免重复红字（含 Sidecar 意外退出）
          if (result.state === "failed" && isBenignAgentStopError(msg)) {
            return { profileId: item.profileId, ok: true, msg };
          }
          if (result.state === "complete") {
            return { profileId: item.profileId, ok: true, msg };
          }
          if (result.state === "failed" || result.state === "aborted") {
            return { profileId: item.profileId, ok: false, msg };
          }
          pushAgentLineFor(item.profileId, "error", msg);
          return { profileId: item.profileId, ok: false, msg };
        } catch (error) {
          const message = formatInvokeError(error);
          if (isBenignAgentStopError(error) || isBenignAgentStopError(message)) {
            pushAgentLineFor(item.profileId, "info", `Agent 已手动停止：${message}`);
            return { profileId: item.profileId, ok: true, msg: message };
          }
          pushAgentLineFor(item.profileId, "error", `发生错误：${message}`);
          return { profileId: item.profileId, ok: false, msg: message };
        } finally {
          setEnvAgentBusy(item.profileId, false);
        }
      }),
    );

    let failCount = 0;
    for (const item of settled) {
      if (item.status === "rejected") {
        failCount += 1;
        continue;
      }
      if (!item.value.ok) {
        failCount += 1;
      }
    }
    if (targets.length > 1) {
      pushLine(
        failCount > 0 ? "warn" : "success",
        `Agent ${modeLabel}结束 · 成功 ${targets.length - failCount} · 失败 ${failCount} · 共 ${targets.length}`,
      );
    }
    if (failCount > 0 && targets.length === 1) {
      const first = settled[0];
      if (first?.status === "fulfilled" && first.value.msg) {
        // Sidecar 退出等失败已由 rpa-state → Banner；此处仅补非会话清理类错误
        const msg = first.value.msg;
        if (!msg.includes("Sidecar 进程意外退出") && !msg.includes("会话已清理")) {
          onError(msg);
        }
      }
    }

    setAgentBusyEnvIds((current) => {
      if (current.length === 0) {
        setAgentRouteMode("idle");
      }
      return current;
    });
  };

  const handleAgentConfirm = async () => {
    const cohort = activeHumanCohortRef.current.filter((item) => item.kind === "confirm");
    if (cohort.length === 0) {
      setAgentConfirmOpen(false);
      closeHumanModals();
      drainHumanQueueRef.current();
      return;
    }
    setAgentConfirmLoading(true);
    try {
      await Promise.all(
        cohort.map((item) =>
          confirmAgentAction(item.profileId, item.requestId, agentFillValues),
        ),
      );
      for (const item of cohort) {
        pushAgentLineFor(item.profileId, "success", "已确认，开始执行填表/点击");
      }
      closeHumanModals();
      drainHumanQueueRef.current();
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setAgentConfirmLoading(false);
    }
  };

  const handleAgentCancelConfirm = async () => {
    const cohort = activeHumanCohortRef.current.filter((item) => item.kind === "confirm");
    setAgentConfirmLoading(true);
    try {
      await Promise.allSettled(
        cohort.map((item) => cancelAgentAction(item.profileId, item.requestId || undefined)),
      );
      for (const item of cohort) {
        pushAgentLineFor(item.profileId, "warn", "用户取消了本次确认");
      }
      closeHumanModals();
      drainHumanQueueRef.current();
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setAgentConfirmLoading(false);
    }
  };

  const handleAbortAgent = async () => {
    const ids =
      agentBusyEnvIds.length > 0
        ? agentBusyEnvIds
        : agentBatchIds.length > 0
          ? agentBatchIds
          : targetProfileId
            ? [targetProfileId]
            : [];
    if (ids.length === 0) {
      return;
    }
    let failMessage = "";
    await Promise.allSettled(
      ids.map(async (id) => {
        try {
          await abortAutonomousAgent(id);
          setEnvAgentBusy(id, false);
          pushAgentLineFor(id, "info", "Agent 已手动停止");
        } catch (error) {
          const message = formatInvokeError(error);
          if (isBenignAgentStopError(error) || isBenignAgentStopError(message)) {
            setEnvAgentBusy(id, false);
            pushAgentLineFor(id, "info", `Agent 已手动停止：${message}`);
          } else {
            failMessage = message;
            pushAgentLineFor(id, "error", `停止失败：${message}`);
          }
        }
      }),
    );
    closeHumanModals();
    pendingHumanRef.current = [];
    setAgentRouteMode("idle");
    if (failMessage) {
      onError(failMessage);
    } else {
      onError("");
    }
  };

  const handleHandoverContinue = async () => {
    const cohort = activeHumanCohortRef.current.filter((item) => item.kind === "handover");
    setAgentHandoverLoading(true);
    try {
      await Promise.all(
        cohort.map((item) => continueAgentHandover(item.profileId, item.requestId || undefined)),
      );
      for (const item of cohort) {
        pushAgentLineFor(item.profileId, "success", "已继续，重新感知页面");
      }
      closeHumanModals();
      drainHumanQueueRef.current();
    } catch (error) {
      onError(formatInvokeError(error));
    } finally {
      setAgentHandoverLoading(false);
    }
  };

  const handleHandoverAbort = async () => {
    closeHumanModals();
    await handleAbortAgent();
    drainHumanQueueRef.current();
  };

  const handleQuickCommand = async (command: QuickCommand) => {
    setQuickMenuOpen(false);
    if (command.fillOnly) {
      setChatInput(command.prompt);
      pushLine("info", `[快捷命令] 已填入「${command.label}」，请编辑后手动发送`);
      return;
    }
    setChatInput("");
    await runChatPrompt(command.prompt);
  };

  const handleSaveCustomCommand = async () => {
    const commandPrompt = chatInput.trim();
    if (!commandPrompt) {
      onError("请先在输入框中填写要保存的快捷命令内容");
      return;
    }

    const label = await prompt({
      title: "增加快捷命令",
      description: "请输入快捷命令名称，将显示在快捷命令菜单中。",
      defaultValue: "自定义命令",
      placeholder: "例如：提取表单 JSON",
      confirmLabel: "增加",
    });
    if (!label?.trim()) {
      return;
    }

    const next: QuickCommand = {
      id: `custom-${Date.now()}`,
      label: label.trim(),
      prompt: commandPrompt,
    };
    const updated = [...customCommands, next];
    setCustomCommands(updated);
    saveCustomQuickCommands(updated);
    setQuickMenuOpen(false);
    pushLine("success", `[快捷命令] 已增加「${next.label}」`);
  };

  const handleDeleteCustomCommand = async (command: QuickCommand) => {
    if (!command.id.startsWith("custom-")) {
      onError("内置快捷命令不可删除");
      return;
    }
    const confirmed = await confirm({
      title: "删除快捷命令",
      description: `确定删除「${command.label}」？此操作不可撤销。`,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    const updated = customCommands.filter((item) => item.id !== command.id);
    setCustomCommands(updated);
    saveCustomQuickCommands(updated);
    pushLine("info", `[快捷命令] 已删除「${command.label}」`);
  };

  const openAgentForRecording = useCallback(() => {
    if (!enableRecording) {
      setEnableRecording(true);
      persistAgentEnableRecording(true);
      pushLine("info", "已自动勾选「录制执行轨迹」：下次 Agent 成功结束后将写入轨迹记忆");
    }
    setActiveTab("agent");
  }, [enableRecording, pushLine]);

  const executeRpa = useCallback(
    async (confirmedProfile?: string) => {
      if (!targetProfileId) {
        onError("请先选择或启动一个运行中的环境");
        return;
      }
      if (agentBusyEnvIds.includes(targetProfileId) || trajectoryBusyEnvIds.includes(targetProfileId)) {
        onError("当前环境正忙，请先停止 Agent/回放后再填表");
        return;
      }
      if (rpaBusyEnvIds.includes(targetProfileId)) {
        onError("当前环境正在填表，请稍后再试");
        return;
      }
      const fillInput = aiRawInput;
      if (!fillInput.trim()) {
        onError("请粘贴填表原始数据");
        return;
      }

      const normalizedFill = normalizeFillInputForExecution(fillInput);
      const fillPayload = normalizedFill.rpaActions.length > 0 ? normalizedFill.payload : fillInput;

      setAiSubmitting(true);
      setEnvRpaBusy(targetProfileId, true);
      setRpaState("running");
      onError("");

      pushLine(
        "info",
        skipHybrid ? "▶ 纯执行模式填表中…" : "▶ AI 填表执行中…",
      );

      try {
        let actionsToSend: RpaAction[] | undefined;
        if (skipHybrid && currentActions.length > 0) {
          actionsToSend = currentActions;
        } else if (skipHybrid && normalizedFill.rpaActions.length > 0) {
          actionsToSend = normalizedFill.rpaActions as RpaAction[];
        }

        const result = await runRpaFill(targetProfileId, fillPayload, {
          actions: actionsToSend,
          confirmedProfile,
          skipHybrid,
          pressEnterAfterFill,
        });

        setRpaState(result.state === "complete" ? "complete" : "paused");
        setRpaMessage(result.msg);
        if (result.actions) {
          setCurrentActions(result.actions as RpaAction[]);
        }
        pushLine(
          result.state === "complete" ? "success" : result.msg.includes("失败") ? "error" : "info",
          `[填表] ${result.msg} (step=${result.step})`,
        );
      } catch (error) {
        const message = formatInvokeError(error);
        setRpaState("paused");
        setRpaMessage(message);
        pushLine("error", `[填表] ${message}`);
        onError(message);
      } finally {
        setAiSubmitting(false);
        setEnvRpaBusy(targetProfileId, false);
      }
    },
    [
      agentBusyEnvIds,
      aiRawInput,
      currentActions,
      onError,
      pressEnterAfterFill,
      pushLine,
      rpaBusyEnvIds,
      setEnvRpaBusy,
      skipHybrid,
      targetProfileId,
      trajectoryBusyEnvIds,
    ],
  );

  const handleDirectFill = async () => {
    if (!targetProfileId) {
      onError("请先选择或启动一个运行中的环境");
      return;
    }
    if (envExecuting) {
      onError(`当前环境正忙（${envBusyReason}），请先停止当前任务后再填表`);
      return;
    }
    if (!aiRawInput.trim()) {
      onError("请填写原始填表数据");
      return;
    }
    if (isAiBlockedForKernel(agentSeatPolicy.isPro, targetProfile?.browser_version)) {
      onError(aiBlockedKernelMessage(targetProfile?.browser_version));
      return;
    }

    setDirectFillSubmitting(true);
    setEnvRpaBusy(targetProfileId, true);
    onError("");
    pushLine("info", "▶ 直接填表：按 name/id/label 启发式映射当前页面字段…");

    try {
      await runDirectFill(targetProfileId, aiRawInput, pressEnterAfterFill);
      pushLine("success", "[填表] 直接填表已完成，请在浏览器中核对填写结果");
    } catch (error) {
      const message = formatInvokeError(error);
      pushLine("error", `[填表] 直接填表失败: ${message}`);
      onError(message);
    } finally {
      setDirectFillSubmitting(false);
      setEnvRpaBusy(targetProfileId, false);
    }
  };

  const handleSmartFill = async () => {
    const naturalLanguage = chatInput.trim();
    if (!smartFillEnabled || !targetProfileId) {
      onError("请先启动环境，并在环境列表中开启「元素提取」开关");
      return;
    }
    if (envExecuting) {
      onError(`当前环境正忙（${envBusyReason}），请先停止当前任务后再填表`);
      return;
    }
    if (!naturalLanguage) {
      onError("请在上方输入框用自然语言描述要填写的内容（如卡号、地址、姓名等）");
      return;
    }
    if (isAiBlockedForKernel(agentSeatPolicy.isPro, targetProfile?.browser_version)) {
      onError(aiBlockedKernelMessage(targetProfile?.browser_version));
      return;
    }

    setSmartFillSubmitting(true);
    setEnvRpaBusy(targetProfileId, true);
    onError("");
    pushLine("info", `▶ 智能填表：解析「${naturalLanguage.slice(0, 48)}${naturalLanguage.length > 48 ? "…" : ""}」并填表…`);

    try {
      const exportJson = await runSmartFill(
        targetProfileId,
        naturalLanguage,
        aiRawInput.trim() || undefined,
        pressEnterAfterFill,
      );
      setAiRawInput(JSON.stringify(JSON.parse(exportJson), null, 2));
      setChatInput("");
      pushLine("success", "[填表] 智能填表已完成，已更新「原始填表数据」中的元素 JSON");
    } catch (error) {
      const message = formatInvokeError(error);
      pushLine("error", `[填表] 智能填表失败: ${message}`);
      onError(message);
    } finally {
      setSmartFillSubmitting(false);
      setEnvRpaBusy(targetProfileId, false);
    }
  };

  const handleAiRun = async () => {
    if (!targetProfileId) {
      onError("请先选择或启动一个运行中的环境");
      return;
    }
    if (envExecuting) {
      onError(`当前环境正忙（${envBusyReason}），请先停止当前任务后再填表`);
      return;
    }
    if (!aiRawInput.trim()) {
      onError("请粘贴填表原始数据");
      return;
    }

    // 人工确认开关必须真正生效：关闭后不再弹预览窗，直接执行。
    // 混合推演（skipHybrid=false）仍会在 sidecar 内完成，只是跳过人工核对 JSON。
    if (!forceHumanConfirm) {
      await executeRpa(undefined);
      return;
    }

    setPreviewLoading(true);
    onError("");
    pushLine("info", skipHybrid ? "▶ 准备填表预览（跳过混合推演）…" : "▶ 正在混合推演填表数据…");

    try {
      const preview = skipHybrid
        ? buildDirectPreviewJson(aiRawInput)
        : formatPreviewJson(await previewAiFill(targetProfileId, aiRawInput));
      setConfirmJson(preview);
      setConfirmOpen(true);
      pushLine("success", "[填表] 已生成预览，请在确认弹窗中核对 JSON");
    } catch (error) {
      const message = formatInvokeError(error);
      pushLine("error", `[填表] 预览失败: ${message}`);
      onError(message);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleConfirmFill = async () => {
    if (!confirmJson.trim()) {
      onError("确认填表数据不能为空");
      return;
    }
    setConfirmOpen(false);
    await executeRpa(confirmJson);
  };

  const handleDeleteTrajectory = async (trajectory: AgentTrajectory) => {
    try {
      await deleteAgentTrajectory(trajectory.id, trajectory.file_path);
      pushAgentLine(
        "success",
        `已删除轨迹：${trajectory.title || trajectory.file_name || `#${trajectory.id}`}`,
      );
      await refreshTrajectories();
    } catch (error) {
      onError(formatInvokeError(error));
    }
  };

  const handleExecuteTrajectory = async (trajectory: AgentTrajectory) => {
    if (!targetProfileId) {
      onError("请先选择或启动一个运行中的环境");
      return;
    }

    let actions: unknown[] = [];
    try {
      const parsed = JSON.parse(trajectory.actions) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) {
        onError("该轨迹没有可执行步骤");
        return;
      }
      actions = parsed;
    } catch {
      onError("轨迹动作 JSON 解析失败");
      return;
    }

    if (envExecuting) {
      onError(`当前环境正忙（${envBusyReason}），请先停止当前任务后再回放`);
      return;
    }

    setEnvTrajectoryBusy(targetProfileId, true);
    setExecutingTrajectoryId(trajectory.id);
    onError("");
    pushReplayLine(
      "info",
      `▶ 轨迹回放「${trajectory.title}」· ${actions.length} 步（脚本优先，需分析时再 AI 交付）`,
    );

    try {
      const result = await replayAgentTrajectory(targetProfileId, {
        filePath: trajectory.file_path,
        actions: trajectory.file_path ? null : actions,
        title: trajectory.title,
        goal: trajectory.goal || trajectory.title,
      });
      const ok = result.state === "complete";
      const benign = result.state === "failed" && isBenignAgentStopError(result.msg || "");
      // 进度与终态由 agent-state → 回放日志；此处仅补 Banner
      if (!ok && !benign) {
        onError(result.msg || "轨迹回放失败");
      }
    } catch (error) {
      const message = formatInvokeError(error);
      if (isBenignAgentStopError(error) || isBenignAgentStopError(message)) {
        pushReplayLine("info", `回放已停止：${message}`);
      } else {
        pushReplayLine("error", `回放失败：${message}`);
        onError(message);
      }
    } finally {
      setEnvTrajectoryBusy(targetProfileId, false);
      setExecutingTrajectoryId(null);
    }
  };

  const handleStopTrajectory = async () => {
    const targets =
      trajectoryBusyEnvIds.length > 0
        ? [...trajectoryBusyEnvIds]
        : targetProfileId
          ? [targetProfileId]
          : [];
    if (targets.length === 0) {
      setExecutingTrajectoryId(null);
      return;
    }
    pushReplayLine(
      "info",
      targets.length > 1 ? `正在停止回放 · ${targets.length} 个环境…` : "正在停止回放…",
    );
    try {
      await Promise.allSettled(
        targets.map(async (id) => {
          try {
            await abortAutonomousAgent(id);
          } catch (error) {
            const message = formatInvokeError(error);
            if (!isBenignAgentStopError(error) && !isBenignAgentStopError(message)) {
              pushReplayLine("error", `环境 #${id} 停止回放失败：${message}`);
            }
          }
        }),
      );
    } finally {
      // 停止后立即清 busy，避免 abort 未 unwind 时按钮永久灰掉
      for (const id of targets) {
        setEnvTrajectoryBusy(id, false);
      }
      setExecutingTrajectoryId(null);
    }
  };

  return (
    <aside className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 flex-col border-b border-border">
        <div className="flex items-center gap-2 px-3 py-2">
          <Sparkles size={14} className="shrink-0 text-primary" />
          <span className="shrink-0 text-xs font-semibold">天枢台 AI 中枢</span>
          <div className="min-w-0 flex-1">
            {targetProfileId || agentBatchIds.length > 0 ? (
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="context-badge" title={agentRouteBadge.title}>
                  <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                    {agentRouteMode === "broadcast"
                      ? "广播"
                      : agentRouteMode === "named"
                        ? "分派"
                        : "焦点"}
                  </span>
                  <span className="text-primary">
                    {agentRouteMode === "idle"
                      ? `#${targetProfileId}`
                      : agentBatchIds.length > 0
                        ? `${agentBatchIds.length} 环境`
                        : `#${targetProfileId}`}
                  </span>
                  {currentDomain && agentRouteMode === "idle" ? (
                    <span className="truncate font-normal text-muted-foreground">
                      {currentDomain}
                    </span>
                  ) : null}
                  <span
                    className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold ${
                      anyAgentBusy || envExecuting
                        ? "bg-amber-500/15 text-amber-700"
                        : browserRunning || runningProfileIds.length > 0
                          ? "bg-emerald-500/15 text-emerald-700"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {anyAgentBusy
                      ? `Agent×${agentBusyEnvIds.length}`
                      : envExecuting
                        ? envBusyReason || "执行中"
                        : agentSeatsSummary
                          ? agentSeatsSummary
                          : runningProfileIds.length > 0
                            ? `${runningProfileIds.length} 运行中`
                            : "未启动"}
                  </span>
                </span>
                {selectedIds.length > 0 ? (
                  <span
                    className="hidden shrink-0 items-center rounded-md border border-border bg-secondary/70 px-2 py-1 text-[10px] font-medium text-muted-foreground sm:inline-flex"
                    title={
                      "已勾选 / 已打开：仅描述浏览器状态，不限制多开。" +
                      (agentMaxAllowed != null
                        ? ` AI 并行上限 ${agentMaxAllowed}（Free=1 / Pro=席位），只约束 Agent/填表同时控制多少个已打开环境。`
                        : " Pro AI 并行跟授权席位走。")
                    }
                  >
                    已选 {selectedIds.length}
                    {selectedRunningIds.length !== selectedIds.length
                      ? ` · 已开 ${selectedRunningIds.length}`
                      : selectedIds.length > 0
                        ? ` · 已开 ${selectedRunningIds.length}`
                        : ""}
                    {agentMaxAllowed != null ? ` · AI并行≤${agentMaxAllowed}` : ""}
                  </span>
                ) : null}
              </div>
            ) : (
              <span className="context-badge border-border bg-secondary/60 text-muted-foreground">
                未绑定环境 — 请在左侧选择或启动
              </span>
            )}
          </div>
        </div>

        <div className="tab-rail">
          <button
            type="button"
            className={`tab-item ${activeTab === "agent" ? "tab-item-active" : ""}`}
            onClick={() => setActiveTab("agent")}
          >
            <Bot size={12} />
            浏览器 Agent
          </button>
          <button
            type="button"
            className={`tab-item ${activeTab === "ai" ? "tab-item-active" : ""}`}
            onClick={() => setActiveTab("ai")}
          >
            <Sparkles size={12} />
            AI 智能填表
          </button>
          <button
            type="button"
            className={`tab-item ${activeTab === "trajectory" ? "tab-item-active" : ""}`}
            onClick={() => setActiveTab("trajectory")}
          >
            <History size={12} />
            轨迹记忆
          </button>
        </div>
      </div>

      {activeTab === "agent" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-2 pt-1">
          {scrapedData && scrapedData.rows.length > 0 ? (
            <ScraperDataPanel
              data={scrapedData.rows}
              profileId={targetProfileId ?? ""}
              meta={{
                mode: scrapedData.mode,
                url: scrapedData.url,
                count: scrapedData.count,
                localPath: scrapedData.localPath,
              }}
              onToastError={onError}
              onToastSuccess={(message) => {
                if (targetProfileId) {
                  pushAgentLineFor(targetProfileId, "success", message);
                }
              }}
              onClear={() => {
                if (!targetProfileId) {
                  return;
                }
                setScrapedDataByEnv((current) => {
                  const next = { ...current };
                  delete next[targetProfileId];
                  return next;
                });
              }}
            />
          ) : null}
          <AgentThoughtChain
            lines={agentLines}
            title="Agent Monitor"
            emptyHint="Agent 思考流将显示在这里…"
            className="mb-2 min-h-0 flex-1"
            onClear={() => {
              if (!targetProfileId) {
                return;
              }
              setAgentLinesByEnv((current) => ({ ...current, [targetProfileId]: [] }));
            }}
            headerActions={
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded border border-code-border bg-code-hover px-1.5 text-[10px] font-medium text-code-text transition-colors hover:border-code-muted hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={
                    browserTargetIds.length === 0 ||
                    selectedStoppedCount === 0 ||
                    browserTargetsBusy
                  }
                  title={
                    browserTargetIds.length === 0
                      ? "请先选择环境"
                      : selectedStoppedCount === 0
                        ? "所选环境均已在运行"
                        : selectedStoppedCount > 1
                          ? `启动已选中的 ${selectedStoppedCount} 个未运行环境`
                          : "启动当前环境浏览器"
                  }
                  onClick={() => void handleStartBrowser()}
                >
                  <Play size={10} />
                  {browserTargetsBusy && selectedStoppedCount > 0
                    ? "启动中"
                    : selectedStoppedCount > 1
                      ? `启动(${selectedStoppedCount})`
                      : "启动"}
                </button>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded border border-code-border bg-code-hover px-1.5 text-[10px] font-medium text-code-text transition-colors hover:border-code-muted hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={
                    browserTargetIds.length === 0 ||
                    selectedRunningCount === 0 ||
                    browserTargetsBusy
                  }
                  title={
                    selectedRunningCount === 0
                      ? "所选环境均未运行"
                      : selectedRunningCount > 1
                        ? `停止已选中的 ${selectedRunningCount} 个运行中环境`
                        : "停止当前环境浏览器"
                  }
                  onClick={() => void handleStopBrowser()}
                >
                  <Square size={10} />
                  {browserTargetsBusy && selectedRunningCount > 0
                    ? "停止中"
                    : selectedRunningCount > 1
                      ? `停止(${selectedRunningCount})`
                      : "停止"}
                </button>
              </div>
            }
          />

          <div className="shrink-0 space-y-2">
            <textarea
              className="min-h-[80px] w-full resize-y rounded-md border border-border bg-background px-3.5 py-2.5 text-xs leading-5 outline-none ring-primary/20 focus:ring-2"
              value={agentGoal}
              onChange={(event) => setAgentGoal(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  if (
                    agentGoal.trim() &&
                    (selectedRunningIds.some((id) => !agentBusyEnvIds.includes(id)) ||
                      /(?:环境\s*#?\s*|#)\d+/i.test(agentGoal))
                  ) {
                    void handleStartAgent();
                  }
                }
              }}
              disabled={false}
              placeholder="未点名=操作左侧已勾选且已打开的环境；点名例：#2 打开百度 #5 打开谷歌（浏览器不限；Free AI≤1 免费核；Pro AI≤席位）"
              rows={3}
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <button
                type="button"
                className="btn btn-primary h-8 shrink-0 px-3.5 text-xs"
                disabled={
                  !agentGoal.trim() ||
                  (selectedRunningIds.length === 0 &&
                    !/(?:环境\s*#?\s*|#)\d+/i.test(agentGoal.trim()))
                }
                title={
                  selectedIds.length === 0 && !/(?:环境\s*#?\s*|#)\d+/i.test(agentGoal.trim())
                    ? "请先在左侧勾选环境，或在提示词中用 #ID 点名"
                    : selectedRunningIds.length === 0 &&
                        !/(?:环境\s*#?\s*|#)\d+/i.test(agentGoal.trim())
                      ? "勾选的环境尚未打开"
                      : agentSeatsSummary
                        ? `Ctrl+Enter 发送 · ${agentSeatsSummary}`
                        : "Ctrl+Enter 发送"
                }
                onClick={() => void handleStartAgent()}
              >
                <Bot size={13} />
                {anyAgentBusy ? "运行中…" : "启动 Agent"}
              </button>
              {anyAgentBusy ? (
                <button
                  type="button"
                  className="btn btn-outline h-8 shrink-0 px-3 text-xs"
                  onClick={() => void handleAbortAgent()}
                >
                  中止全部
                </button>
              ) : null}
              <label
                className="inline-flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-foreground"
                title="勾选后本轮成功结束时写入 SQLite/磁盘，供沙盘回放；关闭则仅内存维护当次上下文"
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-border accent-primary"
                  checked={enableRecording}
                  onChange={(event) => {
                    const next = event.target.checked;
                    setEnableRecording(next);
                    persistAgentEnableRecording(next);
                  }}
                />
                录制执行轨迹 (用于沙盘回放)
              </label>
              {enableRecording ? (
                <span className="text-[10px] text-success">开启后成功任务写入「轨迹记忆」</span>
              ) : (
                <span className="text-[10px] text-muted-foreground">关闭时仅内存上下文，不落盘</span>
              )}
            </div>
          </div>

          <AgentConfirmModal
            open={agentConfirmOpen}
            loading={agentConfirmLoading}
            url={agentConfirmUrl}
            reason={[humanCohortLabel, agentConfirmReason].filter(Boolean).join(" · ")}
            actions={agentConfirmActions}
            fillValues={agentFillValues}
            onFillValueChange={(id, value) =>
              setAgentFillValues((current) => ({ ...current, [id]: value }))
            }
            onConfirm={() => void handleAgentConfirm()}
            onCancel={() => void handleAgentCancelConfirm()}
          />

          <AgentHandoverModal
            open={agentHandoverOpen}
            loading={agentHandoverLoading}
            url={agentHandoverUrl}
            reason={[humanCohortLabel, agentHandoverReason].filter(Boolean).join("\n")}
            onContinue={() => void handleHandoverContinue()}
            onAbort={() => void handleHandoverAbort()}
          />
        </div>
      ) : null}

      {activeTab === "ai" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-2 pt-1">
          <AIChatPanel
            lines={lines}
            chatInput={chatInput}
            chatLoading={chatLoading}
            chatDisabled={
              aiSubmitting ||
              previewLoading ||
              directFillSubmitting ||
              smartFillSubmitting
            }
            quickMenuOpen={quickMenuOpen}
            quickCommands={quickCommands}
            quickMenuRef={quickMenuRef}
            emptyHint="向 AI 提问，支持多轮上下文。天气/常识可直接问；也可问表单结构、风控排查或测试数据映射…"
            onChatInputChange={setChatInput}
            onSend={() => void handleSendChat()}
            onQuickMenuToggle={() => setQuickMenuOpen((current) => !current)}
            onQuickCommand={(command) => void handleQuickCommand(command)}
            onSaveCustomCommand={() => void handleSaveCustomCommand()}
            onDeleteCustomCommand={(command) => void handleDeleteCustomCommand(command)}
          />

          <div className="mt-3 shrink-0 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                原始填表数据
              </label>
              <div className="flex flex-wrap items-center justify-end gap-3">
                <label
                  className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground"
                  title="跳过 AI 混合推演"
                >
                  <button
                    type="button"
                    role="switch"
                    aria-checked={skipHybrid}
                    disabled={previewLoading || aiSubmitting}
                    className={`ui-switch ${skipHybrid ? "bg-primary" : "bg-muted"}`}
                    onClick={() => setSkipHybrid((current) => !current)}
                  >
                    <span
                      className={`ui-switch-knob ${skipHybrid ? "translate-x-3.5" : "translate-x-0.5"}`}
                    />
                  </button>
                  跳过推演
                </label>
                <label
                  className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground"
                  title={
                    forceHumanConfirm
                      ? skipHybrid
                        ? "开启：用本地 JSON 预览后再填表"
                        : "开启：混合推演完成后先核对 JSON 再填表"
                      : "关闭：跳过预览弹窗，直接执行填表"
                  }
                >
                  <button
                    type="button"
                    role="switch"
                    aria-checked={forceHumanConfirm}
                    disabled={previewLoading || aiSubmitting}
                    className={`ui-switch ${forceHumanConfirm ? "bg-primary" : "bg-muted"}`}
                    onClick={() => setForceHumanConfirm((current) => !current)}
                  >
                    <span
                      className={`ui-switch-knob ${
                        forceHumanConfirm ? "translate-x-3.5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                  人工确认
                </label>
                <label
                  className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground"
                  title="填表后是否回车"
                >
                  <button
                    type="button"
                    role="switch"
                    aria-checked={pressEnterAfterFill}
                    disabled={
                      previewLoading || aiSubmitting || directFillSubmitting || smartFillSubmitting
                    }
                    className={`ui-switch ${pressEnterAfterFill ? "bg-primary" : "bg-muted"}`}
                    onClick={() => setPressEnterAfterFill((current) => !current)}
                  >
                    <span
                      className={`ui-switch-knob ${
                        pressEnterAfterFill ? "translate-x-3.5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                  回车
                </label>
              </div>
            </div>
            <textarea
              className="min-h-[64px] w-full resize-y rounded-md border border-border bg-background px-3.5 py-2.5 font-mono text-xs leading-5 outline-none ring-primary/20 focus:ring-2"
              value={aiRawInput}
              onChange={(event) => setAiRawInput(event.target.value)}
              placeholder='粘贴填表 JSON / YAML…'
            />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <button
                type="button"
                className="btn btn-outline w-full py-2.5 text-sm"
                disabled={
                  envExecuting ||
                  directFillSubmitting ||
                  aiSubmitting ||
                  previewLoading ||
                  smartFillSubmitting
                }
                onClick={() => void handleDirectFill()}
                title={
                  envExecuting
                    ? `当前环境正忙（${envBusyReason}）`
                    : "按 JSON 键名直接映射填表"
                }
              >
                <PenLine size={15} />
                {directFillSubmitting ? "填表中…" : "直接填表"}
              </button>
              <button
                type="button"
                className="btn btn-outline w-full py-2.5 text-sm"
                disabled={
                  envExecuting ||
                  !smartFillEnabled ||
                  smartFillSubmitting ||
                  aiSubmitting ||
                  previewLoading ||
                  directFillSubmitting ||
                  chatLoading
                }
                onClick={() => void handleSmartFill()}
                title={
                  envExecuting
                    ? `当前环境正忙（${envBusyReason}）`
                    : smartFillEnabled
                      ? "根据上方自然语言 + 元素提取 JSON 智能补全并填表"
                      : "需启动环境并开启元素提取"
                }
              >
                <Wand2 size={15} />
                {smartFillSubmitting ? "智能填表中…" : "智能填表"}
              </button>
              <button
                type="button"
                className="btn btn-primary w-full py-2.5 text-sm"
                disabled={
                  envExecuting ||
                  aiSubmitting ||
                  previewLoading ||
                  directFillSubmitting ||
                  smartFillSubmitting
                }
                title={envExecuting ? `当前环境正忙（${envBusyReason}）` : undefined}
                onClick={() => void handleAiRun()}
              >
                <Sparkles size={15} />
                {previewLoading ? "推演中…" : aiSubmitting ? "执行中…" : "AI 混合填表"}
              </button>
            </div>
            {!smartFillEnabled ? (
              <p className="text-[10px] text-muted-foreground">
                「智能填表」需在环境列表开启元素提取，并用上方聊天框自然语言描述要填的内容（与 AI 聊天共用输入框；填表进行中会暂锁聊天）。
              </p>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                「智能填表」读取聊天输入框的自然语言；「直接填表 / AI 混合填表」读取下方 JSON。三者互斥执行，不会并行抢同一环境。
              </p>
            )}
          </div>

          <FillConfirmModal
            open={confirmOpen}
            loading={aiSubmitting}
            previewJson={confirmJson}
            onPreviewJsonChange={setConfirmJson}
            onConfirm={() => void handleConfirmFill()}
            onClose={() => {
              if (!aiSubmitting) {
                setConfirmOpen(false);
              }
            }}
          />
        </div>
      ) : null}

      {activeTab === "trajectory" ? (
        <TrajectoryMemoryPanel
          currentDomain={currentDomain}
          boundProfileId={targetProfileId}
          trajectories={trajectories}
          selectedId={selectedTrajectoryId}
          busy={trajectoryBusy}
          envExecuting={envExecuting}
          busyReason={envBusyReason}
          executingId={executingTrajectoryId}
          profiles={profiles}
          busyEnvIds={allBusyEnvIds}
          recordingEnabled={enableRecording}
          monitorLines={replayLines}
          onClearMonitor={() => {
            setReplayWatchEnvIds([]);
            setReplayLinesByEnv({});
          }}
          onSelect={setSelectedTrajectoryId}
          onRefresh={() => void refreshTrajectories()}
          onDelete={(row) => void handleDeleteTrajectory(row)}
          onExecute={(row) => void handleExecuteTrajectory(row)}
          onStop={() => void handleStopTrajectory()}
          onExecutingIdChange={setExecutingTrajectoryId}
          onClearExecutingId={(trajectoryId) => {
            setExecutingTrajectoryId((current) =>
              current === trajectoryId ? null : current,
            );
          }}
          onOpenAgentForRecording={openAgentForRecording}
          onError={onError}
          onLog={(tone, text) => pushReplayLine(tone, text)}
          onEnvTrajectoryBusy={setEnvTrajectoryBusy}
        />
      ) : null}
    </aside>
  );
}

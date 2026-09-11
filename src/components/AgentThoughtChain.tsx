/**
 * Agent Monitor — 结构化 AI 思考流（Thought Chain）卡片
 * 纯 Tailwind，无第三方图表库。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  ClipboardCopy,
  Eraser,
  Eye,
  Globe,
  Hand,
  MousePointerClick,
  Pin,
  PinOff,
  ScanSearch,
  Sparkles,
} from "lucide-react";

import { classifyAgentMonitorLine, type AgentThoughtKind } from "../lib/agentThoughtChain";
import type { TerminalLine } from "../types";

interface AgentThoughtChainProps {
  lines: TerminalLine[];
  className?: string;
  emptyHint?: string;
  title?: string;
  headerActions?: ReactNode;
  onClear?: () => void;
}

function kindIcon(kind: AgentThoughtKind, tool?: string) {
  if (kind === "thought") {
    return Brain;
  }
  if (kind === "perceive") {
    return Eye;
  }
  if (kind === "alert") {
    return tool === "handover" ? Hand : AlertTriangle;
  }
  if (kind === "action") {
    if (tool === "navigate") {
      return Globe;
    }
    if (tool === "click" || tool === "fill") {
      return MousePointerClick;
    }
    if (tool === "vision") {
      return ScanSearch;
    }
    return Sparkles;
  }
  if (kind === "success") {
    return CircleCheck;
  }
  if (kind === "error") {
    return CircleX;
  }
  return Sparkles;
}

function cardShell(kind: AgentThoughtKind): string {
  switch (kind) {
    case "thought":
      return "border-code-border/80 bg-code-hover/30";
    case "perceive":
      return "border-sky-500/25 bg-sky-500/5";
    case "action":
      return "border-emerald-500/30 bg-emerald-500/5";
    case "alert":
      return "border-amber-400/45 bg-amber-500/10";
    case "success":
      return "border-emerald-500/35 bg-emerald-500/10";
    case "error":
      return "border-red-400/40 bg-red-500/10";
    default:
      return "border-code-border bg-transparent";
  }
}

function accentBar(kind: AgentThoughtKind): string {
  switch (kind) {
    case "thought":
      return "bg-code-muted";
    case "perceive":
      return "bg-sky-400";
    case "action":
      return "bg-emerald-400";
    case "alert":
      return "bg-amber-400";
    case "success":
      return "bg-emerald-500";
    case "error":
      return "bg-red-400";
    default:
      return "bg-code-border";
  }
}

function ThoughtCard({
  line,
  classified,
}: {
  line: TerminalLine;
  classified: ReturnType<typeof classifyAgentMonitorLine>;
}) {
  const [open, setOpen] = useState(false);
  const Icon = kindIcon(classified.kind, classified.tool);
  const detail = classified.detail ?? classified.body;

  return (
    <div className={`relative overflow-hidden rounded-md border ${cardShell("thought")}`}>
      <div className={`absolute inset-y-0 left-0 w-0.5 ${accentBar("thought")}`} />
      <button
        type="button"
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors hover:bg-code-hover/40"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icon size={13} className="mt-0.5 shrink-0 text-code-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-code-muted">
              {classified.title}
            </span>
            <span className="text-[10px] text-code-subtle">[{line.ts}]</span>
          </div>
          <div className="mt-0.5 truncate text-[11px] leading-4 text-code-text/90">
            {classified.body}
          </div>
        </div>
        <ChevronDown
          size={13}
          className={`mt-0.5 shrink-0 text-code-subtle transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open ? (
        <div className="border-t border-code-border/60 px-2.5 py-2 pl-7">
          <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-code-muted">
            {detail}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function ActionCard({
  line,
  classified,
}: {
  line: TerminalLine;
  classified: ReturnType<typeof classifyAgentMonitorLine>;
}) {
  const Icon = kindIcon(classified.kind, classified.tool);
  return (
    <div className={`relative overflow-hidden rounded-md border ${cardShell("action")}`}>
      <div className={`absolute inset-y-0 left-0 w-0.5 ${accentBar("action")}`} />
      <div className="flex items-start gap-2 px-2.5 py-2 pl-3">
        <Icon size={13} className="mt-0.5 shrink-0 text-emerald-400" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold tracking-wide text-emerald-300/90">
              {classified.title}
            </span>
            {classified.target ? (
              <span className="rounded bg-emerald-500/15 px-1.5 py-px text-[10px] text-emerald-200/90">
                {classified.target}
              </span>
            ) : null}
            <span className="text-[10px] text-code-subtle">[{line.ts}]</span>
          </div>
          <div className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-4 text-code-text">
            {classified.body}
          </div>
        </div>
      </div>
    </div>
  );
}

function AlertCard({
  line,
  classified,
}: {
  line: TerminalLine;
  classified: ReturnType<typeof classifyAgentMonitorLine>;
}) {
  const Icon = kindIcon("alert", classified.tool);
  return (
    <div className={`relative overflow-hidden rounded-md border ${cardShell("alert")}`}>
      <div className={`absolute inset-y-0 left-0 w-0.5 ${accentBar("alert")}`} />
      <div className="flex items-start gap-2 px-2.5 py-2.5 pl-3">
        <Icon size={14} className="mt-0.5 shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-200">
              {classified.title}
            </span>
            <span className="rounded border border-amber-400/30 px-1 py-px text-[9px] text-amber-200/80">
              需人工
            </span>
            <span className="text-[10px] text-code-subtle">[{line.ts}]</span>
          </div>
          <div className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-4 text-code-text">
            {classified.body}
          </div>
          {classified.detail ? (
            <div className="mt-1.5 rounded border border-amber-400/20 bg-black/20 px-2 py-1.5 font-mono text-[10px] leading-4 text-amber-100/80">
              {classified.detail}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function GenericCard({
  line,
  classified,
}: {
  line: TerminalLine;
  classified: ReturnType<typeof classifyAgentMonitorLine>;
}) {
  const Icon = kindIcon(classified.kind, classified.tool);
  const tone =
    classified.kind === "error"
      ? "text-red-300"
      : classified.kind === "success"
        ? "text-emerald-300"
        : classified.kind === "perceive"
          ? "text-sky-300"
          : "text-code-muted";

  return (
    <div
      className={`relative overflow-hidden rounded-md border ${cardShell(classified.kind)}`}
    >
      <div className={`absolute inset-y-0 left-0 w-0.5 ${accentBar(classified.kind)}`} />
      <div className="flex items-start gap-2 px-2.5 py-2 pl-3">
        <Icon size={13} className={`mt-0.5 shrink-0 ${tone}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] font-medium tracking-wide ${tone}`}>
              {classified.title}
            </span>
            <span className="text-[10px] text-code-subtle">[{line.ts}]</span>
          </div>
          <div className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-4 text-code-text">
            {classified.body}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AgentThoughtChain({
  lines,
  className = "",
  emptyHint = "Agent 思考流将显示在这里…",
  title = "Agent Monitor",
  headerActions,
  onClear,
}: AgentThoughtChainProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);

  const cards = useMemo(
    () =>
      lines.map((line) => ({
        line,
        classified: classifyAgentMonitorLine(line),
      })),
    [lines],
  );

  useEffect(() => {
    const node = containerRef.current;
    if (!node || !autoScroll) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [cards, autoScroll]);

  const handleCopy = async () => {
    const text = lines.map((line) => `[${line.ts}] ${line.text}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-code-border bg-code-bg ${className}`}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-code-border px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-code-muted">
          {title}
        </span>
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-code-subtle transition-colors hover:bg-code-hover hover:text-code-text"
            onClick={() => void handleCopy()}
            title="复制日志"
            aria-label="复制日志"
          >
            {copied ? <Check size={13} /> : <ClipboardCopy size={13} />}
          </button>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-code-subtle transition-colors hover:bg-code-hover hover:text-code-text"
            onClick={() => setAutoScroll((current) => !current)}
            title={autoScroll ? "关闭自动滚动" : "开启自动滚动"}
            aria-label="自动滚动"
          >
            {autoScroll ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
          {onClear ? (
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-code-subtle transition-colors hover:bg-code-hover hover:text-code-text"
              onClick={onClear}
              title="清空日志"
              aria-label="清空日志"
            >
              <Eraser size={13} />
            </button>
          ) : null}
          {headerActions ? (
            <div className="flex shrink-0 items-center gap-1 border-l border-code-border pl-1.5">
              {headerActions}
            </div>
          ) : null}
        </div>
      </div>

      <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        {cards.length === 0 ? (
          <div className="px-1 py-2 text-[11px] text-code-subtle">{emptyHint}</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {cards.map(({ line, classified }) => {
              if (classified.kind === "thought") {
                return <ThoughtCard key={line.id} line={line} classified={classified} />;
              }
              if (classified.kind === "action") {
                return <ActionCard key={line.id} line={line} classified={classified} />;
              }
              if (classified.kind === "alert") {
                return <AlertCard key={line.id} line={line} classified={classified} />;
              }
              return <GenericCard key={line.id} line={line} classified={classified} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

import { Sparkles, Trash2 } from "lucide-react";

import { domainMatchesTemplate } from "../lib/domain";
import type { FormTemplate, RpaAction, TerminalLine } from "../types";
import { RpaControls } from "./RpaControls";
import { SaveTemplateModal } from "./SaveTemplateModal";
import { TerminalLog } from "./TerminalLog";

interface RpaManagerProps {
  targetProfileId: string | null;
  currentDomain: string;
  sortedTemplates: FormTemplate[];
  selectedTemplateId: number | "";
  selectedTemplate: FormTemplate | null;
  autoTrust: boolean;
  rawInput: string;
  skipHybrid: boolean;
  pressEnterAfterFill: boolean;
  isSubmitting: boolean;
  previewLoading: boolean;
  rpaState: "idle" | "running" | "paused" | "complete";
  rpaMessage: string;
  currentActions: RpaAction[];
  rpaControlBusy: boolean;
  saveModalOpen: boolean;
  saveLoading: boolean;
  lines: TerminalLine[];
  onRawInputChange: (value: string) => void;
  onSkipHybridChange: (value: boolean) => void;
  onPressEnterAfterFillChange: (value: boolean) => void;
  onTemplateChange: (value: string) => void;
  onAutoTrustToggle: (enabled: boolean) => void;
  onDeleteTemplate: (templateId: number) => void;
  onPause: () => void;
  onRescan: () => void;
  onResume: () => void;
  onSaveTemplateOpen: () => void;
  onSaveTemplate: (name: string) => void;
  onSaveTemplateClose: () => void;
  onExecute: () => void;
}

export function RpaManager({
  targetProfileId,
  currentDomain,
  sortedTemplates,
  selectedTemplateId,
  selectedTemplate,
  autoTrust,
  rawInput,
  skipHybrid,
  pressEnterAfterFill,
  isSubmitting,
  previewLoading,
  rpaState,
  rpaMessage,
  currentActions,
  rpaControlBusy,
  saveModalOpen,
  saveLoading,
  lines,
  onRawInputChange,
  onSkipHybridChange,
  onPressEnterAfterFillChange,
  onTemplateChange,
  onAutoTrustToggle,
  onDeleteTemplate,
  onPause,
  onRescan,
  onResume,
  onSaveTemplateOpen,
  onSaveTemplate,
  onSaveTemplateClose,
  onExecute,
}: RpaManagerProps) {
  const rpaLines = lines.filter(
    (line) =>
      line.role !== "user" &&
      line.role !== "assistant" &&
      !line.text.startsWith("[你]") &&
      !line.text.startsWith("[AI]"),
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="h-[240px] min-h-[14rem] max-h-[42%] shrink-0 overflow-hidden border-b border-border bg-secondary/40 p-2">
        <TerminalLog
          lines={rpaLines}
          className="h-full min-h-0"
          emptyHint="RPA 执行日志与 Sidecar 状态将显示在这里…"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="space-y-3">
          <div className="space-y-2">
            <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              RPA 模板
            </label>
            <div className="flex items-center gap-2">
              <select
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-2 text-xs outline-none ring-primary/20 focus:ring-2"
                value={selectedTemplateId === "" ? "" : String(selectedTemplateId)}
                onChange={(event) => onTemplateChange(event.target.value)}
                disabled={isSubmitting || previewLoading}
              >
                <option value="">（不使用模板 / 录制新模式）</option>
                {sortedTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {domainMatchesTemplate(currentDomain, template.domain) ? "★ " : ""}
                    {template.template_name} - {template.domain}
                  </option>
                ))}
              </select>
              {selectedTemplate ? (
                <button
                  type="button"
                  className="icon-button shrink-0 text-destructive"
                  title="删除模板"
                  onClick={() => void onDeleteTemplate(selectedTemplate.id)}
                  disabled={isSubmitting}
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
            </div>
            <label className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
              <span>当前网站自动信任</span>
              <button
                type="button"
                role="switch"
                aria-checked={autoTrust}
                className={`relative h-5 w-9 rounded-full transition-colors ${autoTrust ? "bg-primary" : "bg-secondary"}`}
                onClick={() => void onAutoTrustToggle(!autoTrust)}
                disabled={!selectedTemplate || isSubmitting}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                    autoTrust ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </button>
            </label>
          </div>

          <div className="space-y-2">
            <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              填表 JSON 数据
            </label>
            <textarea
              className="min-h-[72px] w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none ring-primary/20 focus:ring-2"
              value={rawInput}
              onChange={(event) => onRawInputChange(event.target.value)}
              placeholder='粘贴填表 JSON / YAML…'
            />
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                className="rounded border-border"
                checked={skipHybrid}
                onChange={(event) => onSkipHybridChange(event.target.checked)}
                disabled={previewLoading || isSubmitting}
              />
              纯 RPA 模式（跳过 AI 推演，零 Token）
            </label>
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                className="rounded border-border"
                checked={pressEnterAfterFill}
                onChange={(event) => onPressEnterAfterFillChange(event.target.checked)}
                disabled={previewLoading || isSubmitting}
              />
              填表完成后自动回车
            </label>
            {currentActions.length > 0 ? (
              <p className="text-[10px] text-muted-foreground">
                动作流 {currentActions.length} 步 · {rpaState}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 z-50 shrink-0 border-t border-border bg-card p-4 shadow-panel">
        <RpaControls
          rpaState={rpaState}
          rpaMessage={rpaMessage}
          currentActionsCount={currentActions.length}
          controlBusy={rpaControlBusy}
          onPause={onPause}
          onRescan={onRescan}
          onResume={onResume}
          onSaveTemplateOpen={onSaveTemplateOpen}
          embedded
        />
        <button
          type="button"
          className="btn btn-primary mt-3 w-full py-2 text-sm"
          disabled={isSubmitting || previewLoading || !targetProfileId}
          onClick={onExecute}
        >
          <Sparkles size={15} />
          {isSubmitting ? "执行中…" : "执行 RPA 模板"}
        </button>
      </div>

      <SaveTemplateModal
        open={saveModalOpen}
        loading={saveLoading}
        stepCount={currentActions.length}
        defaultName={selectedTemplate?.template_name ?? ""}
        onConfirm={onSaveTemplate}
        onClose={onSaveTemplateClose}
      />
    </div>
  );
}

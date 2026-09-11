import { Modal } from "./Modal";

interface AgentHandoverModalProps {
  open: boolean;
  loading: boolean;
  url: string;
  reason: string;
  onContinue: () => void;
  onAbort: () => void;
}

export function AgentHandoverModal({
  open,
  loading,
  url,
  reason,
  onContinue,
  onAbort,
}: AgentHandoverModalProps) {
  return (
    <Modal
      open={open}
      title="人工接管 · Agent 已暂停"
      description="请在浏览器中手动完成当前步骤（验证码/风控等），完成后点继续让 Agent 重新感知页面。"
      onClose={onAbort}
      widthClass="max-w-lg"
    >
      <div className="space-y-3">
        {url ? (
          <p className="truncate text-[11px] text-muted-foreground" title={url}>
            页面：{url}
          </p>
        ) : null}
        <p className="text-sm leading-6 text-foreground whitespace-pre-wrap">
          {reason || "AI 连续尝试失败或无法处理当前页，需要你手动操作。"}
        </p>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" className="btn btn-outline px-4" onClick={onAbort} disabled={loading}>
            中止 Agent
          </button>
          <button
            type="button"
            className="btn btn-primary px-4"
            onClick={onContinue}
            disabled={loading}
          >
            {loading ? "提交中…" : "我已处理，继续"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

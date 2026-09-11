import { Modal } from "./Modal";

interface SaveTemplateModalProps {
  open: boolean;
  loading: boolean;
  defaultName?: string;
  stepCount: number;
  onConfirm: (templateName: string) => void;
  onClose: () => void;
}

export function SaveTemplateModal({
  open,
  loading,
  defaultName = "",
  stepCount,
  onConfirm,
  onClose,
}: SaveTemplateModalProps) {
  return (
    <Modal
      open={open}
      title="保存 RPA 模板"
      description={`将当前 ${stepCount} 步动作流保存为模板，便于同站点一键回放。`}
      onClose={onClose}
      widthClass="max-w-md"
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const input = form.elements.namedItem("templateName") as HTMLInputElement;
          const name = input.value.trim();
          if (name) {
            onConfirm(name);
          }
        }}
      >
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            模板备注名称
          </label>
          <input
            name="templateName"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none ring-primary/20 focus:ring-2"
            defaultValue={defaultName}
            placeholder="例如 Shopify-完整结账流"
            disabled={loading}
            autoFocus
          />
        </div>
        <div className="flex items-center justify-end gap-2">
          <button type="button" className="btn btn-outline px-4" onClick={onClose} disabled={loading}>
            取消
          </button>
          <button type="submit" className="btn btn-primary px-4" disabled={loading || stepCount === 0}>
            {loading ? "保存中…" : "保存模板"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

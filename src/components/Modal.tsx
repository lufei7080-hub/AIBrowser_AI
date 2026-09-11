import { X } from "lucide-react";
import type { PointerEvent, ReactNode } from "react";

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  widthClass?: string;
  layer?: "normal" | "elevated";
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  widthClass = "max-w-lg",
  layer = "normal",
}: ModalProps) {
  if (!open) {
    return null;
  }

  const overlayClass = layer === "elevated" ? "modal-overlay modal-overlay-elevated" : "modal-overlay";

  const handleOverlayPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      event.preventDefault();
      onClose();
    }
  };

  const handlePanelPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const handleCloseClick = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <div className={overlayClass} onPointerDown={handleOverlayPointerDown}>
      <div
        className={`modal-panel ${widthClass}`}
        onPointerDown={handlePanelPointerDown}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
            {description ? (
              <p className="mt-1 text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            className="icon-button"
            onPointerDown={handleCloseClick}
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

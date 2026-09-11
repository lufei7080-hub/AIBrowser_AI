import { Plus, Trash2 } from "lucide-react";

/** 启动时强制首位打开的首页（不可删除） */
export const FORCED_STARTUP_HOMEPAGE = "https://www.browserscan.net/zh";

export function parseStartupUrlsJson(raw: string | null | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .filter(
        (url) =>
          url.replace(/\/$/, "").toLowerCase() !==
          FORCED_STARTUP_HOMEPAGE.replace(/\/$/, "").toLowerCase(),
      );
  } catch {
    return [];
  }
}

export function serializeStartupUrls(urls: string[]): string {
  const cleaned = urls
    .map((item) => item.trim())
    .filter(Boolean)
    .filter(
      (url) =>
        url.replace(/\/$/, "").toLowerCase() !==
        FORCED_STARTUP_HOMEPAGE.replace(/\/$/, "").toLowerCase(),
    );
  return JSON.stringify(cleaned);
}

interface StartupUrlsEditorProps {
  urls: string[];
  onChange: (urls: string[]) => void;
  disabled?: boolean;
}

/**
 * 启动自动开页编辑器：首位锁定 BrowserScan，可追加多个网站。
 */
export function StartupUrlsEditor({ urls, onChange, disabled }: StartupUrlsEditorProps) {
  const updateAt = (index: number, value: string) => {
    const next = [...urls];
    next[index] = value;
    onChange(next);
  };

  const removeAt = (index: number) => {
    onChange(urls.filter((_, i) => i !== index));
  };

  const addRow = () => {
    if (urls.length >= 20) {
      return;
    }
    onChange([...urls, ""]);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="field-label mb-0">启动时自动打开网页</span>
        <button
          type="button"
          className="btn btn-outline h-7 px-2 text-[11px]"
          disabled={disabled || urls.length >= 20}
          onClick={addRow}
        >
          <Plus size={12} />
          添加网站
        </button>
      </div>
      <p className="text-[11px] leading-4 text-muted-foreground">
        第 1 个标签永远打开 BrowserScan；其后按下方顺序依次新开标签。
      </p>
      <div className="space-y-1.5 rounded-md border border-border bg-secondary/15 p-2.5">
        <div className="flex items-center gap-2">
          <span className="w-6 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground">
            1
          </span>
          <input
            className="field-input font-mono text-xs"
            value={FORCED_STARTUP_HOMEPAGE}
            readOnly
            disabled
            title="强制首页，不可修改"
          />
          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            锁定
          </span>
        </div>
        {urls.map((url, index) => (
          <div key={`startup-extra-${index}`} className="flex items-center gap-2">
            <span className="w-6 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground">
              {index + 2}
            </span>
            <input
              className="field-input font-mono text-xs"
              value={url}
              disabled={disabled}
              placeholder="https://example.com"
              onChange={(event) => updateAt(index, event.target.value)}
            />
            <button
              type="button"
              className="btn-icon-danger shrink-0"
              disabled={disabled}
              title="移除"
              aria-label="移除网站"
              onClick={() => removeAt(index)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

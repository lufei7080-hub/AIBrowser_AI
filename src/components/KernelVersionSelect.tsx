import {
  FREE_CHROMIUM_VERSION,
  KERNEL_PRESET_OPTIONS,
  browserVersionFromPreset,
  isFingerprintOnlyKernelPin,
  presetIdFromBrowserVersion,
  type KernelPresetId,
} from "../lib/kernelPolicy";

interface KernelVersionSelectProps {
  value: string;
  onChange: (browserVersion: string) => void;
  disabled?: boolean;
  showFreeKeyHint?: boolean;
}

/** Shared Chromium pin picker for settings / create / batch create. */
export function KernelVersionSelect({
  value,
  onChange,
  disabled,
  showFreeKeyHint = true,
}: KernelVersionSelectProps) {
  const trimmed = value.trim();
  const preset = presetIdFromBrowserVersion(trimmed);
  const selectValue: KernelPresetId | "custom" = preset;
  const hint =
    selectValue === "custom"
      ? "自定义完整 Chromium 版本号（4 或 5 段）。下载/启动将严格使用此 pin，不会自动跳到最新。"
      : KERNEL_PRESET_OPTIONS.find((o) => o.id === selectValue)?.hint ?? "";

  return (
    <div className="space-y-1.5">
      <label className="field-label">
        Chromium 内核
        <select
          className="field-input"
          disabled={disabled}
          value={selectValue}
          onChange={(event) => {
            const id = event.target.value as KernelPresetId | "custom";
            if (id === "custom") {
              onChange(trimmed || FREE_CHROMIUM_VERSION);
              return;
            }
            onChange(browserVersionFromPreset(id));
          }}
        >
          {KERNEL_PRESET_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
          <option value="custom">自定义 Pin…</option>
        </select>
      </label>
      {selectValue === "custom" ? (
        <input
          className="field-input font-mono text-xs"
          disabled={disabled}
          value={value}
          onChange={(event) =>
            onChange(event.target.value.replace(/[^\d.]/g, "").slice(0, 32))
          }
          placeholder={`例：${FREE_CHROMIUM_VERSION}`}
        />
      ) : null}
      <p className="text-[11px] leading-4 text-muted-foreground">
        {hint}
        {showFreeKeyHint && isFingerprintOnlyKernelPin(value) ? (
          <span className="mt-1 block text-amber-700 dark:text-amber-400">
            免费 Key：此内核仅指纹浏览；AI / Agent / 填表将被拦截。打开浏览器不限数量。
          </span>
        ) : null}
      </p>
    </div>
  );
}

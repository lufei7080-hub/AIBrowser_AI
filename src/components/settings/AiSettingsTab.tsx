import { Bot, ExternalLink, Plus, PlugZap, Trash2, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  formatInvokeError,
  persistAiSettings,
  testAiConnection,
} from "../../lib/tauri";
import type { AppSettings, ConnectivityStatus } from "../../types";
import {
  AI_PROVIDER_PRESETS,
  aiApiKeyFieldForProvider,
  aiChatModelFieldForProvider,
  buildModelCatalog,
  defaultTaskModelsForProvider,
  getAiApiKeyForSettings,
  normalizeAiProviderId,
  parseAiExtraModels,
  parseAiTaskModels,
  resolveTaskModel,
  serializeAiExtraModels,
  upsertTaskModel,
  type AiProviderId,
  type AiTaskRole,
} from "../../types";
import { createToast } from "../../lib/toast";
import type { ToastMessage } from "../../lib/toast";
import { ConnectivityIndicator } from "./ConnectivityIndicator";
import { SettingsSection } from "./SettingsSection";

interface AiSettingsTabProps {
  settings: AppSettings;
  aiStatus: ConnectivityStatus;
  saving: boolean;
  onSettingsChange: (next: AppSettings) => void;
  onAiStatusChange: (status: ConnectivityStatus) => void;
  onSavingChange: (saving: boolean) => void;
  onToast: (toast: ToastMessage) => void;
  onError: (message: string) => void;
  registerFlushSave?: (flush: () => Promise<void>) => void;
}

export function AiSettingsTab({
  settings,
  aiStatus,
  saving,
  onSettingsChange,
  onAiStatusChange,
  onSavingChange,
  onToast,
  onError,
  registerFlushSave,
}: AiSettingsTabProps) {
  const [persistHint, setPersistHint] = useState("");
  const [newModelId, setNewModelId] = useState("");
  const [newModelVision, setNewModelVision] = useState(false);
  const keySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const providerId = normalizeAiProviderId(settings.ai_provider, settings.deepseek_base_url);
  const provider = AI_PROVIDER_PRESETS.find((item) => item.id === providerId) ?? AI_PROVIDER_PRESETS[2];
  const apiKeyField = aiApiKeyFieldForProvider(providerId);
  const activeApiKey = settings[apiKeyField];

  const catalog = useMemo(
    () => buildModelCatalog(providerId, settings.ai_extra_models ?? "[]"),
    [providerId, settings.ai_extra_models],
  );

  const taskChat = resolveTaskModel(settings, "chat");
  const taskAgent = resolveTaskModel(settings, "agent");
  const taskVision = resolveTaskModel(settings, "vision");

  const saveNow = async (next: AppSettings, opts?: { quiet?: boolean }) => {
    try {
      await persistAiSettings(next);
      if (!opts?.quiet) {
        setPersistHint("已自动保存");
      }
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
      setPersistHint("");
      throw error;
    }
  };

  useEffect(() => {
    registerFlushSave?.(() => saveNow(settingsRef.current, { quiet: true }));
    return () => registerFlushSave?.(() => Promise.resolve());
  }, [registerFlushSave]);

  useEffect(() => {
    return () => {
      if (keySaveTimer.current) {
        clearTimeout(keySaveTimer.current);
      }
    };
  }, []);

  const apply = (partial: Partial<AppSettings>): AppSettings => {
    const next = { ...settings, ...partial };
    onSettingsChange(next);
    onAiStatusChange("idle");
    return next;
  };

  const applyAndSave = async (partial: Partial<AppSettings>) => {
    const next = apply(partial);
    onSavingChange(true);
    try {
      await saveNow(next);
    } finally {
      onSavingChange(false);
    }
  };

  const handleProviderChange = (nextId: AiProviderId) => {
    const next = AI_PROVIDER_PRESETS.find((item) => item.id === nextId);
    if (!next) {
      return;
    }
    const patch: Partial<AppSettings> = { ai_provider: nextId };
    if (nextId === "deepseek" || nextId === "zhipu") {
      patch.deepseek_base_url = next.baseUrl;
    }
    const defaults = defaultTaskModelsForProvider(nextId);
    const map = parseAiTaskModels(settings.ai_task_models);
    if (!map[nextId]?.chat) {
      map[nextId] = defaults;
      patch.ai_task_models = JSON.stringify(map);
      const chatField = aiChatModelFieldForProvider(nextId);
      (patch as Record<string, string>)[chatField] = defaults.chat;
    }
    void applyAndSave(patch);
  };

  const handleTaskModelChange = (role: AiTaskRole, model: string) => {
    const nextTask = upsertTaskModel(settings.ai_task_models ?? "{}", providerId, role, model);
    const patch: Partial<AppSettings> = { ai_task_models: nextTask };
    if (role === "chat") {
      const chatField = aiChatModelFieldForProvider(providerId);
      (patch as Record<string, string>)[chatField] = model;
    }
    void applyAndSave(patch);
  };

  const handleAddModel = () => {
    const id = newModelId.trim();
    if (!id) {
      onToast(createToast("error", "请输入模型 ID，例如 glm-4.5-air"));
      return;
    }
    const extras = parseAiExtraModels(settings.ai_extra_models);
    if (extras.some((m) => m.value.toLowerCase() === id.toLowerCase())) {
      onToast(createToast("error", "该模型已在自定义列表中"));
      return;
    }
    if (catalog.some((m) => m.value.toLowerCase() === id.toLowerCase() && !m.custom)) {
      onToast(createToast("error", "该模型已在预设列表中，可直接在任务下拉中选择"));
      return;
    }
    extras.push({
      value: id,
      label: id,
      hint: "用户添加",
      vision: newModelVision,
      provider: providerId,
      custom: true,
    });
    setNewModelId("");
    setNewModelVision(false);
    void applyAndSave({ ai_extra_models: serializeAiExtraModels(extras) }).then(() => {
      onToast(createToast("success", `已添加模型 ${id}`));
    });
  };

  const handleRemoveExtra = (value: string) => {
    const extras = parseAiExtraModels(settings.ai_extra_models).filter(
      (m) => m.value.toLowerCase() !== value.toLowerCase(),
    );
    void applyAndSave({ ai_extra_models: serializeAiExtraModels(extras) });
  };

  const handleBaseUrlChange = (value: string) => {
    apply({
      deepseek_base_url: value,
      ai_provider: providerId === "custom" ? "custom" : detectProviderKeepCustom(value, providerId),
    });
  };

  const handleApiKeyChange = (value: string) => {
    apply({ [apiKeyField]: value } as Partial<AppSettings>);
    if (keySaveTimer.current) {
      clearTimeout(keySaveTimer.current);
    }
    keySaveTimer.current = setTimeout(() => {
      void saveNow(settingsRef.current).catch(() => undefined);
    }, 400);
  };

  const handleTest = async () => {
    onSavingChange(true);
    onAiStatusChange("testing");
    onError("");
    try {
      await saveNow(settings, { quiet: true });
      const key = getAiApiKeyForSettings(settings);
      await testAiConnection(settings.deepseek_base_url, key);
      onAiStatusChange("success");
      onToast(createToast("success", "AI 连接测试成功"));
    } catch (error) {
      onAiStatusChange("error");
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const handleSave = async () => {
    onSavingChange(true);
    try {
      await saveNow(settings);
      onToast(createToast("success", "设置已保存"));
      onError("");
    } catch (error) {
      const message = formatInvokeError(error);
      onToast(createToast("error", message));
      onError(message);
    } finally {
      onSavingChange(false);
    }
  };

  const userExtras = parseAiExtraModels(settings.ai_extra_models).filter(
    (m) => !m.provider || m.provider === providerId,
  );

  const keyPlaceholder =
    providerId === "zhipu"
      ? "智谱开放平台 API Key"
      : providerId === "custom"
        ? "自定义端点 API Key"
        : "sk-...";

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={<PlugZap size={15} className="text-primary" />}
        title="API 连接"
        description="切换服务商会立即保存；各服务商 Key 分开存放。"
      >
        <label className="field-label">
          服务商
          <select
            className="field-input"
            value={providerId}
            onChange={(event) => handleProviderChange(event.target.value as AiProviderId)}
          >
            {AI_PROVIDER_PRESETS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {provider.docsUrl ? (
          <a
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            href={provider.docsUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={12} />
            查看 {provider.label} 模型文档
          </a>
        ) : null}
        <label className="field-label">
          API Base URL
          <input
            className="field-input"
            value={settings.deepseek_base_url}
            onChange={(event) => handleBaseUrlChange(event.target.value)}
            onBlur={() => void saveNow(settingsRef.current, { quiet: true })}
            placeholder={
              providerId === "zhipu"
                ? "https://open.bigmodel.cn/api/paas/v4"
                : "https://api.deepseek.com"
            }
          />
        </label>
        <label className="field-label">
          API Key（{provider.label}）
          <input
            className="field-input"
            type="password"
            name={`ai-api-key-${providerId}`}
            autoComplete="off"
            value={activeApiKey}
            onChange={(event) => handleApiKeyChange(event.target.value)}
            placeholder={keyPlaceholder}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <ConnectivityIndicator status={aiStatus} />
          <button
            className="btn btn-outline"
            disabled={saving || aiStatus === "testing"}
            onClick={() => void handleTest()}
          >
            <Zap size={14} className={aiStatus === "testing" ? "animate-pulse" : ""} />
            {aiStatus === "testing" ? "测试中..." : "测试 AI 连接"}
          </button>
          {persistHint ? (
            <span className="text-[11px] text-emerald-600">{persistHint}</span>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        icon={<Bot size={15} className="text-primary" />}
        title="按任务选用模型"
        description="Agent 执行时会在这三档内自动选模：有截图→视觉坐标；汇报分析→极速文本；其余工具操作→深度逻辑。未配置的档位绝不调用；视觉任务未配置将硬拦截报错。"
      >
        <TaskModelSelect
          label="极速文本"
          value={taskChat}
          catalog={catalog}
          onChange={(model) => handleTaskModelChange("chat", model)}
        />
        <TaskModelSelect
          label="深度逻辑"
          value={taskAgent}
          catalog={catalog}
          onChange={(model) => handleTaskModelChange("agent", model)}
        />
        <TaskModelSelect
          label="视觉坐标"
          value={taskVision}
          catalog={catalog}
          preferVision
          onChange={(model) => handleTaskModelChange("vision", model)}
        />
      </SettingsSection>

      <SettingsSection
        icon={<Plus size={15} className="text-primary" />}
        title="模型库 · 自行添加"
        description="可添加服务商文档中的任意模型 ID，添加后即可在上方任务中选用。"
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="field-label min-w-[12rem] flex-1">
            模型 ID
            <input
              className="field-input font-mono text-xs"
              value={newModelId}
              onChange={(event) => setNewModelId(event.target.value)}
              placeholder="例如 glm-4.5-air / glm-5.3"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleAddModel();
                }
              }}
            />
          </label>
          <label className="flex items-center gap-1.5 pb-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={newModelVision}
              onChange={(event) => setNewModelVision(event.target.checked)}
            />
            支持视觉
          </label>
          <button
            type="button"
            className="btn btn-outline mb-0.5"
            disabled={saving}
            onClick={handleAddModel}
          >
            <Plus size={14} />
            添加
          </button>
        </div>
        {userExtras.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {userExtras.map((item) => (
              <li
                key={item.value}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
              >
                <span className="min-w-0 truncate font-mono">
                  {item.value}
                  {item.vision ? (
                    <span className="ml-2 text-[10px] text-muted-foreground">视觉</span>
                  ) : null}
                </span>
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  title="删除自定义模型"
                  onClick={() => handleRemoveExtra(item.value)}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">尚未添加自定义模型，预设模型可直接在任务下拉中选择。</p>
        )}
      </SettingsSection>

      <div className="flex justify-end">
        <button className="btn btn-primary" disabled={saving} onClick={() => void handleSave()}>
          保存设置
        </button>
      </div>
    </div>
  );
}

function TaskModelSelect({
  label,
  value,
  catalog,
  preferVision,
  onChange,
}: {
  label: string;
  value: string;
  catalog: Array<{ value: string; label: string; hint: string; vision?: boolean; custom?: boolean }>;
  preferVision?: boolean;
  onChange: (model: string) => void;
}) {
  const options = useMemo(() => {
    const list = [...catalog];
    if (preferVision) {
      list.sort((a, b) => Number(Boolean(b.vision)) - Number(Boolean(a.vision)));
    }
    if (value && !list.some((item) => item.value === value)) {
      list.unshift({ value, label: value, hint: "当前", custom: true });
    }
    return list;
  }, [catalog, preferVision, value]);

  return (
    <label className="field-label">
      {label}
      <select className="field-input" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={`${label}-${option.value}`} value={option.value}>
            {option.label}
            {option.vision ? " · 视觉" : ""}
            {option.custom ? " · 自定义" : ""} — {option.hint}
          </option>
        ))}
      </select>
    </label>
  );
}

function detectProviderKeepCustom(baseUrl: string, current: AiProviderId): AiProviderId {
  if (current === "custom") {
    return "custom";
  }
  return normalizeAiProviderId(undefined, baseUrl);
}

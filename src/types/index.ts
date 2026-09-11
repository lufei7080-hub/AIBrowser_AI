export type WebglMode = "local" | "random";

export const WEBGL_MODE_OPTIONS = [
  {
    value: "local" as const,
    label: "本地显卡",
    hint: "WMI 探测本机真实显卡并注入 WebGL 指纹，覆盖种子派生的假显卡",
  },
  {
    value: "random" as const,
    label: "随机显卡",
    hint: "从 12 种常见真实桌面显卡（Intel/NVIDIA/AMD）中，按指纹种子稳定映射一种",
  },
] as const;

export interface Profile {
  id: number;
  name: string;
  proxy_id: number | null;
  custom_proxy: string | null;
  cdp_port: number | null;
  status: string;
  fraud_score: number;
  fraud_details: string | null;
  theme_color: string;
  created_at: string;
  use_geoip: boolean;
  humanize: boolean;
  fingerprint_seed: string;
  stealth_preset: StealthPreset;
  /** 该环境是否开启页面交互元素自动提取（默认 false） */
  interactive_element_extract_enabled: boolean;
  /** Agent 观察是否附带多帧低质量视口截图（关=零截图） */
  agent_panorama_enabled?: boolean;
  /** WebGL 指纹策略：local=本机显卡，random=指纹种子映射真实显卡池 */
  webgl_mode: WebglMode;
  /** 空字符串=使用 CloakBrowser 最新版；非空则 pin 到指定 Chromium 版本 */
  browser_version?: string;
  /** Milestone 3：环境核心人设 JSON 字符串 */
  persona_data?: string | null;
  /** 启动额外打开的网站 JSON 数组字符串（首位 BrowserScan 由引擎强制） */
  startup_urls?: string;
}

export type StealthPreset = "default" | "fpjs_bypass";

export const STEALTH_PRESET_OPTIONS = [
  { value: "default" as const, label: "标准防护", hint: "CloakBrowser 默认反检测配置" },
  {
    value: "fpjs_bypass" as const,
    label: "极致绕过 (FingerprintJS/Kasada 适配)",
    hint: "关闭噪声注入并启用 FPJS 优化参数",
  },
] as const;

export function randomFingerprintSeed(): string {
  return String(Math.floor(Math.random() * 90000) + 10000);
}

export interface Proxy {
  id: number;
  type: "HTTP" | "SOCKS5" | "DYNAMIC_API" | string;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  api_config?: string | null;
}

export interface SidecarAiSettings {
  apiKey: string;
  apiBaseUrl: string;
  textModel?: string;
  chatModel?: string;
  agentModel?: string;
  visionModel?: string;
}

/** OpenAI 兼容服务商 */
export type AiProviderId = "deepseek" | "zhipu" | "custom";

export interface AppSettings {
  deepseek_api_key: string;
  /** 智谱 BigModel 专用 Key（与 DeepSeek 分存，切换服务商不丢） */
  zhipu_api_key: string;
  /** 自定义 OpenAI 兼容端点 Key */
  custom_api_key: string;
  /** 当前选用的服务商（显式持久化，避免仅靠 URL 推断导致弹回） */
  ai_provider: AiProviderId;
  deepseek_base_url: string;
  /** DeepSeek 选用的模型 */
  deepseek_chat_model: string;
  /** 智谱选用的模型 */
  zhipu_chat_model: string;
  /** 自定义端点选用的模型 */
  custom_chat_model: string;
  /** 用户自行添加的模型（JSON 数组） */
  ai_extra_models: string;
  /** 按服务商×任务（极速文本/深度逻辑/视觉坐标）选用的模型（JSON） */
  ai_task_models: string;
  cloak_path: string;
  cloak_license_key: string;
  key_file_path: string;
  /** 常规浏览器下载根目录；空则使用应用数据目录下 downloads/browser */
  browser_download_dir: string;
  /** 爬虫/AI 抓取下载根目录；空则使用应用数据目录下 downloads/scraper */
  scraper_download_dir: string;
  /** Pro 授权检查走浏览器代理（--license-through-proxy），企业网/受限网络直连授权服务器失败时开启 */
  license_through_proxy: boolean;
  /** 允许第三方 Cookie（--fingerprint-allow-3p-cookies），嵌入式登录/支付/reCAPTCHA 卡住时按需开启 */
  allow_third_party_cookies: boolean;
  /** Windows 调试：关闭全部指纹伪装显示真实指纹（--fingerprint=off），诊断用 */
  fingerprint_off: boolean;
  /**
   * Agent 感知模式（已固定 balanced；保留字段兼容旧设置库）。
   * economy/classic 已不再暴露 UI。
   */
  agent_sense_mode: "economy" | "balanced" | "classic";
  /**
   * 新建环境默认 Chromium 版本 Pin（空=自动）。
   * 常用：免费核 146… / 打包 151-pro（仅指纹）。
   */
  default_browser_version: string;
}

export interface LicenseEntitlement {
  isPro: boolean;
  isValid: boolean;
  licensePlan?: string | null;
  keyFilePath?: string | null;
}

export interface KeyFileActionResult {
  ok: boolean;
  message: string;
  isPro: boolean;
  isValid: boolean;
  keyFilePath?: string | null;
  licensePlan?: string | null;
}

export interface CacheCleanupReport {
  removedDirs: number;
  removedFiles: number;
  freedBytes: number;
  details: string[];
}

export interface CloakBinaryStatus {
  installed: boolean;
  version?: string | null;
  bundledVersion?: string | null;
  tier?: string | null;
  platform?: string | null;
  binaryPath?: string | null;
  cacheDir?: string | null;
  cacheRoot?: string | null;
  chromiumDirs?: string[];
  unusedCount?: number;
  hasLicense?: boolean;
  releaseChannel?: string | null;
  wrapperVersion?: string | null;
  browserVersionPin?: string | null;
  licenseValid?: boolean | null;
  licensePlan?: string | null;
  proLatestVersion?: string | null;
  proResolvedChannel?: string | null;
  proChannelFallback?: boolean | null;
  sessionSeatsActive?: number | null;
  sessionSeatsLimit?: number | null;
  sessionSeatsState?: string | null;
  updated?: boolean | null;
  updatedTo?: string | null;
  removedCount?: number | null;
  message?: string | null;
  usedKeylessFreePin?: boolean | null;
  licenseFallbackReason?: string | null;
  licenseKeySource?: string | null;
  diagnosticOk?: boolean | null;
  diagnosticSummary?: string | null;
  checks?: CloakDiagnosticCheck[] | null;
}

export interface CloakDiagnosticCheck {
  id: string;
  ok: boolean;
  title: string;
  detail: string;
}

export type ConnectivityStatus = "idle" | "testing" | "success" | "error";

export type ProxyStrategy = "none" | "pool_random" | "pool_shared" | "sequential_ports";

export type ProfileProxyMode = "none" | "pool" | "custom";

/** OpenAI 兼容服务商预设（设置页一键切换） */
export interface AiModelOption {
  value: string;
  label: string;
  hint: string;
  /** 可用于 Agent 截图/开眼 */
  vision?: boolean;
}

export interface AiProviderPreset {
  id: AiProviderId;
  label: string;
  /** 文档入口 */
  docsUrl?: string;
  baseUrl: string;
  defaultTextModel: string;
  defaultVisionModel: string;
  models: AiModelOption[];
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    docsUrl: "https://api-docs.deepseek.com/",
    baseUrl: "https://api.deepseek.com",
    defaultTextModel: "deepseek-v4-flash",
    defaultVisionModel: "deepseek-v4-flash-vision-exp",
    models: [
      {
        value: "deepseek-v4-flash",
        label: "deepseek-v4-flash",
        hint: "极速文本映射，默认推荐",
      },
      {
        value: "deepseek-v4-pro",
        label: "deepseek-v4-pro",
        hint: "深度逻辑推理",
      },
      {
        value: "deepseek-v4-flash-vision-exp",
        label: "deepseek-v4-flash-vision-exp",
        hint: "复杂网页视觉坐标识别",
        vision: true,
      },
    ],
  },
  {
    id: "zhipu",
    label: "智谱 BigModel",
    docsUrl: "https://docs.bigmodel.cn/cn/guide/start/model-overview",
    /** OpenAI 兼容：https://open.bigmodel.cn/api/paas/v4/ */
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultTextModel: "glm-4.7-flash",
    defaultVisionModel: "glm-4.6v-flash",
    models: [
      {
        value: "glm-4.7-flash",
        label: "glm-4.7-flash",
        hint: "免费文本，通用对话/工具调用",
      },
      {
        value: "glm-4.5-flash",
        label: "glm-4.5-flash",
        hint: "免费文本，128K 上下文",
      },
      {
        value: "glm-4.5-air",
        label: "glm-4.5-air",
        hint: "轻量高性价比，推理/编码/智能体稳定",
      },
      {
        value: "glm-4.7",
        label: "glm-4.7",
        hint: "通用对话、推理与智能体",
      },
      {
        value: "glm-4.6",
        label: "glm-4.6",
        hint: "高级编码、复杂推理与工具调用",
      },
      {
        value: "glm-5.2",
        label: "glm-5.2",
        hint: "长程任务与 Coding",
      },
      {
        value: "glm-5.3",
        label: "glm-5.3",
        hint: "旗舰文本 / Agent",
      },
      {
        value: "glm-4.6v-flash",
        label: "glm-4.6v-flash",
        hint: "免费视觉理解（开眼推荐）",
        vision: true,
      },
      {
        value: "glm-4.6v",
        label: "glm-4.6v",
        hint: "视觉 + 工具调用",
        vision: true,
      },
      {
        value: "glm-5.3-flash",
        label: "glm-5.3-flash",
        hint: "原生多模态（图/视频理解）",
        vision: true,
      },
    ],
  },
  {
    id: "custom",
    label: "自定义 OpenAI 兼容",
    baseUrl: "",
    defaultTextModel: "",
    defaultVisionModel: "",
    models: [],
  },
];

/** 扁平模型列表（兼容旧引用） */
export const AI_MODEL_OPTIONS: AiModelOption[] = AI_PROVIDER_PRESETS.flatMap((p) =>
  p.models.map((m) => ({ ...m })),
);

export function detectAiProviderId(baseUrl: string): AiProviderId {
  const u = baseUrl.trim().toLowerCase();
  if (!u) {
    return "custom";
  }
  if (u.includes("bigmodel.cn") || u.includes("bigmodel")) {
    return "zhipu";
  }
  if (u.includes("deepseek.com") || u.includes("deepseek")) {
    return "deepseek";
  }
  return "custom";
}

export function normalizeAiProviderId(
  raw: string | undefined | null,
  baseUrl: string,
): AiProviderId {
  const id = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (id === "deepseek" || id === "zhipu" || id === "custom") {
    return id;
  }
  return detectAiProviderId(baseUrl);
}

/** 当前服务商对应的 API Key 字段 */
export function aiApiKeyFieldForProvider(
  providerId: AiProviderId,
): "deepseek_api_key" | "zhipu_api_key" | "custom_api_key" {
  if (providerId === "zhipu") {
    return "zhipu_api_key";
  }
  if (providerId === "custom") {
    return "custom_api_key";
  }
  return "deepseek_api_key";
}

export function aiChatModelFieldForProvider(
  providerId: AiProviderId,
): "deepseek_chat_model" | "zhipu_chat_model" | "custom_chat_model" {
  if (providerId === "zhipu") {
    return "zhipu_chat_model";
  }
  if (providerId === "custom") {
    return "custom_chat_model";
  }
  return "deepseek_chat_model";
}

/** 任务角色：极速文本 / 深度逻辑 / 视觉坐标（存储键仍为 chat/agent/vision） */
export type AiTaskRole = "chat" | "agent" | "vision";

/** UI 展示名（与存储键分离） */
export const AI_TASK_ROLE_LABELS: Record<AiTaskRole, string> = {
  chat: "极速文本",
  agent: "深度逻辑",
  vision: "视觉坐标",
};

export interface AiTaskModelMap {
  chat: string;
  agent: string;
  vision: string;
}

export type AiTaskModelsByProvider = Partial<Record<AiProviderId, AiTaskModelMap>>;

export interface AiExtraModel extends AiModelOption {
  /** 归属服务商；空=全服务商可见 */
  provider?: AiProviderId | "";
  /** 用户添加（可删） */
  custom?: boolean;
}

export function parseAiExtraModels(raw: string | undefined | null): AiExtraModel[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]")) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: AiExtraModel[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const rec = row as Record<string, unknown>;
      const value = String(rec.value ?? rec.id ?? "").trim();
      if (!value) {
        continue;
      }
      out.push({
        value,
        label: String(rec.label ?? value).trim() || value,
        hint: String(rec.hint ?? "用户添加").trim() || "用户添加",
        vision: Boolean(rec.vision),
        provider: (String(rec.provider ?? "") as AiProviderId | "") || "",
        custom: true,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeAiExtraModels(models: AiExtraModel[]): string {
  return JSON.stringify(
    models.map((m) => ({
      value: m.value,
      label: m.label || m.value,
      hint: m.hint || "用户添加",
      vision: Boolean(m.vision),
      provider: m.provider || "",
      custom: true,
    })),
  );
}

export function parseAiTaskModels(raw: string | undefined | null): AiTaskModelsByProvider {
  try {
    const parsed = JSON.parse(String(raw ?? "{}")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: AiTaskModelsByProvider = {};
    for (const key of ["deepseek", "zhipu", "custom"] as AiProviderId[]) {
      const row = (parsed as Record<string, unknown>)[key];
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        continue;
      }
      const rec = row as Record<string, unknown>;
      out[key] = {
        chat: String(rec.chat ?? "").trim(),
        agent: String(rec.agent ?? "").trim(),
        vision: String(rec.vision ?? "").trim(),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeAiTaskModels(map: AiTaskModelsByProvider): string {
  return JSON.stringify(map);
}

export function defaultTaskModelsForProvider(providerId: AiProviderId): AiTaskModelMap {
  const preset = AI_PROVIDER_PRESETS.find((p) => p.id === providerId);
  const chat = preset?.defaultTextModel || "";
  const vision =
    preset?.defaultVisionModel ||
    preset?.models.find((m) => m.vision)?.value ||
    chat;
  return {
    chat,
    agent: chat,
    vision,
  };
}

/** 合并预设 + 用户模型，供下拉选用 */
export function buildModelCatalog(
  providerId: AiProviderId,
  extraRaw: string,
): AiExtraModel[] {
  const preset = AI_PROVIDER_PRESETS.find((p) => p.id === providerId);
  const presetModels: AiExtraModel[] = (preset?.models ?? []).map((m) => ({
    ...m,
    provider: providerId,
    custom: false,
  }));
  const extras = parseAiExtraModels(extraRaw).filter(
    (m) => !m.provider || m.provider === providerId || providerId === "custom",
  );
  const seen = new Set<string>();
  const merged: AiExtraModel[] = [];
  for (const m of [...presetModels, ...extras]) {
    const key = m.value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(m);
  }
  return merged;
}

export function resolveTaskModel(
  settings: {
    ai_provider?: AiProviderId;
    deepseek_base_url: string;
    deepseek_chat_model: string;
    zhipu_chat_model: string;
    custom_chat_model: string;
    ai_task_models?: string;
  },
  role: AiTaskRole,
): string {
  const provider = normalizeAiProviderId(settings.ai_provider, settings.deepseek_base_url);
  const map = parseAiTaskModels(settings.ai_task_models);
  const defaults = defaultTaskModelsForProvider(provider);
  const row = map[provider];
  const fromTask = String(row?.[role] ?? "").trim();
  if (fromTask) {
    return fromTask;
  }
  if (role === "chat" || role === "agent") {
    const field = aiChatModelFieldForProvider(provider);
    const legacy = String(settings[field] ?? "").trim();
    if (legacy) {
      return legacy;
    }
  }
  return defaults[role] || defaults.chat;
}

export function upsertTaskModel(
  taskModelsRaw: string,
  providerId: AiProviderId,
  role: AiTaskRole,
  model: string,
): string {
  const map = parseAiTaskModels(taskModelsRaw);
  const current = map[providerId] ?? defaultTaskModelsForProvider(providerId);
  map[providerId] = { ...current, [role]: model.trim() };
  return serializeAiTaskModels(map);
}

export function getAiApiKeyForSettings(settings: {
  deepseek_api_key: string;
  zhipu_api_key: string;
  custom_api_key: string;
  ai_provider?: AiProviderId;
  deepseek_base_url: string;
}): string {
  const provider = normalizeAiProviderId(settings.ai_provider, settings.deepseek_base_url);
  const field = aiApiKeyFieldForProvider(provider);
  return String(settings[field] ?? "").trim();
}

export function getAiChatModelForSettings(settings: {
  ai_provider?: AiProviderId;
  deepseek_base_url: string;
  deepseek_chat_model: string;
  zhipu_chat_model: string;
  custom_chat_model: string;
  ai_task_models?: string;
}): string {
  return resolveTaskModel(settings, "chat");
}

export function resolveAiVisionModel(baseUrl: string, chatModel: string): string {
  const providerId = detectAiProviderId(baseUrl);
  const preset = AI_PROVIDER_PRESETS.find((p) => p.id === providerId);
  const raw = chatModel.trim();
  const model = raw.toLowerCase();
  if (preset) {
    const hit = preset.models.find((m) => m.value.toLowerCase() === model);
    if (hit?.vision) {
      return hit.value;
    }
    if (preset.defaultVisionModel) {
      return preset.defaultVisionModel;
    }
  }
  if (model.startsWith("glm-")) {
    if (/(?:^glm-.*v)|glm-5\.3-flash|thinking-flash/i.test(model)) {
      return raw;
    }
    return "glm-4.6v-flash";
  }
  if (model.includes("vision")) {
    return raw;
  }
  return "deepseek-v4-flash-vision-exp";
}

export interface CreateProfileInput {
  name: string;
  theme_color?: string;
  proxy_id?: number | null;
  custom_proxy?: string | null;
  use_geoip?: boolean;
  humanize?: boolean;
  fingerprint_seed?: string;
  stealth_preset?: StealthPreset;
  webgl_mode?: WebglMode;
  browser_version?: string;
  startup_urls?: string;
}

export interface BatchCreateProfilesInput {
  prefix: string;
  count: number;
  theme_color?: string;
  proxy_strategy?: ProxyStrategy;
  proxy_id?: number | null;
  sequential_host?: string;
  sequential_start_port?: number;
  sequential_proxy_type?: "HTTP" | "SOCKS5";
  webgl_mode?: WebglMode;
  stealth_preset?: StealthPreset;
  startup_urls?: string;
  browser_version?: string;
}

export interface UpdateProfileInput {
  id: number;
  name: string;
  theme_color?: string;
  proxy_id?: number | null;
  custom_proxy?: string | null;
  use_geoip?: boolean;
  humanize?: boolean;
  fingerprint_seed?: string;
  stealth_preset?: StealthPreset;
  webgl_mode?: WebglMode;
  browser_version?: string;
  startup_urls?: string;
}

export interface AddProxyInput {
  type: "HTTP" | "SOCKS5" | "DYNAMIC_API" | string;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  api_config?: string | null;
}

export interface DynamicApiProxyInput {
  api_url: string;
  protocol: "HTTP" | "SOCKS5";
  region: string;
  label?: string | null;
}

export interface ProxyTestResult {
  ok: boolean;
  message: string;
}

export interface ProfileIpGeo {
  profile_id: string;
  ip: string | null;
  country: string | null;
  country_code: string | null;
  region?: string | null;
  city?: string | null;
  status: "ok" | "no_proxy" | "error" | string;
  message?: string | null;
}

export interface StartProfileResult {
  profile_id: string;
  cdp_port: number;
  ip_geo?: ProfileIpGeo | null;
}

export interface SidecarLogPayload {
  line: string;
  parsed?: Record<string, unknown> | null;
}

export interface TerminalLine {
  id: string;
  ts: string;
  tone: "info" | "success" | "warn" | "error" | "progress";
  text: string;
  role?: "user" | "assistant" | "system";
  /** Agent Monitor 思考流卡片类型（可选；缺省时前端按文案归类） */
  kind?: "thought" | "perceive" | "action" | "alert" | "success" | "error" | "system";
  meta?: {
    tool?: string;
    target?: string;
    detail?: string;
    url?: string;
  };
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: string;
}

/** AI 对话历史（传给 sidecar 多轮上下文） */
export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface BatchDeleteResult {
  deleted_ids: string[];
  skipped_running_ids: string[];
}

export interface FormTemplate {
  id: number;
  domain: string;
  template_name: string;
  actions: string;
  auto_apply: boolean;
  created_at: string;
}

export interface AgentTrajectory {
  id: number;
  domain: string;
  title: string;
  goal: string;
  start_url: string;
  actions: string;
  created_at: string;
  file_path?: string | null;
  file_name?: string | null;
  step_count?: number | null;
  source?: string | null;
}

/** 前端 → Rust → Sidecar 启动自主 Agent 的任务载荷（关键字段） */
export interface AgentTaskPayload {
  profileId: string;
  goal: string;
  maxRounds?: number;
  senseMode?: "economy" | "balanced" | "classic";
  /** 是否落盘轨迹（SQLite + 磁盘）；默认 false */
  enableRecording?: boolean;
}

/** 沙盘动态表单字段（由轨迹 fill / agent_batch_fill 反推） */
export interface SandboxFormField {
  key: string;
  label: string;
  recordedValue: string;
  inputType?: string;
  semanticSource?: string;
}

/** 沙盘字段覆盖模式 */
export type SandboxFieldMode = "fixed" | "ai_prompt";

export interface SandboxFieldOverride {
  mode: SandboxFieldMode;
  value: string;
  label?: string;
  inputType?: string;
}

export interface PlanBatchEnvRow {
  envId: string;
  /** @deprecated 旧版纯字符串；新沙盘用 fieldOverrides */
  valueOverrides: Record<string, string>;
  fieldOverrides?: Record<string, SandboxFieldOverride>;
}

export interface PlanBatchDataResult {
  summary: string;
  planMatrix: PlanBatchEnvRow[];
}

export interface MockSandboxFieldsResult {
  envId: string;
  valueOverrides: Record<string, string>;
  summary: string;
}

export type RpaActionType = "fill" | "click" | "select" | "wait" | "navigate";

export interface RpaAction {
  step: number;
  type: RpaActionType;
  selector: string;
  dataKey?: string;
  value?: string;
  url?: string;
}

export interface RpaStatePayload {
  state: string;
  step: number;
  msg: string;
  actions?: RpaAction[] | null;
  profile_id: string;
}

export interface RpaRunResult {
  state: string;
  step: number;
  msg: string;
  actions?: RpaAction[] | null;
}

export type ProfileStatus = "running" | "stopped" | string;

export const THEME_COLORS = [
  "#6366f1",
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
] as const;

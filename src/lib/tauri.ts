import { invoke } from "@tauri-apps/api/core";

import type {
  AddProxyInput,
  AppSettings,
  BatchCreateProfilesInput,
  BatchDeleteResult,
  ChatHistoryMessage,
  CloakBinaryStatus,
  CacheCleanupReport,
  KeyFileActionResult,
  LicenseEntitlement,
  CreateProfileInput,
  DynamicApiProxyInput,
  FormTemplate,
  AgentTrajectory,
  MockSandboxFieldsResult,
  PlanBatchDataResult,
  Profile,
  ProfileIpGeo,
  Proxy,
  ProxyTestResult,
  RpaAction,
  RpaRunResult,
  SandboxFieldOverride,
  StartProfileResult,
  UpdateProfileInput,
} from "../types";
import {
  normalizeAiProviderId,
  parseAiTaskModels,
  serializeAiTaskModels,
} from "../types";

export async function fetchProfiles(): Promise<Profile[]> {
  return invoke<Profile[]>("get_profiles");
}

export async function lookupProfilesIpGeo(profileIds: string[]): Promise<ProfileIpGeo[]> {
  return invoke<ProfileIpGeo[]>("lookup_profiles_ip_geo", { profileIds });
}

export async function fetchSettings(): Promise<AppSettings> {
  const raw = await invoke<Record<string, string>>("get_settings");
  const baseUrl = raw.deepseek_base_url ?? "https://api.deepseek.com";
  const deepseekKey = raw.deepseek_api_key ?? "";
  const storedZhipu = raw.zhipu_api_key ?? "";
  const provider = normalizeAiProviderId(raw.ai_provider, baseUrl);
  // 升级兼容：此前智谱 Key 可能写在 deepseek_api_key
  const zhipuKey =
    storedZhipu || (provider === "zhipu" && deepseekKey ? deepseekKey : "");
  const deepseekModel = raw.deepseek_chat_model ?? "deepseek-v4-flash";
  const zhipuModel =
    raw.zhipu_chat_model ||
    (provider === "zhipu" && deepseekModel.startsWith("glm-") ? deepseekModel : "glm-4.7-flash");
  const customModel = raw.custom_chat_model || (provider === "custom" ? deepseekModel : "");
  const aiExtraModels = raw.ai_extra_models ?? "[]";
  let aiTaskModels = raw.ai_task_models ?? "{}";
  // 首次：用已有 chat 模型填充任务映射
  const taskMap = parseAiTaskModels(aiTaskModels);
  if (!taskMap.deepseek && !taskMap.zhipu && !taskMap.custom) {
    aiTaskModels = serializeAiTaskModels({
      deepseek: {
        chat: deepseekModel,
        agent: deepseekModel,
        vision: "deepseek-v4-flash-vision-exp",
      },
      zhipu: {
        chat: zhipuModel,
        agent: zhipuModel,
        vision: "glm-4.6v-flash",
      },
      custom: {
        chat: customModel,
        agent: customModel,
        vision: customModel,
      },
    });
  }
  return {
    deepseek_api_key: deepseekKey,
    zhipu_api_key: zhipuKey,
    custom_api_key: raw.custom_api_key ?? "",
    ai_provider: provider,
    deepseek_base_url: baseUrl,
    deepseek_chat_model: deepseekModel,
    zhipu_chat_model: zhipuModel,
    custom_chat_model: customModel,
    ai_extra_models: aiExtraModels,
    ai_task_models: aiTaskModels,
    cloak_path: raw.cloak_path ?? "",
    cloak_license_key: raw.cloak_license_key ?? "",
    key_file_path: raw.key_file_path ?? "",
    browser_download_dir: raw.browser_download_dir ?? "",
    scraper_download_dir: raw.scraper_download_dir ?? "",
    license_through_proxy: raw.license_through_proxy === "true" || raw.license_through_proxy === "1",
    allow_third_party_cookies:
      raw.allow_third_party_cookies === "true" || raw.allow_third_party_cookies === "1",
    fingerprint_off: raw.fingerprint_off === "true" || raw.fingerprint_off === "1",
    agent_sense_mode: (() => {
      const mode = (raw.agent_sense_mode ?? "balanced").trim().toLowerCase();
      if (mode === "economy" || mode === "classic") {
        return mode;
      }
      return "balanced";
    })(),
    default_browser_version: (raw.default_browser_version ?? "").trim(),
  };
}

/** 持久化 AI 服务商 / Key / 模型（切换即生效） */
export async function persistAiSettings(settings: AppSettings): Promise<void> {
  const provider = normalizeAiProviderId(settings.ai_provider, settings.deepseek_base_url);
  await Promise.all([
    updateSetting("ai_provider", provider),
    updateSetting("deepseek_api_key", settings.deepseek_api_key ?? ""),
    updateSetting("zhipu_api_key", settings.zhipu_api_key ?? ""),
    updateSetting("custom_api_key", settings.custom_api_key ?? ""),
    updateSetting("deepseek_base_url", settings.deepseek_base_url ?? ""),
    updateSetting("deepseek_chat_model", settings.deepseek_chat_model ?? ""),
    updateSetting("zhipu_chat_model", settings.zhipu_chat_model ?? ""),
    updateSetting("custom_chat_model", settings.custom_chat_model ?? ""),
    updateSetting("ai_extra_models", settings.ai_extra_models ?? "[]"),
    updateSetting("ai_task_models", settings.ai_task_models ?? "{}"),
  ]);
}

export async function pickDirectory(title?: string): Promise<string | null> {
  return invoke<string | null>("pick_directory", { title: title ?? null });
}

export async function openPathInOs(path: string): Promise<void> {
  await invoke("open_path_in_os", { path });
}

/** Write text into `{browser|scraper download root}/{profileId}/{filename}`. */
export async function exportTextToDownloadDir(input: {
  track: "browser" | "scraper";
  profileId: string;
  filename: string;
  content: string;
}): Promise<string> {
  return invoke<string>("export_text_to_download_dir", {
    track: input.track,
    profileId: input.profileId,
    filename: input.filename,
    content: input.content,
  });
}

export async function testAiConnection(baseUrl: string, apiKey: string): Promise<void> {
  return invoke("test_ai_connection", { baseUrl, apiKey });
}

export async function testCloakPath(path: string): Promise<void> {
  return invoke("test_cloak_path", { path });
}

export async function detectCloakPath(): Promise<string> {
  return invoke<string>("detect_cloak_path");
}

export async function verifyCloakLicense(key: string, path: string): Promise<void> {
  return invoke("verify_cloak_license", { key, path });
}

export async function pickKeyFile(): Promise<string | null> {
  return invoke<string | null>("pick_key_file");
}

export async function importKeyFile(path: string): Promise<KeyFileActionResult> {
  return invoke<KeyFileActionResult>("import_key_file", { path });
}

export async function testKeyFile(path: string): Promise<KeyFileActionResult> {
  return invoke<KeyFileActionResult>("test_key_file", { path });
}

/** Paste CloakBrowser official `cb_…` license key (no .tsk required). */
export async function setCloakLicenseKey(licenseKey: string): Promise<KeyFileActionResult> {
  return invoke<KeyFileActionResult>("set_cloak_license_key", { licenseKey });
}

export async function clearCloakLicenseKey(): Promise<KeyFileActionResult> {
  return invoke<KeyFileActionResult>("clear_cloak_license_key");
}

export async function checkLicenseEntitlement(): Promise<LicenseEntitlement> {
  return invoke<LicenseEntitlement>("check_license_entitlement");
}

export async function getCloakBinaryStatus(
  licenseKey?: string,
  browserVersion?: string,
): Promise<CloakBinaryStatus> {
  return invoke<CloakBinaryStatus>("get_cloak_binary_status", {
    licenseKey: licenseKey?.trim() || null,
    browserVersion: browserVersion?.trim() || null,
  });
}

export async function downloadCloakBinary(
  licenseKey?: string,
  browserVersion?: string,
): Promise<CloakBinaryStatus> {
  return invoke<CloakBinaryStatus>("download_cloak_binary", {
    licenseKey: licenseKey?.trim() || null,
    browserVersion: browserVersion?.trim() || null,
  });
}

export async function updateCloakBinary(
  licenseKey?: string,
  browserVersion?: string,
): Promise<CloakBinaryStatus> {
  return invoke<CloakBinaryStatus>("update_cloak_binary", {
    licenseKey: licenseKey?.trim() || null,
    browserVersion: browserVersion?.trim() || null,
  });
}

export async function cleanupCloakBinary(
  licenseKey?: string,
  browserVersion?: string,
): Promise<CloakBinaryStatus> {
  return invoke<CloakBinaryStatus>("cleanup_cloak_binary", {
    licenseKey: licenseKey?.trim() || null,
    browserVersion: browserVersion?.trim() || null,
  });
}

export async function purgeAutomationCache(): Promise<CacheCleanupReport> {
  return invoke<CacheCleanupReport>("purge_automation_cache");
}

export async function diagnoseCloakBinary(
  licenseKey?: string,
  browserVersion?: string,
): Promise<CloakBinaryStatus> {
  return invoke<CloakBinaryStatus>("diagnose_cloak_binary", {
    licenseKey: licenseKey?.trim() || null,
    browserVersion: browserVersion?.trim() || null,
  });
}

export async function batchAddProxies(proxies: AddProxyInput[]): Promise<number> {
  return invoke<number>("batch_add_proxies", { proxies });
}

export async function batchDeleteProxies(proxyIds: number[]): Promise<number> {
  return invoke<number>("batch_delete_proxies", { proxyIds });
}

export async function updateSetting(key: keyof AppSettings | string, value: string): Promise<void> {
  return invoke("update_setting", { key, value });
}

export async function fetchProxies(): Promise<Proxy[]> {
  return invoke<Proxy[]>("get_proxies");
}

export async function addProxy(proxy: AddProxyInput): Promise<Proxy> {
  return invoke<Proxy>("add_proxy", { proxy });
}

export async function addDynamicApiProxy(input: DynamicApiProxyInput): Promise<Proxy> {
  return invoke<Proxy>("add_dynamic_api_proxy", { input });
}

export async function testProxyConnection(proxy: string): Promise<ProxyTestResult> {
  return invoke<ProxyTestResult>("test_proxy_connection", { proxy });
}

export async function createProfile(input: CreateProfileInput): Promise<Profile> {
  return invoke<Profile>("create_profile", { input });
}

export async function batchCreateProfiles(input: BatchCreateProfilesInput): Promise<Profile[]> {
  return invoke<Profile[]>("batch_create_profiles", { input });
}

export async function updateProfile(input: UpdateProfileInput): Promise<Profile> {
  return invoke<Profile>("update_profile", { input });
}

export async function setProfileInteractiveExtract(
  profileId: string | number,
  enabled: boolean,
): Promise<Profile> {
  return invoke<Profile>("set_profile_interactive_extract", {
    profileId: String(profileId),
    enabled,
  });
}

export async function setProfileAgentPanorama(
  profileId: string | number,
  enabled: boolean,
): Promise<Profile> {
  return invoke<Profile>("set_profile_agent_panorama", {
    profileId: String(profileId),
    enabled,
  });
}

export type InteractiveExtractCache = {
  profileId: string;
  fill: unknown | null;
  agent: unknown | null;
  fillPath: string;
  agentPath: string;
};

export async function getProfileInteractiveExtract(
  profileId: string,
): Promise<InteractiveExtractCache> {
  return invoke<InteractiveExtractCache>("get_profile_interactive_extract", {
    profileId: String(profileId),
  });
}

/** 请求运行中环境立即提取并推送测试窗（内存事件） */
export async function requestProfileInteractiveExtract(
  profileId: string,
): Promise<void> {
  return invoke<void>("request_profile_interactive_extract", {
    profileId: String(profileId),
  });
}

export async function deleteProfile(profileId: string): Promise<void> {
  return invoke("delete_profile", { profileId });
}

export async function batchDeleteProfiles(profileIds: string[]): Promise<BatchDeleteResult> {
  return invoke<BatchDeleteResult>("batch_delete_profiles", { profileIds });
}

export async function startProfile(profileId: string): Promise<StartProfileResult> {
  return invoke<StartProfileResult>("start_profile", { profileId });
}

export async function stopProfile(profileId: string): Promise<void> {
  return invoke("stop_profile", { profileId });
}

export async function stopAllProfiles(): Promise<number> {
  return invoke<number>("stop_all_profiles");
}

export async function prepareConsoleExit(keepBrowsers: boolean): Promise<void> {
  return invoke("prepare_console_exit", { keepBrowsers });
}

export async function getRunningProfileIds(): Promise<string[]> {
  return invoke<string[]>("get_running_profile_ids");
}

/** Bring the profile Chromium window to the foreground (Windows; no-op elsewhere). */
export async function focusProfileBrowser(profileId: string): Promise<void> {
  return invoke("focus_profile_browser", { profileId });
}

export interface CookieExportResult {
  format: string;
  count: number;
  content: string;
}

export interface CookieImportResult {
  count: number;
  appliedNow: boolean;
  pendingPath?: string | null;
}

export async function exportProfileCookies(
  profileId: string,
  format: "json" | "netscape" = "json",
): Promise<CookieExportResult> {
  return invoke<CookieExportResult>("export_profile_cookies", { profileId, format });
}

export async function importProfileCookies(
  profileId: string,
  payload: string,
): Promise<CookieImportResult> {
  return invoke<CookieImportResult>("import_profile_cookies", { profileId, payload });
}

export interface RunAiFillOptions {
  confirmedProfile?: string;
  skipHybrid?: boolean;
  pressEnterAfterFill?: boolean;
}

export async function previewAiFill(profileId: string, rawInput: string): Promise<string> {
  return invoke<string>("preview_ai_fill", { profileId, rawInput });
}

export async function runSmartFill(
  profileId: string,
  naturalLanguage: string,
  seedInput?: string,
  pressEnterAfterFill?: boolean,
): Promise<string> {
  return invoke<string>("run_smart_fill", {
    profileId,
    naturalLanguage,
    seedInput: seedInput ?? null,
    pressEnterAfterFill: pressEnterAfterFill ?? false,
  });
}

export async function runDirectFill(
  profileId: string,
  rawInput: string,
  pressEnterAfterFill?: boolean,
): Promise<void> {
  return invoke("run_direct_fill", {
    profileId,
    rawInput,
    pressEnterAfterFill: pressEnterAfterFill ?? false,
  });
}

export async function runAiFill(
  profileId: string,
  rawInput: string,
  options?: RunAiFillOptions,
): Promise<void> {
  return invoke("run_ai_fill", {
    profileId,
    rawInput,
    confirmedProfile: options?.confirmedProfile ?? null,
    skipHybrid: options?.skipHybrid ?? false,
    pressEnterAfterFill: options?.pressEnterAfterFill ?? false,
  });
}

export async function sendAiChat(
  message: string,
  profileId?: string,
  history?: ChatHistoryMessage[],
): Promise<string> {
  return invoke<string>("ai_chat", {
    message,
    profileId: profileId ?? null,
    history: history ?? [],
  });
}

export interface RunRpaFillOptions {
  actions?: RpaAction[];
  confirmedProfile?: string;
  skipHybrid?: boolean;
  pressEnterAfterFill?: boolean;
  /** 轨迹记忆回放：点击后不暂停，连续跑完 */
  continuous?: boolean;
}

export async function runRpaFill(
  profileId: string,
  rawInput: string,
  options?: RunRpaFillOptions,
): Promise<RpaRunResult> {
  return invoke<RpaRunResult>("run_rpa_fill", {
    profileId,
    rawInput,
    actions: options?.actions ?? null,
    confirmedProfile: options?.confirmedProfile ?? null,
    skipHybrid: options?.skipHybrid ?? false,
    pressEnterAfterFill: options?.pressEnterAfterFill ?? false,
    continuous: options?.continuous ?? false,
  });
}

export async function resumeRpaFill(profileId: string): Promise<RpaRunResult> {
  return invoke<RpaRunResult>("resume_rpa_fill", { profileId });
}

export async function rescanRpaPage(profileId: string, rawInput?: string): Promise<RpaRunResult> {
  return invoke<RpaRunResult>("rescan_rpa_page", {
    profileId,
    rawInput: rawInput ?? null,
  });
}

export async function pauseRpaFill(profileId: string): Promise<void> {
  return invoke("pause_rpa_fill", { profileId });
}

export async function stopRpaSession(profileId: string): Promise<void> {
  return invoke("stop_rpa_session", { profileId });
}

export interface AgentRunResult {
  state: string;
  step: number;
  msg: string;
}

export async function startAutonomousAgent(
  profileId: string,
  goal: string,
  maxRounds?: number,
  senseMode?: "economy" | "balanced" | "classic",
  enableRecording?: boolean,
): Promise<AgentRunResult> {
  return invoke<AgentRunResult>("start_autonomous_agent", {
    profileId,
    goal,
    maxRounds: maxRounds ?? 15,
    senseMode: senseMode ?? "balanced",
    enableRecording: enableRecording === true,
  });
}

export async function confirmAgentAction(
  profileId: string,
  requestId: string,
  fillOverrides?: Record<string, string>,
): Promise<void> {
  return invoke("confirm_agent_action", {
    profileId,
    requestId,
    fillOverrides: fillOverrides ?? null,
  });
}

export async function cancelAgentAction(profileId: string, requestId?: string): Promise<void> {
  return invoke("cancel_agent_action", {
    profileId,
    requestId: requestId ?? null,
  });
}

export async function replyAgentAsk(
  profileId: string,
  requestId: string,
  answer: string,
): Promise<void> {
  return invoke("reply_agent_ask", {
    profileId,
    requestId,
    answer,
  });
}

export async function continueAgentHandover(
  profileId: string,
  requestId?: string,
): Promise<void> {
  return invoke("continue_agent_handover", {
    profileId,
    requestId: requestId ?? null,
  });
}

export async function abortAutonomousAgent(profileId: string): Promise<void> {
  return invoke("abort_autonomous_agent", { profileId });
}

/** Milestone 4：唤起环境浏览器前台（CDP bringToFront + Win 任务栏） */
export async function bringProfileToFront(profileId: string): Promise<void> {
  return invoke("bring_profile_to_front", { profileId });
}

export async function getProfilePageUrl(profileId: string): Promise<string> {
  return invoke<string>("get_profile_page_url", { profileId });
}

export async function fetchTemplatesByDomain(domain: string): Promise<FormTemplate[]> {
  return invoke<FormTemplate[]>("get_templates_by_domain", { domain });
}

export async function saveFormTemplate(input: {
  domain: string;
  templateName: string;
  actions: string;
  autoApply?: boolean;
}): Promise<number> {
  return invoke<number>("save_template", {
    domain: input.domain,
    templateName: input.templateName,
    actions: input.actions,
    autoApply: input.autoApply ?? false,
  });
}

export async function deleteFormTemplate(templateId: number): Promise<void> {
  return invoke("delete_template", { templateId });
}

export async function toggleTemplateAutoApply(templateId: number, autoApply: boolean): Promise<void> {
  return invoke("toggle_template_auto_apply", { templateId, autoApply });
}

export async function listAgentTrajectories(domain: string): Promise<AgentTrajectory[]> {
  return invoke<AgentTrajectory[]>("list_agent_trajectories", { domain });
}

export async function deleteAgentTrajectory(
  trajectoryId: number,
  filePath?: string | null,
): Promise<void> {
  return invoke("delete_agent_trajectory", {
    trajectoryId,
    filePath: filePath ?? null,
  });
}

export async function replayAgentTrajectory(
  profileId: string,
  options: {
    filePath?: string | null;
    actions?: unknown[] | null;
    title?: string;
    goal?: string;
    valueOverrides?: Record<string, string | SandboxFieldOverride> | null;
  },
): Promise<RpaRunResult> {
  return invoke<RpaRunResult>("replay_agent_trajectory", {
    profileId,
    filePath: options.filePath ?? null,
    actions: options.actions ?? null,
    title: options.title ?? null,
    goal: options.goal ?? null,
    valueOverrides: options.valueOverrides ?? null,
  });
}

export async function planBatchReplayData(input: {
  selectors: string[];
  envIds: string[];
  userPrompt: string;
  fileData?: string;
}): Promise<PlanBatchDataResult> {
  return invoke<PlanBatchDataResult>("plan_batch_replay_data", {
    selectors: input.selectors,
    envIds: input.envIds,
    userPrompt: input.userPrompt,
    fileData: input.fileData ?? null,
  });
}

/** 沙盘字段级 AI 造数（单环境；强制 sidecar fast_text + GeoIP/人设） */
export async function mockSandboxFields(input: {
  envId: string;
  fields: Array<{ key: string; label: string; currentValue: string }>;
  onlyKeys?: string[];
  geoHint?: Record<string, unknown> | null;
}): Promise<MockSandboxFieldsResult> {
  return invoke<MockSandboxFieldsResult>("mock_sandbox_fields", {
    envId: input.envId,
    fields: input.fields,
    onlyKeys: input.onlyKeys ?? null,
    geoHint: input.geoHint ?? null,
  });
}

export async function saveAgentTrajectory(input: {
  domain: string;
  title: string;
  goal: string;
  startUrl: string;
  actions: string;
}): Promise<number> {
  return invoke<number>("save_agent_trajectory", {
    domain: input.domain,
    title: input.title,
    goal: input.goal,
    startUrl: input.startUrl,
    actions: input.actions,
  });
}

export interface AgentControlMemoryRow {
  id: number;
  domain: string;
  intent: string;
  intent_key: string;
  kind: string;
  selector: string;
  text_hint: string;
  x_percent?: number | null;
  y_percent?: number | null;
  hit_count: number;
  updated_at: string;
}

export async function listAgentControlMemory(domain?: string): Promise<AgentControlMemoryRow[]> {
  return invoke<AgentControlMemoryRow[]>("list_agent_control_memory", {
    domain: domain?.trim() || null,
  });
}

export async function upsertAgentControlMemory(input: {
  domain: string;
  intent: string;
  intentKey?: string;
  kind?: string;
  selector?: string;
  textHint?: string;
  xPercent?: number | null;
  yPercent?: number | null;
  hitCount?: number;
}): Promise<number> {
  return invoke<number>("upsert_agent_control_memory", {
    domain: input.domain,
    intent: input.intent,
    intentKey: input.intentKey ?? null,
    kind: input.kind ?? null,
    selector: input.selector ?? null,
    textHint: input.textHint ?? null,
    xPercent: input.xPercent ?? null,
    yPercent: input.yPercent ?? null,
    hitCount: input.hitCount ?? null,
  });
}

export async function clearAgentControlMemory(domain?: string): Promise<number> {
  return invoke<number>("clear_agent_control_memory", {
    domain: domain?.trim() || null,
  });
}

function parseStructuredError(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { kind?: string; message?: string };
    if (parsed.kind && parsed.message) {
      return `${parsed.kind}: ${parsed.message}`;
    }
  } catch {
    return null;
  }
  return null;
}

export function formatInvokeError(error: unknown): string {
  if (typeof error === "string") {
    return parseStructuredError(error) ?? error;
  }
  if (error instanceof Error) {
    return parseStructuredError(error.message) ?? error.message;
  }
  if (typeof error === "object" && error !== null) {
    const record = error as { kind?: string; message?: string };
    if (record.kind && record.message) {
      return `${record.kind}: ${record.message}`;
    }
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * 用户主动停止 / Abort / NotRunning：视为正常结束，禁止红 Banner。
 */
export function isBenignAgentStopError(error: unknown): boolean {
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? `${error.name} ${error.message}`
        : typeof error === "object" && error !== null
          ? JSON.stringify(error)
          : String(error);
  const text = raw.toLowerCase();
  return (
    text.includes("notrunning") ||
    text.includes("aborterror") ||
    text.includes("abort") ||
    text.includes("canceled") ||
    text.includes("cancelled") ||
    text.includes("已被用户中止") ||
    text.includes("用户中止") ||
    text.includes("agent_abort") ||
    text.includes("手动停止")
  );
}

export function proxyLabel(proxy: Proxy): string {
  if (proxy.type === "DYNAMIC_API") {
    try {
      const config = JSON.parse(proxy.api_config ?? "{}") as { label?: string; region?: string };
      return config.label ?? `API 动态提取 (${config.region ?? "hk"})`;
    } catch {
      return "API 动态提取";
    }
  }
  return `${proxy.type}://${proxy.host}:${proxy.port}`;
}

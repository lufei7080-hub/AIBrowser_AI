/**
 * 沙盘延迟生成引擎 — 变量插值 + Just-in-Time fast_text 造数
 */
import type { SidecarAiSettings } from "./engine.js";
import { createModelRouter } from "./ai_model_router.js";
import { extractAssistantContent } from "./ai_client.js";
import type { JsonLogger } from "./json-logger.js";
import {
  buildGeoPersonaContextBlock,
  COLLOQUIAL_TEXT_CONSTRAINT,
  isColloquialField,
  parseGeoContext,
  parsePersonaData,
  suggestPhoneHint,
  type GeoContext,
  type PersonaData,
} from "./persona_engine.js";
import { formatConstraintForInputType } from "./semantic_sniff.js";
import { looksLikeAiInstruction } from "./field_mock.js";

export type FieldOverrideMode = "fixed" | "ai_prompt";

export interface FieldOverrideSpec {
  mode: FieldOverrideMode;
  value: string;
  label?: string;
  inputType?: string;
}

/** 兼容旧版 string 覆盖与新版结构化覆盖 */
export type FieldOverrideInput = string | FieldOverrideSpec;

export function normalizeFieldOverride(raw: unknown): FieldOverrideSpec {
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return { mode: "fixed", value: String(raw ?? "") };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const modeRaw = String(record.mode ?? "fixed").trim().toLowerCase();
    const mode: FieldOverrideMode = modeRaw === "ai_prompt" ? "ai_prompt" : "fixed";
    return {
      mode,
      value: record.value == null ? "" : String(record.value),
      label: record.label != null ? String(record.label) : undefined,
      inputType: record.inputType != null ? String(record.inputType) : undefined,
    };
  }
  return { mode: "fixed", value: "" };
}

export function parseFieldOverrides(
  raw: unknown,
): Record<string, FieldOverrideSpec> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, FieldOverrideSpec> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const selector = String(key ?? "").trim();
    if (!selector) {
      continue;
    }
    out[selector] = normalizeFieldOverride(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function lookupPath(root: Record<string, unknown>, path: string): string {
  const parts = path.split(".").map((part) => part.trim()).filter(Boolean);
  let cursor: unknown = root;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return "";
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (cursor == null) {
    return "";
  }
  return String(cursor);
}

/** 构建模板上下文：persona.* / geoip.* 及别名 */
export function buildTemplateContext(
  geo: GeoContext | null | undefined,
  persona: PersonaData | null | undefined,
): Record<string, unknown> {
  const personaObj: Record<string, unknown> = { ...(persona ?? {}) };
  if (persona?.fullName && !personaObj.name) {
    personaObj.name = persona.fullName;
  }
  if (persona?.firstName && persona?.lastName && !personaObj.name) {
    personaObj.name = `${persona.firstName} ${persona.lastName}`.trim();
  }
  const geoObj: Record<string, unknown> = {
    city: geo?.city ?? "",
    country: geo?.country ?? "",
    countryCode: geo?.countryCode ?? "",
    region: geo?.region ?? "",
    timezone: geo?.timezone ?? "",
    locale: geo?.locale ?? "",
    exitIp: geo?.exitIp ?? "",
    ip: geo?.exitIp ?? "",
  };
  return {
    persona: personaObj,
    geoip: geoObj,
    geo: geoObj,
  };
}

const VAR_RE = /\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g;

/** 将 {{persona.name}} / {{geoip.city}} 替换为环境真实值 */
export function interpolateTemplate(
  template: string,
  geo: GeoContext | null | undefined,
  persona: PersonaData | null | undefined,
): string {
  const ctx = buildTemplateContext(geo, persona);
  return String(template ?? "").replace(VAR_RE, (_match, path: string) => {
    return lookupPath(ctx, path);
  });
}

export const MAGIC_VARIABLE_SUGGESTIONS = [
  { token: "persona.name", label: "人设姓名" },
  { token: "persona.fullName", label: "人设全名" },
  { token: "persona.firstName", label: "名" },
  { token: "persona.lastName", label: "姓" },
  { token: "persona.email", label: "人设邮箱" },
  { token: "persona.phone", label: "人设电话" },
  { token: "persona.city", label: "人设城市" },
  { token: "persona.postalCode", label: "人设邮编" },
  { token: "geoip.city", label: "出口城市" },
  { token: "geoip.region", label: "出口省/州" },
  { token: "geoip.country", label: "出口国家" },
  { token: "geoip.countryCode", label: "国家代码" },
  { token: "geoip.exitIp", label: "出口 IP" },
] as const;

async function generateJustInTimeValue(input: {
  label: string;
  prompt: string;
  inputType?: string;
  geo: GeoContext | null;
  persona: PersonaData | null;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
}): Promise<string> {
  const label = input.label.trim() || "字段";
  if (/password|passwd|otp|token|card|cvv|ssn|密码|驗證|验证码/i.test(label)) {
    throw new Error(`敏感字段「${label}」禁止 AI 盲盒生成`);
  }

  const { route, client } = createModelRouter(input.aiSettings).forIntent(
    "fast_text",
    "沙盘 JIT 造数：极速文本",
  );

  const formatLock = formatConstraintForInputType(input.inputType);
  const phoneHint = suggestPhoneHint(input.geo);
  const contextBlock = buildGeoPersonaContextBlock(input.geo, input.persona);
  const mustColloquial = isColloquialField(label);
  const userPrompt = input.prompt.trim()
    ? looksLikeAiInstruction(input.prompt)
      ? input.prompt.trim()
      : input.prompt.trim()
    : `请为表单字段「${label}」生成一个符合上下文的真实测试值。`;

  const systemParts = [
    "你是天枢台沙盘延迟造数引擎（Just-in-Time）。为即将填入的表单字段生成最终值。",
    formatLock,
    `电话格式提示：${phoneHint}`,
    contextBlock,
  ];
  if (mustColloquial) {
    systemParts.push(COLLOQUIAL_TEXT_CONSTRAINT);
  }

  input.logger.progress("sandbox_jit_generate", {
    model: route.model,
    intent: route.intent,
    label,
    inputType: input.inputType ?? null,
  });

  const response = await client.chat.completions.create({
    model: route.model,
    temperature: mustColloquial ? 0.65 : 0.3,
    max_tokens: 80,
    messages: [
      { role: "system", content: systemParts.join("\n") },
      {
        role: "user",
        content: [
          `Field label: ${label}`,
          `inputType: ${input.inputType ?? "text"}`,
          `Instruction: ${userPrompt}`,
          "Output ONLY the raw value:",
        ].join("\n"),
      },
    ],
  });

  const text = extractAssistantContent(response)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "");
  if (!text) {
    throw new Error(`JIT 造数返回空值（${label}）`);
  }
  return text;
}

export interface ResolveOverrideContext {
  geo?: unknown;
  persona?: unknown;
  aiSettings?: SidecarAiSettings | null;
  logger: JsonLogger;
}

/**
 * 解析单字段运行时最终值：
 * - fixed → 模板插值
 * - ai_prompt → 填表前一秒 fast_text JIT
 */
export async function resolveFieldOverrideValue(
  spec: FieldOverrideSpec,
  fallbackRecorded: string,
  ctx: ResolveOverrideContext,
): Promise<string> {
  const geo = parseGeoContext(ctx.geo);
  const persona = parsePersonaData(ctx.persona);

  if (spec.mode === "fixed") {
    const raw = spec.value.length > 0 ? spec.value : fallbackRecorded;
    return interpolateTemplate(raw, geo, persona);
  }

  // ai_prompt
  if (!ctx.aiSettings?.apiKey?.trim()) {
    throw new Error("AI 盲盒字段需要配置 API Key（fast_text）");
  }
  return generateJustInTimeValue({
    label: spec.label?.trim() || "字段",
    prompt: spec.value,
    inputType: spec.inputType,
    geo,
    persona,
    aiSettings: ctx.aiSettings,
    logger: ctx.logger,
  });
}

export function lookupFieldOverride(
  selector: string,
  overrides?: Record<string, FieldOverrideSpec>,
): FieldOverrideSpec | undefined {
  if (!overrides) {
    return undefined;
  }
  const raw = String(selector ?? "").trim();
  if (!raw) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, raw)) {
    return overrides[raw];
  }
  // 与 replay_engine 选择器归一对齐的轻量兜底
  if (raw.startsWith("xpath=") && Object.prototype.hasOwnProperty.call(overrides, raw.slice(6))) {
    return overrides[raw.slice(6)];
  }
  if (!raw.startsWith("xpath=") && Object.prototype.hasOwnProperty.call(overrides, `xpath=${raw}`)) {
    return overrides[`xpath=${raw}`];
  }
  return undefined;
}

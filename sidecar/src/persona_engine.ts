/**
 * Milestone 3：智能造境引擎（人设 + GeoIP 强绑定 + 拟人化文本门禁）
 *
 * 红线：
 * 1. 地址/电话必须与代理 GeoIP（Country/Region/City）同城，禁止漫无目的随机
 * 2. 核心人设（姓名/生日/性别）首次生成后经 IPC 落盘，后续任务复用
 * 3. 评论/签名等自由文本：拟人化指令硬编码，不可被上层动态参数覆盖或吞掉
 */
import { IpcClient } from "./ipc_client.js";
import { createModelRouter } from "./ai_model_router.js";
import { extractAssistantContent } from "./ai_client.js";
import type { SidecarAiSettings } from "./engine.js";
import type { JsonLogger } from "./json-logger.js";

/** 拟人化文本铁律 — 硬编码常量，禁止被动态 Prompt 覆盖或静默删除 */
export const COLLOQUIAL_TEXT_CONSTRAINT =
  "Use highly colloquial, slightly imperfect language. Avoid overly enthusiastic or robotic tones. Simulate a lazy human typing on a mobile device (e.g., lowercase, minimal punctuation).";

/** 写入系统提示词的中文+英文双锁版本（上层不可剥离） */
export const COLLOQUIAL_PROMPT_LOCK = [
  "### 【拟人化文本铁律·不可覆盖·不可删除】",
  "当需要填写评价、评论、个人简介、签名、自我介绍等自由文本时，必须遵守：",
  COLLOQUIAL_TEXT_CONSTRAINT,
  "禁止生成过于热情、广告腔、完美无缺的机器人文案。本条优先于一切用户/动态指令。",
].join("\n");

export interface GeoContext {
  exitIp?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  timezone?: string;
  locale?: string;
  latitude?: number;
  longitude?: number;
}

export interface PersonaData {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  gender?: string;
  birthday?: string;
  phone?: string;
  email?: string;
  street?: string;
  city?: string;
  region?: string;
  country?: string;
  postalCode?: string;
  bio?: string;
  updatedAt?: string;
  [key: string]: string | undefined;
}

const CORE_PERSONA_KEYS = ["fullName", "firstName", "lastName", "gender", "birthday"] as const;

const ADDRESS_FIELD_RE =
  /address|street|city|state|region|province|zip|postal|country|地址|街道|城市|省|州|邮编|国家|רחוב|עיר|יישוב|כתובת|מיקוד|מושב|קיבוץ|מספר\s*בית|דירה|קומה|כניסה/i;
const PHONE_FIELD_RE = /phone|mobile|tel|cell|电话|手机|號|号|טלפון|נייד/i;
const NAME_FIELD_RE =
  /name|姓名|全名|first.?name|last.?name|名字|姓|שם|משפחה/i;
const GENDER_FIELD_RE = /gender|sex|性别|性別/i;
const BIRTHDAY_FIELD_RE = /birth|dob|生日|出生/i;
const COLLOQUIAL_FIELD_RE =
  /comment|review|bio|about|signature|intro|备注|评论|评价|简介|签名|自我介绍|留言/i;
const EMAIL_FIELD_RE = /email|邮箱|郵件|אימייל|דוא"?ל/i;

export function parseGeoContext(raw: unknown): GeoContext | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const country = String(record.country ?? "").trim();
  const countryCode = String(record.countryCode ?? record.country_code ?? "").trim();
  const region = String(record.region ?? record.regionName ?? "").trim();
  const city = String(record.city ?? "").trim();
  if (!country && !countryCode && !city && !region) {
    return null;
  }
  return {
    exitIp: String(record.exitIp ?? record.exit_ip ?? "").trim() || undefined,
    country: country || undefined,
    countryCode: countryCode || undefined,
    region: region || undefined,
    city: city || undefined,
    timezone: String(record.timezone ?? "").trim() || undefined,
    locale: String(record.locale ?? "").trim() || undefined,
    latitude: Number.isFinite(Number(record.latitude)) ? Number(record.latitude) : undefined,
    longitude: Number.isFinite(Number(record.longitude)) ? Number(record.longitude) : undefined,
  };
}

export function parsePersonaData(raw: unknown): PersonaData | null {
  if (!raw) {
    return null;
  }
  if (typeof raw === "string") {
    try {
      return parsePersonaData(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const out: PersonaData = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined || value === null) {
      continue;
    }
    const text = String(value).trim();
    if (text) {
      out[key] = text;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function isColloquialField(label: string): boolean {
  return COLLOQUIAL_FIELD_RE.test(label);
}

export function isAddressLikeField(label: string): boolean {
  return ADDRESS_FIELD_RE.test(label);
}

export function isPhoneLikeField(label: string): boolean {
  return PHONE_FIELD_RE.test(label);
}

export function isCorePersonaField(label: string): boolean {
  return (
    NAME_FIELD_RE.test(label) ||
    GENDER_FIELD_RE.test(label) ||
    BIRTHDAY_FIELD_RE.test(label)
  );
}

/** 注入 Agent 提示词的 Geo + 人设强上下文（死死绑定） */
export function buildGeoPersonaContextBlock(
  geo: GeoContext | null | undefined,
  persona: PersonaData | null | undefined,
): string {
  const lines: string[] = [
    "【造境上下文·GeoIP 强绑定·不可违背】",
    COLLOQUIAL_PROMPT_LOCK,
  ];

  if (geo) {
    lines.push(
      `代理出口 GeoIP：country=${geo.country ?? "?"} (${geo.countryCode ?? "?"})` +
        ` / region=${geo.region ?? "?"} / city=${geo.city ?? "?"}` +
        ` / tz=${geo.timezone ?? "?"} / locale=${geo.locale ?? "?"}` +
        (geo.exitIp ? ` / ip=${geo.exitIp}` : ""),
    );
    lines.push(
      "生成地址、电话区号时必须与上述 City/Region/Country 严格同城；严禁随机生成其它国家城市。",
    );
  } else {
    lines.push("当前无可靠 GeoIP：地址类字段若需编造，优先保守使用常见本地格式，并在确认窗标明。");
  }

  if (persona && Object.keys(persona).length > 0) {
    const safe = { ...persona };
    lines.push(`已落盘人设基准（必须复用，禁止同环境换名换生日）：${JSON.stringify(safe)}`);
  } else {
    lines.push(
      "本环境尚无人设：若首次填写姓名/生日/性别等核心信息，填完后系统将自动落盘；后续任务必须沿用。",
    );
  }

  return lines.join("\n");
}

/** 从批量填表结果中抽取可落盘的核心人设字段 */
export function extractCorePersonaFromFillPairs(
  pairs: Array<{ label?: string; key?: string; value: string }>,
): PersonaData {
  const persona: PersonaData = {};
  for (const pair of pairs) {
    const label = `${pair.label ?? ""} ${pair.key ?? ""}`.trim();
    const value = String(pair.value ?? "").trim();
    if (!value) {
      continue;
    }
    if (NAME_FIELD_RE.test(label) && !persona.fullName) {
      persona.fullName = value;
      const parts = value.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        persona.firstName = parts[0];
        persona.lastName = parts.slice(1).join(" ");
      }
    } else if (GENDER_FIELD_RE.test(label) && !persona.gender) {
      persona.gender = value;
    } else if (BIRTHDAY_FIELD_RE.test(label) && !persona.birthday) {
      persona.birthday = value;
    } else if (PHONE_FIELD_RE.test(label) && !persona.phone) {
      persona.phone = value;
    } else if (EMAIL_FIELD_RE.test(label) && !persona.email) {
      persona.email = value;
    } else if (/street|街道|地址线|רחוב/i.test(label) && !persona.street) {
      persona.street = value;
    } else if (/^city$|城市|עיר|יישוב/i.test(label) && !persona.city) {
      persona.city = value;
    } else if (/state|region|province|省|州/i.test(label) && !persona.region) {
      persona.region = value;
    } else if (/country|国家|國家/i.test(label) && !persona.country) {
      persona.country = value;
    } else if (/zip|postal|邮编|מיקוד/i.test(label) && !persona.postalCode) {
      persona.postalCode = value;
    } else if (COLLOQUIAL_FIELD_RE.test(label) && !persona.bio) {
      persona.bio = value;
    }
  }
  return persona;
}

export function hasCorePersonaFields(persona: PersonaData): boolean {
  return CORE_PERSONA_KEYS.some((key) => Boolean(String(persona[key] ?? "").trim()));
}

export function mergePersona(base: PersonaData | null, incoming: PersonaData): PersonaData {
  const out: PersonaData = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    const text = String(value ?? "").trim();
    if (!text) {
      continue;
    }
    const existing = String(out[key] ?? "").trim();
    if (!existing) {
      out[key] = text;
    }
  }
  out.updatedAt = new Date().toISOString();
  return out;
}

/** 经 Milestone 1 IPC 上报 SavePersonaData；失败回退 stdout 事件 */
export function persistPersonaData(input: {
  profileId: string;
  persona: PersonaData;
  logger: JsonLogger;
}): void {
  if (!hasCorePersonaFields(input.persona)) {
    return;
  }
  const payload = {
    profileId: input.profileId,
    persona: input.persona,
  };
  const fallback = (): void => {
    input.logger.write({
      kind: "result",
      level: "info",
      message: "persona_data_stdout_fallback",
      data: {
        type: "persona_data",
        ...payload,
      },
    });
    // 同时写专用 type 行，供 Rust stdout 泵兜底（若后续接入）
    try {
      process.stdout.write(
        `${JSON.stringify({
          type: "persona_data",
          ts: new Date().toISOString(),
          profileId: input.profileId,
          persona: input.persona,
        })}\n`,
      );
    } catch {
      // ignore
    }
  };

  const client = IpcClient.global;
  if (client) {
    client.report("persona_data", payload, fallback);
    input.logger.progress("persona_data_ipc_reported", {
      profileId: input.profileId,
      keys: Object.keys(input.persona),
    });
  } else {
    fallback();
  }
}

/**
 * 低风险字段自由编造（极速文本）：仅当 allow_hallucination_for_non_critical=true
 * 且字段判定为地址/评论等非关键时调用；GeoIP 作为强制上下文。
 */
export async function hallucinateNonCriticalValue(input: {
  fieldLabel: string;
  fieldHint?: string;
  geo: GeoContext | null;
  persona: PersonaData | null;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  /** 用户要求的资料语种（用X语填写），优先于仅看字段脚本 */
  fillLocale?: string | null;
}): Promise<string | null> {
  const label = input.fieldLabel.trim();
  if (!label) {
    return null;
  }
  // 私密/关键字段绝不幻想
  if (/password|passwd|otp|token|card|cvv|ssn|密码|驗證|验证码/i.test(label)) {
    return null;
  }

  const { route, client } = createModelRouter(input.aiSettings).forIntent(
    "fast_text",
    "非关键字段造境：极速文本",
  );

  const geoLine = input.geo
    ? `GeoIP lock: country=${input.geo.country ?? ""} region=${input.geo.region ?? ""} city=${input.geo.city ?? ""} locale=${input.geo.locale ?? ""}`
    : "GeoIP unknown — be conservative.";
  const personaLine = input.persona
    ? `Existing persona (reuse): ${JSON.stringify(input.persona)}`
    : "No persona yet.";

  const mustColloquial = isColloquialField(label);
  const hebrewField = /[\u0590-\u05FF]/.test(label);
  const israelGeo =
    /^(IL|ISR)$/i.test(String(input.geo?.countryCode ?? "")) ||
    /israel|ישראל/i.test(String(input.geo?.country ?? "")) ||
    /he(-|_)?il/i.test(String(input.geo?.locale ?? ""));
  const fillLocale = String(input.fillLocale ?? "").toLowerCase();
  const systemParts = [
    "You generate a single realistic form field value for browser automation testing.",
    "Output ONLY the raw value string, no quotes, no JSON, no explanation.",
    geoLine,
    "Address/phone MUST match the GeoIP city/region/country. Never invent another country.",
    personaLine,
  ];
  if (fillLocale === "he" || hebrewField || israelGeo) {
    systemParts.push(
      "Generate Israel-local / Hebrew-script values when appropriate: Hebrew full name, mobile 05X…, Israeli city/street in Hebrew.",
    );
  } else if (fillLocale === "zh") {
    systemParts.push("Generate Chinese-local values: Chinese name, mainland mobile 1xxxxxxxxxx, Chinese city/street.");
  } else if (fillLocale === "ar") {
    systemParts.push("Generate Arabic-local values: Arabic name, regional mobile, Arabic city/street.");
  } else if (fillLocale === "ja") {
    systemParts.push("Generate Japanese-local values: Japanese name, mobile 090…, Japanese city/street.");
  } else if (fillLocale === "ko") {
    systemParts.push("Generate Korean-local values: Korean name, mobile 010…, Korean city/street.");
  } else if (fillLocale === "en") {
    systemParts.push("Generate English-script Western/SG-style name, phone, address.");
  } else if (hebrewField || israelGeo) {
    systemParts.push(
      "Field labels may be Hebrew. Generate Israel-local values when the label is Hebrew.",
    );
  }
  // 拟人化铁律：硬拼进 system，禁止被上层吞掉
  if (mustColloquial) {
    systemParts.push(COLLOQUIAL_TEXT_CONSTRAINT);
  }

  input.logger.progress("persona_hallucinate_field", {
    model: route.model,
    intent: route.intent,
    field: label,
    colloquial: mustColloquial,
  });

  try {
    const response = await client.chat.completions.create({
      model: route.model,
      temperature: mustColloquial ? 0.7 : 0.3,
      max_tokens: 120,
      messages: [
        { role: "system", content: systemParts.join("\n") },
        {
          role: "user",
          content: `Field: ${label}\nHint: ${input.fieldHint ?? ""}\nGenerate value:`,
        },
      ],
    });
    const text = extractAssistantContent(response)
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "");
    return text || null;
  } catch (error) {
    input.logger.warn("persona_hallucinate_failed", {
      field: label,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 根据 Geo 给出电话区号提示（弱约束，写入提示词） */
export function suggestPhoneHint(geo: GeoContext | null | undefined): string {
  const code = String(geo?.countryCode ?? "").toUpperCase();
  const map: Record<string, string> = {
    US: "+1 (area code of the GeoIP city)",
    CA: "+1 (local area code)",
    GB: "+44",
    UK: "+44",
    CN: "+86",
    JP: "+81",
    KR: "+82",
    DE: "+49",
    FR: "+33",
    AU: "+61",
    SG: "+65",
    HK: "+852",
    TW: "+886",
  };
  return map[code] ?? (code ? `country dialing code for ${code}` : "local format");
}

/**
 * GIF 动图验证码（策略 gif_animated_dwell）
 * 类型门禁 → 拉 GIF → GDI 全帧拆解 → 视觉选最清晰帧读码
 * 非 GIF / 未注册类型：unsupported，禁止截图 OCR 回退
 */
import { readFileSync, mkdirSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";

import { createModelRouter, isIntentConfigured } from "../ai_model_router.js";
import type { SidecarAiSettings } from "../engine.js";
import type { JsonLogger } from "../json-logger.js";
import { stripFencedJson } from "../json_extract.js";
import type { AgentFileSystem } from "./filesystem.js";
import {
  findCaptchaFormHints as findCaptchaFormHintsShared,
  type CaptchaFormHints,
} from "./captcha_form_hints.js";
import { extractGifFramesViaGdi, isGifBuffer, upscaleFramesToJpeg } from "./gif_frames.js";
import type { IndexedElementRef } from "./views.js";

export type CaptchaStrategyId = "gif_animated_dwell";

/** 视觉读码并发上限（异步池，非 OS 线程） */
const CAPTCHA_VISION_CONCURRENCY = 4;

export const SUPPORTED_CAPTCHA_STRATEGIES: ReadonlyArray<{
  id: CaptchaStrategyId;
  title: string;
  signals: string;
}> = [
  {
    id: "gif_animated_dwell",
    title: "GIF 动图 / 迷雾 / 停留最长",
    signals: "停留时间最长、迷雾动图、gif",
  },
];

export type { CaptchaFormHints };

export interface SolveAnimatedCaptchaResult {
  ok: boolean;
  code: string;
  frame: number;
  confidence: number;
  framesCaptured: number;
  formHints: CaptchaFormHints;
  strategy?: CaptchaStrategyId | "unsupported" | "none";
  supportedStrategies?: string[];
  framePaths?: string[];
  gifPath?: string;
  /** 本轮落盘产物（GIF/帧目录/视觉 JPEG），验证完成后删除 */
  artifactPaths?: string[];
  detail?: string;
}

const MAX_VISION_FRAMES = 12;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** GIF 专用门禁；禁止裸站名把其它题误判为 GIF */
export function detectCaptchaStrategy(input: {
  pageText: string;
  pageUrl: string;
  goalHint?: string;
  forceStrategy?: string;
}): CaptchaStrategyId | null {
  const force = String(input.forceStrategy ?? "").trim();
  if (force === "gif_animated_dwell") return "gif_animated_dwell";
  if (force && force !== "gif_animated_dwell") return null;

  const blob = `${input.pageText}\n${input.pageUrl}`;

  if (
    /滑块|拼图|拖动|点选|依次点击|turnstile|recaptcha|hcaptcha|geetest|极验|旋转验证/i.test(
      blob,
    ) &&
    !/停留时间最长|迷雾|动图|\.gif|gif\s*验证/i.test(blob)
  ) {
    return null;
  }

  if (
    /停留时间最长|迷雾|动图验证|animated\s*captcha|gif\s*验证|\.gif/i.test(blob)
  ) {
    return "gif_animated_dwell";
  }

  if (/验证码|captcha|人机验证/i.test(blob) && /动图|gif|迷雾|停留/i.test(blob)) {
    return "gif_animated_dwell";
  }

  return null;
}

export function findCaptchaFormHints(
  selectorMap: Map<number, IndexedElementRef>,
): CaptchaFormHints {
  return findCaptchaFormHintsShared(selectorMap, "gif");
}

async function locateAndFetchCaptchaGif(page: Page): Promise<{
  buf: Buffer;
  src: string;
} | null> {
  const info = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll("img")) as HTMLImageElement[];
    const scored: Array<{ src: string; score: number; w: number; h: number }> = [];
    for (const el of imgs) {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 16 || r.bottom < 0 || r.top > innerHeight) continue;
      const src = String(el.currentSrc || el.src || "").trim();
      if (!src) continue;
      const alt = `${el.alt || ""} ${el.className || ""} ${el.id || ""}`;
      let score = 0;
      if (/\.gif(\?|$)/i.test(src) || src.startsWith("data:image/gif")) score += 100;
      if (/captcha|verify|code|验证|yanzheng/i.test(alt + src)) score += 40;
      if (r.width >= 80 && r.width <= 400 && r.height >= 24 && r.height <= 120) score += 20;
      scored.push({ src, score, w: r.width, h: r.height });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0] ?? null;
  });
  if (!info?.src) return null;

  if (info.src.startsWith("data:")) {
    const m = info.src.match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
    if (!m?.[3]) return null;
    const isB64 = Boolean(m[2]);
    const payload = m[3];
    const buf = isB64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload));
    return { buf, src: "data:inline" };
  }

  const resp = await page.request.get(info.src, { timeout: 15_000 });
  if (!resp.ok()) return null;
  const buf = Buffer.from(await resp.body());
  return { buf, src: info.src };
}

function sampleFramePaths(paths: string[], maxN: number): string[] {
  if (paths.length <= maxN) return paths;
  const out: string[] = [];
  const last = paths.length - 1;
  for (let i = 0; i < maxN; i++) {
    const idx = Math.round((i * last) / (maxN - 1));
    const p = paths[idx]!;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** 验证码字符不定长：常见 3–8，兼容更短/更长，禁止写死位数 */
const CAPTCHA_CODE_RE = /^[A-Za-z0-9]{2,16}$/;

type FrameRead = {
  code: string | null;
  /** 清晰度置信度；缺则 null，禁止用假常数填充 */
  confidence: number | null;
  readable: boolean;
};

/** 本轮读码候选内存：凡识别到码即入，再按清晰度置信度择优 */
type CaptchaCandidate = {
  frameIndex: number;
  code: string;
  confidence: number;
  /** json | clarity_ask | prose_clarity | unscored */
  confidenceSource: string;
  /** 截断后的原文，避免占内存 */
  raw: string;
};

/** 删除单帧落盘文件（读完即毁，释放磁盘）；静默，由调用方打进度 */
function destroyFrameImageFiles(paths: Array<string | undefined | null>): number {
  let removed = 0;
  for (const p of paths) {
    const target = String(p ?? "").trim();
    if (!target || !existsSync(target)) continue;
    try {
      unlinkSync(target);
      removed += 1;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

function parseConfidenceValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    let n = v;
    if (n > 1 && n <= 100) n = n / 100;
    if (n >= 0 && n <= 1) return n;
    return null;
  }
  if (typeof v === "string") {
    const t = v.trim().replace(/%$/, "");
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    return parseConfidenceValue(n);
  }
  return null;
}

function normalizeCaptchaCode(raw: unknown): string | null {
  const code = String(raw ?? "")
    .trim()
    .replace(/\s+/g, "");
  if (!code || /^null$/i.test(code) || code === "?" || code === "-") return null;
  if (!CAPTCHA_CODE_RE.test(code)) return null;
  if (/^(null|true|false|code|json|frame|user|html|xxxx)$/i.test(code)) return null;
  return code;
}

/**
 * 从模型对「本帧画面」的描述推断清晰度（非站点特化、非固定假分）。
 * 只依据雾/糊/清晰等画面描述；不因「不对/再看」等认字犹豫降权（认字犹豫≠画面清晰度）。
 */
function estimateClarityFromProse(text: string): number | null {
  const t = String(text ?? "");
  if (!t.trim()) return null;

  const confM = t.match(
    /(?:confidence|clarity|accuracy|score|准确率|置信度|清晰度)\s*[：:=\-]?\s*(0?\.\d+|1(?:\.0+)?|\d{1,3})%?/i,
  );
  const numbered = confM?.[1] ? parseConfidenceValue(confM[1]) : null;
  if (numbered != null && numbered > 0) return numbered;

  if (/confidence\s*要低|清晰度\s*(要|偏|较)?低|打低分/i.test(t)) return 0.32;

  if (/几乎看不清|完全模糊|无法识别|不可读|太糊/i.test(t)) return 0.18;
  if (/很模糊|非常模糊|雾很重|严重遮挡|雾状/i.test(t)) return 0.28;
  if (/比较模糊|较为模糊|不太清晰|看不准|识别不准/i.test(t)) return 0.36;
  if (/(?<![不])模糊|有雾|看不清/i.test(t)) return 0.38;
  if (/有点模糊|略模糊|稍糊/i.test(t)) return 0.48;

  if (/非常清晰|十分清晰|清晰可见|很清楚|清楚可读/i.test(t)) return 0.9;
  if (/较清晰|比较清晰|能看清|可以读出|能看到/i.test(t)) return 0.72;
  if (/(?<![不])清晰/i.test(t)) return 0.78;

  return null;
}

/**
 * 解析视觉响应：只取 code + 清晰度 confidence。
 * - 无码 / 不可读 → code=null
 * - 有码无 confidence → confidence=null（后续用追问/口语清晰度补齐，有码必入内存）
 * - 不定长；不针对某一站点/某一张图特化
 */
function parseFrameRead(raw: string): FrameRead {
  const text = String(raw ?? "").trim();
  if (!text) return { code: null, confidence: null, readable: false };

  if (
    /视频解析|不支持.*图|不支持.*视频/i.test(text) &&
    !/[A-Za-z0-9]{2,}/.test(text)
  ) {
    return { code: null, confidence: null, readable: false };
  }

  const body = stripFencedJson(text);

  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
      if (obj.readable === false || obj.ok === false || obj.unreadable === true) {
        const c0 = normalizeCaptchaCode(obj.code);
        if (!c0) return { code: null, confidence: null, readable: false };
      }
      const code = normalizeCaptchaCode(
        obj.code ?? obj.text ?? obj.captcha ?? obj.answer ?? obj.验证码,
      );
      const confidence =
        parseConfidenceValue(obj.confidence) ??
        parseConfidenceValue(obj.clarity) ??
        parseConfidenceValue(obj.accuracy) ??
        parseConfidenceValue(obj.score) ??
        parseConfidenceValue(obj.准确率) ??
        parseConfidenceValue(obj.置信度) ??
        parseConfidenceValue(obj.清晰度);
      if (!code) {
        return { code: null, confidence: null, readable: false };
      }
      return {
        code,
        confidence,
        readable: confidence == null ? true : confidence > 0,
      };
    } catch {
      /* fall through */
    }
  }

  return extractCodeWithoutInventedConfidence(body);
}

/**
 * 自由文本仅提取「看见的码」；置信度若文中有数字则带上，否则留给清晰度推断。
 * 支持引号包裹、分隔符拼字符（位数不定：2～16）。
 */
function extractCodeWithoutInventedConfidence(body: string): FrameRead {
  const votes = new Map<string, number>();
  const bump = (raw: string, weight: number) => {
    const c = normalizeCaptchaCode(raw);
    if (!c) return;
    votes.set(c, (votes.get(c) ?? 0) + weight);
  };

  for (const m of body.matchAll(/[「“"'`]([A-Za-z0-9]{2,16})[」”"'`]/g)) {
    bump(m[1]!, 4);
  }
  for (const m of body.matchAll(
    /(?:code|captcha|验证码|可能是|看起来是|看起来像是|像是|应该是|字符是|实际是)\s*[：:=\-]?\s*[「“"'`]?([A-Za-z0-9]{2,16})/gi,
  )) {
    bump(m[1]!, 3);
  }
  // 不定长：A、B、C… / A, B, C… → 拼接（2～16 字符）
  for (const m of body.matchAll(
    /\b([A-Za-z0-9](?:\s*[、,，]\s*[A-Za-z0-9]){1,15})\b/g,
  )) {
    bump(m[1]!.replace(/\s*[、,，]\s*/g, ""), 3);
  }

  const confidence = estimateClarityFromProse(body);

  if (votes.size === 0) {
    return { code: null, confidence, readable: false };
  }

  let best = "";
  let bestN = 0;
  for (const [c, n] of votes) {
    if (n > bestN || (n === bestN && c.length >= best.length)) {
      best = c;
      bestN = n;
    }
  }
  return { code: best || null, confidence, readable: Boolean(best) };
}

/** 仅追问清晰度；JSON 失败则从口语清晰度描述推断 */
async function askClarityConfidence(input: {
  client: VisionClient;
  model: string;
  imagePart: {
    type: "image_url";
    image_url: { url: string; detail: "high" };
  };
  code: string;
  signal?: AbortSignal;
}): Promise<{ confidence: number | null; raw: string }> {
  const resp = await input.client.chat.completions.create(
    {
      model: input.model,
      temperature: 0,
      max_tokens: 60,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `验证码已定为「${input.code}」。不要重读字符。` +
                "只根据本帧雾/糊/遮挡程度打清晰度 0~1。" +
                '只输出：{"confidence":0.72} 这种一行 JSON，禁止思考过程。',
            },
            input.imagePart,
          ],
        },
      ],
    },
    input.signal ? { signal: input.signal } : undefined,
  );
  const raw = extractVisionMessageText(resp).text;
  const read = parseFrameRead(raw);
  if (read.confidence != null && read.confidence > 0) {
    return { confidence: read.confidence, raw };
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      const c =
        parseConfidenceValue(obj.confidence) ?? parseConfidenceValue(obj.clarity);
      if (c != null && c > 0) return { confidence: c, raw };
    } catch {
      /* prose */
    }
  }
  const fromProse = estimateClarityFromProse(raw);
  return { confidence: fromProse, raw };
}

/** 删除本轮验证码落盘文件（GIF / frames / vision） */
export function cleanupCaptchaArtifacts(
  paths: string[] | undefined,
  logger: JsonLogger,
): void {
  if (!paths?.length) return;
  let removed = 0;
  for (const p of paths) {
    const target = String(p ?? "").trim();
    if (!target || !existsSync(target)) continue;
    try {
      rmSync(target, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("captcha_artifact_cleanup_failed", {
        path: target.slice(0, 200),
        error: msg.slice(0, 160),
      });
    }
  }
  if (removed > 0) {
    logger.agentProgress(`已清理验证码临时文件 ${removed} 项（防重复使用旧图）`, {
      phase: "animated_captcha",
      stage: "cleanup",
      removed,
    });
  }
}

/** 从 OpenAI 兼容响应里抠文本（含 glm 偶发空 content / reasoning） */
function extractVisionMessageText(resp: {
  choices?: Array<{
    message?: {
      content?: unknown;
      reasoning_content?: unknown;
      refusal?: unknown;
    } | null;
    finish_reason?: string | null;
  }>;
}): { text: string; finishReason: string } {
  const choice = resp.choices?.[0];
  const msg = choice?.message;
  const finishReason = String(choice?.finish_reason ?? "");
  if (!msg) return { text: "", finishReason };
  const c = msg.content;
  if (typeof c === "string" && c.trim()) return { text: c.trim(), finishReason };
  if (Array.isArray(c)) {
    const joined = c
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          const o = p as Record<string, unknown>;
          return String(o.text ?? o.content ?? "");
        }
        return "";
      })
      .join("")
      .trim();
    if (joined) return { text: joined, finishReason };
  }
  const reasoning = msg.reasoning_content;
  if (typeof reasoning === "string" && reasoning.trim()) {
    return { text: reasoning.trim(), finishReason };
  }
  const refusal = msg.refusal;
  if (typeof refusal === "string" && refusal.trim()) {
    return { text: refusal.trim(), finishReason };
  }
  return { text: "", finishReason };
}

type VisionClient = {
  chat: {
    completions: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: (
        body: any,
        options?: { signal?: AbortSignal },
      ) => Promise<{
        choices?: Array<{
          message?: {
            content?: unknown;
            reasoning_content?: unknown;
            refusal?: unknown;
          } | null;
          finish_reason?: string | null;
        }>;
      }>;
    };
  };
};

/**
 * 单帧读码（可在并发池中运行）。结束后销毁本帧 JPEG/PNG 与 base64，释放槽位。
 */
async function readOneCaptchaFrame(input: {
  client: VisionClient;
  model: string;
  frameIndex: number;
  total: number;
  jpegPath: string;
  sourcePngPath?: string;
  logger: JsonLogger;
  pageHint?: string;
  signal?: AbortSignal;
  systemPrompt: string;
}): Promise<CaptchaCandidate | null> {
  const i = input.frameIndex;
  const n = input.total;
  let b64: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let imagePart: any = null;

  try {
    if (input.signal?.aborted) {
      throw new Error("Agent 已中止");
    }

    b64 = readFileSync(input.jpegPath).toString("base64");
    input.logger.agentProgress(`读码第 ${i}/${n} 帧…（并发池）`, {
      phase: "animated_captcha",
      stage: "read_frame",
      frame: i,
    });

    let raw = "";
    let finishReason = "";
    let read: FrameRead = { code: null, confidence: null, readable: false };
    let confidenceSource = "none";
    imagePart = {
      type: "image_url" as const,
      image_url: {
        url: `data:image/jpeg;base64,${b64}`,
        detail: "high" as const,
      },
    };
    // base64 已挂到 imagePart，尽早松开独立引用
    b64 = null;

    try {
      const resp = await input.client.chat.completions.create(
        {
          model: input.model,
          temperature: 0.05,
          max_tokens: 220,
          messages: [
            { role: "system", content: input.systemPrompt },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    `第 ${i}/${n} 帧。只输出一行 JSON：code（不定长）+ confidence（清晰度）。` +
                    (input.pageHint ? ` 页面提示：${input.pageHint.slice(0, 120)}` : ""),
                },
                imagePart,
              ],
            },
          ],
        },
        input.signal ? { signal: input.signal } : undefined,
      );
      const extracted = extractVisionMessageText(resp);
      raw = extracted.text;
      finishReason = extracted.finishReason;
      read = parseFrameRead(raw);
      if (read.confidence != null && read.confidence > 0) confidenceSource = "json";
    } catch (err) {
      if (input.signal?.aborted || (err instanceof Error && /abort/i.test(err.message))) {
        throw new Error("Agent 已中止");
      }
      const msg = err instanceof Error ? err.message : String(err);
      input.logger.agentProgress(`第 ${i} 帧请求失败，排除：${msg.slice(0, 120)}`, {
        phase: "animated_captcha",
        stage: "frame_excluded",
        frame: i,
      });
      return null;
    }

    if (!read.code && !input.signal?.aborted) {
      try {
        input.logger.agentProgress(`第 ${i} 帧未读出码，短提示重试…`, {
          phase: "animated_captcha",
          stage: "frame_retry",
          frame: i,
        });
        const retry = await input.client.chat.completions.create(
          {
            model: input.model,
            temperature: 0,
            max_tokens: 120,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text:
                      "只输出一行 JSON，禁止思考。位数不定。" +
                      '{"code":"所见字符","confidence":0.0} 或 {"code":null,"confidence":0,"readable":false}',
                  },
                  imagePart,
                ],
              },
            ],
          },
          input.signal ? { signal: input.signal } : undefined,
        );
        const extracted2 = extractVisionMessageText(retry);
        if (extracted2.text) {
          raw = extracted2.text;
          finishReason = extracted2.finishReason;
          read = parseFrameRead(raw);
          if (read.confidence != null && read.confidence > 0) confidenceSource = "json";
        }
      } catch (err) {
        if (input.signal?.aborted || (err instanceof Error && /abort/i.test(err.message))) {
          throw new Error("Agent 已中止");
        }
      }
    }

    if (!read.code) {
      input.logger.agentProgress(
        `第 ${i} 帧未读出码，排除：${raw.slice(0, 140) || `(空响应 finish=${finishReason || "?"})`}`,
        {
          phase: "animated_captcha",
          stage: "frame_excluded",
          frame: i,
          preview: raw.slice(0, 280),
          finishReason,
        },
      );
      return null;
    }

    const code = read.code;
    let confidence = read.confidence;

    if (confidence == null || confidence <= 0) {
      const fromProse = estimateClarityFromProse(raw);
      if (fromProse != null && fromProse > 0) {
        confidence = fromProse;
        confidenceSource = "prose_clarity";
      }
    }

    if ((confidence == null || confidence <= 0) && !input.signal?.aborted) {
      try {
        input.logger.agentProgress(`第 ${i} 帧已读到 ${code}，追问清晰度…`, {
          phase: "animated_captcha",
          stage: "ask_clarity",
          frame: i,
          code,
        });
        const asked = await askClarityConfidence({
          client: input.client,
          model: input.model,
          imagePart,
          code,
          signal: input.signal,
        });
        if (asked.raw) raw = `${raw}\n---\n${asked.raw}`;
        if (asked.confidence != null && asked.confidence > 0) {
          confidence = asked.confidence;
          confidenceSource = "clarity_ask";
        }
      } catch (err) {
        if (input.signal?.aborted || (err instanceof Error && /abort/i.test(err.message))) {
          throw new Error("Agent 已中止");
        }
      }
    }

    if (confidence == null || confidence <= 0) {
      confidence = 0.55;
      confidenceSource = "unscored";
    }

    return {
      frameIndex: i,
      code,
      confidence: Math.min(1, confidence),
      confidenceSource,
      raw: raw.slice(0, 400),
    };
  } finally {
    // 结果已返回（或失败）：销毁图片引用与落盘文件，释放本路「线程」资源
    imagePart = null;
    b64 = null;
    const removed = destroyFrameImageFiles([input.jpegPath, input.sourcePngPath]);
    input.logger.agentProgress(
      `第 ${i} 帧任务结束，已销毁图片 ${removed} 个并释放并发槽`,
      {
        phase: "animated_captcha",
        stage: "frame_slot_released",
        frame: i,
        removed,
      },
    );
  }
}

/**
 * 并发池读码（默认 4 路）→ 入内存 → 按清晰度择优。
 * 每帧结束后销毁该帧图片并释放池槽，不长期占资源。
 */
async function askVisionPerFrameCode(input: {
  client: VisionClient;
  model: string;
  framePaths: string[];
  /** 与 framePaths 一一对应的源 PNG，读完一并删除 */
  sourcePngPaths?: string[];
  logger: JsonLogger;
  pageHint?: string;
  signal?: AbortSignal;
}): Promise<{ frame: number; code: string; confidence: number } | null> {
  const n = input.framePaths.length;
  const concurrency = Math.min(CAPTCHA_VISION_CONCURRENCY, Math.max(1, n));
  input.logger.agentProgress(
    `验证码识别中…（并发 ${concurrency} · ${n} 帧 · ${input.model}）`,
    {
      phase: "animated_captcha",
      mode: "per_frame_memory_pool",
      frames: n,
      concurrency,
      model: input.model,
    },
  );

  const memory: CaptchaCandidate[] = [];
  const systemPrompt =
    "通用验证码读码。禁止思考过程、禁止解释。" +
    "位数不固定：原样抄写所见字符，禁止假设位数。" +
    "confidence = 本帧画面清晰度（雾/糊/遮挡越重越低），禁止所有帧相同假分。" +
    '可读：{"code":"所见字符","confidence":0.85,"readable":true}；' +
    '看不清：{"code":null,"confidence":0,"readable":false}。' +
    "第一行起只能是一个 JSON。";

  let cursor = 0;
  let fatal: Error | null = null;

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      if (input.signal?.aborted || fatal) {
        throw new Error("Agent 已中止");
      }
      const idx = cursor;
      cursor += 1;
      if (idx >= n) return;

      const jpegPath = input.framePaths[idx]!;
      const sourcePngPath = input.sourcePngPaths?.[idx];
      try {
        const hit = await readOneCaptchaFrame({
          client: input.client,
          model: input.model,
          frameIndex: idx + 1,
          total: n,
          jpegPath,
          sourcePngPath,
          logger: input.logger,
          pageHint: input.pageHint,
          signal: input.signal,
          systemPrompt,
        });
        if (hit) {
          memory.push(hit);
          input.logger.agentProgress(
            `第 ${hit.frameIndex} 帧入内存：code=${hit.code}（len=${hit.code.length}）清晰度=${hit.confidence.toFixed(2)}(${hit.confidenceSource}) · 内存 ${memory.length} 条`,
            {
              phase: "animated_captcha",
              stage: "memory_push",
              frame: hit.frameIndex,
              code: hit.code,
              codeLen: hit.code.length,
              confidence: hit.confidence,
              confidenceSource: hit.confidenceSource,
              memorySize: memory.length,
            },
          );
        }
      } catch (err) {
        if (
          input.signal?.aborted ||
          (err instanceof Error && /已中止|abort/i.test(err.message))
        ) {
          fatal = err instanceof Error ? err : new Error("Agent 已中止");
          throw fatal;
        }
        const msg = err instanceof Error ? err.message : String(err);
        input.logger.agentProgress(`第 ${idx + 1} 帧异常，排除：${msg.slice(0, 120)}`, {
          phase: "animated_captcha",
          stage: "frame_excluded",
          frame: idx + 1,
        });
        // 异常路径仍尝试毁图（readOne 的 finally 通常已执行；此处兜底）
        destroyFrameImageFiles([jpegPath, sourcePngPath]);
      }
    }
  });

  const settled = await Promise.allSettled(workers);
  if (fatal || input.signal?.aborted) {
    // 中止：销毁尚未处理完的残留帧图
    for (let i = 0; i < n; i++) {
      destroyFrameImageFiles([input.framePaths[i], input.sourcePngPaths?.[i]]);
    }
    throw new Error("Agent 已中止");
  }
  for (const s of settled) {
    if (s.status === "rejected") {
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      if (/已中止|abort/i.test(msg)) throw new Error("Agent 已中止");
    }
  }

  if (memory.length === 0) {
    input.logger.agentProgress("候选内存为空：全部帧均未读出验证码", {
      phase: "animated_captcha",
      stage: "memory_empty",
    });
    return null;
  }

  memory.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const rank = (s: string) =>
      s === "json" ? 0 : s === "clarity_ask" ? 1 : s === "prose_clarity" ? 2 : 3;
    const rd = rank(a.confidenceSource) - rank(b.confidenceSource);
    if (rd !== 0) return rd;
    return a.frameIndex - b.frameIndex;
  });
  const best = memory[0]!;
  input.logger.agentProgress(
    `内存对比择优：第 ${best.frameIndex} 帧 code=${best.code}（清晰度 ${best.confidence.toFixed(2)}/${best.confidenceSource}）` +
      (memory.length > 1
        ? `；候选 ${memory
            .slice(0, 8)
            .map(
              (h) =>
                `${h.frameIndex}:${h.code}@${h.confidence.toFixed(2)}(${h.confidenceSource})`,
            )
            .join(", ")}`
        : ""),
    {
      phase: "animated_captcha",
      stage: "pick_best_from_memory",
      frame: best.frameIndex,
      code: best.code,
      confidence: best.confidence,
      confidenceSource: best.confidenceSource,
      memorySize: memory.length,
    },
  );

  return { code: best.code, frame: best.frameIndex, confidence: best.confidence };
}

export async function checkCaptchaOutcome(page: Page): Promise<{
  verified: boolean | null;
  signal: string;
}> {
  await sleep(900);
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    const text = await page.evaluate(() => String(document.body?.innerText || "").slice(0, 4000));
    if (/验证成功|通过验证|正确答案|提交成功|恭喜/i.test(text)) {
      // 排除教学文案里举例的 success（勿把协议说明当过关）
      if (
        /请使用协议通过|不会在图像识别|返回\s*["'{]*\s*\{?\s*success|示例|例如/i.test(
          text,
        ) &&
        !/验证成功|通过验证|正确答案|提交成功|恭喜/i.test(text)
      ) {
        /* fall through */
      } else {
        const m = text.match(/验证成功|通过验证|正确答案|提交成功|恭喜/i);
        return { verified: true, signal: m?.[0] ?? "success" };
      }
    }
    // 英文 success 仅在不像「教学/协议说明」时采信
    if (
      /\bsuccess\b|\baccepted\b|\bcorrect\b/i.test(text) &&
      !/请使用协议通过|不会在图像识别|返回\s*\{?\s*success|示例|例如|success\s*:\s*true/i.test(
        text,
      )
    ) {
      const m = text.match(/\bsuccess\b|\baccepted\b|\bcorrect\b/i);
      return { verified: true, signal: m?.[0] ?? "success" };
    }
    if (/验证失败|不正确|错误|再试|重新|失败|wrong|incorrect|failed|invalid/i.test(text)) {
      const m = text.match(/验证失败|不正确|错误|再试|重新|失败|wrong|incorrect|failed|invalid/i);
      return { verified: false, signal: m?.[0] ?? "fail" };
    }
    return { verified: null, signal: "no_clear_signal" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Execution context was destroyed|Target closed|navigat/i.test(msg)) {
      return { verified: null, signal: "nav_or_context_destroyed" };
    }
    throw err;
  }
}

export async function solveAnimatedCaptcha(input: {
  page: Page;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  selectorMap: Map<number, IndexedElementRef>;
  pageHint?: string;
  goalHint?: string;
  forceStrategy?: string;
  fileSystem?: AgentFileSystem;
  signal?: AbortSignal;
}): Promise<SolveAnimatedCaptchaResult> {
  if (input.signal?.aborted) {
    throw new Error("Agent 已中止");
  }
  const supported = SUPPORTED_CAPTCHA_STRATEGIES.map((s) => s.id);
  const emptyHints = findCaptchaFormHints(input.selectorMap);

  const pageText = await input.page
    .evaluate(() => String(document.body?.innerText || "").slice(0, 2500))
    .catch(() => "");
  const strategy = detectCaptchaStrategy({
    pageText,
    pageUrl: input.page.url(),
    goalHint: `${input.goalHint ?? ""} ${input.pageHint ?? ""}`,
    forceStrategy: input.forceStrategy,
  });

  if (!strategy) {
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: 0,
      formHints: emptyHints,
      strategy: "unsupported",
      supportedStrategies: supported,
      detail:
        "unsupported: 当前验证码类型未封装（目前支持 GIF/滑块/算式/点选，由 solve_captcha 分发）。请勿重试本 GIF 专用路径。",
    };
  }

  input.logger.agentProgress("① 类型门禁通过：gif_animated_dwell → 拉取 GIF…", {
    phase: "animated_captcha",
    stage: "fetch_gif",
  });

  const media = await locateAndFetchCaptchaGif(input.page);
  if (!media) {
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: 0,
      formHints: emptyHints,
      strategy: "unsupported",
      supportedStrategies: supported,
      detail: "not_gif: 未定位到验证码图片媒体，本策略不可用。",
    };
  }

  if (!isGifBuffer(media.buf)) {
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: 0,
      formHints: emptyHints,
      strategy: "unsupported",
      supportedStrategies: supported,
      detail: "not_gif: 定位到的验证码媒体不是 GIF，本策略不可用。",
    };
  }

  if (!input.fileSystem) {
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: 0,
      formHints: emptyHints,
      strategy,
      detail: "缺少 Agent 工作区，无法落盘 GIF/帧",
    };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const gifPath = input.fileSystem.writeBinaryFile(`captcha_raw_${stamp}.gif`, media.buf);
  const framesDir = join(input.fileSystem.root, `captcha_frames_${stamp}`);
  mkdirSync(framesDir, { recursive: true });
  const artifactPaths: string[] = [gifPath, framesDir];

  input.logger.agentProgress("② GDI 全帧拆解中…", {
    phase: "animated_captcha",
    stage: "gdi_extract",
    gifPath,
    src: media.src.slice(0, 120),
  });

  if (input.signal?.aborted) {
    throw new Error("Agent 已中止");
  }

  let framePaths: string[];
  try {
    framePaths = await extractGifFramesViaGdi(gifPath, framesDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: 0,
      formHints: emptyHints,
      strategy,
      gifPath,
      detail: msg,
    };
  }

  const formHints = findCaptchaFormHints(input.selectorMap);
  input.logger.agentProgress(`② 已拆出 ${framePaths.length} 帧（GDI）`, {
    phase: "animated_captcha",
    frames: framePaths.length,
    singleFrame: framePaths.length === 1,
  });

  const sampled = sampleFramePaths(framePaths, MAX_VISION_FRAMES);
  if (sampled.length < framePaths.length) {
    input.logger.agentProgress(`抽样 ${sampled.length}/${framePaths.length} 帧后放大送视觉`, {
      phase: "animated_captcha",
      sampled: sampled.length,
      total: framePaths.length,
    });
    const sampledSet = new Set(sampled);
    let dropped = 0;
    for (const p of framePaths) {
      if (!sampledSet.has(p)) {
        dropped += destroyFrameImageFiles([p]);
      }
    }
    if (dropped > 0) {
      input.logger.agentProgress(`已销毁未抽样 PNG ${dropped} 个`, {
        phase: "animated_captcha",
        stage: "drop_unsampled",
        dropped,
      });
    }
  }

  const visionDir = join(input.fileSystem.root, `captcha_vision_${stamp}`);
  let visionPaths: string[];
  try {
    input.logger.agentProgress("②b 放大帧为 JPEG（×4）供视觉…", {
      phase: "animated_captcha",
      stage: "upscale_jpeg",
    });
    if (input.signal?.aborted) {
      throw new Error("Agent 已中止");
    }
    visionPaths = await upscaleFramesToJpeg(sampled, visionDir, 4);
    artifactPaths.push(visionDir);
    destroyFrameImageFiles([join(visionDir, "_png_list.txt")]);
  } catch (err) {
    if (input.signal?.aborted || (err instanceof Error && /已中止|abort/i.test(err.message))) {
      throw new Error("Agent 已中止");
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: framePaths.length,
      formHints,
      strategy,
      gifPath,
      framePaths,
      artifactPaths,
      detail: `帧放大失败: ${msg}`,
    };
  }

  const router = createModelRouter(input.aiSettings);
  if (!isIntentConfigured(router.pool, "vision")) {
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: framePaths.length,
      formHints,
      strategy,
      gifPath,
      framePaths,
      detail: "视觉模型未配置",
    };
  }

  const { route, client } = router.forIntent("vision", "GIF验证码识别");
  try {
    const asked = await askVisionPerFrameCode({
      client: client as unknown as VisionClient,
      model: route.model,
      framePaths: visionPaths,
      sourcePngPaths: sampled,
      logger: input.logger,
      pageHint: input.pageHint,
      signal: input.signal,
    });
    if (!asked) {
      return {
        ok: false,
        code: "",
        frame: 0,
        confidence: 0,
        framesCaptured: framePaths.length,
        formHints,
        strategy,
        gifPath,
        framePaths,
        artifactPaths,
        detail:
          "候选内存为空：全部帧均未读出验证码。勿刷新，可再调本工具；满3次 HITL。",
      };
    }
    return {
      ok: true,
      code: asked.code,
      frame: asked.frame,
      confidence: asked.confidence,
      framesCaptured: framePaths.length,
      formHints,
      strategy,
      gifPath,
      framePaths,
      artifactPaths,
      detail: `mode=per_frame_code frame=${asked.frame} conf=${asked.confidence}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (input.signal?.aborted || /已中止|abort/i.test(msg)) {
      throw new Error("Agent 已中止");
    }
    return {
      ok: false,
      code: "",
      frame: 0,
      confidence: 0,
      framesCaptured: framePaths.length,
      formHints,
      strategy,
      gifPath,
      framePaths,
      artifactPaths,
      detail: msg,
    };
  }
}

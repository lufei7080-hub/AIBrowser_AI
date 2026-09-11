/**
 * 通用切语言：确定性脚本优先（无站点硬编码）。
 * 流水线：感知命中文案 → 目标语短码 → 语言入口探针 →（耗尽后才交给 LLM/视觉）
 *
 * 重要：仅「切换网站 UI 语言」走本模块。
 * 「用希伯来语/英文填写资料」属于 fill_locale，禁止误判为切语言。
 */
import type { Page } from "playwright-core";

import { gatewayPointClick, requireGateway } from "./core/action_gateway.js";
import type { JsonLogger } from "./json-logger.js";
import {
  FILL_LOCALE_FRAME_RE,
  isFillLocaleGoal,
  LANGUAGE_NAME_RE,
  LANGUAGE_SWITCH_VERB_RE,
} from "./fill_locale.js";

/**
 * @deprecated 仅作文档/检索别名；真正判定请用 isLanguageSwitchGoal。
 * 旧正则过宽，会把「使用希伯来语填写」误判成切语言。
 */
export const LANGUAGE_GOAL_RE = LANGUAGE_SWITCH_VERB_RE;

/**
 * 是否要求切换网站/界面语言。
 * 「使用X语随机资料填写」等填资料语种目标必须返回 false。
 */
export function isLanguageSwitchGoal(goal: string): boolean {
  const g = String(goal ?? "");
  if (!g.trim()) {
    return false;
  }
  // 填资料语种优先：用/使用/以 X 语填写 → 绝不切 UI
  if (isFillLocaleGoal(g) && !LANGUAGE_SWITCH_VERB_RE.test(g)) {
    return false;
  }
  if (FILL_LOCALE_FRAME_RE.test(g) && !LANGUAGE_SWITCH_VERB_RE.test(g)) {
    return false;
  }
  if (LANGUAGE_SWITCH_VERB_RE.test(g)) {
    return true;
  }
  // 短指令：「切语言」「换语言」
  if (/^(?:请)?(?:帮我)?(?:切|换|改)(?:一下)?语言/i.test(g.trim())) {
    return true;
  }
  // 「把页面弄成英文」类且无填表意图
  if (
    LANGUAGE_NAME_RE.test(g) &&
    /(?:页面|界面|网站|网页|站点).{0,12}(?:英|中|希伯来|hebrew|arabic|日|韩|文|语)/i.test(g) &&
    !/(?:填|资料|随机|注册|登录|表单)/i.test(g)
  ) {
    return true;
  }
  return false;
}

export type LanguageTargetKind = "hebrew" | "english" | "chinese" | "arabic" | "generic";

export interface LanguageTarget {
  kind: LanguageTargetKind;
  label: string;
  /** 优先点击：目标语言本身 */
  pickTexts: string[];
  /** 次优先：打开语言菜单/入口的常见文案 */
  entryTexts: string[];
}

export function resolveLanguageTarget(goal: string): LanguageTarget {
  const g = String(goal ?? "");
  if (/希伯来|希伯來|hebrew|עברית/i.test(g)) {
    return {
      kind: "hebrew",
      label: "Hebrew / עברית / HE",
      pickTexts: ["עברית", "Hebrew", "HE", "Iw"],
      entryTexts: ["EN", "English", "Language", "语言", "語", "中文", "العربية"],
    };
  }
  if (/英语|英文|english/i.test(g)) {
    return {
      kind: "english",
      label: "English / EN",
      pickTexts: ["English", "EN", "Eng", "英语", "英文"],
      entryTexts: ["HE", "עברית", "Language", "语言", "語", "中文", "العربية", "EN"],
    };
  }
  if (/中文|简体|繁體|chinese|zh[-_]?cn|zh[-_]?tw/i.test(g)) {
    return {
      kind: "chinese",
      label: "中文 / CN / ZH",
      pickTexts: ["中文", "简体", "繁體", "繁体", "Chinese", "CN", "ZH"],
      entryTexts: ["EN", "English", "Language", "语言", "HE", "עברית", "العربية"],
    };
  }
  if (/阿拉伯|arabic|العرب/i.test(g)) {
    return {
      kind: "arabic",
      label: "العربية / AR",
      pickTexts: ["العربية", "Arabic", "AR"],
      entryTexts: ["EN", "English", "Language", "语言", "HE", "עברית", "中文"],
    };
  }
  return {
    kind: "generic",
    label: "目标语言菜单项",
    pickTexts: ["EN", "English", "HE", "עברית", "中文", "Language"],
    entryTexts: ["Language", "语言", "語", "EN", "HE"],
  };
}

export interface LanguageScriptResult {
  /** 已出现目标语言信号，可直接收工或交 LLM 确认 finish */
  done: boolean;
  /** 本轮有点击成功（页面可能变了） */
  progressed: boolean;
  /** 脚本候选已试完，允许视觉救赎 */
  exhausted: boolean;
  /** 累计尝试次数（含本轮） */
  attempts: number;
  note: string;
  clicked?: string;
  method?: string;
}

function uniqueTexts(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const t = String(raw ?? "").trim();
    if (!t || t.length > 24) {
      continue;
    }
    const key = t.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * 页面是否已呈现目标语言信号（html lang / dir / 正文语种密度）。
 * 希伯来语：lang=he|iw、dir=rtl + 正文希伯来字母密度、或表单类希伯来文案——
 * 不要求页面必须出现「עברית」菜单词（结账页常已是希伯来语却无该词）。
 */
export async function pageShowsLanguageTarget(
  page: Page,
  target: LanguageTarget,
): Promise<boolean> {
  try {
    return await page.evaluate(
      (args: { pickTexts: string[]; kind: string }) => {
        const stripMarks = (value: string) => value.replace(/[\u0591-\u05C7]/g, "");
        const htmlLang = (
          document.documentElement.getAttribute("lang") ||
          document.documentElement.getAttribute("xml:lang") ||
          ""
        ).toLowerCase();
        const htmlDir = (
          document.documentElement.getAttribute("dir") ||
          document.body?.getAttribute("dir") ||
          ""
        ).toLowerCase();
        const rawBody = (document.body?.innerText || "").slice(0, 6000);
        const bodySample = stripMarks(rawBody);
        const heLetters = (bodySample.match(/[\u0590-\u05FF]/g) || []).length;
        const latinLetters = (bodySample.match(/[A-Za-z]/g) || []).length;
        const denseHebrew = heLetters >= 40 && heLetters >= latinLetters * 0.35;
        const rtlHint = htmlDir === "rtl" || denseHebrew;
        // 结账/注册表常见希伯来标签（比单纯「עברית」芯片更可靠）
        const hebrewFormHints =
          /שם\s*מלא|אימייל|דוא"?ל|טלפון|רחוב|עיר|יישוב|מספר\s*בית|דירה|קומה|כניסה|פרטים\s*אישיים|אישור|המשך|לתשלום/.test(
            bodySample,
          );

        for (const t of args.pickTexts) {
          const want = stripMarks(String(t || ""))
            .trim()
            .toLowerCase();
          if (!want) {
            continue;
          }
          if (want === "en" || want === "eng" || want === "english") {
            if (/^en\b/.test(htmlLang)) {
              // 已是英文页：希伯来字母很少
              if (heLetters < 20 || latinLetters > heLetters * 2) {
                return true;
              }
            }
            if (/\benglish\b/i.test(bodySample) && heLetters < 30) {
              return true;
            }
            continue;
          }
          if (want === "he" || want === "iw" || want === "hebrew" || want.includes("עברית")) {
            if (/^(he|iw)\b/.test(htmlLang)) {
              return true;
            }
            // 正文已是希伯来语结账/表单：视为已切好，禁止再点语言芯片空转
            if (hebrewFormHints || (rtlHint && denseHebrew)) {
              return true;
            }
            // 仅菜单里出现「עברית」不够（可能仍是英文 UI）
            if (/עברית/.test(bodySample) && denseHebrew) {
              return true;
            }
            continue;
          }
          if (want === "ar" || want.includes("العرب")) {
            if (/^ar\b/.test(htmlLang)) {
              return true;
            }
            continue;
          }
          if (want === "zh" || want === "cn" || want.includes("中文") || want.includes("简体")) {
            if (/^zh\b/.test(htmlLang) || /[\u4e00-\u9fff]{20,}/.test(bodySample)) {
              return true;
            }
            continue;
          }
          const blob = `${htmlLang}\n${bodySample}`.toLowerCase();
          if (blob.includes(want) && args.kind !== "hebrew") {
            return true;
          }
        }

        // kind 兜底：即使 pickTexts 未命中，强信号也算匹配
        if (args.kind === "hebrew" && (hebrewFormHints || (/^(he|iw)\b/.test(htmlLang) && denseHebrew))) {
          return true;
        }
        return false;
      },
      { pickTexts: target.pickTexts, kind: target.kind },
    );
  } catch {
    return false;
  }
}

/** 导出给其它模块：正文是否已是希伯来语表单/结账态（可跳过切语言） */
export async function pageLooksLikeHebrewUi(page: Page): Promise<boolean> {
  return pageShowsLanguageTarget(page, resolveLanguageTarget("希伯来语 hebrew עברית"));
}

async function clickByVisibleText(
  page: Page,
  text: string,
  reason: string,
): Promise<{ ok: boolean; method?: string; detail?: string }> {
  const gateway = requireGateway();
  try {
    const exact = page.getByText(text, { exact: true }).first();
    if (await exact.isVisible().catch(() => false)) {
      await gateway.click(exact, { semanticLabel: text, skipSettle: true });
      return { ok: true, method: "getByText_exact" };
    }
    const loose = page.getByText(text, { exact: false }).first();
    if (await loose.isVisible().catch(() => false)) {
      await gateway.click(loose, { semanticLabel: text, skipSettle: true });
      return { ok: true, method: "getByText_loose" };
    }

    const clicked = await page.evaluate((targetText: string) => {
      const clean = (value: string) =>
        value
          .replace(/[\u0591-\u05C7]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      const want = clean(targetText).toLowerCase();
      if (!want) {
        return null;
      }
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      const candidates: Array<{ el: HTMLElement; score: number }> = [];
      const nodes = document.querySelectorAll(
        "a, button, span, div, li, p, label, uni-view, uni-text, view, text, [role='button'], img",
      );
      nodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) {
          return;
        }
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          return;
        }
        const label = clean(
          node.innerText ||
            node.textContent ||
            node.getAttribute("aria-label") ||
            node.getAttribute("title") ||
            node.getAttribute("alt") ||
            "",
        );
        if (!label || label.length > 48) {
          return;
        }
        const lower = label.toLowerCase();
        if (lower !== want && !lower.includes(want) && !want.includes(lower)) {
          return;
        }
        const rect = node.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) {
          return;
        }
        if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) {
          return;
        }
        const exactHit = lower === want ? 0 : 1;
        const small = rect.width <= 96 && rect.height <= 96 ? 0 : 2;
        const topRight = rect.top < vh * 0.4 && rect.left > vw * 0.5 ? 0 : 1;
        candidates.push({ el: node, score: exactHit * 10 + small + topRight });
      });
      candidates.sort((a, b) => a.score - b.score);
      const best = candidates[0]?.el;
      if (!best) {
        return null;
      }
      const rect = best.getBoundingClientRect();
      return {
        text: clean(best.innerText || best.textContent || "").slice(0, 48) || text,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    }, text);

    if (!clicked) {
      return { ok: false, detail: `未找到「${text}」` };
    }
    await gatewayPointClick(page, clicked.x, clicked.y, {
      semanticLabel: clicked.text || text,
      skipSettle: true,
    });
    return { ok: true, method: "dom_coordinate", detail: reason };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 通用语言入口探针：aria/title/class 含 lang，优先右上角小控件 */
export async function clickLanguageEntryProbe(page: Page): Promise<{
  ok: boolean;
  detail?: string;
}> {
  try {
    const hit = await page.evaluate(() => {
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      const nodes = Array.from(
        document.querySelectorAll(
          [
            "[aria-label*='lang' i]",
            "[aria-label*='language' i]",
            "[title*='lang' i]",
            "[title*='language' i]",
            "[class*='lang' i]",
            "[class*='locale' i]",
            "[data-lang]",
            "img[alt*='lang' i]",
            "img[src*='lang' i]",
            "img[src*='globe' i]",
            "svg",
          ].join(","),
        ),
      );
      const scored: Array<{ el: HTMLElement; score: number; label: string }> = [];
      for (const node of nodes) {
        let el: HTMLElement | null =
          node instanceof HTMLElement ? node : (node.parentElement as HTMLElement | null);
        if (!el) {
          continue;
        }
        // svg → 可点父级
        if (node.tagName.toLowerCase() === "svg") {
          el = node.closest("a,button,[role='button'],uni-view,div,span") as HTMLElement | null;
          if (!el) {
            continue;
          }
        }
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
          continue;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8 || rect.width > 120 || rect.height > 120) {
          continue;
        }
        if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) {
          continue;
        }
        const label = (
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.className?.toString?.() ||
          el.tagName
        ).slice(0, 48);
        const topRight = rect.top < vh * 0.35 && rect.left > vw * 0.55 ? 0 : 3;
        const small = rect.width <= 48 && rect.height <= 48 ? 0 : 1;
        scored.push({ el, score: topRight + small, label });
      }
      scored.sort((a, b) => a.score - b.score);
      const best = scored[0];
      if (!best) {
        return null;
      }
      const rect = best.el.getBoundingClientRect();
      return {
        label: best.label,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    });
    if (!hit) {
      return { ok: false, detail: "无语言入口探针命中" };
    }
    await gatewayPointClick(page, hit.x, hit.y, {
      semanticLabel: hit.label || "language-entry",
      skipSettle: true,
    });
    return { ok: true, detail: hit.label };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function settleBrief(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
  try {
    await page.waitForTimeout(800);
  } catch {
    await new Promise((r) => setTimeout(r, 800));
  }
}

/**
 * 在 LLM 轮之前尝试确定性切语言（最多点击 2 次：入口 + 目标语）。
 * 无站点 host 特例。
 */
export async function tryDeterministicLanguageSwitch(input: {
  page: Page;
  goal: string;
  goalHits?: string[];
  logger: JsonLogger;
  /** 已尝试次数（跨轮累计） */
  attemptsSoFar: number;
  maxAttempts?: number;
}): Promise<LanguageScriptResult> {
  const maxAttempts = Math.max(2, input.maxAttempts ?? 4);
  if (!isLanguageSwitchGoal(input.goal)) {
    return { done: false, progressed: false, exhausted: true, attempts: input.attemptsSoFar, note: "非切语言目标" };
  }
  if (input.attemptsSoFar >= maxAttempts) {
    return {
      done: false,
      progressed: false,
      exhausted: true,
      attempts: input.attemptsSoFar,
      note: `切语言脚本已达上限(${maxAttempts})，交 LLM/视觉`,
    };
  }

  const target = resolveLanguageTarget(input.goal);
  if (await pageShowsLanguageTarget(input.page, target)) {
    return {
      done: true,
      progressed: false,
      exhausted: false,
      attempts: input.attemptsSoFar,
      note: `页面已呈现目标语言信号（${target.label}）`,
    };
  }

  const ordered = uniqueTexts([
    ...(input.goalHits ?? []),
    ...target.pickTexts,
    ...target.entryTexts,
  ]);

  let attempts = input.attemptsSoFar;
  let lastClick = "";
  let lastMethod = "";

  // 1) 先点目标语 / 感知命中（菜单可能已开）
  for (const text of ordered.slice(0, 8)) {
    if (attempts >= maxAttempts) {
      break;
    }
    attempts += 1;
    input.logger.agentState("running", {
      step: attempts,
      msg: `切语言·脚本点击「${text}」`,
    });
    const hit = await clickByVisibleText(input.page, text, `deterministic pick ${text}`);
    if (!hit.ok) {
      continue;
    }
    lastClick = text;
    lastMethod = hit.method ?? "click";
    input.logger.progress("language_script_click", {
      text,
      method: hit.method,
      phase: "pick_or_entry",
    });
    await settleBrief(input.page);
    if (await pageShowsLanguageTarget(input.page, target)) {
      return {
        done: true,
        progressed: true,
        exhausted: false,
        attempts,
        note: `脚本已切到 ${target.label}（点「${text}」）`,
        clicked: text,
        method: lastMethod,
      };
    }
    // 点了入口：立刻再试目标语
    for (const pick of target.pickTexts.slice(0, 4)) {
      if (attempts >= maxAttempts) {
        break;
      }
      if (pick.toLowerCase() === text.toLowerCase()) {
        continue;
      }
      attempts += 1;
      input.logger.agentState("running", {
        step: attempts,
        msg: `切语言·脚本选目标「${pick}」`,
      });
      const pickHit = await clickByVisibleText(input.page, pick, `deterministic target ${pick}`);
      if (!pickHit.ok) {
        continue;
      }
      lastClick = pick;
      lastMethod = pickHit.method ?? "click";
      input.logger.progress("language_script_click", {
        text: pick,
        method: pickHit.method,
        phase: "target",
      });
      await settleBrief(input.page);
      if (await pageShowsLanguageTarget(input.page, target)) {
        return {
          done: true,
          progressed: true,
          exhausted: false,
          attempts,
          note: `脚本已切到 ${target.label}（入口后点「${pick}」）`,
          clicked: pick,
          method: lastMethod,
        };
      }
      break;
    }
    break;
  }

  // 2) 文案全无 → 语言入口探针（地球仪 / aria）
  if (attempts < maxAttempts && !lastClick) {
    attempts += 1;
    input.logger.agentState("running", {
      step: attempts,
      msg: "切语言·探针语言入口（aria/图标）",
    });
    const probe = await clickLanguageEntryProbe(input.page);
    if (probe.ok) {
      lastClick = probe.detail || "lang-probe";
      lastMethod = "lang_entry_probe";
      input.logger.progress("language_script_probe", { detail: probe.detail });
      await settleBrief(input.page);
      for (const pick of target.pickTexts.slice(0, 4)) {
        if (attempts >= maxAttempts) {
          break;
        }
        attempts += 1;
        const pickHit = await clickByVisibleText(input.page, pick, `after probe ${pick}`);
        if (!pickHit.ok) {
          continue;
        }
        lastClick = pick;
        lastMethod = pickHit.method ?? "click";
        await settleBrief(input.page);
        if (await pageShowsLanguageTarget(input.page, target)) {
          return {
            done: true,
            progressed: true,
            exhausted: false,
            attempts,
            note: `探针入口后点「${pick}」已切到 ${target.label}`,
            clicked: pick,
            method: lastMethod,
          };
        }
        break;
      }
      return {
        done: false,
        progressed: true,
        exhausted: attempts >= maxAttempts,
        attempts,
        note: `已点语言入口探针，菜单可能已开；继续脚本或交 LLM 点「${target.label}」`,
        clicked: lastClick,
        method: lastMethod,
      };
    }
  }

  const exhausted = attempts >= maxAttempts || !lastClick;
  return {
    done: false,
    progressed: Boolean(lastClick),
    exhausted,
    attempts,
    note: lastClick
      ? `脚本已点「${lastClick}」，尚未确认语言切换；交 LLM/视觉跟进`
      : "脚本未命中可见语言文案/入口，交 LLM 感知或视觉",
    clicked: lastClick || undefined,
    method: lastMethod || undefined,
  };
}

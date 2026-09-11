/**
 * Milestone 5：防遮挡动态拦截（Anti-Overlay / PointerEvent）
 *
 * Playwright Actionability 会被「透明全屏 Loading / Cloudflare 无感遮罩」欺骗。
 * 在真实 click/fill 前：对目标 Element 中心点做 elementFromPoint，
 * 顶层节点必须是目标或其祖先/后代；否则中止并返回
 * `Blocked by overlay: div.cf-turnstile-wrapper` 给深度逻辑模型决策。
 */
import type { Locator, Page } from "playwright-core";

export type ClickGuardResult =
  | { ok: true; x: number; y: number; topTag: string }
  | {
      ok: false;
      x: number;
      y: number;
      reason: string;
      topTag?: string;
      topText?: string;
      blockedBy?: string;
    };

const MASK_HINT_RE =
  /mask|modal|overlay|dialog|popup|toast|loading|spinner|cookie|consent|backdrop|drawer|turnstile|captcha|cf-|遮罩|弹窗|加载/i;

function describeOverlayElement(input: {
  tag: string;
  id: string;
  className: string;
  text: string;
}): string {
  const tag = (input.tag || "div").toLowerCase();
  const id = input.id.trim() ? `#${input.id.trim()}` : "";
  const classTokens = String(input.className || "")
    .split(/\s+/)
    .map((c) => c.trim())
    .filter((c) => c && c.length < 48 && !/^[a-f0-9_-]{16,}$/i.test(c));
  // 优先挑「像遮罩」的 class，否则取前两个
  const preferred =
    classTokens.find((c) => MASK_HINT_RE.test(c)) ??
    classTokens.slice(0, 2).join(".") ;
  const cls = preferred ? `.${preferred.replace(/\s+/g, ".")}` : "";
  const base = `${tag}${id}${cls}`;
  if (input.text.trim()) {
    return `${base}「${input.text.trim().slice(0, 40)}」`;
  }
  return base;
}

function occlusionFailMessage(detail: string): string {
  const blocked = detail.startsWith("Blocked by overlay:")
    ? detail
    : `Blocked by overlay: ${detail}`;
  return (
    `${blocked}。点击已中止：坐标顶层元素与目标节点不匹配（疑似透明遮罩/弹窗/Loading）。` +
    `请先关闭该层、等待加载结束，或改点关闭按钮；禁止对着遮罩盲点。`
  );
}

/**
 * 核心：在目标 Locator 自身上下文中取中心点 + elementFromPoint，
 * 与目标 Node 做 contains 关系判定（比纯 selector 字符串更抗欺骗）。
 */
export async function assertLocatorNotOccluded(
  page: Page,
  locator: Locator,
): Promise<ClickGuardResult> {
  void page;
  try {
    const probe = await locator.evaluate((el) => {
      if (!(el instanceof Element)) {
        return {
          ok: false as const,
          x: 0,
          y: 0,
          reason: "目标不是 Element",
          topTag: "",
          topText: "",
          blockedBy: "",
        };
      }
      const target = el as HTMLElement;
      const rect = target.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        return {
          ok: false as const,
          x: 0,
          y: 0,
          reason: "目标无有效包围盒（宽高<2）",
          topTag: "",
          topText: "",
          blockedBy: "",
        };
      }
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const top = document.elementFromPoint(x, y);
      if (!top || !(top instanceof Element)) {
        return {
          ok: false as const,
          x: Math.round(x),
          y: Math.round(y),
          reason: "elementFromPoint 无元素",
          topTag: "",
          topText: "",
          blockedBy: "unknown",
        };
      }
      const topEl = top as HTMLElement;
      const related =
        top === target || target.contains(top) || top.contains(target);
      const topTag = (topEl.tagName || "").toLowerCase();
      const topText = (topEl.innerText || topEl.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      const topId = String(topEl.id || "");
      const topClass = String(topEl.className || "");

      if (related) {
        return {
          ok: true as const,
          x: Math.round(x),
          y: Math.round(y),
          topTag,
          topText,
          blockedBy: "",
        };
      }

      return {
        ok: false as const,
        x: Math.round(x),
        y: Math.round(y),
        reason: "顶层节点与目标不匹配",
        topTag,
        topText,
        blockedBy: JSON.stringify({
          tag: topTag,
          id: topId,
          className: topClass,
          text: topText.slice(0, 40),
        }),
      };
    });

    if (probe.ok) {
      return {
        ok: true,
        x: probe.x,
        y: probe.y,
        topTag: probe.topTag,
      };
    }

    let blockedLabel = probe.topTag || "unknown";
    if (probe.blockedBy) {
      try {
        const parsed = JSON.parse(probe.blockedBy) as {
          tag?: string;
          id?: string;
          className?: string;
          text?: string;
        };
        blockedLabel = describeOverlayElement({
          tag: parsed.tag ?? "",
          id: parsed.id ?? "",
          className: parsed.className ?? "",
          text: parsed.text ?? "",
        });
      } catch {
        blockedLabel = probe.topTag || probe.reason;
      }
    }

    return {
      ok: false,
      x: probe.x,
      y: probe.y,
      reason: occlusionFailMessage(blockedLabel),
      topTag: probe.topTag,
      topText: probe.topText,
      blockedBy: blockedLabel,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      x: 0,
      y: 0,
      reason: occlusionFailMessage(`检测异常 ${message.slice(0, 80)}`),
    };
  }
}

/** 校验视口坐标 (x,y) 顶层元素（视觉坐标点击用） */
export async function assertPointClickable(
  page: Page,
  x: number,
  y: number,
  expect?: { selector?: string; text?: string },
): Promise<ClickGuardResult> {
  const probe = await page.evaluate(
    ({ px, py, selector, text }: { px: number; py: number; selector?: string; text?: string }) => {
      const top = document.elementFromPoint(px, py);
      if (!top || !(top instanceof Element)) {
        return {
          ok: false as const,
          reason: "elementFromPoint 无元素",
          topTag: "",
          topText: "",
          blockedBy: "",
        };
      }
      const topEl = top as HTMLElement;
      const topTag = (topEl.tagName || "").toLowerCase();
      const topText = (topEl.innerText || topEl.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      const topId = String(topEl.id || "");
      const topClass = String(topEl.className || "");
      const style = window.getComputedStyle(topEl);
      if (
        style.visibility === "hidden" ||
        Number(style.opacity) === 0 ||
        style.pointerEvents === "none"
      ) {
        return {
          ok: false as const,
          reason: "顶层元素不可见或 pointer-events:none",
          topTag,
          topText,
          blockedBy: JSON.stringify({
            tag: topTag,
            id: topId,
            className: topClass,
            text: topText.slice(0, 40),
          }),
        };
      }

      let matched = false;
      if (selector) {
        try {
          const expected = document.querySelector(selector);
          if (
            expected &&
            (expected === top || expected.contains(top) || top.contains(expected))
          ) {
            matched = true;
          }
          if (!matched && top.closest(selector)) {
            matched = true;
          }
        } catch {
          /* invalid selector */
        }
      }
      if (!matched && text) {
        const want = text.replace(/\s+/g, " ").trim().slice(0, 40);
        if (want && (topText.includes(want) || want.includes(topText.slice(0, 20)))) {
          matched = true;
        }
      }

      const rect = topEl.getBoundingClientRect();
      const vw = Math.max(1, window.innerWidth);
      const vh = Math.max(1, window.innerHeight);
      const covers =
        rect.width >= vw * 0.85 && rect.height >= vh * 0.4;
      const isChromeShell =
        topTag === "html" ||
        topTag === "body" ||
        topTag === "main" ||
        (topTag === "div" && covers);
      const smallHit =
        rect.width >= 8 &&
        rect.height >= 8 &&
        rect.width <= 160 &&
        rect.height <= 160;
      const iconish =
        /^(img|button|a|i|svg|path|uni-image|uni-button|span|label)$/i.test(topTag) ||
        /icon|btn|lang|flag|avatar|image/i.test(`${topId} ${topClass}`);
      const visualDesc =
        Boolean(text) &&
        /右上|左上|右下|左下|圆形|圆钮|图标|icon|按钮|语言|地球|国旗|旗|耳机|客服|\ben\b|hebrew|עבר|中文|图片|照片/i.test(
          String(text),
        );

      if (!selector && !text) {
        if (isChromeShell) {
          return {
            ok: false as const,
            reason: "坐标落在整页壳层，拒绝松散点击",
            topTag,
            topText,
            blockedBy: JSON.stringify({
              tag: topTag,
              id: topId,
              className: topClass,
              text: topText.slice(0, 40),
            }),
          };
        }
        const maskHit =
          /mask|modal|overlay|dialog|popup|loading|spinner|cookie|consent|backdrop|turnstile|captcha|cf-/i.test(
            topClass,
          ) ||
          /mask|modal|overlay|turnstile|captcha/i.test(topId);
        if (maskHit && covers) {
          return {
            ok: false as const,
            reason: "疑似全屏遮罩",
            topTag,
            topText,
            blockedBy: JSON.stringify({
              tag: topTag,
              id: topId,
              className: topClass,
              text: topText.slice(0, 40),
            }),
          };
        }
        // 无目标描述时：只允许落在小可点控件上，禁止点大容器中心
        if (!smallHit && !iconish) {
          return {
            ok: false as const,
            reason: "坐标未落到明确小控件，拒绝宽松点击",
            topTag,
            topText,
            blockedBy: JSON.stringify({
              tag: topTag,
              id: topId,
              className: topClass,
              text: topText.slice(0, 40),
            }),
          };
        }
        return { ok: true as const, topTag, topText, blockedBy: "" };
      }

      // 视觉描述常无法匹配 DOM 文案：允许「描述像图标 + 顶层是小图标控件」
      if (!matched && visualDesc && smallHit && iconish && !isChromeShell) {
        matched = true;
      }

      if (matched) {
        return { ok: true as const, topTag, topText, blockedBy: "" };
      }
      return {
        ok: false as const,
        reason: "坐标顶层不是目标控件",
        topTag,
        topText,
        blockedBy: JSON.stringify({
          tag: topTag,
          id: topId,
          className: topClass,
          text: topText.slice(0, 40),
        }),
      };
    },
    {
      px: Math.round(x),
      py: Math.round(y),
      selector: expect?.selector,
      text: expect?.text,
    },
  );

  if (!probe.ok) {
    let blockedLabel = probe.topTag || probe.reason;
    if (probe.blockedBy) {
      try {
        const parsed = JSON.parse(probe.blockedBy) as {
          tag?: string;
          id?: string;
          className?: string;
          text?: string;
        };
        blockedLabel = describeOverlayElement({
          tag: parsed.tag ?? "",
          id: parsed.id ?? "",
          className: parsed.className ?? "",
          text: parsed.text ?? "",
        });
      } catch {
        /* keep */
      }
    }
    return {
      ok: false,
      x: Math.round(x),
      y: Math.round(y),
      reason: occlusionFailMessage(blockedLabel),
      topTag: probe.topTag,
      topText: probe.topText,
      blockedBy: blockedLabel,
    };
  }
  return {
    ok: true,
    x: Math.round(x),
    y: Math.round(y),
    topTag: probe.topTag,
  };
}

/** 根据 Playwright boundingBox 校验中心点（无 Locator 时的兜底） */
export async function assertBoxCenterClickable(
  page: Page,
  box: { x: number; y: number; width: number; height: number } | null,
  expect?: { selector?: string; text?: string },
): Promise<ClickGuardResult> {
  if (!box || box.width < 2 || box.height < 2) {
    return {
      ok: false,
      x: 0,
      y: 0,
      reason: occlusionFailMessage("目标无有效包围盒（宽高<2）"),
    };
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  return assertPointClickable(page, x, y, expect);
}

export function looksLikeMaskDescription(text: string): boolean {
  return MASK_HINT_RE.test(text);
}

export function isOverlayBlockedError(message: string): boolean {
  return /Blocked by overlay:/i.test(message);
}

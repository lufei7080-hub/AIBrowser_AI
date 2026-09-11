/**
 * Milestone 5：元素自愈重连（Node-Layer Self-Healing）
 *
 * React/Vue 重渲染会使短 ID 背后的 ElementHandle/selector 失效。
 * 蒸馏阶段把「指纹」存进 element_map；遇 stale 时静默按指纹重查（最多 2 次），
 * 成功则对 LLM 透明，失败再上报。
 */
import type { Page } from "playwright-core";

export interface ElementFingerprint {
  tagName: string;
  textDigest: string;
  inputType: string | null;
  name?: string;
  placeholder?: string;
  role?: string;
  ariaLabel?: string;
  classHints?: string[];
  xpath?: string;
  selector?: string;
}

export interface HealedElementRef {
  id: string;
  selector: string;
  xpath: string;
  tagName: string;
  inputType: string | null;
  text: string;
  frameUrl?: string | null;
  rect?: { x: number; y: number; w: number; h: number } | null;
  fingerprint?: ElementFingerprint;
}

const STALE_RE =
  /not attached|detached|stale|Element is not attached|Node is detached|Execution context was destroyed|Target closed|frame was detached|unable to find element|strict mode violation|waiting for (locator|selector)|Timeout \d+ms exceeded/i;

export function isStaleLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return STALE_RE.test(message);
}

function digestText(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48)
    .toLowerCase();
}

function classHintsFrom(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .split(/\s+/)
    .map((c) => c.trim())
    .filter((c) => c.length >= 2 && c.length < 40 && !/^[a-f0-9_-]{12,}$/i.test(c))
    .slice(0, 4);
}

export function buildElementFingerprint(input: {
  tagName: string;
  text?: string | null;
  inputType?: string | null;
  name?: string | null;
  placeholder?: string | null;
  role?: string | null;
  ariaLabel?: string | null;
  className?: string | null;
  xpath?: string | null;
  selector?: string | null;
}): ElementFingerprint {
  return {
    tagName: String(input.tagName ?? "").toLowerCase(),
    textDigest: digestText(input.text),
    inputType: input.inputType ? String(input.inputType).toLowerCase() : null,
    name: input.name?.trim() || undefined,
    placeholder: input.placeholder?.trim() || undefined,
    role: input.role?.trim() || undefined,
    ariaLabel: input.ariaLabel?.trim() || undefined,
    classHints: classHintsFrom(input.className),
    xpath: input.xpath?.trim() || undefined,
    selector: input.selector?.trim() || undefined,
  };
}

export async function requeryByFingerprint(
  page: Page,
  fingerprint: ElementFingerprint,
  frameUrl?: string | null,
): Promise<HealedElementRef | null> {
  const scope =
    frameUrl && frameUrl.trim()
      ? page.frames().find((frame) => frame.url() === frameUrl) ?? page
      : page;

  const hit = await scope
    .evaluate((fp: Record<string, unknown>) => {
      const digest = (value: string | null | undefined) =>
        String(value ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 48)
          .toLowerCase();

      function buildXPath(element: Element): string {
        const segments: string[] = [];
        let current: Element | null = element;
        while (current && current.nodeType === 1) {
          let index = 1;
          let sibling: Element | null = current.previousElementSibling;
          while (sibling) {
            if (sibling.nodeName === current.nodeName) {
              index += 1;
            }
            sibling = sibling.previousElementSibling;
          }
          segments.unshift(`${current.nodeName.toLowerCase()}[${index}]`);
          current = current.parentElement;
        }
        return `/${segments.join("/")}`;
      }

      function cssPath(element: Element): string {
        const html = element as HTMLElement;
        if (html.id) {
          return `#${CSS.escape(html.id)}`;
        }
        const parts: string[] = [];
        let cur: Element | null = element;
        while (cur && cur.nodeType === 1 && parts.length < 5) {
          let part = cur.nodeName.toLowerCase();
          const curHtml = cur as HTMLElement;
          if (curHtml.id) {
            parts.unshift(`#${CSS.escape(curHtml.id)}`);
            break;
          }
          const parentEl: Element | null = cur.parentElement;
          if (parentEl) {
            const same = Array.from(parentEl.children).filter(
              (child: Element) => child.nodeName === cur!.nodeName,
            );
            if (same.length > 1) {
              part += `:nth-of-type(${same.indexOf(cur) + 1})`;
            }
          }
          parts.unshift(part);
          cur = parentEl;
        }
        return parts.join(" > ");
      }

      const wantTag = String(fp.tagName || "").toLowerCase();
      const wantText = String(fp.textDigest || "");
      const wantType = fp.inputType ? String(fp.inputType).toLowerCase() : "";
      const wantName = String(fp.name || "").toLowerCase();
      const wantPh = String(fp.placeholder || "").toLowerCase();
      const wantRole = String(fp.role || "").toLowerCase();
      const wantAria = String(fp.ariaLabel || "").toLowerCase();
      const classHints = Array.isArray(fp.classHints)
        ? (fp.classHints as string[])
        : [];

      const nodes = Array.from(
        document.querySelectorAll(
          "a,button,input,textarea,select,summary,[role='button'],[role='link'],[role='textbox'],[contenteditable='true'],label,option",
        ),
      ) as Element[];

      type BestHit = { el: Element; score: number };
      let best: BestHit | null = null;
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }
        const style = window.getComputedStyle(node);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        ) {
          continue;
        }
        const rect = node.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) {
          continue;
        }

        let score = 0;
        const tag = node.tagName.toLowerCase();
        if (wantTag && tag === wantTag) {
          score += 30;
        } else if (wantTag) {
          score -= 10;
        }

        const text = digest(
          node.innerText ||
            node.getAttribute("aria-label") ||
            (node as HTMLInputElement).placeholder ||
            node.textContent,
        );
        if (wantText && text) {
          if (text === wantText) {
            score += 40;
          } else if (text.includes(wantText) || wantText.includes(text.slice(0, 16))) {
            score += 22;
          }
        }

        const inputType = ((node as HTMLInputElement).type || "").toLowerCase();
        if (wantType && inputType === wantType) {
          score += 15;
        }
        const nameAttr = String(node.getAttribute("name") || "").toLowerCase();
        if (wantName && nameAttr === wantName) {
          score += 18;
        }
        const ph = String((node as HTMLInputElement).placeholder || "").toLowerCase();
        if (wantPh && ph && (ph === wantPh || ph.includes(wantPh))) {
          score += 12;
        }
        const role = String(node.getAttribute("role") || "").toLowerCase();
        if (wantRole && role === wantRole) {
          score += 8;
        }
        const aria = String(node.getAttribute("aria-label") || "").toLowerCase();
        if (wantAria && aria && (aria === wantAria || aria.includes(wantAria))) {
          score += 12;
        }
        const cls = String(node.className || "");
        for (const hint of classHints) {
          if (hint && cls.includes(hint)) {
            score += 5;
          }
        }

        if (!best || score > best.score) {
          best = { el: node, score };
        }
      }

      if ((!best || best.score < 40) && fp.selector) {
        try {
          const el = document.querySelector(String(fp.selector));
          if (el instanceof HTMLElement) {
            const prevScore = best ? best.score : 0;
            best = { el, score: Math.max(prevScore, 35) };
          }
        } catch {
          /* ignore */
        }
      }

      if (!best || best.score < 35) {
        return null;
      }

      const el = best.el as HTMLElement;
      const rect = el.getBoundingClientRect();
      return {
        tagName: el.tagName.toLowerCase(),
        inputType: (el as HTMLInputElement).type || null,
        text: digest(el.innerText || el.getAttribute("aria-label") || el.textContent).slice(
          0,
          80,
        ),
        selector: cssPath(el),
        xpath: buildXPath(el),
        score: best.score,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      };
    }, fingerprint as unknown as Record<string, unknown>)
    .catch(() => null);

  if (!hit) {
    return null;
  }

  return {
    id: "",
    selector: hit.selector,
    xpath: hit.xpath,
    tagName: hit.tagName,
    inputType: hit.inputType,
    text: hit.text,
    frameUrl: frameUrl ?? null,
    rect: hit.rect,
    fingerprint: {
      ...fingerprint,
      selector: hit.selector,
      xpath: hit.xpath,
      textDigest: digestText(hit.text),
    },
  };
}

export async function withElementSelfHeal(input: {
  page: Page;
  ref: HealedElementRef;
  onHealed?: (ref: HealedElementRef) => void;
  action: (ref: HealedElementRef) => Promise<void>;
  maxRetries?: number;
}): Promise<{ healed: boolean; attempts: number }> {
  const maxRetries = Math.max(0, input.maxRetries ?? 2);
  let ref = input.ref;
  let healed = false;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      if (ref.fingerprint) {
        const probeSelector =
          ref.selector.startsWith("/") || ref.selector.startsWith("xpath=")
            ? ref.selector.startsWith("xpath=")
              ? ref.selector
              : `xpath=${ref.selector}`
            : ref.selector;
        const frameUrl = ref.frameUrl?.trim();
        const scope =
          frameUrl && frameUrl.length > 0
            ? input.page.frames().find((frame) => frame.url() === frameUrl) ?? input.page
            : input.page;
        const connected = await scope
          .locator(probeSelector)
          .first()
          .evaluate((el) => Boolean(el.isConnected))
          .catch(() => false);
        if (!connected) {
          const next = await requeryByFingerprint(
            input.page,
            ref.fingerprint,
            ref.frameUrl,
          );
          if (!next) {
            throw new Error("stale element: fingerprint requery miss");
          }
          next.id = ref.id;
          ref = next;
          healed = true;
          input.onHealed?.(ref);
        }
      }

      await input.action(ref);
      return { healed, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (!isStaleLikeError(error) || attempt >= maxRetries) {
        throw error;
      }
      if (!ref.fingerprint) {
        throw error;
      }
      const next = await requeryByFingerprint(input.page, ref.fingerprint, ref.frameUrl);
      if (!next) {
        throw error;
      }
      next.id = ref.id;
      ref = next;
      healed = true;
      input.onHealed?.(ref);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "self-heal exhausted"));
}

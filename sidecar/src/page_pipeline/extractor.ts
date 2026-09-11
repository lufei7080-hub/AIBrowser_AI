/**
 * Extractor：索引 DOM 蒸馏 + CDP 无障碍树兜底摘要。
 */
import type { CDPSession, Page } from "playwright-core";

import {
  extractAgentInteractiveTree,
  type AgentExtractResult,
} from "../interactive_elements.js";
import {
  applyDistillToExtract,
  computeStructureHash,
} from "../page_distill.js";
import type { AgentSenseMode } from "../llm_budget.js";
import { PAGE_PIPELINE_CONFIG } from "./config.js";

export interface ExtractObservationResult {
  extract: AgentExtractResult & { structureHash: string; truncated: number };
  structureHash: string;
  a11ySummary: string | null;
  error: string | null;
}

export async function extractAndDistill(
  page: Page,
  opts?: {
    goal?: string;
    senseMode?: AgentSenseMode;
    includeScreenshot?: boolean;
    signal?: AbortSignal;
  },
): Promise<ExtractObservationResult> {
  if (opts?.signal?.aborted) {
    throw new Error("提取已中止");
  }

  try {
    const extractMs = PAGE_PIPELINE_CONFIG.extractTimeoutMs ?? 12_000;
    const raw = await Promise.race([
      extractAgentInteractiveTree(page, {
        includeScreenshot: opts?.includeScreenshot === true,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`extract_timeout_${extractMs}ms`)), extractMs);
      }),
    ]);
    const viewport = await page
      .evaluate(() => ({
        width: window.innerWidth || 1280,
        height: window.innerHeight || 800,
      }))
      .catch(() => ({ width: 1280, height: 800 }));

    const distilled = applyDistillToExtract(raw, opts?.senseMode ?? "balanced", {
      goal: opts?.goal,
      viewport,
    });

    const a11ySummary = await Promise.race([
      fetchA11ySummary(page),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 2_000);
      }),
    ]).catch(() => null);

    return {
      extract: distilled,
      structureHash: distilled.structureHash || computeStructureHash(distilled.llm_json),
      a11ySummary,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      extract: {
        url: page.url(),
        extractedAt: new Date().toISOString(),
        llm_json: [],
        element_map: new Map(),
        skipped: 0,
        structureHash: "error",
        truncated: 0,
      },
      structureHash: "error",
      a11ySummary: null,
      error: message,
    };
  }
}

/** CDP Accessibility.getFullAXTree → 压缩文本兜底 */
async function fetchA11ySummary(page: Page): Promise<string | null> {
  let client: CDPSession | null = null;
  try {
    client = await page.context().newCDPSession(page);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await (client as any).send("Accessibility.getFullAXTree")) as {
      nodes?: Array<{
        ignored?: boolean;
        role?: { value?: string };
        name?: { value?: string };
        description?: { value?: string };
      }>;
    };
    const nodes = result?.nodes ?? [];
    const lines: string[] = [];
    for (const n of nodes) {
      if (n.ignored) {
        continue;
      }
      const role = String(n.role?.value ?? "").trim();
      const name = String(n.name?.value ?? n.description?.value ?? "").trim();
      if (!role && !name) {
        continue;
      }
      if (
        !/button|link|textbox|search|checkbox|radio|combobox|heading|dialog|menuitem|tab|switch/i.test(
          role,
        ) &&
        name.length < 2
      ) {
        continue;
      }
      lines.push(`${role || "node"}: ${name.slice(0, 80)}`);
      if (lines.join("\n").length > PAGE_PIPELINE_CONFIG.a11yMaxChars) {
        break;
      }
    }
    const text = lines.slice(0, 120).join("\n");
    return text.trim() ? text : null;
  } catch {
    return null;
  } finally {
    if (client) {
      try {
        await client.detach();
      } catch {
        /* ignore */
      }
    }
  }
}

/** 结构相似度（基于 hash 相等或 Jaccard on tokenized hash pairs —— 简化：相等=1，否则用 llm 长度比） */
export function structureSimilarity(a: string, b: string): number {
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  // 短 hash 不相等即认为变化显著（structureHash 已是骨架摘要）
  return 0;
}

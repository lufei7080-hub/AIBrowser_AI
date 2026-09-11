/**
 * 验证码策略分发：
 * gif_animated_dwell | slider_gap_drag | math_image_solve | point_select_click
 */
import type { Page } from "playwright-core";

import type { SidecarAiSettings } from "../engine.js";
import type { JsonLogger } from "../json-logger.js";
import {
  solveAnimatedCaptcha,
  type SolveAnimatedCaptchaResult,
  cleanupCaptchaArtifacts,
} from "./animated_captcha.js";
import type { AgentFileSystem } from "./filesystem.js";
import {
  solveMathImageCaptcha,
  type MathSolveResult,
} from "./math_image_captcha.js";
import {
  solvePointSelectCaptcha,
  type PointSelectResult,
} from "./point_select_captcha.js";
import {
  solveSliderCaptcha,
  type SliderSolveResult,
} from "./slider_captcha.js";
import type { IndexedElementRef } from "./views.js";

export type CaptchaStrategyId =
  | "gif_animated_dwell"
  | "slider_gap_drag"
  | "math_image_solve"
  | "point_select_click";

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
  {
    id: "slider_gap_drag",
    title: "滑块缺口拖拽",
    signals: "请按住滑块、缺口、缓慢拖动",
  },
  {
    id: "math_image_solve",
    title: "静态算式图计算",
    signals: "验证答案、计算的结果、算式",
  },
  {
    id: "point_select_click",
    title: "点选 / 顺序点击",
    signals: "请依次点击、按顺序点击、请点击",
  },
];

export function detectCaptchaStrategy(input: {
  pageText: string;
  pageUrl: string;
  goalHint?: string;
  forceStrategy?: string;
}): CaptchaStrategyId | null {
  const force = String(input.forceStrategy ?? "").trim();
  if (
    force === "gif_animated_dwell" ||
    force === "slider_gap_drag" ||
    force === "math_image_solve" ||
    force === "point_select_click"
  ) {
    return force;
  }

  // 优先看页面（URL+可见文案）；goalHint 仅作弱回退，并剥掉 topic/N 避免串题误路由
  const pageBlob = `${input.pageText}\n${input.pageUrl}`;
  const goalSafe = String(input.goalHint ?? "")
    .replace(/match2025\/topic\/\d+/gi, "")
    .replace(/\btopic\/\d+\b/gi, "");

  const pick = (blob: string): CaptchaStrategyId | null => {
    if (
      /滑块缺口|请按住滑块|缓慢拖动到合适位置|缺口之涟漪|slider\s*gap|slide\s*captcha/i.test(
        blob,
      ) ||
      (/滑块|拼图缺口|拖动滑块/i.test(blob) &&
        !/停留时间最长|迷雾动图|\.gif|验证答案|依次点击|按顺序点击/i.test(blob))
    ) {
      return "slider_gap_drag";
    }

    if (
      /验证答案|计算的结果|输入计算|算式验证|数学验证码/i.test(blob) ||
      (/提交参赛代码/i.test(blob) && /验证答案|计算/i.test(blob))
    ) {
      if (
        !/请按住滑块|停留时间最长|迷雾动图|依次点击|按顺序点击|请点击[「"]/i.test(blob)
      ) {
        return "math_image_solve";
      }
    }

    if (
      /点击变换|请依次|按顺序点击|依次按照顺序点击|请点击[「"“]/i.test(blob) ||
      (/请点击/i.test(blob) && /球体|左侧|右侧|上方|下方|图标|字符|三角|柱体/i.test(blob))
    ) {
      if (!/请按住滑块|停留时间最长|验证答案|计算的结果/i.test(blob)) {
        return "point_select_click";
      }
    }

    if (
      /停留时间最长|迷雾|动图验证|animated\s*captcha|gif\s*验证|\.gif/i.test(blob)
    ) {
      return "gif_animated_dwell";
    }

    if (/验证码|captcha|人机验证/i.test(blob) && /动图|gif|迷雾|停留/i.test(blob)) {
      return "gif_animated_dwell";
    }

    if (/验证码|captcha/i.test(blob) && /滑块|缺口|拖动/i.test(blob)) {
      return "slider_gap_drag";
    }

    if (
      /验证码|captcha/i.test(blob) &&
      /计算|算式|数学|验证答案/i.test(blob) &&
      !/动图|gif|滑块|依次|点选/i.test(blob)
    ) {
      return "math_image_solve";
    }

    if (
      /验证码|captcha|人机/i.test(blob) &&
      /点选|依次点击|按顺序|顺序点击/i.test(blob)
    ) {
      return "point_select_click";
    }

    return null;
  };

  return pick(pageBlob) ?? pick(`${pageBlob}\n${goalSafe}`);
}

export type UnifiedCaptchaResult =
  | {
      kind: "gif";
      strategy: "gif_animated_dwell";
      gif: SolveAnimatedCaptchaResult;
    }
  | {
      kind: "slider";
      strategy: "slider_gap_drag";
      slider: SliderSolveResult;
    }
  | {
      kind: "math";
      strategy: "math_image_solve";
      math: MathSolveResult;
    }
  | {
      kind: "point";
      strategy: "point_select_click";
      point: PointSelectResult;
    }
  | {
      kind: "unsupported";
      strategy: "unsupported";
      detail: string;
      supportedStrategies: string[];
    };

export async function solveCaptcha(input: {
  page: Page;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  selectorMap: Map<number, IndexedElementRef>;
  pageHint?: string;
  goalHint?: string;
  forceStrategy?: string;
  fileSystem?: AgentFileSystem;
  signal?: AbortSignal;
}): Promise<UnifiedCaptchaResult> {
  const pageText = await input.page
    .evaluate(() => String(document.body?.innerText || "").slice(0, 2500))
    .catch(() => "");
  const strategy = detectCaptchaStrategy({
    pageText,
    pageUrl: input.page.url(),
    goalHint: `${input.goalHint ?? ""} ${input.pageHint ?? ""}`,
    forceStrategy: input.forceStrategy,
  });

  const supported = SUPPORTED_CAPTCHA_STRATEGIES.map((s) => s.id);

  if (!strategy) {
    return {
      kind: "unsupported",
      strategy: "unsupported",
      supportedStrategies: supported,
      detail: `unsupported: 当前验证码类型未封装。已支持：${supported.join(", ")}。请勿对未支持类型反复重试本工具。`,
    };
  }

  if (strategy === "slider_gap_drag") {
    input.logger.agentProgress("类型门禁：slider_gap_drag", {
      phase: "captcha_dispatch",
      strategy,
    });
    const slider = await solveSliderCaptcha({
      page: input.page,
      aiSettings: input.aiSettings,
      logger: input.logger,
      fileSystem: input.fileSystem,
      signal: input.signal,
      pageHint: input.pageHint,
      goalHint: input.goalHint,
    });
    return { kind: "slider", strategy: "slider_gap_drag", slider };
  }

  if (strategy === "math_image_solve") {
    input.logger.agentProgress("类型门禁：math_image_solve", {
      phase: "captcha_dispatch",
      strategy,
    });
    const math = await solveMathImageCaptcha({
      page: input.page,
      aiSettings: input.aiSettings,
      logger: input.logger,
      selectorMap: input.selectorMap,
      pageHint: input.pageHint,
      goalHint: input.goalHint,
      fileSystem: input.fileSystem,
      signal: input.signal,
    });
    return { kind: "math", strategy: "math_image_solve", math };
  }

  if (strategy === "point_select_click") {
    input.logger.agentProgress("认出是「点选验证码」，开始解题…", {
      phase: "captcha_dispatch",
      strategy,
    });
    const point = await solvePointSelectCaptcha({
      page: input.page,
      aiSettings: input.aiSettings,
      logger: input.logger,
      fileSystem: input.fileSystem,
      signal: input.signal,
      pageHint: input.pageHint,
      goalHint: input.goalHint,
    });
    return { kind: "point", strategy: "point_select_click", point };
  }

  input.logger.agentProgress("类型门禁：gif_animated_dwell", {
    phase: "captcha_dispatch",
    strategy,
  });
  const gif = await solveAnimatedCaptcha({
    ...input,
    forceStrategy: "gif_animated_dwell",
  });
  return { kind: "gif", strategy: "gif_animated_dwell", gif };
}

export { cleanupCaptchaArtifacts };

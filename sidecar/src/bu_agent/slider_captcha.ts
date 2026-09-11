/**
 * 滑块缺口验证码（策略 slider_gap_drag）
 * 定位控件 → 像素/视觉求缺口 dx → 拟人拖拽 → 验收 → 毁图
 * 可选监听校验响应（协议观察，不改指纹）
 */
import { existsSync, unlinkSync } from "node:fs";
import type { Page } from "playwright-core";

import { createModelRouter, isIntentConfigured } from "../ai_model_router.js";
import type { SidecarAiSettings } from "../engine.js";
import type { JsonLogger } from "../json-logger.js";
import type { AgentFileSystem } from "./filesystem.js";
import {
  encodeBytesToJpegOnPage,
  fetchImageBuffer,
  freezePageForCapture,
  unfreezePageForCapture,
  waitCaptureSettle,
} from "./point_select/silent_capture.js";

export interface SliderSolveResult {
  ok: boolean;
  strategy: "slider_gap_drag" | "unsupported";
  gapX: number;
  dragDistance: number;
  confidence: number;
  method: string;
  verified: boolean | null;
  verifySignal: string;
  protocolHints: string[];
  artifactPaths: string[];
  detail?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function destroyPaths(paths: string[]): number {
  let n = 0;
  for (const p of paths) {
    if (!p || !existsSync(p)) continue;
    try {
      unlinkSync(p);
      n += 1;
    } catch {
      /* ignore */
    }
  }
  return n;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

type SliderDomInfo = {
  ok: boolean;
  reason?: string;
  /** 底图视口盒 */
  image: { x: number; y: number; w: number; h: number } | null;
  /** 滑块手柄中心 */
  handle: { x: number; y: number; w: number; h: number } | null;
  /** 轨道盒（可滑动条，非文案节点） */
  track: { x: number; y: number; w: number; h: number } | null;
  /** 供像素分析：在页内标记的 data 属性选择器 */
  imageSelector: string;
  imgSrc: string;
};

async function locateSliderDom(page: Page): Promise<SliderDomInfo> {
  return page.evaluate(() => {
    const ATTR = "data-cf-slider-target";
    document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));

    const box = (el: Element | null) => {
      if (!el) return null;
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return null;
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };

    const textBlob = (el: Element) =>
      `${el.id || ""} ${String((el as HTMLElement).className || "")} ${el.getAttribute("aria-label") || ""} ${(el as HTMLElement).innerText || ""}`.slice(
        0,
        240,
      );

    // 1) 底图：优先大面积横向图（排除 154×50 一类图标/装饰）
    const media = Array.from(
      document.querySelectorAll("img,canvas"),
    ) as Array<HTMLImageElement | HTMLCanvasElement>;
    let imgEl: HTMLImageElement | HTMLCanvasElement | null = null;
    let bestImg = -1;
    for (const el of media) {
      const r = el.getBoundingClientRect();
      if (r.width < 180 || r.height < 60) continue; // 拒绝过小「底图」
      if (r.bottom < 0 || r.top > innerHeight) continue;
      let score = r.width * r.height;
      const ratio = r.width / Math.max(1, r.height);
      if (ratio >= 1.2 && ratio <= 4.5) score *= 1.4;
      if (el.tagName === "IMG") {
        const src = String((el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || "");
        if (/captcha|slide|verify|gap|puzzle|match/i.test(src)) score *= 1.5;
      }
      // 越靠近视口中部越好
      score *= 1 + Math.max(0, 1 - Math.abs(r.top + r.height / 2 - innerHeight / 2) / innerHeight);
      if (score > bestImg) {
        bestImg = score;
        imgEl = el;
      }
    }

    // 2) 轨道：底图正下方、宽度接近底图的条；勿用仅含文案的窄 span
    let trackEl: HTMLElement | null = null;
    const imgBox = imgEl?.getBoundingClientRect();
    const candidates = Array.from(
      document.querySelectorAll("div,section,ul,li,p"),
    ) as HTMLElement[];
    let bestTrack = -1;
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 18 || r.height > 90) continue;
      const t = textBlob(el);
      const hasHint = /请按住滑块|缓慢拖动|拖动到合适位置|slider|slide/i.test(t);
      let score = 0;
      if (hasHint) score += 80;
      if (imgBox) {
        const gap = r.top - imgBox.bottom;
        if (gap >= -4 && gap <= 80) score += 60 - Math.min(60, Math.abs(gap));
        const widthDiff = Math.abs(r.width - imgBox.width);
        if (widthDiff < imgBox.width * 0.35) score += 40;
        if (Math.abs(r.left - imgBox.left) < 40) score += 20;
      }
      // 惩罚：自身几乎只有文字、没有可拖子块
      const kids = el.querySelectorAll("div,span,button");
      if (kids.length === 0) score -= 30;
      if (score > bestTrack) {
        bestTrack = score;
        trackEl = el;
      }
    }

    // 回退：任意含提示文案的块
    if (!trackEl) {
      for (const el of candidates) {
        if (/请按住滑块|缓慢拖动到合适位置/i.test(textBlob(el))) {
          // 向上找更宽的父级作为轨道
          let cur: HTMLElement | null = el;
          for (let i = 0; i < 4 && cur; i++) {
            const r = cur.getBoundingClientRect();
            if (r.width >= 180 && r.height >= 24 && r.height <= 100) {
              trackEl = cur;
              break;
            }
            cur = cur.parentElement;
          }
          if (!trackEl) trackEl = el;
          break;
        }
      }
    }

    // 3) 手柄：轨道内最左侧、接近正方形的可拖块
    let handleEl: HTMLElement | null = null;
    if (trackEl) {
      const tr = trackEl.getBoundingClientRect();
      const kids = Array.from(
        trackEl.querySelectorAll("div,span,button,i,em,a"),
      ) as HTMLElement[];
      let bestH = -1;
      for (const el of kids) {
        const r = el.getBoundingClientRect();
        if (r.width < 12 || r.width > 72 || r.height < 12 || r.height > 72) continue;
        // 必须在轨道左 30%
        if (r.left > tr.left + tr.width * 0.3) continue;
        let score = 50 - (r.left - tr.left);
        if (/slider|btn|handle|thumb|drag|block|btn/i.test(textBlob(el))) score += 25;
        if (Math.abs(r.width - r.height) < 12) score += 15;
        if (score > bestH) {
          bestH = score;
          handleEl = el;
        }
      }
      if (!handleEl) {
        handleEl = (trackEl.querySelector("div,span,button") as HTMLElement | null) ?? null;
      }
    }

    if (!imgEl || !trackEl || !handleEl) {
      return {
        ok: false,
        reason: `missing image=${imgEl ? 1 : 0} track=${trackEl ? 1 : 0} handle=${handleEl ? 1 : 0}`,
        image: null,
        handle: null,
        track: null,
        imageSelector: "",
        imgSrc: "",
      };
    }

    imgEl.setAttribute(ATTR, "1");
    const imageBox = box(imgEl as Element);
    const trackBox2 = box(trackEl as Element);
    const hb = box(handleEl as Element);
    if (!imageBox || !trackBox2 || !hb) {
      return {
        ok: false,
        reason: "bbox_failed",
        image: null,
        handle: null,
        track: null,
        imageSelector: "",
        imgSrc: "",
      };
    }
    const handleCenter = {
      x: hb.x + hb.w / 2,
      y: hb.y + hb.h / 2,
      w: hb.w,
      h: hb.h,
    };
    const imgSrc =
      imgEl.tagName === "IMG"
        ? String((imgEl as HTMLImageElement).currentSrc || (imgEl as HTMLImageElement).src || "")
        : "";

    return {
      ok: true,
      image: imageBox,
      handle: handleCenter,
      track: trackBox2,
      imageSelector: `[${ATTR}="1"]`,
      imgSrc,
    };
  });
}

/** 页内 canvas：精确定位灰色拼图缺口左缘（排除彩色角色/涟漪噪点） */
async function findGapByPixels(
  page: Page,
  imageSelector: string,
): Promise<{
  gapX: number;
  gapCenter: number;
  gapW: number;
  imageWidth: number;
  imageHeight: number;
  confidence: number;
  detail: string;
} | null> {
  return page.evaluate(async (sel) => {
    const target = document.querySelector(sel) as
      | HTMLImageElement
      | HTMLCanvasElement
      | null;
    if (!target) return null;

    const disp = target.getBoundingClientRect();
    const w =
      target instanceof HTMLCanvasElement
        ? target.width
        : (target as HTMLImageElement).naturalWidth || Math.floor(disp.width);
    const h =
      target instanceof HTMLCanvasElement
        ? target.height
        : (target as HTMLImageElement).naturalHeight || Math.floor(disp.height);
    if (w < 40 || h < 20) return null;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    try {
      ctx.drawImage(target as CanvasImageSource, 0, 0, w, h);
    } catch {
      return null;
    }
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(0, 0, w, h).data;
    } catch {
      // 跨域 canvas 污染：无法读像素
      return null;
    }

    const at = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]!, a: data[i + 3]! };
    };
    const lumaOf = (p: { r: number; g: number; b: number }) =>
      0.299 * p.r + 0.587 * p.g + 0.114 * p.b;
    const satOf = (p: { r: number; g: number; b: number }) => {
      const max = Math.max(p.r, p.g, p.b);
      const min = Math.min(p.r, p.g, p.b);
      return max === 0 ? 0 : (max - min) / max;
    };

    const cornerSamples: number[] = [];
    for (const [cx, cy] of [
      [4, 4],
      [w - 5, 4],
      [4, h - 5],
      [Math.floor(w * 0.5), 4],
      [Math.floor(w * 0.25), 4],
      [Math.floor(w * 0.75), 4],
    ] as Array<[number, number]>) {
      const p = at(Math.max(0, Math.min(w - 1, cx)), Math.max(0, Math.min(h - 1, cy)));
      if (p.a > 20 && satOf(p) < 0.25) cornerSamples.push(lumaOf(p));
    }
    const bgLuma =
      cornerSamples.length > 0
        ? cornerSamples.reduce((a, b) => a + b, 0) / cornerSamples.length
        : 210;
    // 相对阈值：半透明灰缺口常在 bg-70~bg-25（如 bg≈240、缺口≈168），
    // 旧硬顶 luma<165 会把涟漪题缺口整段误杀。
    const gapDarkMax = Math.min(bgLuma - 18, bgLuma * 0.88);
    const gapDarkMin = Math.max(40, bgLuma * 0.35);

    const y0 = Math.floor(h * 0.1);
    const y1 = Math.floor(h * 0.9);
    const colGrey = new Float64Array(w);
    const colEdge = new Float64Array(w);

    for (let x = 0; x < w; x++) {
      let run = 0;
      let bestRun = 0;
      let darkSum = 0;
      let darkN = 0;
      let colorPenalty = 0;
      let edgeSum = 0;
      let edgeN = 0;
      for (let y = y0; y < y1; y++) {
        const p = at(x, y);
        if (p.a < 20) {
          run = 0;
          continue;
        }
        const sat = satOf(p);
        const luma = lumaOf(p);
        if (sat > 0.28) {
          colorPenalty += sat * 8;
          run = 0;
          continue;
        }
        // 相对背景变暗即可（兼容半透明灰缺口）
        const isGapGrey =
          sat < 0.28 && luma <= gapDarkMax && luma >= gapDarkMin && luma < bgLuma - 18;
        if (isGapGrey) {
          run += 1;
          bestRun = Math.max(bestRun, run);
          darkSum += bgLuma - luma;
          darkN += 1;
        } else {
          run = 0;
        }
        // 局部对比：相对左右邻域变暗（抗涟漪纹理）
        if (x >= 20 && x < w - 20) {
          const neigh: number[] = [];
          for (const dx of [-20, -12, 12, 20]) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const np = at(xx, y);
            if (np.a > 20 && satOf(np) < 0.3) neigh.push(lumaOf(np));
          }
          if (neigh.length >= 2) {
            const localBg = neigh.reduce((a, b) => a + b, 0) / neigh.length;
            const diff = localBg - luma;
            if (diff > 12 && sat < 0.28) {
              edgeSum += diff;
              edgeN += 1;
            }
          }
        }
      }
      const avgDark = darkN > 0 ? darkSum / darkN : 0;
      const hRatio = bestRun / Math.max(1, h);
      let heightFit = 0;
      if (hRatio >= 0.15 && hRatio <= 0.65) heightFit = 1;
      else if (hRatio >= 0.08 && hRatio < 0.15) heightFit = 0.5;
      else if (hRatio > 0.65 && hRatio < 0.8) heightFit = 0.35;
      colGrey[x] = Math.max(0, avgDark * heightFit * 1.2 - colorPenalty);
      const edgeAvg = edgeN > 0 ? edgeSum / Math.max(1, y1 - y0) : 0;
      const edgeFit = edgeN / Math.max(1, y1 - y0);
      colEdge[x] = edgeAvg * (edgeFit >= 0.08 ? 1 : edgeFit >= 0.04 ? 0.5 : 0);
    }

    const smoothCol = (src: Float64Array): Float64Array => {
      const out = new Float64Array(w);
      const rad = Math.max(2, Math.floor(w * 0.01));
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let c = 0;
        for (let k = -rad; k <= rad; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= w) continue;
          sum += src[xx]!;
          c += 1;
        }
        out[x] = c ? sum / c : 0;
      }
      return out;
    };
    const smoothGrey = smoothCol(colGrey);
    const smoothEdge = smoothCol(colEdge);
    // 融合：灰块密度 + 局部对比（涟漪题上对比度更稳）
    const smooth = new Float64Array(w);
    let maxG = 0;
    let maxE = 0;
    for (let x = 0; x < w; x++) {
      maxG = Math.max(maxG, smoothGrey[x]!);
      maxE = Math.max(maxE, smoothEdge[x]!);
    }
    for (let x = 0; x < w; x++) {
      const g = maxG > 0 ? smoothGrey[x]! / maxG : 0;
      const e = maxE > 0 ? smoothEdge[x]! / maxE : 0;
      smooth[x] = g * 0.45 + e * 0.55;
    }

    const xStart = Math.floor(w * 0.06);
    const xEnd = Math.floor(w * 0.82);
    const expectedW = Math.max(24, Math.floor(w * 0.12));
    let bestLeft = xStart;
    let bestRight = xStart + expectedW;
    let bestIntegral = -1;
    const winMin = Math.max(16, Math.floor(w * 0.07));
    const winMax = Math.min(Math.floor(w * 0.3), xEnd - xStart);
    for (let win = winMin; win <= winMax; win += 2) {
      let acc = 0;
      for (let x = xStart; x < xStart + win && x < xEnd; x++) acc += smooth[x]!;
      for (let left = xStart; left + win <= xEnd; left++) {
        if (left > xStart) {
          acc -= smooth[left - 1]!;
          acc += smooth[left + win - 1]!;
        }
        const wFit = 1 - Math.min(1, Math.abs(win - expectedW) / expectedW);
        const score = acc * (0.65 + 0.35 * wFit);
        if (score > bestIntegral) {
          bestIntegral = score;
          bestLeft = left;
          bestRight = left + win;
        }
      }
    }

    const gapW = Math.max(1, bestRight - bestLeft);
    const gapCenter = Math.floor((bestLeft + bestRight) / 2);
    const peakV = smooth[gapCenter] ?? 0;
    let mean = 0;
    for (let x = bestLeft; x < bestRight; x++) mean += smooth[x]!;
    mean /= gapW;
    const thresh = mean * 0.4;
    let left = gapCenter;
    while (left > xStart && smooth[left]! >= thresh) left -= 1;
    left = Math.min(w - 2, Math.max(0, left + 1));

    // 用灰块通道的绝对峰值辅助置信度（归一化后 peakV∈[0,1]）
    const greyPeak = smoothGrey[gapCenter] ?? 0;
    const edgePeak = smoothEdge[gapCenter] ?? 0;
    let confidence = 0.28;
    if (peakV > 0.25 && gapW >= winMin && gapW <= winMax) {
      confidence = Math.min(
        0.96,
        0.48 + peakV * 0.35 + Math.min(greyPeak, 40) / 120 + Math.min(edgePeak, 30) / 100,
      );
    }
    if (left < w * 0.05 || left > w * 0.85) confidence *= 0.7;
    if (mean < 0.12) confidence *= 0.55;
    // 灰块与局部对比都有信号时加分
    if (greyPeak > 4 && edgePeak > 8) confidence = Math.min(0.98, confidence + 0.08);

    return {
      gapX: left,
      gapCenter,
      gapW,
      imageWidth: w,
      imageHeight: h,
      confidence,
      detail: `left=${left} center=${gapCenter} gapW=${gapW} peak=${peakV.toFixed(2)} grey=${greyPeak.toFixed(1)} edge=${edgePeak.toFixed(1)} bg=${bgLuma.toFixed(0)}`,
    };
  }, imageSelector);
}

async function findGapByVision(input: {
  page: Page;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  fileSystem?: AgentFileSystem;
  signal?: AbortSignal;
  imageBox: { x: number; y: number; w: number; h: number };
  imageSelector?: string;
  imgSrc?: string;
}): Promise<{ gapX: number; gapCenter?: number; imageWidth: number; confidence: number; path?: string } | null> {
  if (!isIntentConfigured(createModelRouter(input.aiSettings).pool, "vision")) {
    return null;
  }
  const clip = {
    x: Math.max(0, Math.floor(input.imageBox.x)),
    y: Math.max(0, Math.floor(input.imageBox.y)),
    width: Math.floor(input.imageBox.w),
    height: Math.floor(input.imageBox.h),
  };

  // 优先静默拉原图 / 离屏 canvas；仅失败才 screenshot（防闪）
  let buf: Buffer | null = null;
  if (input.imgSrc) {
    try {
      const raw = await fetchImageBuffer(input.page, input.imgSrc);
      if (raw) {
        const enc = await encodeBytesToJpegOnPage(
          input.page,
          raw,
          clip.width,
          clip.height,
        );
        if (enc?.b64) buf = Buffer.from(enc.b64, "base64");
      }
    } catch {
      /* fall through */
    }
  }
  if (!buf && input.imageSelector) {
    try {
      const dataUrl = await input.page.evaluate(async (sel) => {
        const el = document.querySelector(sel) as
          | HTMLImageElement
          | HTMLCanvasElement
          | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        if (!ctx) return null;
        try {
          ctx.drawImage(el as CanvasImageSource, 0, 0, w, h);
          return c.toDataURL("image/jpeg", 0.92);
        } catch {
          return null;
        }
      }, input.imageSelector);
      if (dataUrl && dataUrl.includes(",")) {
        buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
      }
    } catch {
      /* fall through */
    }
  }
  if (!buf) {
    await freezePageForCapture(input.page);
    try {
      await waitCaptureSettle();
      buf = await input.page.screenshot({
        type: "jpeg",
        quality: 92,
        clip,
        scale: "css",
        animations: "disabled",
        caret: "hide",
      });
    } finally {
      await unfreezePageForCapture(input.page);
    }
  }

  let path: string | undefined;
  if (input.fileSystem) {
    const stamp = Date.now();
    path = input.fileSystem.writeBinaryFile(`captcha_slider_${stamp}.jpg`, buf);
  }
  const b64 = buf.toString("base64");
  const router = createModelRouter(input.aiSettings);
  const { route, client } = router.forIntent("vision", "滑块缺口定位");
  try {
    const resp = await client.chat.completions.create(
      {
        model: route.model,
        temperature: 0,
        max_tokens: 120,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "滑块验证码底图。找出灰色/半透明拼图缺口（凹陷阴影块），不是右侧彩色卡通人物，也不是底部滑轨。" +
                  `本图显示宽约 ${clip.width}px。` +
                  "gapX=缺口左缘距图像左边缘的像素；gapCenter=缺口中心X；imageWidth=必须等于图宽像素。" +
                  '只输出一行JSON：{"gapX":123,"gapCenter":150,"imageWidth":400,"confidence":0.0~1.0}。禁止思考。',
              },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "high" },
              },
            ],
          },
        ],
      },
      input.signal ? { signal: input.signal } : undefined,
    );
    const raw = String(resp.choices?.[0]?.message?.content ?? "").trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return path ? { gapX: 0, imageWidth: clip.width, confidence: 0, path } : null;
    }
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    let gapX = Number(obj.gapX ?? obj.x ?? 0);
    let gapCenter = Number(obj.gapCenter ?? obj.centerX ?? 0);
    let imageWidth = Number(obj.imageWidth ?? clip.width);
    let confidence = Number(obj.confidence ?? 0.6);
    if (!Number.isFinite(imageWidth) || imageWidth <= 0) imageWidth = clip.width;
    // 模型偶发回 0~1 归一化坐标
    if (Number.isFinite(gapX) && gapX > 0 && gapX <= 1.5) gapX = gapX * imageWidth;
    if (Number.isFinite(gapCenter) && gapCenter > 0 && gapCenter <= 1.5) {
      gapCenter = gapCenter * imageWidth;
    }
    if ((!Number.isFinite(gapX) || gapX <= 0) && Number.isFinite(gapCenter) && gapCenter > 0) {
      gapX = Math.max(1, gapCenter - imageWidth * 0.06);
    }
    if (!Number.isFinite(gapX) || gapX <= 0) {
      return path ? { gapX: 0, imageWidth, confidence: 0, path } : null;
    }
    if (!Number.isFinite(confidence)) confidence = 0.6;
    // 若模型 imageWidth 与裁剪宽差太大，按显示宽重标定
    if (Math.abs(imageWidth - clip.width) > clip.width * 0.25) {
      gapX = (gapX / imageWidth) * clip.width;
      if (gapCenter > 0) gapCenter = (gapCenter / imageWidth) * clip.width;
      imageWidth = clip.width;
    }
    return {
      gapX: Math.floor(gapX),
      gapCenter: Number.isFinite(gapCenter) && gapCenter > 0 ? Math.floor(gapCenter) : undefined,
      imageWidth: Math.max(1, Math.floor(imageWidth || clip.width)),
      confidence: Math.min(1, Math.max(0, confidence)),
      path,
    };
  } catch (err) {
    if (input.signal?.aborted || (err instanceof Error && /abort/i.test(err.message))) {
      throw new Error("Agent 已中止");
    }
    input.logger.warn("slider_vision_gap_failed", {
      error: err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160),
    });
    return path ? { gapX: 0, imageWidth: clip.width, confidence: 0, path } : null;
  }
}

async function humanDragSlider(
  page: Page,
  from: { x: number; y: number },
  distance: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("Agent 已中止");
  const targetX = from.x + distance;
  await page.mouse.move(from.x, from.y, { steps: 3 });
  await sleep(90 + Math.floor(Math.random() * 70));
  await page.mouse.down();
  await sleep(50 + Math.floor(Math.random() * 50));

  // 涟漪类：先略超冲再回落对准（拟人）
  const overshoot = Math.min(14, Math.max(4, distance * 0.03)) * (Math.random() > 0.3 ? 1 : 0);
  const midX = targetX + overshoot;
  const duration = 1100 + Math.floor(Math.random() * 700);
  const steps = 36 + Math.floor(Math.random() * 16);
  for (let i = 1; i <= steps; i++) {
    if (signal?.aborted) {
      await page.mouse.up().catch(() => undefined);
      throw new Error("Agent 已中止");
    }
    const t = easeInOutCubic(i / steps);
    const jitterX = (Math.random() - 0.5) * 1.2;
    const jitterY = (Math.random() - 0.5) * 0.9;
    const x = from.x + (midX - from.x) * t + jitterX;
    const y = from.y + jitterY;
    await page.mouse.move(x, y);
    await sleep(Math.max(10, Math.floor(duration / steps)));
  }
  if (overshoot > 0) {
    await page.mouse.move(targetX, from.y, { steps: 4 });
    await sleep(70 + Math.floor(Math.random() * 60));
  } else {
    await page.mouse.move(targetX, from.y);
    await sleep(50 + Math.floor(Math.random() * 50));
  }
  await page.mouse.up();
}

type ProtocolHit = { url: string; preview: string };

function attachProtocolObserver(page: Page): {
  hits: ProtocolHit[];
  dispose: () => void;
} {
  const hits: ProtocolHit[] = [];
  const onResp = async (res: {
    url: () => string;
    headers: () => Record<string, string>;
    text: () => Promise<string>;
    status: () => number;
  }) => {
    try {
      const url = res.url();
      if (!/captcha|verify|slide|check|gap|ripple|challenge|token/i.test(url)) {
        // 仍看 JSON 成功体
        const ct = String(res.headers()["content-type"] ?? "");
        if (!/json|text|javascript/i.test(ct)) return;
      }
      if (res.status() >= 400) return;
      const body = (await res.text()).slice(0, 500);
      if (/success\s*[:=]\s*true|"success"\s*:\s*true|验证成功|通过验证/i.test(body)) {
        hits.push({ url: url.slice(0, 200), preview: body.slice(0, 240) });
      }
    } catch {
      /* ignore body read errors */
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page.on("response", onResp as any);
  return {
    hits,
    dispose: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page.off("response", onResp as any);
    },
  };
}

export async function checkSliderOutcome(page: Page): Promise<{
  verified: boolean | null;
  signal: string;
}> {
  await sleep(700);
  const text = await page
    .evaluate(() => String(document.body?.innerText || "").slice(0, 5000))
    .catch(() => "");

  // 失败优先（拖错后页内常仍残留题面里的 success 说明）
  if (/验证失败|不正确|错误|再试|失败|wrong|failed|invalid/i.test(text)) {
    const m = text.match(/验证失败|不正确|错误|再试|失败|wrong|failed/i);
    return { verified: false, signal: m?.[0] ?? "fail" };
  }
  if (/验证成功|通过验证|正确答案|提交成功|恭喜/i.test(text)) {
    const m = text.match(/验证成功|通过验证|正确答案|提交成功|恭喜/i);
    return { verified: true, signal: m?.[0] ?? "ok" };
  }
  // 题面常写「返回 {success:true}」——禁止把教学句当成已通过
  const looksLikeChallengeCopy =
    /请使用协议通过|不会在图像识别|滑块缺口之涟漪|返回\s*["'{]*\s*\{?\s*success/i.test(
      text,
    );
  if (
    !looksLikeChallengeCopy &&
    /"success"\s*:\s*true|success\s*[:=：]\s*true/i.test(text)
  ) {
    return { verified: true, signal: "success:true" };
  }
  return { verified: null, signal: "no_clear_signal" };
}

export async function solveSliderCaptcha(input: {
  page: Page;
  aiSettings: SidecarAiSettings;
  logger: JsonLogger;
  fileSystem?: AgentFileSystem;
  signal?: AbortSignal;
  pageHint?: string;
  goalHint?: string;
}): Promise<SliderSolveResult> {
  if (input.signal?.aborted) throw new Error("Agent 已中止");
  const artifactPaths: string[] = [];

  input.logger.agentProgress("① 滑块策略：定位底图/手柄/轨道…", {
    phase: "slider_captcha",
    stage: "locate",
  });

  const dom = await locateSliderDom(input.page);
  if (!dom.ok || !dom.image || !dom.handle || !dom.track || !dom.imageSelector) {
    return {
      ok: false,
      strategy: "unsupported",
      gapX: 0,
      dragDistance: 0,
      confidence: 0,
      method: "none",
      verified: null,
      verifySignal: "",
      protocolHints: [],
      artifactPaths,
      detail: `unsupported: 未定位到滑块控件（${dom.reason ?? "unknown"}）`,
    };
  }

  input.logger.agentProgress(
    `已定位底图 ${Math.round(dom.image.w)}×${Math.round(dom.image.h)} · 轨道宽 ${Math.round(dom.track.w)} · 手柄(${Math.round(dom.handle.x)},${Math.round(dom.handle.y)})`,
    { phase: "slider_captcha", stage: "located" },
  );

  // 像素求缺口（必须与定位到的同一张底图）
  let gapX = 0;
  let gapW = 0;
  let imageWidth = Math.floor(dom.image.w);
  let confidence = 0;
  let method = "none";
  let gapOnDisplayPx = 0;

  input.logger.agentProgress("② 像素精定位缺口…", {
    phase: "slider_captcha",
    stage: "pixel_gap",
  });
  const pixel = await findGapByPixels(input.page, dom.imageSelector);
  if (pixel && pixel.confidence >= 0.32 && pixel.gapX > 0 && pixel.gapX < pixel.imageWidth) {
    gapX = pixel.gapX;
    gapW = pixel.gapW;
    imageWidth = pixel.imageWidth;
    confidence = pixel.confidence;
    method = `pixel:${pixel.detail}`;
    gapOnDisplayPx = (gapX / Math.max(1, imageWidth)) * dom.image.w;
  } else if (pixel) {
    input.logger.agentProgress(
      `像素缺口置信不足 conf=${pixel.confidence.toFixed(2)} · ${pixel.detail}`,
      { phase: "slider_captcha", stage: "pixel_gap_weak", conf: pixel.confidence },
    );
  }

  const visionConfigured = isIntentConfigured(
    createModelRouter(input.aiSettings).pool,
    "vision",
  );
  const needVision =
    visionConfigured &&
    (confidence < 0.72 ||
      gapX <= 0 ||
      gapX >= imageWidth * 0.85 ||
      gapW > imageWidth * 0.3 ||
      dom.image.w < 180 ||
      confidence < 0.85);

  if (needVision) {
    input.logger.agentProgress("②b 视觉交叉校验缺口…", {
      phase: "slider_captcha",
      stage: "vision_gap",
      prevConf: confidence,
    });
    const vision = await findGapByVision({
      page: input.page,
      aiSettings: input.aiSettings,
      logger: input.logger,
      fileSystem: input.fileSystem,
      signal: input.signal,
      imageBox: dom.image,
      imageSelector: dom.imageSelector,
      imgSrc: dom.imgSrc,
    });
    if (vision?.path) artifactPaths.push(vision.path);
    if (vision && vision.gapX > 0) {
      const vDisp = (vision.gapX / Math.max(1, vision.imageWidth)) * dom.image.w;
      if (gapOnDisplayPx <= 0) {
        gapOnDisplayPx = vDisp;
        gapX = vision.gapX;
        imageWidth = Math.floor(dom.image.w);
        confidence = vision.confidence;
        method = `vision:conf=${vision.confidence.toFixed(2)}`;
      } else {
        const delta = Math.abs(vDisp - gapOnDisplayPx);
        const agree = delta <= Math.max(10, dom.image.w * 0.035);
        if (agree) {
          gapOnDisplayPx = gapOnDisplayPx * 0.65 + vDisp * 0.35;
          confidence = Math.min(0.98, (confidence + vision.confidence) / 2 + 0.08);
          method = `fuse:px+vis Δ=${delta.toFixed(1)}`;
        } else if (vision.confidence > confidence + 0.12) {
          gapOnDisplayPx = vDisp;
          confidence = vision.confidence;
          method = `vision_override:Δ=${delta.toFixed(1)}`;
        } else {
          method = `${method}|vis_disagree_Δ=${delta.toFixed(1)}`;
          confidence *= 0.92;
        }
      }
    }
  }

  if (gapOnDisplayPx <= 0 && gapX > 0) {
    gapOnDisplayPx = (gapX / Math.max(1, imageWidth)) * dom.image.w;
  }

  if (gapOnDisplayPx <= 0 || gapOnDisplayPx >= dom.image.w * 0.98) {
    const removed = destroyPaths(artifactPaths);
    return {
      ok: false,
      strategy: "slider_gap_drag",
      gapX: 0,
      dragDistance: 0,
      confidence: 0,
      method,
      verified: null,
      verifySignal: "",
      protocolHints: [],
      artifactPaths: [],
      detail: `未能定位缺口（已毁临时图 ${removed}）。勿刷新，可重试；满3次 HITL。`,
    };
  }

  const trackUsable = Math.max(40, dom.track.w - dom.handle.w - 6);
  const scaleToTrack =
    Math.abs(dom.track.w - dom.image.w) > dom.image.w * 0.25
      ? trackUsable / Math.max(1, dom.image.w - dom.handle.w)
      : 1;

  let baseDrag = gapOnDisplayPx * scaleToTrack - 1.5;
  const handleInset = dom.handle.x - dom.track.x;
  const nearTrackLeft = handleInset <= dom.handle.w * 0.8 + 6;
  if (!nearTrackLeft && handleInset > 0 && handleInset < trackUsable) {
    baseDrag = Math.max(0, baseDrag - handleInset);
  }
  baseDrag = Math.max(15, Math.min(trackUsable, baseDrag));

  const tryOffsets = [0, -6, 8, -12, 14];
  const protocolAll: string[] = [];
  let lastDrag = baseDrag;
  let lastOutcome: { verified: boolean | null; signal: string } = {
    verified: null,
    signal: "no_clear_signal",
  };

  input.logger.agentProgress(
    `③ 缺口显示 ${gapOnDisplayPx.toFixed(1)}px → 基准拖距 ${baseDrag.toFixed(1)}px / 可用 ${trackUsable.toFixed(0)} · ${method} · conf=${confidence.toFixed(2)}`,
    {
      phase: "slider_captcha",
      stage: "plan_drag",
      gapOnDisplayPx,
      baseDrag,
      trackUsable,
      confidence,
      method,
    },
  );

  for (let ti = 0; ti < tryOffsets.length; ti++) {
    if (input.signal?.aborted) throw new Error("Agent 已中止");
    const off = tryOffsets[ti]!;
    const dragDistance = Math.max(15, Math.min(trackUsable, baseDrag + off));
    lastDrag = dragDistance;

    const domNow = ti === 0 ? dom : await locateSliderDom(input.page);
    const handle = domNow.handle ?? dom.handle;
    if (!handle) break;

    const observer = attachProtocolObserver(input.page);
    try {
      input.logger.agentProgress(
        `④ 拟人拖拽${ti === 0 ? "" : `微调#${ti}(${off >= 0 ? "+" : ""}${off}px)`}… drag=${dragDistance.toFixed(1)}`,
        { phase: "slider_captcha", stage: "drag", attempt: ti + 1, dragDistance, offset: off },
      );
      await humanDragSlider(
        input.page,
        { x: handle.x, y: handle.y },
        dragDistance,
        input.signal,
      );
      // 须在 dispose 前验收：校验 XHR 常在 mouseup 之后才返回
      lastOutcome = await checkSliderOutcome(input.page);
      if (lastOutcome.verified == null && observer.hits.length > 0) {
        lastOutcome = { verified: true, signal: "protocol_success_body" };
      }
      protocolAll.push(...observer.hits.map((h) => `${h.url} :: ${h.preview}`));
    } finally {
      observer.dispose();
    }

    input.logger.agentProgress(
      `⑤ 验收#${ti + 1}：verified=${String(lastOutcome.verified)} signal=${lastOutcome.signal}`,
      {
        phase: "slider_captcha",
        stage: "verify",
        attempt: ti + 1,
        verified: lastOutcome.verified,
        signal: lastOutcome.signal,
      },
    );

    if (lastOutcome.verified === true) break;
    if (lastOutcome.verified === false && ti < tryOffsets.length - 1) {
      await sleep(450);
      continue;
    }
    if (lastOutcome.verified == null) break;
  }

  const removed = destroyPaths(artifactPaths);
  if (removed > 0) {
    input.logger.agentProgress(`已销毁滑块临时图 ${removed} 个`, {
      phase: "slider_captcha",
      stage: "cleanup",
      removed,
    });
  }

  return {
    ok: lastOutcome.verified !== false,
    strategy: "slider_gap_drag",
    gapX: Math.round(gapOnDisplayPx),
    dragDistance: lastDrag,
    confidence,
    method,
    verified: lastOutcome.verified,
    verifySignal: lastOutcome.signal,
    protocolHints: protocolAll,
    artifactPaths: [],
    detail:
      lastOutcome.verified === true
        ? `slider_ok drag=${lastDrag.toFixed(1)} ${method}`
        : lastOutcome.verified === false
          ? `slider_fail：${lastOutcome.signal}；captcha_attempt+1；勿刷新未满3次可重试`
          : `slider_done drag=${lastDrag.toFixed(1)}；无明确页内信号` +
            (protocolAll.length ? `；协议候选 ${protocolAll.length}` : ""),
  };
}

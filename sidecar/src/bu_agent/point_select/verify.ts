/**
 * 点选验收：协议 success / 题干消失
 */
import type { Page } from "playwright-core";

export type ProtocolHit = { url: string; preview: string };

export function attachProtocolObserver(page: Page): {
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
      const ct = String(res.headers()["content-type"] ?? "");
      if (
        !/captcha|verify|click|check|point|challenge|token/i.test(url) &&
        !/json|text|javascript/i.test(ct)
      ) {
        return;
      }
      if (res.status() >= 400) return;
      const body = (await res.text()).slice(0, 500);
      if (/success\s*[:=]\s*true|"success"\s*:\s*true|验证成功|通过验证/i.test(body)) {
        hits.push({ url: url.slice(0, 200), preview: body.slice(0, 240) });
      }
    } catch {
      /* ignore */
    }
  };
  page.on("response", onResp);
  return {
    hits,
    dispose: () => {
      page.off("response", onResp);
    },
  };
}

export async function verifyPointSelect(
  page: Page,
  protocolHits: ProtocolHit[],
): Promise<{ verified: boolean | null; signal: string }> {
  if (protocolHits.length > 0) {
    return { verified: true, signal: `protocol:${protocolHits[0]!.preview.slice(0, 80)}` };
  }

  const pageOk = await page
    .evaluate(() => {
      const t = String(document.body?.innerText || "");
      if (/success\s*[:=]\s*true|验证成功|通过验证|恭喜/i.test(t)) return "page_success";
      if (/验证失败|校验失败|点击错误/i.test(t)) return "page_fail";
      // 题干仍在 → 未过
      if (/请点击\s*[「"“]|请依次|按顺序点击/.test(t)) return "still_prompt";
      return "unknown";
    })
    .catch(() => "unknown");

  if (pageOk === "page_success") return { verified: true, signal: pageOk };
  if (pageOk === "page_fail") return { verified: false, signal: pageOk };
  if (pageOk === "still_prompt") return { verified: false, signal: pageOk };
  return { verified: null, signal: pageOk };
}

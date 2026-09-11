import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import { resolveGateway } from "../core/action_gateway.js";
import { beginAgentLlmWait, createLlmClient } from "../ai_client.js";
import { scrapePageData } from "../tools/scraper_engine.js";
import { visionLocateAndClick, clickViewportPercent } from "../page_vision_locate.js";
import {
  createModelRouter,
  isIntentConfigured,
  isVisualModelNotConfiguredError,
} from "../ai_model_router.js";
import { CONFIRM_SKIP_THRESHOLD } from "../agent_confidence.js";
import { registerAction, type ActionContext } from "./registry.js";
import { registerSkillMetaActions } from "./skills/index.js";
import {
  checkCaptchaOutcome,
} from "./animated_captcha.js";
import {
  solveCaptcha,
  cleanupCaptchaArtifacts,
} from "./captcha_dispatch.js";
import { findIndexByTextHint } from "./captcha_form_hints.js";
import type { ActionResult } from "./views.js";

const VISION_CAPABILITY_ERROR =
  "当前需要视觉定位（图标/图片入口），但未配置视觉模型（vision）。" +
  "请到「设置 → AI」填写视觉模型后重试。禁止用 ask_user 猜测要点哪个图标。";

const SCREENSHOT_CAPABILITY_ERROR =
  "需要截图才能继续，但当前无法获取页面截图。请确认浏览器可用；若仍失败，请开启 Agent 截图能力并配置视觉模型后重试。";

function isVisualTargetQuestion(text: string): boolean {
  const q = String(text ?? "").trim();
  // 验证码/读码类 HITL：允许 ask_user（勿因含「图片」误拦）
  if (
    /验证码|captcha|识别.*码|码是什么|填写验证|读出|字母数字/i.test(q) &&
    !/点哪|点击哪|哪个图标|点哪个/i.test(q)
  ) {
    return false;
  }
  // 仅拦截「要点哪个图标/语言入口」类空转提问
  return (
    /点哪|点击哪|点哪个|哪个图标|哪一个图标|语言球|客服图标/i.test(q) ||
    (/(图标|语言入口|地球|国旗|locale|hebrew)/i.test(q) &&
      /哪个|哪一个|点哪|点击|定位/i.test(q))
  );
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function elementLabelBlob(el: {
  text?: string;
  placeholder?: string;
  name?: string;
  role?: string;
  tagName?: string;
  inputType?: string | null;
}): string {
  return [el.text, el.placeholder, el.name, el.role, el.tagName, el.inputType ?? ""]
    .filter(Boolean)
    .join(" ");
}

/** Playwright 选择器：xpath 路径必须带 xpath= 前缀，否则会被当 CSS 解析失败 */
function elementPlaywrightSelector(el: {
  selector: string;
  xpath?: string;
}): string {
  const xp = String(el.xpath ?? "").trim();
  if (xp) return xp.startsWith("xpath=") ? xp : `xpath=${xp}`;
  const sel = String(el.selector ?? "").trim();
  if (!sel) return sel;
  if (sel.startsWith("xpath=") || sel.startsWith("css=") || sel.startsWith("text=")) return sel;
  if (sel.startsWith("/") || sel.startsWith("(") || sel.startsWith("./")) {
    return `xpath=${sel}`;
  }
  return sel;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Agent 已中止");
  }
}

function needsHitlConfirm(
  kind: "fill" | "click",
  text: string,
  value?: string,
): boolean {
  const blob = `${text} ${value ?? ""}`;
  if (kind === "fill") {
    return /密码|password|otp|验证码|短信|邮箱|验证器|authenticator|totp|card|cvv|支付|汇款/i.test(
      blob,
    );
  }
  return /注册|登录|提交|确认|支付|购买|删除|sign\s*up|login|submit|confirm|pay|buy|delete/i.test(
    blob,
  );
}

function ok(content: string, extra?: Partial<ActionResult>): ActionResult {
  return { extractedContent: content, longTermMemory: content, success: true, ...extra };
}

function fail(error: string): ActionResult {
  return { error, success: false };
}

export function registerAllActions(): void {
  registerAction("search", async (params, ctx) => {
    const query = str(params.query).trim();
    if (!query) return fail("search 需要 query");
    const engine = str(params.engine, "google").toLowerCase();
    const url =
      engine === "bing"
        ? `https://www.bing.com/search?q=${encodeURIComponent(query)}`
        : engine === "duckduckgo"
          ? `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
          : `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    const gw = resolveGateway(ctx.page);
    await gw.navigate(url);
    return ok(`已搜索(${engine}): ${query}`);
  });

  registerAction("navigate", async (params, ctx) => {
    let url = str(params.url).trim();
    if (!url) return fail("navigate 需要 url");
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    const newTab = bool(params.new_tab, false);
    if (newTab) {
      const p = await ctx.page.context().newPage();
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await p.bringToFront();
      ctx.setActivePage?.(p);
      const gw = resolveGateway(p);
      await gw.navigate(url, { alreadyNavigated: true });
      return ok(`新标签打开 ${url}`);
    }
    const gw = resolveGateway(ctx.page);
    await gw.navigate(url);
    return ok(`已导航 ${url}`);
  });

  registerAction("go_back", async (_params, ctx) => {
    const gw = resolveGateway(ctx.page);
    await gw.goBack();
    return ok("已后退");
  });

  registerAction("wait", async (params, ctx) => {
    const seconds = Math.min(30, Math.max(0.5, num(params.seconds, 1)));
    await resolveGateway(ctx.page).wait(seconds);
    return ok(`等待 ${seconds}s`);
  });

  registerAction("click", async (params, ctx) => {
    const index = params.index != null ? num(params.index) : null;
    const x = params.coordinate_x != null ? num(params.coordinate_x) : null;
    const y = params.coordinate_y != null ? num(params.coordinate_y) : null;
    const gw = resolveGateway(ctx.page);
    if (x != null && y != null) {
      await gw.pointClick(x, y);
      return ok(`坐标点击 (${x},${y})`);
    }
    if (index == null) return fail("click 需要 index 或坐标");
    const el = ctx.resolveElement(index);
    if (!el) return fail(`无效 index: ${index}`);
    const label = elementLabelBlob(el) || el.tagName;
    if (needsHitlConfirm("click", label)) {
      const confirmId = randomUUID();
      const decision = await ctx.requestConfirm({
        requestId: confirmId,
        url: ctx.page.url(),
        reason: `点击 [${index}] ${label}`,
        actions: [{ kind: "click", id: String(index), text: label }],
      });
      if (!decision.approved) return fail("用户取消点击确认");
    }
    try {
      await gw.click(elementPlaywrightSelector(el), { semanticLabel: el.text });
    } catch (err) {
      if (el.xpath) {
        await gw.click(`xpath=${el.xpath}`, { semanticLabel: el.text });
      } else {
        throw err;
      }
    }
    return ok(`已点击 [${index}] ${label}`);
  });

  registerAction("input", async (params, ctx) => {
    const index = num(params.index);
    const text = str(params.text);
    const clear = bool(params.clear, true);
    const el = ctx.resolveElement(index);
    if (!el) return fail(`无效 index: ${index}`);
    const label = elementLabelBlob(el) || el.tagName;
    let value = text;
    if (needsHitlConfirm("fill", label, text) || text.length === 0) {
      const confirmId = randomUUID();
      const decision = await ctx.requestConfirm({
        requestId: confirmId,
        url: ctx.page.url(),
        reason: `填写 [${index}] ${label}`,
        actions: [
          {
            kind: "fill",
            id: String(index),
            text: label,
            value: text,
          },
        ],
      });
      if (!decision.approved) return fail("用户取消填写确认");
      value = decision.fillOverrides?.[String(index)] ?? text;
    } else if (typeof params.confidence === "number" && params.confidence < CONFIRM_SKIP_THRESHOLD) {
      const confirmId = randomUUID();
      const decision = await ctx.requestConfirm({
        requestId: confirmId,
        url: ctx.page.url(),
        reason: `低置信填写 [${index}] ${label}`,
        actions: [{ kind: "fill", id: String(index), text: label, value: text }],
      });
      if (!decision.approved) return fail("用户取消填写确认");
      value = decision.fillOverrides?.[String(index)] ?? text;
    }
    const gw = resolveGateway(ctx.page);
    const selector = elementPlaywrightSelector(el);
    await gw.fill(selector, value, {
      semanticLabel: label,
      humanLike: true,
      append: !clear,
    });
    const verifyHit = findIndexByTextHint(
      ctx.browserState.selectorMap,
      /验证答案/i,
      /提交参赛/i,
    );
    if (verifyHit) {
      return ok(
        `已输入 [${index}]: ${value.slice(0, 80)}。下一动作立即 click(index=${verifyHit.index})「${verifyHit.label}」，勿空等、勿再 solve_captcha。`,
      );
    }
    return ok(`已输入 [${index}]: ${value.slice(0, 80)}`);
  });

  registerAction("scroll", async (params, ctx) => {
    const down = bool(params.down, true);
    const pages = Math.max(0.1, num(params.pages, 1));
    const gw = resolveGateway(ctx.page);
    if (pages >= 10) {
      await gw.scroll(down ? "bottom" : "up");
    } else {
      for (let i = 0; i < Math.ceil(pages); i++) {
        await gw.scroll(down ? "down" : "up");
      }
    }
    return ok(`滚动 ${down ? "下" : "上"} ×${pages}`);
  });

  registerAction("send_keys", async (params, ctx) => {
    const keys = str(params.keys).trim();
    if (!keys) return fail("send_keys 需要 keys");
    await resolveGateway(ctx.page).executeKeyPress(keys);
    return ok(`按键 ${keys}`);
  });

  registerAction("find_text", async (params, ctx) => {
    const text = str(params.text).trim();
    if (!text) return fail("find_text 需要 text");
    for (let i = 0; i < 8; i++) {
      const found = await ctx.page.getByText(text, { exact: false }).first().isVisible().catch(() => false);
      if (found) {
        await ctx.page.getByText(text, { exact: false }).first().scrollIntoViewIfNeeded().catch(() => null);
        return ok(`已找到文本: ${text}`);
      }
      await resolveGateway(ctx.page).scroll("down");
    }
    return fail(`未找到文本: ${text}`);
  });

  registerAction("switch", async (params, ctx) => {
    const tabId = str(params.tab_id).trim();
    const pages = ctx.page.context().pages();
    const idx = Math.max(0, parseInt(tabId, 10) - 1);
    const target = pages[idx] ?? pages.find((_, i) => String(i + 1).padStart(4, "0").slice(-4) === tabId);
    if (!target) return fail(`标签不存在: ${tabId}`);
    await target.bringToFront();
    ctx.setActivePage?.(target);
    // 回放无法复现「切标签」语义，落盘为导航到该标签 URL
    const finalUrl = target.url();
    if (finalUrl && !/^about:blank/i.test(finalUrl)) {
      resolveGateway(target).recordNavigate(finalUrl);
    }
    return ok(`已切换到标签 ${tabId}`);
  });

  registerAction("close", async (params, ctx) => {
    const tabId = str(params.tab_id).trim();
    const pages = ctx.page.context().pages();
    const idx = Math.max(0, parseInt(tabId, 10) - 1);
    const target = pages[idx];
    if (!target) return fail(`标签不存在: ${tabId}`);
    if (pages.length <= 1) return fail("不能关闭最后一个标签");
    await target.close();
    return ok(`已关闭标签 ${tabId}`);
  });

  registerAction("extract", async (params, ctx) => {
    const query = str(params.query).trim();
    if (!query) return fail("extract 需要 query");
    const markdown = await ctx.page.evaluate(() => {
      const clone = document.body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("script,style,noscript").forEach((n) => n.remove());
      return (clone.innerText || "").slice(0, 80_000);
    });
    const client = createLlmClient(ctx.aiSettings);
    const model =
      ctx.aiSettings.agentModel ||
      ctx.aiSettings.chatModel ||
      ctx.aiSettings.textModel ||
      "deepseek-chat";
    const wait = beginAgentLlmWait({ timeoutMs: 45_000 });
    try {
      const completion = await client.chat.completions.create(
        {
          model,
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content:
                "你是页面信息提取器。只根据给定正文回答用户查询，不要编造。用简洁中文或用户要求的格式。",
            },
            {
              role: "user",
              content: `查询：${query}\n\n页面正文：\n${markdown.slice(0, 60_000)}`,
            },
          ],
        } as never,
        { signal: wait.signal },
      );
      const text = completion.choices[0]?.message?.content?.trim() || "(空)";
      return ok(text, { includeExtractedContentOnlyOnce: true, extractedContent: text });
    } finally {
      wait.stop();
    }
  });

  registerAction("search_page", async (params, ctx) => {
    const pattern = str(params.pattern);
    if (!pattern) return fail("search_page 需要 pattern");
    const useRegex = bool(params.regex, false);
    const caseSensitive = bool(params.case_sensitive, false);
    const maxResults = Math.min(50, Math.max(1, num(params.max_results, 25)));
    const contextChars = Math.min(400, Math.max(40, num(params.context_chars, 150)));
    const matches = await ctx.page.evaluate(
      ({ pattern, useRegex, caseSensitive, maxResults, contextChars }) => {
        const text = document.body?.innerText || "";
        const out: string[] = [];
        if (useRegex) {
          const flags = caseSensitive ? "g" : "gi";
          const re = new RegExp(pattern, flags);
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) && out.length < maxResults) {
            const i = m.index;
            out.push(text.slice(Math.max(0, i - contextChars), i + m[0].length + contextChars));
          }
        } else {
          const hay = caseSensitive ? text : text.toLowerCase();
          const needle = caseSensitive ? pattern : pattern.toLowerCase();
          let from = 0;
          while (out.length < maxResults) {
            const i = hay.indexOf(needle, from);
            if (i < 0) break;
            out.push(text.slice(Math.max(0, i - contextChars), i + pattern.length + contextChars));
            from = i + Math.max(1, needle.length);
          }
        }
        return out;
      },
      { pattern, useRegex, caseSensitive, maxResults, contextChars },
    );
    const content = matches.length
      ? `找到 ${matches.length} 处：\n${matches.map((m, i) => `${i + 1}. …${m}…`).join("\n")}`
      : "未找到匹配";
    return ok(content, { includeExtractedContentOnlyOnce: true, extractedContent: content });
  });

  registerAction("find_elements", async (params, ctx) => {
    const selector = str(params.selector).trim();
    if (!selector) return fail("find_elements 需要 selector");
    const maxResults = Math.min(100, Math.max(1, num(params.max_results, 50)));
    const includeText = bool(params.include_text, true);
    const attributes = Array.isArray(params.attributes)
      ? params.attributes.filter((x): x is string => typeof x === "string")
      : [];
    const rows = await ctx.page.evaluate(
      ({ selector, maxResults, includeText, attributes }) => {
        const nodes = Array.from(document.querySelectorAll(selector)).slice(0, maxResults);
        return nodes.map((n) => {
          const el = n as HTMLElement;
          const row: Record<string, string> = { tag: el.tagName.toLowerCase() };
          if (includeText) row.text = (el.innerText || "").trim().slice(0, 200);
          for (const a of attributes) {
            row[a] = el.getAttribute(a) || "";
          }
          return row;
        });
      },
      { selector, maxResults, includeText, attributes },
    );
    const content = JSON.stringify(rows, null, 2);
    return ok(`匹配 ${rows.length} 个元素\n${content}`, {
      includeExtractedContentOnlyOnce: true,
      extractedContent: content,
    });
  });

  registerAction("dropdown_options", async (params, ctx) => {
    const index = num(params.index);
    const el = ctx.resolveElement(index);
    if (!el) return fail(`无效 index: ${index}`);
    const options = await ctx.page.locator(el.selector).first().evaluate((node) => {
      const select = node as HTMLSelectElement;
      if (select.tagName === "SELECT") {
        return Array.from(select.options).map((o) => o.text);
      }
      return Array.from(
        node.querySelectorAll('[role="option"], option, li'),
      ).map((o) => (o.textContent || "").trim()).filter(Boolean);
    });
    const content = options.slice(0, 80).join("\n");
    return ok(content || "(无选项)", {
      includeExtractedContentOnlyOnce: true,
      extractedContent: content,
    });
  });

  registerAction("select_dropdown", async (params, ctx) => {
    const index = num(params.index);
    const text = str(params.text).trim();
    const el = ctx.resolveElement(index);
    if (!el) return fail(`无效 index: ${index}`);
    const gw = resolveGateway(ctx.page);
    const label = el.text || el.tagName;
    const trySelect = async (selector: string) => {
      await gw.selectOption(selector, text, { semanticLabel: label });
    };
    try {
      await trySelect(el.selector);
    } catch {
      if (el.xpath) {
        try {
          await trySelect(`xpath=${el.xpath}`);
          return ok(`已选择 [${index}] → ${text}`);
        } catch {
          /* 非原生 select */
        }
      }
      await gw.click(elementPlaywrightSelector(el), { semanticLabel: label });
      await ctx.page
        .getByText(text, { exact: true })
        .first()
        .click({ force: true, timeout: 5_000 });
      gw.recordClick({ selector: `text=${text}`, label: text });
    }
    return ok(`已选择 [${index}] → ${text}`);
  });

  registerAction("screenshot", async (params, ctx) => {
    const fileName = str(params.file_name).trim();
    if (fileName) {
      try {
        const buf = await ctx.page.screenshot({ type: "png", fullPage: false });
        const path = ctx.fileSystem.writeBinaryFile(
          fileName.endsWith(".png") ? fileName : `${fileName}.png`,
          buf,
        );
        return ok(`截图已保存 ${path}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail(`${SCREENSHOT_CAPABILITY_ERROR}（${msg}）`);
      }
    }
    // 先探针能否截图；失败立即报权限/能力错误，禁止「已请求」后静默截图关闭
    try {
      await ctx.page.screenshot({ type: "jpeg", quality: 40, fullPage: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`${SCREENSHOT_CAPABILITY_ERROR}（${msg}）`);
    }
    ctx.setIncludeScreenshotNext(true);
    return ok("已请求下一轮附带截图（将强制拍视口图并交给决策模型）");
  });

  registerAction("write_file", async (params, ctx) => {
    const fileName = str(params.file_name).trim();
    const content = str(params.content);
    const append = bool(params.append, false);
    if (!fileName) return fail("write_file 需要 file_name");
    const path = ctx.fileSystem.writeFile(fileName, content, append);
    return ok(`已写入 ${path}`);
  });

  registerAction("replace_file", async (params, ctx) => {
    const fileName = str(params.file_name).trim();
    const oldStr = str(params.old_str);
    const newStr = str(params.new_str);
    const path = ctx.fileSystem.replaceFile(fileName, oldStr, newStr);
    return ok(`已替换 ${path}`);
  });

  registerAction("read_file", async (params, ctx) => {
    const fileName = str(params.file_name).trim();
    const content = ctx.fileSystem.readFile(fileName);
    return ok(content, { includeExtractedContentOnlyOnce: true, extractedContent: content });
  });

  registerAction("evaluate", async (params, ctx) => {
    const code = str(params.code).trim();
    if (!code) return fail("evaluate 需要 code");
    const banned =
      /navigator\.|webgl|WebGL|AudioContext|canvas\.toDataURL|chrome\.runtime|permissions/i;
    if (banned.test(code)) {
      return fail("evaluate 禁止触碰指纹/环境相关 API");
    }
    const result = await ctx.page.evaluate(async (c) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${c})`);
      const v = fn();
      return typeof v?.then === "function" ? await v : v;
    }, code);
    return ok(`evaluate 结果: ${JSON.stringify(result)?.slice(0, 2000)}`);
  });

  registerAction("upload_file", async (params, ctx) => {
    const index = num(params.index);
    const path = str(params.path).trim();
    const el = ctx.resolveElement(index);
    if (!el) return fail(`无效 index: ${index}`);
    if (!path) return fail("upload_file 需要 path");
    await ctx.page.locator(el.selector).first().setInputFiles(path);
    return ok(`已上传文件到 [${index}]`);
  });

  registerAction("save_as_pdf", async (params, ctx) => {
    const fileName = str(params.file_name, "page").trim() || "page";
    const pdf = await ctx.page.pdf({
      printBackground: bool(params.print_background, true),
      landscape: bool(params.landscape, false),
    });
    const path = ctx.fileSystem.writeBinaryFile(
      fileName.endsWith(".pdf") ? fileName : `${fileName}.pdf`,
      pdf,
    );
    return ok(`PDF 已保存 ${path}`);
  });

  registerAction("done", async (params) => {
    const text = str(params.text, "");
    const success = bool(params.success, true);
    return {
      isDone: true,
      success,
      extractedContent: text,
      longTermMemory: text,
    };
  });

  registerAction("scrape_page_data", async (params, ctx) => {
    const targetDescription = str(params.targetDescription || params.target_description).trim();
    const result = await scrapePageData(ctx.page, {
      mode: "dom",
      targetDescription: targetDescription || undefined,
      fields:
        params.fields && typeof params.fields === "object" && !Array.isArray(params.fields)
          ? (params.fields as Record<string, string>)
          : undefined,
      autoScroll: bool(params.autoScroll ?? params.auto_scroll, false),
      profileId: ctx.profileId,
      aiSettings: ctx.aiSettings,
    });
    const content = JSON.stringify(result).slice(0, 12_000);
    return ok(content, { includeExtractedContentOnlyOnce: true, extractedContent: content });
  });

  registerAction("ask_user", async (params, ctx) => {
    const question = str(params.question || params.text).trim() || "请提供所需信息";
    // 通用：问「点哪个图标/语言球」不是 HITL，禁止空转 ask_user
    if (isVisualTargetQuestion(question)) {
      const router = createModelRouter(ctx.aiSettings);
      if (!isIntentConfigured(router.pool, "vision")) {
        return fail(VISION_CAPABILITY_ERROR);
      }
      return fail(
        "不要用 ask_user 询问要点哪个图标/图片/语言入口。请改用 ask_vision_locate(query=清晰形态描述, click=true)。",
      );
    }
    // 禁止把 recall_skill 手册全文当「问题」卡住人工
    if (
      /#\s*Skill:|##\s*何时用|网格化定位|格号\s*[-→>]|禁止\s*`?ask_user|本轮唯一动作/i.test(question) ||
      (question.length > 800 && /Skill:|何时用|suggestedSkill|recall_skill/i.test(question))
    ) {
      return fail(
        "ask_user 的 question 不能是技能手册/召回正文。点选请 solve_captcha；短信/邮箱/验证器码才用 ask_user 问短问题。",
      );
    }
    const requestId = randomUUID();
    ctx.logger.agentAskUser({ requestId, question, profileId: ctx.profileId });
    const answer = await ctx.askUser(requestId, question);
    return ok(`用户回答: ${answer}`);
  });

  registerAction("handover_to_human", async (params, ctx) => {
    const reason = str(params.reason, "需要人工接管");
    const requestId = randomUUID();
    await ctx.requestHandover({ requestId, reason, url: ctx.page.url() });
    return ok(`人工接管完成，继续执行。原因: ${reason}`);
  });

  registerAction("ask_vision_locate", async (params, ctx) => {
    const query = str(params.query || params.target).trim();
    if (!query) return fail("ask_vision_locate 需要 query");
    const router = createModelRouter(ctx.aiSettings);
    if (!isIntentConfigured(router.pool, "vision")) {
      return fail(VISION_CAPABILITY_ERROR);
    }
    // 短问法自动扩成「先描述再坐标」；语言类补 EN 圆钮线索（形态提示，非站点硬编码）
    const enrichedHint =
      /语言|中文|english|\ben\b|hebrew|עבר|locale/i.test(query) &&
      !/右上|圆形|EN|地球|国旗|图标/i.test(query)
        ? `${query}（常见为右上角语言入口：圆形语种缩写/地球仪/国旗图标）`
        : query;
    try {
      const result = await visionLocateAndClick({
        page: ctx.page,
        goal: ctx.goal,
        question: enrichedHint,
        aiSettings: ctx.aiSettings,
        logger: ctx.logger,
        autoClick: bool(params.click, true),
      });
      if (!result.ok) {
        const detail = result.detail || "视觉定位失败";
        if (/截图失败/i.test(detail)) {
          return fail(`${SCREENSHOT_CAPABILITY_ERROR}（${detail}）`);
        }
        return fail(detail);
      }
      return ok(JSON.stringify(result).slice(0, 2000));
    } catch (err) {
      if (isVisualModelNotConfiguredError(err)) {
        return fail(VISION_CAPABILITY_ERROR);
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/截图失败|screenshot/i.test(msg)) {
        return fail(`${SCREENSHOT_CAPABILITY_ERROR}（${msg}）`);
      }
      return fail(`ask_vision_locate 失败：${msg}`);
    }
  });

  registerAction("click_viewport", async (params, ctx) => {
    const xPercent = num(params.xPercent ?? params.x_percent);
    const yPercent = num(params.yPercent ?? params.y_percent);
    await clickViewportPercent(ctx.page, xPercent, yPercent);
    return ok(`视口点击 ${xPercent}%,${yPercent}%`);
  });

  registerAction("solve_captcha", handleSolveCaptcha);
  registerAction("solve_animated_captcha", handleSolveCaptcha);
  registerAction("solve_slider_captcha", async (params, ctx) => {
    return handleSolveCaptcha({ ...params, strategy: "slider_gap_drag" }, ctx);
  });
  registerAction("solve_math_captcha", async (params, ctx) => {
    return handleSolveCaptcha({ ...params, strategy: "math_image_solve" }, ctx);
  });
  registerAction("solve_point_select_captcha", async (params, ctx) => {
    return handleSolveCaptcha({ ...params, strategy: "point_select_click" }, ctx);
  });
}

async function handleSolveCaptcha(
  params: Record<string, unknown>,
  ctx: ActionContext,
): Promise<ActionResult> {
  const throwIfAborted = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("Agent 已中止");
  };
  throwIfAborted(ctx.signal);
  const autoFill = bool(params.auto_fill ?? params.autoFill, true);
  const autoSubmit = bool(params.auto_submit ?? params.autoSubmit, true);
  const pageHint = str(params.page_hint || params.hint || ctx.goal).slice(0, 240);
  const forceStrategy = str(params.strategy || params.force_strategy || "").slice(0, 64);

  let unified;
  try {
    unified = await solveCaptcha({
      page: ctx.page,
      aiSettings: ctx.aiSettings,
      logger: ctx.logger,
      selectorMap: ctx.browserState.selectorMap,
      pageHint: pageHint || undefined,
      goalHint: ctx.goal,
      forceStrategy: forceStrategy || undefined,
      fileSystem: ctx.fileSystem,
      signal: ctx.signal,
    });
  } catch (err) {
    if (isVisualModelNotConfiguredError(err)) {
      return fail(VISION_CAPABILITY_ERROR);
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/已中止|aborted|AbortError/i.test(msg)) {
      return fail("Agent 已中止");
    }
    return fail(`solve_captcha 失败：${msg}`);
  }

  throwIfAborted(ctx.signal);

  if (unified.kind === "unsupported") {
    return fail(unified.detail);
  }

  if (unified.kind === "slider") {
    const result = unified.slider;
    if (result.strategy === "unsupported" || (!result.ok && result.verified === null && result.gapX <= 0)) {
      return fail(result.detail || "滑块验证码未能完成");
    }
    const payload: Record<string, unknown> = {
      strategy: "slider_gap_drag",
      gapX: result.gapX,
      dragDistance: result.dragDistance,
      confidence: result.confidence,
      method: result.method,
      verified: result.verified,
      verifySignal: result.verifySignal,
      protocolHints: result.protocolHints,
    };
    if (result.verified === true) {
      payload.next = "滑块已通过：可 done(success=true)";
      cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
    } else if (result.verified === false) {
      payload.next =
        "滑块失败：captcha_attempt+1；勿刷新；继续只用 solve_captcha（勿换别名空转）；满 3 次 HITL";
    } else {
      cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
      payload.next =
        "已拖拽；若页内或协议出现 success 可 done(success=true)；否则未满 3 次可再 solve_captcha";
    }
    const content = JSON.stringify(payload);
    return ok(content, {
      includeExtractedContentOnlyOnce: true,
      extractedContent: content,
      longTermMemory:
        result.verified === true
          ? `滑块验证通过 drag=${result.dragDistance.toFixed(1)}`
          : result.verified === false
            ? `滑块验证失败（${result.verifySignal}）`
            : `滑块已拖拽 gapX=${result.gapX} drag=${result.dragDistance.toFixed(1)}`,
      success: result.verified === false ? false : true,
    });
  }

  if (unified.kind === "point") {
    const result = unified.point;
    if (result.strategy === "unsupported" || (!result.ok && result.points.length === 0)) {
      return fail(result.detail || "点选验证码未能完成");
    }
    const payload: Record<string, unknown> = {
      strategy: "point_select_click",
      points: result.points,
      viewportPoints: result.viewportPoints,
      confidence: result.confidence,
      method: result.method,
      verified: result.verified,
      verifySignal: result.verifySignal,
      protocolHints: result.protocolHints,
      crop: result.crop,
    };
    if (result.verified === true) {
      payload.next = "点选已通过：可 done(success=true)";
      cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
    } else if (result.verified === false) {
      payload.next =
        "点选失败：captcha_attempt+1；勿刷新；继续只用 solve_captcha；满 3 次 handover_to_human（勿 ask_user 代点）";
    } else {
      cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
      payload.next =
        "已拟人点选；若页内/协议 success 可 done(success=true)；否则未满3次再 solve_captcha";
    }
    const content = JSON.stringify(payload);
    return ok(content, {
      includeExtractedContentOnlyOnce: true,
      extractedContent: content,
      longTermMemory:
        result.verified === true
          ? `点选通过 n=${result.points.length}`
          : result.verified === false
            ? `点选失败（${result.verifySignal}）`
            : `点选已点击 n=${result.points.length}`,
      success: result.verified === false ? false : true,
    });
  }

  if (unified.kind === "math") {
    const result = unified.math;
    if (!result.ok || !result.answer) {
      return fail(
        result.detail ||
          "未能求解算式。勿刷新；继续只用 solve_captcha（勿改用 solve_math_captcha 空转同一路径）；满 3 次 HITL。",
      );
    }

    const payload: Record<string, unknown> = {
      strategy: "math_image_solve",
      expr: result.expr,
      answer: result.answer,
      confidence: result.confidence,
      method: result.method,
      inputIndex: result.formHints.inputIndex,
      submitIndex: result.formHints.submitIndex,
      filled: false,
      submitted: false,
      verified: null as boolean | null,
      verifySignal: "",
    };

    const gw = resolveGateway(ctx.page);
    ctx.logger.agentProgress(
      `④ 答案「${result.answer}」（${result.expr}）→ 填入并点「验证答案」`,
      {
        phase: "math_image_captcha",
        stage: "fill_submit",
        answer: result.answer,
        expr: result.expr,
      },
    );

    if (autoFill && result.formHints.inputIndex != null) {
      const index = result.formHints.inputIndex;
      const el = ctx.resolveElement(index);
      if (el) {
        const sel = elementPlaywrightSelector(el);
        const answer = String(result.answer);
        await gw.fill(sel, answer, {
          semanticLabel: elementLabelBlob(el) || el.tagName,
          humanLike: false,
          append: false,
        });
        // 回读防幻觉/错填：DOM 值必须等于求值结果
        const actual = await ctx.page
          .locator(sel)
          .inputValue()
          .catch(async () =>
            ctx.page.locator(sel).evaluate((n) => String((n as HTMLInputElement).value ?? "")),
          )
          .catch(() => "");
        const norm = (s: string) => String(s).trim().replace(/\s+/g, "");
        if (norm(actual) !== norm(answer)) {
          ctx.logger.warn("math_fill_mismatch_refill", {
            expected: answer,
            actual: String(actual).slice(0, 32),
          });
          await gw.fill(sel, answer, {
            semanticLabel: elementLabelBlob(el) || el.tagName,
            humanLike: false,
            append: false,
          });
          const again = await ctx.page
            .locator(sel)
            .inputValue()
            .catch(() => "");
          if (norm(again) !== norm(answer)) {
            return fail(
              `算式已求出「${answer}」（${result.expr}），但输入框回读为「${again || actual}」。请下一轮用 input 填入 ${answer}。`,
            );
          }
        }
        payload.filled = true;
        payload.filledValue = answer;
      } else {
        return fail(
          `已算出「${result.answer}」，但输入框 index=${index} 已失效。请下一轮用 input 填入。`,
        );
      }
    }

    if (autoSubmit && result.formHints.submitIndex != null && payload.filled) {
      const index = result.formHints.submitIndex;
      const el = ctx.resolveElement(index);
      if (!el) {
        return fail(
          `已填入「${result.answer}」，但验证按钮 index=${index} 已失效。请下一轮 click 文案含「验证答案」的 index；勿空等。`,
        );
      }
      const sel = elementPlaywrightSelector(el);
      try {
        await gw.click(sel, { semanticLabel: el.text });
      } catch {
        if (el.xpath) {
          await gw.click(`xpath=${el.xpath}`, { semanticLabel: el.text });
        } else {
          throw new Error(`验证答案按钮点击失败 index=${index}`);
        }
      }
      payload.submitted = true;
      try {
        const outcome = await checkCaptchaOutcome(ctx.page);
        payload.verified = outcome.verified;
        payload.verifySignal = outcome.signal;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Execution context was destroyed|Target closed|navigat/i.test(msg)) {
          payload.verifySignal = "nav_or_context_destroyed";
          payload.verified = null;
        } else {
          throw err;
        }
      }
    } else if (autoSubmit && payload.filled && result.formHints.submitIndex == null) {
      const hit = findIndexByTextHint(
        ctx.browserState.selectorMap,
        /验证答案/i,
        /提交参赛/i,
      );
      if (hit) {
        const el = ctx.resolveElement(hit.index);
        if (el) {
          await gw.click(elementPlaywrightSelector(el), { semanticLabel: el.text });
          payload.submitted = true;
          payload.submitIndex = hit.index;
          try {
            const outcome = await checkCaptchaOutcome(ctx.page);
            payload.verified = outcome.verified;
            payload.verifySignal = outcome.signal;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/Execution context was destroyed|Target closed|navigat/i.test(msg)) {
              payload.verifySignal = "nav_or_context_destroyed";
              payload.verified = null;
            } else {
              throw err;
            }
          }
        }
      }
    }

    if (payload.verified === true) {
      payload.next =
        "页内已通过验证答案；勿点「提交参赛代码」除非用户目标要求；可继续任务或 done";
      cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
    } else if (payload.verified === false) {
      payload.next =
        "答案错误：captcha_attempt+1；勿刷新；继续只用 solve_captcha（勿换别名空转）；满 3 次 HITL";
    } else if (payload.filled && payload.submitted) {
      cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
      payload.next = "已填交验证答案；若页内出现成功提示可继续；勿误点提交参赛代码";
    } else if (payload.filled && !payload.submitted) {
      payload.next =
        result.formHints.submitIndex != null
          ? `已填入；下一轮仅 click(index=${result.formHints.submitIndex}) 验证答案`
          : "已填入，请点击「验证答案」";
    } else if (!payload.filled) {
      payload.next = `用 input 填入 "${result.answer}" 后点击「验证答案」`;
    }

    const content = JSON.stringify(payload);
    const mem =
      payload.verified === true
        ? `算式验证通过: ${result.expr}=${result.answer}`
        : payload.verified === false
          ? `算式验证失败: ${result.expr}=${result.answer}（${payload.verifySignal}）`
          : `算式求解: ${result.expr}=${result.answer}`;
    return ok(content, {
      includeExtractedContentOnlyOnce: true,
      extractedContent: content,
      longTermMemory: mem,
      success: payload.verified === false ? false : true,
    });
  }

  // GIF 路径
  const result = unified.gif;
  if (result.strategy === "unsupported") {
    return fail(
      result.detail ||
        "unsupported: 当前验证码类型未封装。请勿重试本工具。",
    );
  }

  if (!result.ok || !result.code) {
    cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
    return fail(
      result.detail ||
        "未能识别。勿刷新；继续只用 solve_captcha（勿换别名空转）；满 3 次后 handover_to_human。",
    );
  }

  const payload: Record<string, unknown> = {
    strategy: result.strategy ?? "gif_animated_dwell",
    code: result.code,
    frame: result.frame,
    confidence: result.confidence,
    framesCaptured: result.framesCaptured,
    framePaths: result.framePaths ?? [],
    gifPath: result.gifPath ?? "",
    inputIndex: result.formHints.inputIndex,
    submitIndex: result.formHints.submitIndex,
    filled: false,
    submitted: false,
    verified: null as boolean | null,
    verifySignal: "",
  };

  const gw = resolveGateway(ctx.page);
  ctx.logger.agentProgress(
    `③ 读码完成「${result.code}」(最清晰帧 ${result.frame}) → 立即填写提交`,
    {
      phase: "animated_captcha",
      stage: "fill_submit",
      code: result.code,
    },
  );

  if (autoFill && result.formHints.inputIndex != null) {
    const index = result.formHints.inputIndex;
    const el = ctx.resolveElement(index);
    if (el) {
      const sel = elementPlaywrightSelector(el);
      await gw.fill(sel, result.code, {
        semanticLabel: elementLabelBlob(el) || el.tagName,
        humanLike: false,
        append: false,
      });
      payload.filled = true;
      payload.filledValue = result.code;
    } else {
      return fail(
        `已识别验证码「${result.code}」，但输入框 index=${index} 已失效。请下一轮用 input 填入。`,
      );
    }
  }

  if (autoSubmit && result.formHints.submitIndex != null && payload.filled) {
    const index = result.formHints.submitIndex;
    const el = ctx.resolveElement(index);
    if (!el) {
      return fail(
        `已填入「${result.code}」，但提交按钮 index=${index} 已失效。请下一轮 click 含「验证答案/提交」的 index；勿空等。`,
      );
    }
    const sel = elementPlaywrightSelector(el);
    try {
      await gw.click(sel, { semanticLabel: el.text });
    } catch {
      if (el.xpath) {
        await gw.click(`xpath=${el.xpath}`, { semanticLabel: el.text });
      } else {
        throw new Error(`提交按钮点击失败 index=${index}`);
      }
    }
    payload.submitted = true;
    const outcome = await checkCaptchaOutcome(ctx.page);
    payload.verified = outcome.verified;
    payload.verifySignal = outcome.signal;
  } else if (autoSubmit && payload.filled && result.formHints.submitIndex == null) {
    const hit = findIndexByTextHint(
      ctx.browserState.selectorMap,
      /验证答案|提交|确定/i,
      /提交参赛/i,
    );
    if (hit) {
      const el = ctx.resolveElement(hit.index);
      if (el) {
        await gw.click(elementPlaywrightSelector(el), { semanticLabel: el.text });
        payload.submitted = true;
        payload.submitIndex = hit.index;
        const outcome = await checkCaptchaOutcome(ctx.page);
        payload.verified = outcome.verified;
        payload.verifySignal = outcome.signal;
      }
    }
  }

  if (payload.verified === true) {
    payload.next = "页内已出现成功提示：可 done(success=true)";
    cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
  } else if (payload.verified === false) {
    payload.next =
      "页内提示失败：captcha_attempt+1；勿刷新；继续只用 solve_captcha（勿换别名空转）；满 3 次 HITL";
  } else if (payload.filled && payload.submitted) {
    cleanupCaptchaArtifacts(result.artifactPaths, ctx.logger);
    payload.next = "已填交；若页内出现成功提示可 done(success=true)";
  } else if (payload.filled && !payload.submitted) {
    payload.next =
      result.formHints.submitIndex != null
        ? `已填入；下一轮仅 click(index=${result.formHints.submitIndex})`
        : "已填入，请点击提交";
  } else if (!payload.filled) {
    payload.next = `用 input 填入 "${result.code}" 后提交`;
  }

  const content = JSON.stringify(payload);
  const mem =
    payload.verified === true
      ? `验证码通过: ${result.code}`
      : payload.verified === false
        ? `验证码错误: ${result.code}（${payload.verifySignal}）`
        : `GIF验证码识别(帧${result.frame}): ${result.code}`;
  return ok(content, {
    includeExtractedContentOnlyOnce: true,
    extractedContent: content,
    longTermMemory: mem,
    success: payload.verified === false ? false : true,
  });
}

/** 懒加载注册 */
let registered = false;
export function ensureActionsRegistered(): void {
  if (registered) return;
  registerAllActions();
  registerSkillMetaActions();
  registered = true;
}

export type { Page, ActionContext };

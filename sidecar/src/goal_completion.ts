/**
 * 任务结束检测：目标意图验收 × 通用页面信号（禁止站点特判）。
 */
import type { Page } from "playwright-core";

export type GoalIntent =
  | "navigate"
  | "auth"
  | "cart_add"
  | "checkout"
  | "form_submit"
  | "deliverable"
  | "language"
  | "other";

export interface PageCompletionSignals {
  url: string;
  path: string;
  title: string;
  bodySample: string;
  passwordFieldCount: number;
  /** URL 仍像登录/注册路由 */
  onAuthRoute: boolean;
  /** 购物车数量（角标或可解析数字） */
  cartCount: number;
  /** 出现「移出购物车 / Remove」类控件 */
  hasCartRemoveControl: boolean;
  /** 通用确认/完成页（thank/complete/success/订单成功…） */
  confirmationLike: boolean;
  /** 通用成功短语（注册成功/登录成功/提交成功…） */
  successPhrase: boolean;
}

export type CompletionStrength = "hard" | "soft" | "none";

export interface GoalCompletionResult {
  done: boolean;
  strength: CompletionStrength;
  reason: string;
  intents: GoalIntent[];
  satisfied: GoalIntent[];
  pending: GoalIntent[];
}

/** 从自然语言目标抽出可验收意图（有序去重） */
export function parseGoalIntents(goal: string): GoalIntent[] {
  const g = String(goal ?? "");
  const out: GoalIntent[] = [];
  const push = (intent: GoalIntent) => {
    if (!out.includes(intent)) {
      out.push(intent);
    }
  };

  if (/告诉我|发给我|总结|分析|提取|简化|第一条|回复我|是什么/i.test(g)) {
    push("deliverable");
  }
  if (/https?:\/\//i.test(g) || /打开|访问|前往|navigate|go\s*to/i.test(g)) {
    push("navigate");
  }
  if (/语言|hebrew|希伯来|english|英文|中文|locale|language|设置成/i.test(g)) {
    push("language");
  }
  if (/注册|登录|sign\s*up|sign\s*in|log\s*in|register|login/i.test(g)) {
    push("auth");
  }
  if (/填|表单|报名|开通|认证|submit|填写/i.test(g) && !out.includes("auth")) {
    push("form_submit");
  }
  if (/加购|加入购物车|加到购物车|购物车|第一个商品|第一件|add\s*to\s*cart/i.test(g)) {
    push("cart_add");
  }
  if (/结算|下单|checkout|付款|支付|提交订单|place\s*order|buy\s*now/i.test(g)) {
    push("checkout");
  }
  if (out.length === 0) {
    push("other");
  }
  return out;
}

/** 通用：URL/文案是否像「流程终点确认页」 */
export function looksLikeConfirmationPage(url: string, title: string, body: string): boolean {
  const blob = `${url}\n${title}\n${body}`.toLowerCase();
  // URL 路径语义
  if (
    /\/(thank[_-]?you|checkout[_-]?complete|order[_-]?complete|payment[_-]?success|purchase[_-]?complete|success|complete|confirmation|receipt|done)(\/|$|\?|#|\.)/i.test(
      url,
    )
  ) {
    return true;
  }
  // 文案语义（多语言通用）
  if (
    /thank\s*you(\s+for\s+your\s+order)?|order\s+(has\s+been\s+)?(dispatched|confirmed|placed|complete)|checkout\s*[:\-]?\s*complete|payment\s+successful|下单成功|支付成功|购买成功|订单(?:已)?(?:提交|完成|成功)|结账完成|交易成功/i.test(
      blob,
    )
  ) {
    return true;
  }
  return false;
}

export function looksLikeSuccessPhrase(body: string, title: string): boolean {
  const blob = `${title}\n${body}`;
  return /注册成功|登录成功|提交成功|创建成功|操作成功|验证成功|已成功注册|successfully\s+(?:registered|created|submitted|logged\s*in)|registration\s+successful|sign\s*ed\s*up|account\s+created|login\s+successful|נרשמ.*הצלח|ההרשמה\s*הושלמה|הצלחה/i.test(
    blob,
  );
}

export function isAuthRoute(url: string): boolean {
  try {
    const u = new URL(url);
    const p = `${u.pathname}${u.hash}`.toLowerCase();
    return /login|signin|sign-in|signup|sign-up|register|zhuce|auth|\/reg(?:ister)?(?:\/|$)/i.test(p);
  } catch {
    return /login|signin|signup|register/i.test(url);
  }
}

/** 在页面上下文采集通用完成信号（无站点 host 特判） */
export async function capturePageCompletionSignals(page: Page): Promise<PageCompletionSignals> {
  const data = await page.evaluate(() => {
    const bodySample = (document.body?.innerText || "").slice(0, 5000);
    const title = document.title || "";
    const url = location.href;
    const path = location.pathname || "";
    const passwordFieldCount = document.querySelectorAll('input[type="password"]').length;

    let cartCount = 0;
    const badgeSelectors = [
      "[data-test*='cart' i][class*='badge' i]",
      "[class*='cart' i][class*='badge' i]",
      "[class*='shopping_cart_badge' i]",
      "[aria-label*='cart' i]",
      "a[href*='cart' i] .badge",
      ".cart-count",
      "#cart_count",
    ];
    for (const sel of badgeSelectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) {
          continue;
        }
        const n = Number(String(el.textContent || "").replace(/[^\d]/g, ""));
        if (Number.isFinite(n) && n > 0) {
          cartCount = Math.max(cartCount, n);
        } else if ((el.textContent || "").trim()) {
          cartCount = Math.max(cartCount, 1);
        }
      } catch {
        /* ignore */
      }
    }

    let hasCartRemoveControl = false;
    const clickables = Array.from(
      document.querySelectorAll("button, a, input[type='button'], input[type='submit']"),
    );
    for (const el of clickables.slice(0, 80)) {
      const t = String((el as HTMLElement).innerText || (el as HTMLInputElement).value || "")
        .replace(/\s+/g, " ")
        .trim();
      if (/^remove$|移出购物车|删除商品|remove\s+from\s+cart/i.test(t)) {
        hasCartRemoveControl = true;
        break;
      }
    }
    if (hasCartRemoveControl && cartCount < 1) {
      cartCount = 1;
    }

    return { url, path, title, bodySample, passwordFieldCount, cartCount, hasCartRemoveControl };
  });

  return {
    url: data.url,
    path: data.path,
    title: data.title,
    bodySample: data.bodySample,
    passwordFieldCount: data.passwordFieldCount,
    onAuthRoute: isAuthRoute(data.url),
    cartCount: data.cartCount,
    hasCartRemoveControl: data.hasCartRemoveControl,
    confirmationLike: looksLikeConfirmationPage(data.url, data.title, data.bodySample),
    successPhrase: looksLikeSuccessPhrase(data.bodySample, data.title),
  };
}

/**
 * 核心：意图是否被页面信号满足。
 * hard = 可强制收工；soft = 仅教练提示。
 */
export function evaluateGoalCompletion(
  goal: string,
  signals: PageCompletionSignals,
): GoalCompletionResult {
  const intents = parseGoalIntents(goal);
  if (intents.includes("deliverable")) {
    return {
      done: false,
      strength: "none",
      reason: "汇报/总结类目标须由阅读交付验收，不由页面成功文案收工",
      intents,
      satisfied: [],
      pending: intents,
    };
  }

  const satisfied: GoalIntent[] = [];
  const pending: GoalIntent[] = [];

  const authOk =
    !signals.onAuthRoute &&
    signals.passwordFieldCount === 0 &&
    (signals.successPhrase || signals.confirmationLike || /inventory|account|dashboard|home|products|cart/i.test(signals.path));
  const cartOk = signals.cartCount >= 1 || signals.hasCartRemoveControl;
  const checkoutOk = signals.confirmationLike;
  const formOk = signals.successPhrase || signals.confirmationLike || authOk;

  for (const intent of intents) {
    let ok = false;
    switch (intent) {
      case "navigate":
        ok = Boolean(signals.url && !/^about:blank/i.test(signals.url));
        break;
      case "auth":
        ok = authOk || checkoutOk || cartOk;
        break;
      case "form_submit":
        ok = formOk;
        break;
      case "cart_add":
        // 加购：购物车有货；若已到确认页也视为加购已发生
        ok = cartOk || checkoutOk;
        break;
      case "checkout":
        ok = checkoutOk;
        break;
      case "language":
        // 语言由独立信号验收，这里不伪装完成
        ok = false;
        break;
      case "other":
        ok = signals.confirmationLike || signals.successPhrase;
        break;
      default:
        ok = false;
    }
    if (ok) {
      satisfied.push(intent);
    } else {
      pending.push(intent);
    }
  }

  // 工作意图：排除纯 navigate
  const workIntents = intents.filter((i) => i !== "navigate");
  const workPending = pending.filter((i) => i !== "navigate");
  const workSatisfied = satisfied.filter((i) => i !== "navigate");

  // 终点确认页：覆盖购物/表单类剩余意图（用户常做到结算完成）
  if (checkoutOk && workIntents.some((i) => i === "cart_add" || i === "checkout" || i === "auth" || i === "form_submit")) {
    return {
      done: true,
      strength: "hard",
      reason: "通用确认页信号已满足目标业务意图（订单/流程完成）",
      intents,
      satisfied: [...new Set([...satisfied, ...workIntents])],
      pending: pending.filter((i) => i === "language"),
    };
  }

  if (workIntents.length > 0 && workPending.length === 0) {
    return {
      done: true,
      strength: "hard",
      reason: `目标意图已全部验收：${workSatisfied.join("→")}`,
      intents,
      satisfied,
      pending: [],
    };
  }

  // 仅登录、且已离开鉴权页
  if (workIntents.length === 1 && workIntents[0] === "auth" && authOk) {
    return {
      done: true,
      strength: "hard",
      reason: "登录/注册意图已验收（已离开鉴权页且无密码框）",
      intents,
      satisfied,
      pending: [],
    };
  }

  // 仅加购
  if (
    workIntents.includes("cart_add") &&
    !workIntents.includes("checkout") &&
    cartOk &&
    workPending.every((i) => i === "auth" || i === "cart_add")
  ) {
    // auth 也可能还 pending：若已在商品页且有购物车，auth 视作满足
    const pendingNonAuth = workPending.filter((i) => i !== "auth" && i !== "cart_add");
    if (pendingNonAuth.length === 0 && cartOk) {
      return {
        done: true,
        strength: "hard",
        reason: "加购意图已验收（购物车数量/移出控件）",
        intents,
        satisfied: [...new Set([...satisfied, "auth" as GoalIntent, "cart_add" as GoalIntent])],
        pending: [],
      };
    }
  }

  if (signals.successPhrase || signals.confirmationLike || cartOk) {
    return {
      done: false,
      strength: "soft",
      reason: `页面有完成迹象，但仍缺意图：${workPending.join(",") || "无"}`,
      intents,
      satisfied,
      pending: workPending,
    };
  }

  return {
    done: false,
    strength: "none",
    reason: "尚无匹配目标的完成信号",
    intents,
    satisfied,
    pending: workPending.length ? workPending : pending,
  };
}

export async function assessGoalCompletion(
  page: Page,
  goal: string,
): Promise<GoalCompletionResult & { signals: PageCompletionSignals }> {
  const signals = await capturePageCompletionSignals(page);
  const result = evaluateGoalCompletion(goal, signals);
  return { ...result, signals };
}

/** 兼容旧调用：返回给人看的短提示；hard 完成时文案可直接用于收工 */
export function formatCompletionHint(result: GoalCompletionResult): string | null {
  if (result.strength === "none") {
    return null;
  }
  if (result.strength === "hard" && result.done) {
    return `目标已验收：${result.reason}`;
  }
  const pending = result.pending.filter((i) => i !== "navigate").join("→");
  return pending
    ? `目标未完全验收（仍缺：${pending}）。${result.reason}`
    : `目标未完全验收：${result.reason}`;
}

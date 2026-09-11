import type { ActionContext } from "./registry.js";
import { TERMINATES_SEQUENCE, getActionHandler } from "./registry.js";
import type { ActionResult, AgentAction } from "./views.js";

/**
 * 同轮多动作执行。
 * solve_captcha 及别名必须独占本轮。
 */
export async function multiAct(
  actions: AgentAction[],
  ctx: ActionContext,
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  const startUrl = ctx.page.url();

  let queue = actions;
  const CAPTCHA_ACTIONS = new Set([
    "solve_captcha",
    "solve_animated_captcha",
    "solve_slider_captcha",
    "solve_math_captcha",
    "solve_point_select_captcha",
  ]);
  const captchaSolve = actions.filter((a) => CAPTCHA_ACTIONS.has(a.name));
  if (captchaSolve.length > 0) {
    if (actions.length > 1) {
      ctx.logger.agentProgress(
        `本轮仅执行 ${captchaSolve[0]!.name}（已丢弃同轮其它动作）`,
        {
          phase: "captcha",
          dropped: actions.filter((a) => !CAPTCHA_ACTIONS.has(a.name)).map((a) => a.name),
        },
      );
    }
    queue = captchaSolve.slice(0, 1);
  }

  for (let i = 0; i < queue.length; i++) {
    if (ctx.signal?.aborted) {
      results.push({
        success: false,
        error: "Agent 已中止",
      });
      break;
    }
    const action = queue[i]!;
    const handler = getActionHandler(action.name);
    if (!handler) {
      results.push({
        success: false,
        error: `未知动作: ${action.name}`,
      });
      break;
    }

    let result: ActionResult;
    try {
      result = await handler(action.params, ctx);
    } catch (err) {
      result = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    results.push(result);

    if (result.isDone) break;
    if (result.error) break;
    if (TERMINATES_SEQUENCE.has(action.name)) break;

    const urlNow = ctx.page.url();
    if (urlNow !== startUrl && action.name === "click") {
      break;
    }
  }

  return results;
}

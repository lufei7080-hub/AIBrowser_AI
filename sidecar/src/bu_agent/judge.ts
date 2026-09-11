import { beginAgentLlmWait, createLlmClient } from "../ai_client.js";
import type { SidecarAiSettings } from "../engine.js";
import { extractJsonObject } from "./prompts.js";
import type { HistoryItem, JudgementResult } from "./views.js";

const JUDGE_TIMEOUT_MS = 12_000;

export async function judgeTrace(input: {
  goal: string;
  history: HistoryItem[];
  finalText: string;
  successClaimed: boolean;
  aiSettings: SidecarAiSettings;
}): Promise<JudgementResult> {
  const client = createLlmClient(input.aiSettings);
  const model =
    input.aiSettings.chatModel ||
    input.aiSettings.textModel ||
    input.aiSettings.agentModel ||
    "deepseek-chat";
  const steps = input.history
    .slice(-8)
    .map(
      (h) =>
        `Step ${h.stepNumber}: eval=${h.evaluationPreviousGoal ?? ""} memory=${h.memory ?? ""} actions=${h.actions
          .map((a) => a.name)
          .join(",")} results=${h.actionResults
          .map((r) => r.error || r.extractedContent || "")
          .join(" | ")
          .slice(0, 240)}`,
    )
    .join("\n");

  const wait = beginAgentLlmWait({ timeoutMs: JUDGE_TIMEOUT_MS });
  try {
    const completion = await client.chat.completions.create(
      {
        model,
        temperature: 0,
        max_tokens: 400,
        messages: [
          {
            role: "system",
            content: `你是任务完成度评判器。根据轨迹判断 Agent 是否真正完成用户目标。
只输出 JSON：{"verdict":true/false,"reasoning":"...","failure_reason":null或字符串,"impossible_task":false,"reached_captcha":false}
禁止用训练知识补全页面事实。简短 reasoning（≤80 字）。`,
          },
          {
            role: "user",
            content: `用户目标：${input.goal}
Agent 声称 success=${input.successClaimed}
最终文本：${input.finalText.slice(0, 2000)}
轨迹：
${steps}`,
          },
        ],
      } as never,
      { signal: wait.signal },
    );
    const raw = completion.choices[0]?.message?.content ?? "{}";
    try {
      const obj = extractJsonObject(raw) as Record<string, unknown>;
      return {
        verdict: Boolean(obj.verdict),
        reasoning: String(obj.reasoning ?? ""),
        failureReason: obj.failure_reason == null ? null : String(obj.failure_reason),
        impossibleTask: Boolean(obj.impossible_task),
        reachedCaptcha: Boolean(obj.reached_captcha),
      };
    } catch {
      return {
        verdict: input.successClaimed,
        reasoning: "judge 解析失败，回退到 Agent 自报 success",
        failureReason: null,
      };
    }
  } finally {
    wait.stop();
  }
}

/** 干净短轨迹且已自报成功：跳过二次评判，省一轮 LLM */
export function shouldSkipJudge(input: {
  successClaimed: boolean;
  history: HistoryItem[];
  goal: string;
  finalText?: string;
}): boolean {
  if (!input.successClaimed) return false;
  if (input.history.length > 6) return false;
  const hasError = input.history.some((h) =>
    h.actionResults.some((r) => Boolean(r.error)),
  );
  if (hasError) return false;
  // 已有实质交付 / 短成功轨迹：再跑评判只拖慢收尾
  return true;
}

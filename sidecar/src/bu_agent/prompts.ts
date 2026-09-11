import type { AgentOutput, AgentSettings, BrowserStateSummary, HistoryItem, PlanItem } from "./views.js";
import { buildSkillsSystemAppendix, ensureSkillsLoaded } from "./skills/index.js";
import { SYSTEM_PROMPT_FLASH, SYSTEM_PROMPT_THINKING } from "./system_prompt_text.js";
import { stripFencedJson } from "../json_extract.js";

export function loadSystemPrompt(settings: AgentSettings): string {
  const raw = settings.flashMode ? SYSTEM_PROMPT_FLASH : SYSTEM_PROMPT_THINKING;
  let text = raw.replace(/\{max_actions\}/g, String(settings.maxActionsPerStep)).trim();
  if (!text) {
    throw new Error(
      "Agent 系统提示词为空：请将新版提示词写入 sidecar/src/bu_agent/system_prompt_text.ts（SYSTEM_PROMPT_THINKING）",
    );
  }
  try {
    ensureSkillsLoaded();
    // Flash：仅一行技能索引，避免冲淡极简提示；Thinking：完整目录 + always_on 短摘要
    const appendix = buildSkillsSystemAppendix(undefined, {
      compact: Boolean(settings.flashMode),
    });
    if (appendix.trim()) {
      text = `${text}\n\n${appendix.trim()}`;
    }
  } catch {
    // 技能目录缺失时不阻断 Agent
  }
  return text;
}

function formatPlan(plan: PlanItem[]): string {
  if (!plan.length) return "";
  const lines = plan.map((item, i) => {
    const mark =
      item.status === "done"
        ? "[x]"
        : item.status === "current"
          ? "[>]"
          : item.status === "skipped"
            ? "[-]"
            : "[ ]";
    return `${mark} ${i}. ${item.text}`;
  });
  return `<plan>\n${lines.join("\n")}\n</plan>`;
}

function formatHistory(items: HistoryItem[], compactedMemory?: string | null): string {
  const parts: string[] = [];
  if (compactedMemory?.trim()) {
    parts.push(`<compacted_memory>\n${compactedMemory.trim()}\n</compacted_memory>`);
  }
  for (const item of items) {
    const resultLines = item.actionResults
      .map((r, i) => {
        if (r.error) return `Action ${i + 1}: ERROR ${r.error}`;
        if (r.isDone) return `Action ${i + 1}: done success=${r.success} ${r.extractedContent ?? ""}`;
        return `Action ${i + 1}: ${r.extractedContent ?? r.longTermMemory ?? "ok"}`;
      })
      .join("\n");
    parts.push(
      `<step_${item.stepNumber}>
Evaluation of Previous Step: ${item.evaluationPreviousGoal ?? ""}
Memory: ${item.memory ?? ""}
Next Goal: ${item.nextGoal ?? ""}
Action Results:
${resultLines}
</step_${item.stepNumber}>`,
    );
  }
  return parts.join("\n");
}

export interface StateMessageInput {
  userRequest: string;
  history: HistoryItem[];
  compactedMemory?: string | null;
  fileSystemSummary: string;
  todoContents: string;
  plan: PlanItem[];
  browser: BrowserStateSummary;
  readState?: string | null;
  stepNumber: number;
  maxSteps: number;
  includeScreenshot: boolean;
  /** 多帧 vision（优先于 browser.screenshotBase64） */
  visionImages?: string[];
  nudges?: string[];
}

export function buildUserStateMessage(input: StateMessageInput): {
  text: string;
  images: string[];
} {
  const today = new Date().toISOString().slice(0, 10);
  const sections: string[] = [];
  sections.push(`<user_request>\n${input.userRequest}\n</user_request>`);
  sections.push(`<agent_history>\n${formatHistory(input.history, input.compactedMemory)}\n</agent_history>`);
  sections.push(
    `<agent_state>
<file_system>
${input.fileSystemSummary}
</file_system>
<todo_contents>
${input.todoContents}
</todo_contents>
${formatPlan(input.plan)}
</agent_state>`,
  );

  const pageInfo = input.browser.pageInfo
    ? `Pages above: ${input.browser.pageInfo.pagesAbove}; Pages below: ${input.browser.pageInfo.pagesBelow}`
    : "";
  const tabs = input.browser.tabs
    .map((t) => `- ${t.id}: ${t.title || "(untitled)"} | ${t.url}`)
    .join("\n");
  sections.push(
    `<browser_state>
Current URL: ${input.browser.url}
Title: ${input.browser.title}
${pageInfo}
Open Tabs:
${tabs || "(none)"}
Interactive Elements:
${input.browser.interactiveTree}
</browser_state>`,
  );

  if (input.browser.pageDigest?.trim()) {
    sections.push(
      `<page_digest>\n${input.browser.pageDigest.trim()}\n</page_digest>`,
    );
  }

  if (input.includeScreenshot && (input.visionImages?.length || input.browser.screenshotBase64)) {
    const n = input.visionImages?.length || 1;
    sections.push(
      `<browser_vision>\n（已附 ${n} 帧视口截图；请将其视为视觉真值，勿拼接理解成长条图）\n</browser_vision>`,
    );
  }

  if (input.browser.observationError) {
    sections.push(
      `<observation_error>\n${input.browser.observationError}\nsuggested_action: reload or go_back\n</observation_error>`,
    );
  }

  if (input.readState?.trim()) {
    sections.push(`<read_state>\n${input.readState.trim()}\n</read_state>`);
  }

  if (input.nudges?.length) {
    for (const n of input.nudges) {
      sections.push(`<sys>\n${n}\n</sys>`);
    }
  }

  sections.push(
    `<step_info>\nStep ${input.stepNumber} / ${input.maxSteps}\nToday: ${today}\n</step_info>`,
  );

  return {
    text: sections.join("\n\n"),
    images: input.includeScreenshot
      ? input.visionImages?.length
        ? input.visionImages
        : input.browser.screenshotBase64
          ? [input.browser.screenshotBase64]
          : input.browser.screenshotList?.length
            ? input.browser.screenshotList
            : []
      : [],
  };
}

export function agentOutputJsonSchema(settings: AgentSettings): Record<string, unknown> {
  if (settings.flashMode) {
    return {
      type: "object",
      additionalProperties: false,
      required: ["memory", "action"],
      properties: {
        memory: { type: "string" },
        action: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["evaluation_previous_goal", "memory", "next_goal", "action"],
    properties: {
      thinking: { type: "string" },
      evaluation_previous_goal: { type: "string" },
      memory: { type: "string" },
      next_goal: { type: "string" },
      current_plan_item: { type: ["integer", "null"] },
      plan_update: {
        type: ["array", "null"],
        items: { type: "string" },
      },
      action: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
  };
}

/** 将 LLM 返回规范为 AgentOutput；容忍多种常见走形 */
export function normalizeAgentOutput(raw: unknown): AgentOutput {
  if (!raw || typeof raw !== "object") {
    throw new Error("AgentOutput 非法：非对象");
  }
  const o = raw as Record<string, unknown>;

  let actionRaw: unknown = o.action ?? o.actions ?? o.tool_calls;
  // 顶层直接给了单个动作：{"navigate":{"url":"..."}}
  if (actionRaw == null) {
    const known = Object.keys(o).filter((k) =>
      [
        "search",
        "navigate",
        "go_back",
        "wait",
        "click",
        "input",
        "scroll",
        "send_keys",
        "find_text",
        "switch",
        "close",
        "extract",
        "search_page",
        "find_elements",
        "done",
        "scrape_page_data",
        "ask_user",
        "handover_to_human",
        "ask_vision_locate",
        "click_viewport",
        "screenshot",
        "write_file",
        "read_file",
        "replace_file",
        "evaluate",
        "upload_file",
        "save_as_pdf",
        "dropdown_options",
        "select_dropdown",
        "list_skills",
        "recall_skill",
        "detect_page_blockers",
        "solve_captcha",
        "solve_animated_captcha",
        "solve_slider_captcha",
        "solve_math_captcha",
        "solve_point_select_captcha",
      ].includes(k),
    );
    if (known.length === 1) {
      actionRaw = [{ [known[0]!]: o[known[0]!] }];
    } else if (known.length > 1) {
      actionRaw = known.map((k) => ({ [k]: o[k] }));
    }
  }

  // 单个动作对象而非数组
  if (actionRaw && typeof actionRaw === "object" && !Array.isArray(actionRaw)) {
    actionRaw = [actionRaw];
  }

  if (!Array.isArray(actionRaw) || actionRaw.length === 0) {
    throw new Error("AgentOutput.action 不得为空");
  }

  const action = actionRaw.map((item, i) => normalizeOneAction(item, i));
  return {
    thinking: typeof o.thinking === "string" ? o.thinking : undefined,
    evaluation_previous_goal:
      typeof o.evaluation_previous_goal === "string"
        ? o.evaluation_previous_goal
        : typeof o.evaluation === "string"
          ? o.evaluation
          : undefined,
    memory: typeof o.memory === "string" ? o.memory : undefined,
    next_goal:
      typeof o.next_goal === "string"
        ? o.next_goal
        : typeof o.nextGoal === "string"
          ? o.nextGoal
          : undefined,
    current_plan_item:
      typeof o.current_plan_item === "number"
        ? o.current_plan_item
        : o.current_plan_item === null
          ? null
          : undefined,
    plan_update: Array.isArray(o.plan_update)
      ? o.plan_update.filter((x): x is string => typeof x === "string")
      : o.plan_update === null
        ? null
        : undefined,
    action,
  };
}

function normalizeOneAction(item: unknown, i: number): { name: string; params: Record<string, unknown> } {
  if (!item || typeof item !== "object") {
    throw new Error(`action[${i}] 非法`);
  }
  const obj = item as Record<string, unknown>;

  // {name, params} / {tool, arguments} / {function:{name,arguments}}
  if (typeof obj.name === "string") {
    const params =
      obj.params && typeof obj.params === "object"
        ? (obj.params as Record<string, unknown>)
        : obj.arguments && typeof obj.arguments === "object"
          ? (obj.arguments as Record<string, unknown>)
          : typeof obj.arguments === "string"
            ? (JSON.parse(obj.arguments) as Record<string, unknown>)
            : {};
    return { name: obj.name, params: coerceParams(params) };
  }
  if (obj.function && typeof obj.function === "object") {
    const fn = obj.function as Record<string, unknown>;
    const name = String(fn.name ?? "");
    let params: Record<string, unknown> = {};
    if (typeof fn.arguments === "string") {
      try {
        params = JSON.parse(fn.arguments) as Record<string, unknown>;
      } catch {
        params = {};
      }
    } else if (fn.arguments && typeof fn.arguments === "object") {
      params = fn.arguments as Record<string, unknown>;
    }
    if (!name) throw new Error(`action[${i}] 缺少 function.name`);
    return { name, params: coerceParams(params) };
  }

  const entries = Object.entries(obj).filter(([k]) => k !== "thinking" && k !== "memory");
  if (entries.length === 0) {
    throw new Error(`action[${i}] 空对象`);
  }
  // 优先取唯一动作键；若多键且含 index/text 等，可能是扁平参数（少见）
  if (entries.length === 1) {
    const [name, params] = entries[0]!;
    return {
      name,
      params:
        params && typeof params === "object"
          ? coerceParams(params as Record<string, unknown>)
          : params == null
            ? {}
            : { value: params },
    };
  }

  // {"action":"navigate","url":"..."} 扁平写法
  if (typeof obj.action === "string") {
    const name = obj.action;
    const params = { ...obj };
    delete params.action;
    return { name, params: coerceParams(params) };
  }

  throw new Error(`action[${i}] 无法识别：${JSON.stringify(obj).slice(0, 200)}`);
}

function coerceParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  for (const key of ["index", "seconds", "pages", "max_results", "xPercent", "yPercent", "coordinate_x", "coordinate_y"]) {
    if (typeof out[key] === "string" && out[key] !== "" && !Number.isNaN(Number(out[key]))) {
      out[key] = Number(out[key]);
    }
  }
  return out;
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("无法从模型输出中解析 JSON 对象");
  const body = stripFencedJson(trimmed);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("无法从模型输出中解析 JSON 对象");
  }
  return JSON.parse(body.slice(start, end + 1)) as unknown;
}

/** 从 OpenAI tool_calls 转为 AgentOutput */
export function agentOutputFromToolCalls(
  toolCalls: Array<{ function?: { name?: string; arguments?: string } }>,
  content?: string | null,
): AgentOutput {
  if (!toolCalls.length) {
    throw new Error("tool_calls 为空");
  }
  const action = toolCalls.map((tc, i) => {
    const name = tc.function?.name?.trim();
    if (!name) throw new Error(`tool_calls[${i}] 缺少 name`);
    let params: Record<string, unknown> = {};
    const rawArgs = tc.function?.arguments ?? "{}";
    try {
      params = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      params = {};
    }
    return { name, params: coerceParams(params) };
  });
  return {
    thinking: content?.trim() || undefined,
    memory: content?.trim()?.slice(0, 300) || undefined,
    next_goal: action[0] ? `执行 ${action.map((a) => a.name).join(" → ")}` : undefined,
    evaluation_previous_goal: "继续推进任务",
    action,
  };
}

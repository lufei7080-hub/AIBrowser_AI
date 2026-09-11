/**
 * 将 BU registry 动作暴露为 OpenAI function tools。
 * 旧天枢台靠 tool_choice:required 才能稳定驱动模型；纯 JSON AgentOutput 对多数国产模型过脆。
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions.mjs";
import { listRegisteredActions } from "./registry.js";

const PARAMS: Record<string, ChatCompletionTool["function"]["parameters"]> = {
  search: {
    type: "object",
    properties: {
      query: { type: "string" },
      engine: { type: "string", description: "google|bing|duckduckgo" },
    },
    required: ["query"],
  },
  navigate: {
    type: "object",
    properties: {
      url: { type: "string" },
      new_tab: { type: "boolean" },
    },
    required: ["url"],
  },
  go_back: { type: "object", properties: {} },
  wait: {
    type: "object",
    properties: { seconds: { type: "number" } },
  },
  click: {
    type: "object",
    properties: {
      index: { type: "number", description: "browser_state 中的 [index]" },
      coordinate_x: { type: "number" },
      coordinate_y: { type: "number" },
    },
  },
  input: {
    type: "object",
    properties: {
      index: { type: "number" },
      text: { type: "string" },
      clear: { type: "boolean" },
    },
    required: ["index", "text"],
  },
  scroll: {
    type: "object",
    properties: {
      down: { type: "boolean" },
      pages: { type: "number" },
      index: { type: "number" },
    },
  },
  send_keys: {
    type: "object",
    properties: { keys: { type: "string" } },
    required: ["keys"],
  },
  find_text: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  switch: {
    type: "object",
    properties: { tab_id: { type: "string" } },
    required: ["tab_id"],
  },
  close: {
    type: "object",
    properties: { tab_id: { type: "string" } },
    required: ["tab_id"],
  },
  extract: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  search_page: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      regex: { type: "boolean" },
      max_results: { type: "number" },
    },
    required: ["pattern"],
  },
  find_elements: {
    type: "object",
    properties: {
      selector: { type: "string" },
      max_results: { type: "number" },
    },
    required: ["selector"],
  },
  dropdown_options: {
    type: "object",
    properties: { index: { type: "number" } },
    required: ["index"],
  },
  select_dropdown: {
    type: "object",
    properties: { index: { type: "number" }, text: { type: "string" } },
    required: ["index", "text"],
  },
  screenshot: {
    type: "object",
    properties: { file_name: { type: "string" } },
  },
  write_file: {
    type: "object",
    properties: {
      file_name: { type: "string" },
      content: { type: "string" },
      append: { type: "boolean" },
    },
    required: ["file_name", "content"],
  },
  replace_file: {
    type: "object",
    properties: {
      file_name: { type: "string" },
      old_str: { type: "string" },
      new_str: { type: "string" },
    },
    required: ["file_name", "old_str", "new_str"],
  },
  read_file: {
    type: "object",
    properties: { file_name: { type: "string" } },
    required: ["file_name"],
  },
  evaluate: {
    type: "object",
    properties: { code: { type: "string" } },
    required: ["code"],
  },
  upload_file: {
    type: "object",
    properties: { index: { type: "number" }, path: { type: "string" } },
    required: ["index", "path"],
  },
  save_as_pdf: {
    type: "object",
    properties: { file_name: { type: "string" } },
  },
  done: {
    type: "object",
    properties: {
      text: { type: "string" },
      success: { type: "boolean" },
    },
    required: ["text"],
  },
  scrape_page_data: {
    type: "object",
    properties: {
      targetDescription: { type: "string" },
      autoScroll: { type: "boolean" },
    },
  },
  ask_user: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  },
  handover_to_human: {
    type: "object",
    properties: { reason: { type: "string" } },
    required: ["reason"],
  },
  ask_vision_locate: {
    type: "object",
    properties: {
      query: { type: "string" },
      click: { type: "boolean" },
    },
    required: ["query"],
  },
  click_viewport: {
    type: "object",
    properties: {
      xPercent: { type: "number" },
      yPercent: { type: "number" },
    },
    required: ["xPercent", "yPercent"],
  },
  list_skills: { type: "object", properties: {} },
  recall_skill: {
    type: "object",
    properties: {
      skill_id: {
        type: "string",
        description: "本地技能 id，如 form-filling / auth-hitl",
      },
    },
    required: ["skill_id"],
  },
  detect_page_blockers: { type: "object", properties: {} },
  solve_captcha: {
    type: "object",
    properties: {
      strategy: {
        type: "string",
        description:
          "可选强制策略：gif_animated_dwell | slider_gap_drag | math_image_solve | point_select_click",
      },
      auto_fill: {
        type: "boolean",
        description: "GIF/算式：默认 true，求解后立即填",
      },
      auto_submit: {
        type: "boolean",
        description: "GIF/算式：默认 true，填后立即点提交/验证答案",
      },
      page_hint: { type: "string", description: "页面说明摘要" },
    },
  },
  solve_animated_captcha: {
    type: "object",
    properties: {
      strategy: {
        type: "string",
        description: "可选强制策略；兼容别名，推荐改用 solve_captcha",
      },
      auto_fill: { type: "boolean", description: "默认 true，本工具内立即填" },
      auto_submit: { type: "boolean", description: "默认 true，本工具内立即提交" },
      page_hint: { type: "string", description: "页面说明摘要" },
    },
  },
  solve_slider_captcha: {
    type: "object",
    properties: {
      page_hint: { type: "string", description: "页面说明摘要" },
    },
  },
  solve_math_captcha: {
    type: "object",
    properties: {
      auto_fill: { type: "boolean", description: "默认 true" },
      auto_submit: { type: "boolean", description: "默认 true，点「验证答案」" },
      page_hint: { type: "string", description: "页面说明摘要" },
    },
  },
  solve_point_select_captcha: {
    type: "object",
    properties: {
      page_hint: { type: "string", description: "页面说明摘要" },
    },
  },
};

const DESC: Record<string, string> = {
  search: "打开搜索引擎并搜索",
  navigate: "打开 URL",
  go_back: "浏览器后退",
  wait: "等待秒数",
  click: "按 browser_state 的 index 点击（或坐标）",
  input: "按 index 向输入框填入文本",
  scroll: "滚动页面",
  send_keys: "发送键盘按键",
  find_text: "滚动直到找到文本",
  switch: "切换标签页",
  close: "关闭标签页",
  extract: "用二次 LLM 提取页面信息",
  search_page: "页内文本搜索（零成本）",
  find_elements: "CSS 查询元素",
  dropdown_options: "列出下拉选项",
  select_dropdown: "选择下拉项",
  screenshot: "截图（下一轮视觉或存盘）",
  write_file: "写工作区文件",
  replace_file: "替换文件片段",
  read_file: "读工作区文件",
  evaluate: "执行页内 JS（禁止指纹 API）",
  upload_file: "上传文件",
  save_as_pdf: "保存 PDF",
  done: "结束任务并交付结果（须为该步唯一动作）",
  scrape_page_data: "天枢台混合爬虫",
  ask_user: "向用户提问并等待",
  handover_to_human: "人工接管",
  ask_vision_locate: "视觉定位：先描述再给坐标（语言球/图标救赎）",
  click_viewport: "按视口百分比点击",
  list_skills: "列出本地 Agent Skills 目录",
  recall_skill: "按 skill_id 召回 SKILL.md 全文到 read_state",
  detect_page_blockers: "按需检测验证码/登录墙/Cookie/风控（禁每步例行）",
  solve_captcha:
    "独占本轮：自动分发 GIF/滑块/算式/点选；失败勿换同策略别名空转；未支持类型报错勿死磕",
  solve_animated_captcha:
    "solve_captcha 兼容别名（与分发后同路径，勿在失败后改用本别名顶次数）",
  solve_slider_captcha:
    "独占本轮：强制滑块缺口（与 solve_captcha 分发后同路径）",
  solve_math_captcha:
    "独占本轮：强制算式图（与 solve_captcha 分发后同路径；失败勿用本别名顶次数）",
  solve_point_select_captcha:
    "独占本轮：强制点选（裁剪验证区→JSON坐标→拟人贝塞尔点击）",
};

const CORE_TOOL_NAMES = [
  "search",
  "navigate",
  "go_back",
  "wait",
  "click",
  "input",
  "scroll",
  "send_keys",
  "done",
  "search_page",
  "extract",
  "screenshot",
  "ask_user",
  "handover_to_human",
] as const;

export function buildRegistryOpenAiTools(mode: "full" | "core" = "full"): ChatCompletionTool[] {
  const names =
    mode === "core"
      ? CORE_TOOL_NAMES.filter((name) => listRegisteredActions().includes(name))
      : listRegisteredActions();
  return names.map((name) => ({
    type: "function" as const,
    function: {
      name,
      description: DESC[name] ?? name,
      parameters: PARAMS[name] ?? { type: "object", properties: {} },
    },
  }));
}

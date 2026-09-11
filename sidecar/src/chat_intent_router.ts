import type { ChatCompletionTool } from "openai/resources/chat/completions.mjs";

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** 参考生产实践：互斥意图 + other 兜底（Vellum / DEV intent-as-tool 模式） */
export type ChatIntent =
  | "general_chat"
  | "advice"
  | "browser_navigate"
  | "browser_inspect"
  | "form_assist";

export interface ChatIntentResult {
  intent: ChatIntent;
  confidence: number;
  reason: string;
}

const ALL_TOOL_NAMES = [
  "get_current_url",
  "get_interactive_elements",
  "get_page_form_schema",
  "navigate_to_url",
] as const;

function lastAssistantMessage(history?: ChatHistoryMessage[]): string | null {
  if (!history?.length) {
    return null;
  }
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index]!;
    if (item.role === "assistant" && item.content.trim()) {
      return item.content.trim();
    }
  }
  return null;
}

export function isAffirmativeReply(message: string): boolean {
  return /^(是的|是|好(的|吧)?|可以|行|嗯+|对|要|OK|ok|yes|y)[。.!？?~]*$/i.test(message.trim());
}

export function isCloseTabCommand(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(close tab|close page)$/i.test(trimmed)) {
    return true;
  }
  return /^(?:关闭|关掉)(?:当前|这个)?(?:标签页?|页面|网页)/i.test(trimmed);
}

export function isStartBrowserCommand(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }
  if (hasExplicitBrowserNavigateIntent(trimmed)) {
    return false;
  }
  if (/^(?:启动|开启|运行|打开)(?:浏览器|环境|窗口)?[。.!？?~]*$/i.test(trimmed)) {
    return true;
  }
  return /^(?:启动|开启|运行)环境\s*#?\d+/i.test(trimmed);
}

export function isStopBrowserCommand(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed || isCloseTabCommand(trimmed)) {
    return false;
  }
  return /^(?:停止|关闭|退出|关掉|结束)(?:浏览器|环境|窗口)?[。.!？?~]*$/i.test(trimmed);
}

export function hasExplicitBrowserNavigateIntent(message: string): boolean {
  const trimmed = message.trim().replace(/[。.!！？?~～]+$/g, "");
  if (!trimmed || trimmed === "打开" || trimmed === "访问") {
    return false;
  }
  if (/^(打开|开启)(浏览器|环境|窗口)$/i.test(trimmed)) {
    return false;
  }
  // 允许「打开百度」「打开 https://…」「打开：淘宝」——分隔符可选
  if (/^(打开|访问|去(?:一下)?|navigate|open|visit)\s*\S+/i.test(trimmed)) {
    return true;
  }
  if (/^直接搜索\s*[：:\s]*/i.test(trimmed)) {
    return true;
  }
  if (/^搜(?:索|一下)\s*[「"'：:\s]?\S+/i.test(trimmed)) {
    return true;
  }
  return /^(打开|访问)(谷歌|google|百度|baidu|必应|bing|youtube)/i.test(trimmed);
}

export function isCurrentUrlQuestion(message: string): boolean {
  return /^(当前网址|当前链接|现在(?:的)?网址|页面网址|get_current_url|current url)/i.test(message.trim());
}

export function isFormAssistQuestion(message: string): boolean {
  const trimmed = message.trim();
  return /填表|表单|字段映射|键值对|结账|信用卡|cvv|风控|hidden|token|模板|json.*填|生成.*json/i.test(trimmed);
}

export function isBrowserInspectQuestion(message: string): boolean {
  const trimmed = message.trim();
  if (isCurrentUrlQuestion(trimmed) || isFormAssistQuestion(trimmed)) {
    return true;
  }
  return /当前页面|页面结构|交互元素|扫描页面|分析页面|什么网站|在哪个网站/i.test(trimmed);
}

export function isAdviceQuestion(message: string): boolean {
  const trimmed = message.trim();
  if (hasExplicitBrowserNavigateIntent(trimmed) || isBrowserInspectQuestion(trimmed)) {
    return false;
  }
  return /建议|推荐|怎么选|如何选择|对比|好不好|靠谱吗|有什么注意|最佳实践/i.test(trimmed);
}

export function isGeneralKnowledgeQuestion(message: string): boolean {
  const trimmed = message.trim();
  if (
    hasExplicitBrowserNavigateIntent(trimmed) ||
    isBrowserInspectQuestion(trimmed) ||
    isAdviceQuestion(trimmed)
  ) {
    return false;
  }
  if (/^(输出|导出|显示|元素提取|当前网址|当前页面|填表|表单|打开|访问|直接搜索|搜索)/i.test(trimmed)) {
    return false;
  }
  if (isAffirmativeReply(trimmed)) {
    return false;
  }
  return /是什么|什么是|为什么|怎么回事|什么意思|如何|怎么|怎样|介绍|解释|区别|吗[？?]?$|呢[？?]?$|你好|hello|hi/i.test(
    trimmed,
  );
}

/**
 * 级联意图路由（参考 Semantic Router + 规则兜底）：
 * 1. 显式浏览器动作优先
 * 2. 页面/填表次之
 * 3. 建议类
 * 4. 常识闲聊
 */
export function classifyChatIntent(
  message: string,
  history?: ChatHistoryMessage[],
): ChatIntentResult {
  const trimmed = message.trim();
  if (!trimmed) {
    return { intent: "general_chat", confidence: 0.5, reason: "empty" };
  }

  if (hasExplicitBrowserNavigateIntent(trimmed)) {
    return { intent: "browser_navigate", confidence: 0.95, reason: "explicit_navigate_verb" };
  }

  if (isFormAssistQuestion(trimmed)) {
    return { intent: "form_assist", confidence: 0.9, reason: "form_keywords" };
  }

  if (isBrowserInspectQuestion(trimmed)) {
    return { intent: "browser_inspect", confidence: 0.88, reason: "inspect_keywords" };
  }

  if (isAdviceQuestion(trimmed)) {
    return { intent: "advice", confidence: 0.82, reason: "advice_keywords" };
  }

  if (isAffirmativeReply(trimmed)) {
    const last = lastAssistantMessage(history);
    if (last && /(?:打开|访问|搜索|搜一下|navigate|元素提取|当前页面)/i.test(last)) {
      return { intent: "browser_navigate", confidence: 0.75, reason: "affirmative_after_browser_offer" };
    }
    return { intent: "general_chat", confidence: 0.7, reason: "affirmative_continue_chat" };
  }

  if (isGeneralKnowledgeQuestion(trimmed)) {
    return { intent: "general_chat", confidence: 0.85, reason: "knowledge_question" };
  }

  if (/打开|访问|网址|url|页面|填表|搜索/i.test(trimmed)) {
    return { intent: "browser_inspect", confidence: 0.55, reason: "weak_browser_signal" };
  }

  return { intent: "general_chat", confidence: 0.6, reason: "default_chat" };
}

export function intentToolChoice(intent: ChatIntent): "none" | "auto" {
  if (intent === "general_chat" || intent === "advice") {
    return "none";
  }
  return "auto";
}

export function intentTemperature(intent: ChatIntent): number {
  if (intent === "general_chat" || intent === "advice") {
    return 0.55;
  }
  if (intent === "form_assist") {
    return 0.25;
  }
  return 0.35;
}

export function filterToolsForIntent(
  tools: ChatCompletionTool[],
  intent: ChatIntent,
): ChatCompletionTool[] {
  const allow = new Set<string>();
  switch (intent) {
    case "browser_navigate":
      allow.add("navigate_to_url");
      break;
    case "browser_inspect":
      allow.add("get_current_url");
      allow.add("get_interactive_elements");
      allow.add("get_page_form_schema");
      break;
    case "form_assist":
      for (const name of ALL_TOOL_NAMES) {
        if (name !== "navigate_to_url") {
          allow.add(name);
        }
      }
      break;
    default:
      return [];
  }
  return tools.filter((tool) => {
    if (tool.type !== "function") {
      return false;
    }
    return allow.has(tool.function.name);
  });
}

export function buildIntentHint(intent: ChatIntentResult): string {
  const lines: Record<ChatIntent, string> = {
    general_chat: "【本轮意图】常识/闲聊 — 直接用中文回答，禁止调用任何工具。",
    advice: "【本轮意图】咨询建议 — 先给清晰建议与步骤；除非用户明确要求扫描页面，否则禁止调用工具。",
    browser_navigate: "【本轮意图】浏览器导航 — 必须调用 navigate_to_url 实际打开/搜索，禁止只口头答应。",
    browser_inspect: "【本轮意图】页面读取 — 必须调用 get_current_url 或 get_interactive_elements 获取真实数据后再答。",
    form_assist: "【本轮意图】填表辅助 — 必须先 get_interactive_elements（优先）扫描页面，再生成 JSON 键值对；禁止编造字段。",
  };
  return `${lines[intent.intent]}\n（判定：${intent.reason}，置信 ${Math.round(intent.confidence * 100)}%）`;
}

export const CHAT_ROUTING_FEW_SHOT = [
  "【路由示例 — 模仿此边界】",
  "用户: React 是什么 → 直接解释，不调工具",
  "用户: SEO 和 SEM 区别 → 直接对比解释，不调工具",
  "用户: 填表有什么建议 → 文字给建议；若需字段清单再问是否扫描页面",
  "用户: 打开百度 → navigate_to_url(target=百度, mode=auto)",
  "用户: 搜索 CloakBrowser 文档 → navigate_to_url(mode=search)",
  "用户: 当前网址 → get_current_url",
  "用户: 生成填表 JSON 模板 → get_interactive_elements 后输出 key 与页面一致的 JSON",
].join("\n");

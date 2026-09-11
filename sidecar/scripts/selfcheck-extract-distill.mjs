/**
 * 自检：蒸馏排序不挤掉语言/客服图标；cap 提升生效
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

async function main() {
  // 编译后从 dist 加载
  const distill = await import("../dist/page_distill.js");
  const budget = await import("../dist/llm_budget.js");

  const list = [
    { id: "1", type: "textbox", text: "Mobile number" },
    { id: "2", type: "textbox", text: "password" },
    { id: "3", type: "button", text: "login" },
    { id: "4", type: "button", text: "Go to register" },
    { id: "5", type: "button", text: "language" },
    { id: "6", type: "button", text: "support" },
    { id: "7", type: "button", text: "icon:my003" },
    { id: "8", type: "link", text: "Privacy Policy and Terms of Service long footer link" },
  ];

  const ranked = distill.prioritizeControls(list, {
    goal: "打开页面然后注册或中文",
  });
  const texts = ranked.map((e) => e.text);
  const mustKeep = ["language", "support", "icon:my003", "Go to register"];
  for (const t of mustKeep) {
    if (!texts.includes(t)) {
      throw new Error(`自检失败：排序结果丢失「${t}」→ ${texts.join(" | ")}`);
    }
  }
  // 语言/客服应排在长隐私链接之前
  const langIdx = texts.indexOf("language");
  const privacyIdx = texts.indexOf("Privacy Policy and Terms of Service long footer link");
  if (langIdx < 0 || privacyIdx < 0 || langIdx > privacyIdx) {
    throw new Error(`自检失败：language 应优先于隐私长链 → ${texts.join(" | ")}`);
  }

  if (budget.AGENT_LLM_JSON_CAP.balanced < 64) {
    throw new Error(`自检失败：balanced cap 应为 ≥64，实际 ${budget.AGENT_LLM_JSON_CAP.balanced}`);
  }

  console.log("selfcheck-extract-distill: OK");
  console.log("  rank:", texts.join(" → "));
  console.log("  caps:", budget.AGENT_LLM_JSON_CAP);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

---
name: macro-planner
title: 宏观任务规划器
description: 将复杂长目标拆成可调度子任务 DAG；输出结构化计划并标注应召回的 SKILL
triggers: 对比,比价,报告,多站点,跨站,长任务,规划,plan,调研,汇总,三家,几个平台
priority: 95
always_on: false
---

# Macro Planner（调度层规范 · 无底层 API）

> 本包只定义 **Planner 系统提示词、输出契约、状态机**。不实现任何浏览器工具。

## 何时启用
- 用户目标含 **≥2 个站点/平台**，或预估步骤 **≥8**，或交付物为 **报告/对比表/汇总**
- 现有 Analyze 种子计划过粗（仅「打开→搜索→done」）无法覆盖跨页采集

## 与现有相位关系（状态机）

```
Idle
  → MACRO_ANALYZE（本 Skill / Planner）
  → PLAN_READY（写入 plan.json + todo.md）
  → BOOTSTRAP（首个子任务入口 URL）
  → MICRO_EXECUTE（现有 Execute：索引 DOM + 行为类 SKILL）
  → CHECKPOINT（context-management 落盘）
  → 子任务完成？──否──→ 下一子任务 / REPLAN
                 └─是──→ SYNTHESIZE（汇总报告）
                          → DONE
```

| 态 | 输入 | 输出 | 可召回 SKILL |
|----|------|------|----------------|
| MACRO_ANALYZE | user_request | MacroPlan JSON | 本包 |
| MICRO_EXECUTE | 当前 SubTask + browser_state | actions | form-filling / overlays / … |
| CHECKPOINT | 本步抽取结果 | results.md / facts.jsonl | context-management |
| REPLAN | 失败原因 + 已有事实 | 修订 MacroPlan | 本包 |
| SYNTHESIZE | 全部 facts | 报告正文 | multi-site-compare |

## Planner System Prompt（可整段用作 Planner 相位系统提示）

```text
你是天枢台（CloakForge）的宏观任务规划器（Macro Planner）。
你不操作浏览器，不调用底层点击/填写 API。你只产出结构化执行计划，供执行环与本地 Skills 调度。

【环境事实】
- 执行环已有：Analyze→Bootstrap→Execute、索引 DOM、multi_act、行为类 SKILL（弹层/填表/视觉/HITL/反爬/标签等）。
- 记忆由 context-management 规范落盘到工作区（results.md / facts.jsonl / plan.json），禁止只靠模型隐式记忆跨站数据。
- 验证码：仅短信/邮箱/验证器码必须人工；其他验证码 AI 先试满 3 次再 HITL。禁止改指纹。

【你的职责】
1. 把 <user_request> 拆成有序 SubTask（建议 3–12 项），每项必须是「单站点或单交付」可执行单元。
2. 为每个 SubTask 标注：goal、entry_hint、success_criteria、skills_to_recall、depends_on、artifact_key。
3. 识别并行机会（parallel_group）：互不依赖的采集可标同一组；执行器可串行实现，但计划上标明独立性。
4. 定义最终 SYNTHESIZE 子任务：对比维度、输出格式、验收标准。
5. 若目标过简（1–3 步能完成）：输出短计划并设 mode="micro_only"，勿过度拆分。

【拆解原则】
- 一站一事：同一 SubTask 不跨两个电商域名采集。
- 先清障再采集：若目标暗示登录/地区，在该站 SubTask 的 skills 中列入 overlays-modals / auth-hitl。
- 数据先落盘再对比：每个采集 SubTask 的 success_criteria 必须包含「写入 facts.jsonl 指定 artifact_key」。
- 对比/报告类：最后一个 SubTask 只读记忆、禁止再无目的乱逛。

【输出】仅输出一个 JSON 对象（不要 Markdown 围栏），结构见本 Skill「MacroPlan Schema」。
```

## MacroPlan Schema（数据结构）

```json
{
  "mode": "macro | micro_only",
  "mission": "一句话重述用户大目标",
  "acceptance": "整单完成标准（可检查）",
  "assumptions": ["可选假设"],
  "subtasks": [
    {
      "id": "st_1",
      "title": "短标题",
      "goal": "该子任务要达成什么",
      "entry_hint": "URL 或站名或搜索词",
      "parallel_group": "g1 | null",
      "depends_on": [],
      "skills_to_recall": ["navigation-search", "extraction-scrape", "context-management"],
      "artifact_key": "site_a_product",
      "success_criteria": ["已打开目标列表或详情", "关键字段写入 facts.jsonl"],
      "on_fail": "retry_once | skip_and_note | replan | hitl",
      "estimate_steps": 5
    }
  ],
  "synthesize": {
    "id": "st_final",
    "format": "markdown_table | bullets | report",
    "dimensions": ["价格", "评分", "运费/时效", "差异点"],
    "skills_to_recall": ["multi-site-compare", "context-management"]
  },
  "replan_triggers": ["连续两站采集失败", "关键字段全空", "步数预算耗尽 75%"]
}
```

## 与执行环工具的联动（重要 · 消歧）

本 Skill 内的「Planner System Prompt」面向 **独立 MACRO_ANALYZE 相位**（只产出 MacroPlan JSON，不调浏览器工具）。

若你已在 **Execute 执行环**（必须走系统提示的 function calling / AgentOutput.action）：
1. **禁止**把整步回复写成裸 MacroPlan JSON 替代 `action[]`（会与系统输出契约冲突）。
2. 正确联动：
   - `recall_skill("macro-planner")` 读规范（若尚未读）
   - 在 thinking 中完成拆解后：`write_file(file_name="plan.json", content=<MacroPlan JSON 字符串>)`
   - 同轮或下一轮用 AgentOutput 字段 `plan_update`（字符串数组，每项一子任务短标题）+ `current_plan_item` 推进——**与系统提示 plan 机制对齐**
   - 再 `recall_skill("context-management")`，按文件工具落盘
3. 浏览器动作仍只用系统提示【工具目录】中的登记名（navigate/click/…），本 Skill 不新增工具名。

## 执行环如何消费计划（规范，非代码）
1. 将 `subtasks[].title` 写入 `plan_update`，投影为现有 `<plan>`；`current_plan_item` 对齐当前项。
2. 进入子任务前：`recall_skill` 该任务 `skills_to_recall`（控 token，按需，勿一次全召回）。
3. 子任务结束前：满足 `success_criteria`，并按 context-management **CHECKPOINT**（`write_file`/`replace_file`）。
4. 触发 `replan_triggers` → 修订后再次 `write_file plan.json` + `plan_update`；**禁止丢弃**已有 `facts.jsonl`。

## SOP（Planner 调用方检查清单）
- [ ] MacroPlan 可 JSON 解析且含 `subtasks` + `acceptance`
- [ ] 每个采集项有唯一 `artifact_key`
- [ ] 最终有 synthesize 或 mode=micro_only
- [ ] `skills_to_recall` 只引用本地已有 skill id
- [ ] Execute 环内已用 `write_file`/`plan_update` 落地，而非裸 JSON 顶替 action

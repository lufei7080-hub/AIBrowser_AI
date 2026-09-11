---
name: tabs-windows
title: 多标签管理
description: new_tab、switch、close；研究任务与外链的标签策略
triggers: 标签,tab,新窗口,new_tab,switch,close,外链
priority: 55
always_on: false
---

# 多标签

## 规则
- `navigate(url, new_tab=true)` 开新标签；活动页会切换
- `switch(tab_id)` / `close(tab_id)`：tab_id 来自 Open Tabs（如 0001）
- 不能关闭最后一个标签
- switch/close/navigate 会 terminates_sequence

## 策略
- 研究/比价：详情页 new_tab，保留 SERP
- 外链广告谨慎；优先同站
- 任务结束前可 close 无关标签，但非必须

---
name: animated-captcha-dwell
title: GIF 动图验证码
description: 仅 GIF；类型门禁→GDI全帧拆解→选最清晰读码→填交；非GIF报错
triggers: 验证码,captcha,动图,gif,停留最长,迷雾,match2025,猿人学,yuanrenxue
priority: 93
always_on: false
---

# GIF 动图 / 迷雾 / 停留最长

## 何时用

仅当页面验证码是 **GIF 动图**（题面常写「停留时间最长」「迷雾」）时：

本轮唯一动作：`{"solve_captcha": {}}`

（别名 `solve_animated_captcha` 同路径；失败后勿换别名顶次数。）

## 工具行为

1. 类型门禁：非已注册策略 / 非 GIF 魔数 → `unsupported`，**勿重试本工具**
2. 拉取 GIF → Windows System.Drawing 全帧拆 PNG → **×4 JPEG**
3. **并发 4 读码 → 入内存 → 按清晰度择优**：位数不定；每帧结束后销毁该帧 JPEG/PNG 并释放池槽；取最高清晰度填交

## 禁止

- 刷新页面 / 点击验证码图换新码
- 对滑块/算式/点选题死磕本策略（应继续用 `solve_captcha` 自动分发）
- 失败后换别名空转同一路径

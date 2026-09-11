---
name: auth-hitl
title: 登录认证与验证码
description: 仅短信/邮箱/验证器码必须人工；其他验证码 AI 先试满 3 次再 HITL
triggers: 登录,login,sign in,验证码,captcha,otp,2fa,密码,支付,payment,handover,接管,滑块,turnstile,短信,邮箱,authenticator
priority: 90
always_on: false
---

# 登录 / 验证码 / HITL

## 铁律（两类验证码）

### B. 必须 100% 人工确认（不可跳过）
**仅限**：短信验证码、邮箱验证码、验证器（Authenticator / TOTP）动态码。
1. 可先 `click`「发送验证码 / 获取验证码 / 发送邮件」
2. **必须** `ask_user`（或系统人工确认）拿到码值 —— 禁止 AI 猜测/编造
3. 再用 `input` 填入对应 index

### A. 其他验证码（默认 AI 过）
适用：图形 CAPTCHA、滑块、点选顺序、拼图、Turnstile、算术图、图片选字等一切**非**短信/邮箱/验证器码。

- **GIF / 迷雾 / 停留最长**：优先 `solve_animated_captcha`（仅 GIF；非 GIF 会报错勿重试）。细则见 `animated-captcha-dwell`。
- 其它未封装类型：
  1. `screenshot` / 视觉分析
  2. `ask_vision_locate` / `click_viewport` / `click` / `wait` / `input`
  3. memory 记 `captcha_attempt=N`；**未满 3 次禁止** `ask_user` / `handover_to_human`
  4. **第 3 次仍失败** → 再 `ask_user` 或 `handover_to_human`
  5. 禁止改指纹；无成功证据禁止 `done(success=true)`

### C. 仍禁止
- 把短信/邮箱/验证器码当成「可 AI 猜的图」
- 无证据声称已通过；改 navigator/WebGL 过检测

## 登录流
1. 登录墙可按需 `detect_page_blockers`
2. 账号密码：`input` → `click`
3. 缺账号密码凭证：`ask_user`
4. 遇验证码：短信/邮箱/验证器 → **B**；GIF 迷雾类 → `animated-captcha-dwell`；其它 → **A**

## 会话
- 已有 Cookie：先试主任务
- 不要为保登录注入 init script

## 支付表单
- 卡号/CVV/支付密码走确认框或 ask_user（与「三类动态验证码」规则独立）；复杂收银台可 handover

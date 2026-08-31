---
name: prototype-llm
description: LLM 可行性判断（L3）：复杂块先经 LLM（只读）判「可行/不可行」，不可行→preflight-failed，报错 fail-safe PASS。确保无白窗浪费——复杂块不开出空白窗。Use when a deterministically-complex block needs an LLM feasibility check.
---
# Prototype Gate (LLM) — 确保无白窗浪费
- 职责：`prototype-gate` 判定为「复杂」的块，再请 LLM（只读）判「该任务是否可行、不矛盾」，只回「可行/不可行」。
- 触发：复杂块（恒启用，无法被关闭）。
- 恒启用：本能力没有用户可关闭的开关，始终生效。它就是用来**确保无白窗浪费**：复杂块先做可行性判断，避免开出空白/注定失败的窗。
- LLM 报错/超时→ fail-safe PASS（不误拦，宁可多测也不白开窗）。

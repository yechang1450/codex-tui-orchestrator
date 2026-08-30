---
name: prototype-llm
description: LLM 可行性判断（L3，开销较大）：复杂块请求 LLM 判「可行/不可行」，不可行→preflight-failed；报错 fail-safe PASS。用户可关掉本 skill 以跳过 LLM 原型测试。Use when a deterministically-complex block needs an LLM feasibility check.
---
# Prototype Gate (LLM) — the toggleable one
- 职责：`prototype-gate` 判定为「复杂」的块，再请 LLM（只读）判「该任务是否可行、不矛盾」，只回「可行/不可行」。
- 触发：复杂块 + `ORCH_PROTOTYPE_LLM=1`。
- 运行时开关：`ORCH_PROTOTYPE_LLM=1|0`（默认 `1`）；effort 由 `ORCH_PROTOTYPE_EFFORT` 决定（默认 `high`）。
- **关闭本 skill**：agent 不会置 `ORCH_PROTOTYPE_LLM=1` → 引擎默认 `0` → 跳过 LLM 原型测试（省钱/省时，复杂块直接放行，风险=可能白开窗）。
- LLM 报错/超时→ fail-safe PASS（不误拦）。

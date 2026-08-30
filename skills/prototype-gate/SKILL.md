---
name: prototype-gate
description: 确定性可行性前置门禁：L1 空判 + L2 复杂度分类；简单块直接 PASS，不调 LLM。Use as the deterministic feasibility gate before spawning a block.
---
# Prototype Gate (deterministic)
- 职责：每个块 spawn 前做**确定性**可行性判断：L1 空/无动作→拒绝；L2 复杂度分类（多句/含分析/长指令→复杂）。
- 触发：`--run-windows` 每块 spawn 前。
- 运行时开关：`ORCH_PROTOTYPE=on|off`（默认 `on`）。
- 与 `prototype-llm`：本 skill 是**不花 LLM 的判断**；复杂块才交给 `prototype-llm`。
- 关闭=不做确定性预判（极端情况可能空转某窗，不建议关）。

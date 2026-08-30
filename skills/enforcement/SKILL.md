---
name: enforcement
description: 执行门禁：force.mjs --enable/--status/--assert + 未 armed 时按 kind fail-closed（真实 kind REFUSED）+ headless 硬关。Use to decide whether a real execution is sanctioned.
---
# Enforcement (gate)
- 职责：`armEnforcement()` 写 `temp/.orchestrator-enabled`；`--assert <kind>` 只在**被授权的窗口**（CODEX_ORCH_WINDOW=1）里放行；headless `--run/--exec` 需 `ORCH_ALLOW_HEADLESS=1`；`codex-tui-orchestrator-preflight.mjs` 未 armed 时按 kind fail-closed（真实 kinds REFUSED+exit1，只读放行）。
- 触发：每次真实执行发起前。
- 运行时开关：`ORCH_ALLOW_HEADLESS`（headless 逃生门）。
- 关闭=关闭门禁（真实执行可在非窗口态发生，违反 AGENTS）。

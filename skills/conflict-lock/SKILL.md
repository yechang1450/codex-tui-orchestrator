---
name: conflict-lock
description: 活窗间资源冲突检测：conflictKeys 重叠→等待→上锁→冲突释放自动重跑。Use when new blocks could collide with already-running windows.
---
# Conflict / Lock
- 职责：与**正在运行的窗**比对 conflictKeys；重叠→等待其关闭；仍冲突→上锁（`locked` 终态，不误窗）；冲突释放→自动重跑。
- 触发：`--run-windows` 每次 spawn 前，以及同批窗口之间。
- 运行时开关：`ORCH_CONFLICT=on|off`（默认 `on`）。
- 依赖：`registry`（读 windows/locks）。
- 关闭=不检测资源冲突（有并发撞车风险，不建议关）。

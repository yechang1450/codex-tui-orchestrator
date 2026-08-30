---
name: dependency-order
description: dependsOn 逻辑前置顺序：把块按依赖分层（wave），前置完成后才开后续；linked 链整块串行。Use when blocks declare dependsOn on each other.
---
# Dependency / Order
- 职责：解析 `dependsOn` 依赖→按层排队；linked 整块串行；independent 且无前置→同层并行。
- 触发：`--run-windows` decompose 之后、spawn 之前。
- 运行时开关：`ORCH_DEPENDS=on|off`（默认 `on`）。
- 边界：只处理**逻辑先后**（前置/产出依赖），**不等于**资源冲突（那是 `conflict-lock`）。
- 关闭=忽略 dependsOn（会把有先后依赖的任务并发跑，危险，不建议关）。

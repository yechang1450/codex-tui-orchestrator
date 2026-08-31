---
name: decompose-classify
description: 把原始请求按并发冲突拆成 linked/independent 块（含 conflictKeys/dependsOn），并做「只读→inline」预判，避免把纯分析弹窗。Use when the orchestrator needs to turn a multi-part request into blocks.
---
# Decompose / Classify
- 职责：请求 → `{blocks:[{type:linked|independent,title,dependsOn,conflictKeys,tasks}]}`；同时做「只读→inline」预判。
- 触发：任一 `--run-windows` 请求。
- 只读门禁：命中只读词（分析/方案/看看/说明/为什么/如何…）且无真实动作词（写/改/建/装/测/重启/删/还原/配置…）→ 输出 inline、**不弹窗、exit 0**。


- 恒启用：本能力没有用户可关闭的开关，始终生效（无需也不应关闭）。
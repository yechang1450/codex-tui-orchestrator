---
name: hygiene
description: 用完即弃：一次性产物（launcher/prompt/result/log/pid/win-summary）默认清理；ORCH_KEEP_TEMP=1 保留 win-summary 排查。Use to keep the workspace clean after a run.
---
# Hygiene (cleanup)
- 职责：清理 `temp/` 下 `codex-win-*`/`win-launch-*`/`win-*.result.json`/`win-*.log`/`window-*.pid` 等一次性产物（`win-summary.json` 默认保留给 poll）。
- 触发：`--run-windows` / `--spawn` 结束后。
- 运行时开关：`ORCH_KEEP_TEMP=1`（保留 win-summary 排查）。
- 关闭=不清临时（会积累垃圾，违反「清爽」）。

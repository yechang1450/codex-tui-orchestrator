---
name: window-runtime
description: 窗口生命周期：写 launcher/spawn/watchdog 自动关/closeWindow + 归约发现/task_complete/汇报捕获/win-summary。Use to manage a visible interactive Codex window's life and result capture.
---
# Window Runtime (launcher + capture)
- 职责：写 `win-launch-*.ps1`（UTF-8+BOM、chcp 65001）→ spawn 可见 TUI → watchdog 在「最终完成标记」后杀 codex 子进程→launcher `exit 0`→窗自动关；同时从 rollout 捕获最终汇报写入 `win-summary.json`。
- 触发：`--run-windows` / `--spawn`。
- **窗口 prompt 规则**：必须要求「一次性完成全部改动→读回+node --check+无乱码→才输出以【本块唯一标识】…完成 开头的最终汇报」，**禁止中途输出未完状态**（否则 auto-close 会误关）。


- 恒启用：本能力没有用户可关闭的开关，始终生效（无需也不应关闭）。
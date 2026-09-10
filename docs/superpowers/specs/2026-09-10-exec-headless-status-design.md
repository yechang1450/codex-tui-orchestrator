# Exec Headless 与双通道状态同步设计

## 目标

在 codex-tui-orchestrator 中把 `exec+headless`（无弹窗但仍执行真实 Codex 任务、写检查点并接受独立验收）设为默认执行模式，同时保留 `--run-windows` 作为显式可见 TUI 模式。两种模式必须共用拆块、容量、检查点、回执和恢复协议。

## 现状与约束

- `runner.mjs` 已持有任务 ledger、TodoList、块调度、检查点和恢复逻辑。
- `orchestrate-sdk.mjs` 已有可见 `--run-windows`，旧 `--run/--exec` headless 路径绕过了完整 runner，不能继续并行维护。
- TodoList 表达用户任务语义；窗口或 exec 进程是运行时载体，不能用窗口关闭或进程退出代替验收成功。
- 所有临时文件必须留在发起工作区的 `temp/orchestrator` 下；恢复必须 fail-closed，不能盲目重放不确定副作用。

## 设计

### 执行模式

`--exec` 和 `--headless` 使用 headless executor；`--run-windows` 和 `--visible` 使用 visible executor。未指定模式时按 `headless` 处理。`ORCH_EXEC_MODE=headless|visible` 作为环境覆盖，但显式 CLI 参数优先。

两种 executor 由 runner 通过同一接口调用：`prepare`、`start`、`wait`、`inspect`、`close`、`cleanup`。visible executor 保留 launcher/watchdog/PID 逻辑；headless executor 调用 Codex `exec`，持久化 PID、stdout/stderr、JSONL 事件和退出码。

### 状态模型

- `todoList`：T001 等原始任务的 pending/running/verified/failed/needs-reconciliation 状态。
- `blocks`：逻辑块及依赖状态。
- `executionStatus`：每个块的 mode、queued/reserved/launching/running/awaiting-verification/retrying/verified/failed 等运行时状态。
- `events.jsonl`：带单调 `seq` 的状态事件历史。

`summary.json` 与 `goal.json` 继续作为原子快照；每次状态变化同时追加事件。事件包含 `runId`、`block`、可选 `taskId`、`mode`、`attempt`、状态和时间戳。

### 实时查看

增加 `--status --run-id <id>` 的单次快照和 `--status --watch --run-id <id>` 的只读事件流。主控可据此同时展示 TodoList 与 execution/spawn 状态；TUI 窗只消费提示中的本块视图，不直接修改主控状态。

### 恢复与验收

headless 与 visible 都使用相同的 checkpoint 和 acceptance 规则。进程仍存活时接管等待；进程退出但无完整检查点时仅允许有限安全重试；已开始但结果不明时进入 `needs-reconciliation`；只有独立验收成功才进入 `verified`。

## 验收标准

1. 默认执行不创建窗口；显式 `--run-windows` 创建窗口。
2. 两种模式生成相同任务 ID、检查点和最终验收语义。
3. TodoList 与 executionStatus 在每个事件后保持一致。
4. `--resume-run` 能接管 headless 进程或 visible launcher，且不重复已验证副作用。
5. 离线回归、发布完整性和 doctor 全部通过；文档说明默认模式和显式可见模式。

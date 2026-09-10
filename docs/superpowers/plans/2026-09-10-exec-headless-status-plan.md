# Exec Headless 与双通道状态同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `exec+headless` 设为默认真实执行模式，保留可见 `--run-windows`，并让 TodoList 与块运行时状态实时同步。

**Architecture:** runner 保持唯一调度、检查点、恢复和验收内核；visible/headless 通过 executor hooks 注入。summary/goal 是原子快照，events.jsonl 是带序号的增量状态流。

**Tech Stack:** Node.js 22、Codex CLI `exec` JSONL、Windows PowerShell/Windows Terminal、Node test runner。

**Spec:** `docs/superpowers/specs/2026-09-10-exec-headless-status-design.md`

## Global Constraints

- 默认执行模式为 `headless`；`--run-windows` 显式选择可见 TUI。
- TodoList 只表达原始任务状态；executionStatus 表达块运行时状态。
- 状态写入必须原子化并位于发起工作区 `temp/orchestrator`。
- 没有独立验收的结果不能标记为 verified。
- 不得修改或删除活动窗口、活动进程或其他 run 的状态。

### Task 1: 模式解析与 executor 边界

**Files:**
- Modify: `scripts/core/orchestrate-sdk.mjs`
- Modify: `scripts/core/runner.mjs`
- Test: `test/execution-mode.test.mjs`

- [ ] 写失败测试：默认 headless、`--run-windows` visible、环境变量覆盖、显式参数优先。
- [ ] 运行该测试确认因缺少 mode parser/executor 选择而失败。
- [ ] 实现纯函数 mode parser，并让 `--exec`/`--headless` 进入统一 runner。
- [ ] 运行测试确认通过，并验证旧 visible 路径行为不变。

### Task 2: headless executor 与 durable attempt

**Files:**
- Create: `scripts/core/headless-executor.mjs`
- Modify: `scripts/core/orchestrate-sdk.mjs`
- Modify: `scripts/core/runner.mjs`
- Test: `test/headless-executor.test.mjs`

- [ ] 写 fake Codex exec 进程测试：记录 PID、stdout JSONL、退出码和 checkpoint。
- [ ] 运行测试确认 headless executor 尚不存在。
- [ ] 实现 `start/wait/inspect/close/cleanup`，不创建窗口，输出全部归 run attempt 目录。
- [ ] 将 executor 接入 runner，禁止旧 `Promise.all` headless 路径绕过 ledger。
- [ ] 运行 headless executor 与 runner 相关测试。

### Task 3: executionStatus 与事件流

**Files:**
- Modify: `scripts/core/runner.mjs`
- Modify: `scripts/core/contracts.mjs`
- Create: `scripts/core/status-events.mjs`
- Test: `test/status-events.test.mjs`

- [ ] 写失败测试：状态转换产生单调 seq；TodoList 与 executionStatus 同步；事件 JSONL 可增量读取。
- [ ] 实现原子快照加 append-only 事件写入。
- [ ] 在 reservation、launch、task checkpoint、verify、retry、failure、run completion 处发事件。
- [ ] 增加 `--status --watch` 只读输出。
- [ ] 运行状态流和恢复测试。

### Task 4: 恢复、回执与 live contract

**Files:**
- Modify: `scripts/core/runner.mjs`
- Modify: `scripts/core/recovery.mjs`
- Modify: `scripts/core/supervisor-core.mjs`
- Test: `test/recovery-runtime.test.mjs`
- Test: `test/supervisor.test.mjs`

- [ ] 写 headless 进程存活接管、流中断和无回执场景的失败测试。
- [ ] 让 resume 按 mode 接管进程/launcher，不重复 verified task。
- [ ] 让事件和快照在安全重试、needs-reconciliation、最终验收后保持一致。
- [ ] 运行恢复与 supervisor 回归。

### Task 5: 文档、manifest 与发布校验

**Files:**
- Modify: `README.md`
- Modify: `README-zh.md`
- Modify: `skills/codex-tui-orchestrator/SKILL.md`
- Modify: `docs/execution-contract.md`
- Modify: `docs/release-policy.md`
- Modify: `.codex-plugin/plugin.json`
- Modify: `release.json`
- Test: `test/documentation-consistency.test.mjs`

- [ ] 文档说明默认 headless、显式 visible、TodoList 与 executionStatus 的区别及 watch 命令。
- [ ] 更新插件 manifest 描述和封存 hash。
- [ ] 运行文档一致性、完整回归、release-integrity、doctor、只读 status。
- [ ] 运行一次 headless 与一次 visible 的真实验收；证据按结果如实记录。

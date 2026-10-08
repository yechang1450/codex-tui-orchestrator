---
name: codex-tui-orchestrator
description: Use when codex-tui-orchestrator (legacy codex-TUI-orchestrator) receives an authorized multi-part request needing conflict/dependency-based Codex execution with live task and block status with independent verification; 只读分析和修改编排器自身留在主对话。
---

# Codex TUI Orchestrator

本技能只接 Codex CLI；编排器自身的只读分析、设计和修改留在主对话。宿主信任 SessionStart hook 后会自动准备环境；未准备或缺少 Node/npm 时先运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<插件绝对路径>\scripts\bootstrap.ps1" -Action prepare`，补齐经校验的运行时、SDK 和 CLI，再执行任务。该参数仅作用于这个子进程，不修改系统或用户策略。不得修改宿主 hook 信任或制造登录凭据；详见[环境准备](../../docs/environment-setup.md)。

## 硬性执行契约

- 默认 `--exec`（headless）；只有用户需要观察或交互时才用 `--run-windows` / `--visible`。两种模式都继承发起窗口最近结构化 `turn_context` 的 model、thinking/reasoning level 和 service tier；缺字段时依次回退到原生 `CODEX_HOME/config.toml`、`ORCH_*`。不得递归编排、调用子代理或另开子窗口。
- 保留所有原始任务 ID 和原文。把任务拆到原子项，按依赖、父子路径锁、资源冲突和未知作用域归并为串行块；块间必须无依赖、无冲突、无未知风险。单块直接回到发起对话执行，多块才编排并发。
- 对没有项目编号的任务，只有在文件/目录提示逐项对应原始任务中明确写出的全部路径时，才把它们视为可分块资源；漏报、编造或作用域不明时整批串行。`--plan` 供主控核查，不能把模型推断当作绝对保证。
- 启动每个块前按实时可用内存和该块预测峰值准入：可用内存 `<=1000 MB` 回退单窗；否则必须满足 `预测峰值 < 可用内存 - 1000 MB`。不满足就排队，窗口退出并释放租约后重试；不得合并独立块、突破底线硬跑或只按固定窗口数限流。默认块成本 400 MB，并用实测峰值滚动修正。
- 每个任务经过 `started → 实际操作/自验 → completed`，父控按 FIFO 串行队列独立检查真实工作区并写 `verification-report.jsonl`。结束标记、子窗自报、关窗或进程退出都不能证明成功；最后清理并核对剩余错误窗口/线程。
- 不确定副作用标为 `needs-reconciliation`，不可盲目重跑；仅显式 `retrySafe:true` 的任务可安全重试。成功条件是全部任务已独立 `verified` 且自有进程已退出。

## 入口与恢复

```powershell
# 从拥有任务的工作区运行；@(...) 保留每个参数的边界。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<插件绝对路径>\scripts\bootstrap.ps1" -Action run -Arguments @('--plan', '<请求>')
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<插件绝对路径>\scripts\bootstrap.ps1" -Action run -Arguments @('--run-id', '<ID>', '--acceptance-file', '<JSON>', '--exec', '<请求>')
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<插件绝对路径>\scripts\bootstrap.ps1" -Action run -Arguments @('--verify-run', '<ID>', '--acceptance-file', '<JSON>')
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<插件绝对路径>\scripts\bootstrap.ps1" -Action run -Arguments @('--status', '--workspace', '<工作区>', '--run-id', '<ID>', '--watch')
```

`--resume-run` 复用原计划、模式和验收摘要；传输、超时、容量、服务端错误只做有上限退避，账户用量上限立即失败并保留证据。`--doctor`、`--plan`、`--status --readonly` 分别用于环境、规划和只读诊断；`--plan` 不改任务文件，但可能写拆分缓存。

开发或发布前，在源码根目录且已有 Node 22+ 时运行 `node scripts/release-integrity.mjs`；无参数即执行封存校验，`--seal` 只用于准备新的发行封存，不能用旧证据代替新校验。

执行时读取[执行协议](../../docs/execution-contract.md)；发布历史和审查证据按需读取，不在技能发现阶段递归加载。

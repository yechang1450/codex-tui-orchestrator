---
name: codex-tui-orchestrator
description: Use when codex-tui-orchestrator (legacy codex-TUI-orchestrator) receives an authorized multi-part request needing conflict/dependency-based Codex execution with live task and block status with independent verification; 只读分析和修改编排器自身留在主对话。
---

# Codex TUI Orchestrator

本插件只接 Codex CLI。专用核心固定在本插件内，启动时按 `release.json` 校验完整性；其它 Agent 由独立适配器处理。

## 先做的事

- 只读分析、方案和编排器自身修改留在主对话；用户已授权时直接执行，不重复询问窗口批准。
- 默认用 `--exec`（headless，无弹窗）执行；需要观察或交互时用 `--run-windows` / `--visible`。`--run` 和裸请求遵循 `ORCH_EXEC_MODE`，显式参数优先。
- 可见模式默认 `ORCH_TUI=wt`（Windows Terminal）；`ORCH_TUI=inactive` 只在显式指定时使用，仍不能保证焦点不变。
- 两种执行模式默认继承原生 Codex 的模型与推理配置；需要沿用当前对话的临时设置时，由调用方显式传入 `ORCH_MODEL`、`ORCH_EFFORT`。执行块不得递归编排、调用子代理或另开窗口。

## 规划与执行

- 从发起工作区调用绝对入口，临时文件只进 `workspace/temp/orchestrator`。并发按**运行时内存预算**（`ORCH_CAPACITY_MODE=dynamic`，默认）：规划后先判断全部块同时运行的预估成本是否会把可用内存压到 `ORCH_MIN_AVAILABLE_MB`（默认 512）以下，超了就把同一并行层里最贵的两块合并（块内串行），循环到放得下；执行期每开一个新块前复检，不够就 `deferred` 暂缓，等已运行块结束后重检，全部跑完仍不够则**降级硬跑**（记 `degraded=hard-run`，绝不 fail-closed，保证一轮跑完）。每窗成本默认 256 MB 并按实测滚动修正；单任务请求不在编排范围内，直接用 Codex 执行。`ORCH_CAPACITY_MODE=formula` 可回退旧的 `floor(机器内存MB/2000)` 公式。
- 保留原始任务 ID 和原文。按冲突、父子路径锁和依赖拆块；未知、自指、循环依赖在启动前报错，覆盖不确定时保留全部任务并串行兜底。
- 先生成唯一 run ID 和 acceptance JSON（每个 T001 等任务都要有内容或行为检查），再执行：
  `node <SDK绝对路径> --run-id <ID> --acceptance-file <JSON绝对路径> --exec "<完整请求>"`
- 每项必须按 `started → 实际操作与自验 → completed` 写检查点；最后由主控独立验收。仅有结束标记、关窗、agent 自报或进程退出都不算成功。
- 需要观察时运行：
  `node <插件绝对路径>/scripts/status.mjs --workspace <工作区> --run-id <ID> --watch`
  `status.mjs` 只读，不依赖 SDK；原生 TodoList/spawn 卡片属于宿主，本插件只提供终端面板和状态事件。

## 状态与恢复

- TodoList（原始任务状态）和 Execution（执行块状态）来自同一持久账本：`manifest.json` 是规划清单，`summary.json` 是权威快照，`events.jsonl` 是有序事件，`goal.json` 是派生镜像。
- 全部任务 `verified` 且自有进程已退出才成功；缺检查或结果不符保留为 `awaiting-verification`。产物只清理本次拥有且已结束的文件。
- `--resume-run <ID>` 沿用原任务、计划、模式和验收条件；已验证任务不重做，存活窗口按 PID/创建时间/命令行接管。
- 已开始但副作用不明的任务进入 `needs-reconciliation`（需核对真实结果），不能盲目重跑；只有预先声明 `retrySafe:true` 的任务可安全重试。恢复不会重放整个块。
- 传输、超时、容量和服务端错误只做有上限的退避；容量错误发生在检查点前才自动重试。单任务可用 `supervise.mjs`，多任务使用 `--resume-run`。
- 核对真实结果时运行 `node <SDK绝对路径> --verify-run <ID> --acceptance-file <JSON>`；不保证外部副作用恰好一次。
- 验收契约在运行开始时按规范化 SHA-256 摘要绑定到 `manifest.json` / `summary.json`：`--verify-run` 与 `--resume-run` 读到不一致的契约会直接拒绝（执行窗改不了自己的验收门槛）。确实要换契约才加 `--allow-acceptance-change`（放在 run ID 之后）或 `ORCH_ACCEPTANCE_OVERRIDE=1`，重新绑定会记进账本 history。

provider 明确返回账户用量上限（如 usage_limit_exceeded）时立即失败并保留错误；结构化 `error`/`turn.failed` 或 `task_complete.error` 才是配额信号，任务文本与工具输出不具备该权限。此类失败不消耗普通失败预算或重开窗口；等待额度恢复后再用原运行身份恢复。

## 诊断与发布

- `--doctor` 检查依赖和 CLI；`--plan` 只规划；`--status --readonly` 只读检查窗口和锁。
- 插件管理器每次安装、升级或回退都会建新缓存；对返回的 `<installed>/scripts` 先运行 `npm ci --omit=optional --ignore-scripts --no-audit --no-fund`，再运行 release integrity 和 doctor。
- `node <插件绝对路径>/scripts/release-integrity.mjs` 校验发布快照。核心改动前确认没有活动窗口，完成回归和适用的真实验收后再发布。

详见 [执行协议](../../docs/execution-contract.md) 和 [发布规则](../../docs/release-policy.md)。

---
name: codex-tui-orchestrator
description: Use when codex-tui-orchestrator (legacy codex-TUI-orchestrator) receives an authorized multi-part request needing conflict/dependency-based Codex execution with live task and block status with independent verification; 只读分析和修改编排器自身留在主对话。
---

# Codex TUI Orchestrator

本插件仅支持 Codex CLI。其它 Agent 由独立的 open-tui-orchestrator 实现适配。专用插件持有固定核心快照，不得链接通用开发目录；启动时按 release.json 检查核心完整性。

## 使用范围与授权

- 只读分析、方案及编排器自身修改在主对话执行。
- 适合拆分的真实任务默认使用 --exec（headless，无终端弹窗）；独立块并发，冲突或依赖任务串行。整批可见窗口用 --run-windows 或 --visible；单个可见窗口用 --spawn。
- 用户已授权时直接执行，不重复询问是否批准窗口。窗口使用 never；技能不能覆盖宿主工具限制。
- --run 和裸请求默认 headless，ORCH_EXEC_MODE 可设 headless/visible；显式参数优先。执行块不得递归编排、调用子代理或另开窗口。
- 显式可见模式默认 ORCH_TUI=wt，使用 Windows Terminal 承载可见 TUI；内部仍使用 PowerShell 启动脚本管理执行生命周期。ORCH_TUI=inactive 仅为显式传统控制台选项，不主动切换用户窗口；它也不能保证完全避免焦点变化，见 docs/inactive-windows.md。
- TUI 窗默认使用 `gpt-5.3-codex-spark` 与最高 `xhigh` 思考强度；调用方显式设置 `ORCH_MODEL` 或 `ORCH_EFFORT` 时覆盖默认值。

## 目录和容量

从发起对话目录调用 SDK 绝对路径，不切换到安装目录。默认沿用当前工作区；临时文件归入工作区 temp/orchestrator。

规划前检测内存：最大窗口数 = floor(系统报告 GiB × 1024/1000 × 3/4)。整批至多该数量的块；多余任务合并到已有块串行执行，不另排额外批次。全局容量计入活动和预留窗口。

原始任务保持稳定 ID；普通逗号后的补充说明不能丢失。模型只能分类，不得改写任务原文或凭已完成建议跳过任务。覆盖不确定时保留全部任务，并明确报告串行兜底。

每块只等待自身前置验收成功，不等待无关块。未知、自指及循环依赖在启动前报错。冲突锁考虑规范化路径及父子目录关系。

## 执行与独立验收

1. 主控准备唯一 run ID 和验收 JSON，按 T001 等原始任务 ID 定义只读检查。验收应核对内容或行为，不能仅凭文件存在。
2. 调用 node <SDK绝对路径> --run-id <ID> --acceptance-file <JSON绝对路径> --exec "<完整请求>"。
3. 窗内逐项执行提供的 started/completed 检查点命令；完成全部实际操作和自查后，最后只输出 __ORCH_DONE__ <本窗token>。
4. 主控运行 node <scripts绝对路径>/poll-windows.mjs --run-id <ID> --require-all-success --timeoutMs <时限>。
5. 全部原始任务 verified 且所属执行进程退出才算成功。结束标记、关窗、agent 自报及其它批次的结果都不能代替验收。
6. 缺检查或结果不符时保留任务并继续核查；不能当作完成。全部授权任务在本轮验证后交付。

产物按 run ID 放在工作区 temp/orchestrator/runs/<ID>。清理只针对本次拥有且已结束的临时文件，不删除活动窗文件或无关文件。

## 双通道实时状态

TodoList（原始任务清单）保留 T001 等任务身份。Execution（执行块状态面板，也称 spawn 状态）显示每个块的模式、PID、尝试次数、等待原因和重试时间。块已启动不代表其中每个任务都已开始。

- started 检查点使任务进入 running；completed 进入 awaiting-verification；独立验收通过才显示 verified。
- 执行输出持续显示双状态。交互终端固定刷新面板，普通输出按状态变化追加。
- manifest.json 从规划开始保存清单；summary.json 是权威快照，events.jsonl 是带序号事件，goal.json 是派生镜像。文件都归当前工作区 temp/orchestrator/runs/<ID>。

~~~powershell
node <插件绝对路径>/scripts/status.mjs --workspace D:\your-project --run-id <ID> --watch
node <插件绝对路径>/scripts/status.mjs --workspace D:\your-project --run-id <ID> --watch --json
~~~

status.mjs 只读且不依赖 SDK，退出观察不会终止执行。JSONL（逐行 JSON 事件）用于接入宿主界面；重连先读最新快照再跟随事件，--after 指定已观察序号。默认每 250ms 观察检查点，系统和同步协调可能延迟显示，不承诺硬实时。

Codex 原生 TodoList/spawn 卡片属于宿主界面。本插件提供持续终端面板和状态事件；原生卡片需要宿主消费同一接口，不能仅靠技能文件注入。可以随时打开观察面板；选择下一次任务的执行模式不会重启当前任务。

恢复沿用原来的执行模式和任务身份。旧记录未声明模式时仍按 visible 恢复，不会因新默认值改变执行方式。

## 中断恢复

单个任务不需要拆分成可见并发块时，可用独立监督器：`node <插件绝对路径>/scripts/supervise.mjs --workspace <工作区> --prompt "<完整任务>" --max-attempts 3`。它把会话 ID 和尝试记录写入工作区 `temp/orchestrator/supervisor/runs/<ID>`，对传输错误、超时、容量、限流和服务端错误做有限退避，并在可能时恢复同一个 Codex 会话。保存的任务用同一 `--run-id <ID> --resume` 继续。

监督器只能保证有限恢复，不能把有不确定外部副作用的操作变成可安全重复；这类情况仍需先核对实际状态。多任务计划继续使用下面的检查点恢复流程。

从原工作区运行 node <SDK绝对路径> --resume-run <ID>。使用保存的任务、计划、执行模式和验收条件；旧记录无模式字段时仍按 visible 恢复；按 PID、创建时间及命令行接管存活窗口，不重复启动替代窗。

已验证任务不重复执行。已开始但副作用不明确的任务进入 needs-reconciliation（需要主控核对实际结果的状态），不能盲目重跑。仅事先确定可安全重复的任务才能设置 retrySafe:true。启动器不重放整个块。

遇到 `Selected model is at capacity`、`try a different model` 或 `server_overloaded` 时，插件会在尚未写入任务检查点前自动按倒计时退避重试；任务一旦开始，仍遵守 needs-reconciliation 安全边界。可用 ORCH_CAPACITY_RETRIES、ORCH_CAPACITY_RETRY_MS、ORCH_CAPACITY_RETRY_MAX_MS 调整有限重试。

使用 --verify-run <ID> --acceptance-file <JSON> 复核已有结果。不保证任意外部操作恰好执行一次。

## 诊断和发布

- --doctor 检查依赖；--plan 仅规划；--status --readonly 检查窗口与锁。
- node <插件绝对路径>/scripts/release-integrity.mjs 校验发布核心。
- 开发改动经回归与相关真实验收后才能发布。修改核心前确认没有活动窗口，不热替换正在运行的版本。
- Codex 使用现有登录的 HTTPS Responses 配置，避免 WebSocket 首次超时回退；HTTPS 仍可能遇到断网。

详见 [执行协议](../../docs/execution-contract.md) 和 [发布规则](../../docs/release-policy.md)。

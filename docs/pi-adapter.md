# 历史外部项目记录：open-tui-orchestrator 的 pi 适配器

> **不适用于本 Codex 插件**：本文件记录的是外部项目 `open-tui-orchestrator` 的历史 Pi 适配工作和当时的测试观察。`codex-tui-orchestrator` 只接受 Codex CLI；本文件不是它的功能说明、运行指令或兼容性承诺，也不认证当前版本的 Pi 支持状态。

当时的 `open-tui-orchestrator` 支持已安装的 Codex CLI 和 pi CLI。专用 `codex-tui-orchestrator` 只接受 Codex；两套入口各自维护并发协调器、任务清单、冲突锁、恢复和验收状态，避免跨实现清理彼此的租约。

## 当时的使用方式（仅供历史阅读）

从发起对话的工作目录调用，不要先切到安装目录：

```powershell
open-tui-orchestrator --agent pi --doctor
open-tui-orchestrator --agent pi --run-id my-run --acceptance-file D:/work/temp/acceptance.json --run-windows '项目91：修改页面，运行测试；项目92：修改接口，检查结果'
open-tui-orchestrator --agent pi --resume-run my-run
```

实际验收 JSON 由主持根据任务准备，规则见 [执行协议](execution-contract.md)。`--plan` 使用 pi 自己的无工具模式规划；`--run-windows` 使用 pi 的真实交互窗口，未用 Codex 代跑。

## 当时的 CLI 与运行协议

- 支持本地 pi 0.84.4 及以上所需接口。解析 npm 启动入口后，直接用 Node 和实际 cli.js 调用，避免批处理字符串拼接；也检查原生可执行候选。显式路径错误时不回退、不安装。
- Windows 上只接受通过宿主 Authenticode 校验的 `pi.exe`；PATH 中的 shim、脚本和未签名显式路径会在执行前拒绝。仅用于本机开发的显式未签名路径必须同时设置 `ORCH_ALLOW_UNVERIFIED_PI=1` 与 `ORCH_CLI`/`PI_EXE`，不会放宽 PATH 自动发现。
- 保留 pi 自己的模型和登录设置。只有调用方显式传入 ORCH_MODEL / ORCH_EFFORT 才转为 pi 对应参数；不读取或输出密钥。
- `--approve` 处理本次项目文件信任，`--offline` 关闭启动时非必要联网，不禁止正常模型请求。没有向 pi 塞入 Codex 的 `--sandbox`、`--cd` 或 `never` 参数；不支持的沙箱要求明确拒绝。
- 窗口工作目录继承发起目录。pi 会话写入该工作区 `temp/orchestrator/pi/sessions`，启动器和检查点沿用工作区 temp；不修改用户全局配置。
- 使用 pi 的 agent_settled 事件（自动重试、压缩及排队消息均处理完毕后发出的结束事件），仅在空闲时检查最后一条 assistant 输出，再调用 pi 的正常退出接口。用户提示里的结束标记不能触发成功。
- 结束标记只表示执行生命周期结束；任务是否成功仍由主持逐项验收。每批记录实际 agent，恢复时不能悄悄切换到另一种 agent。

## 当时的分块根因修复

原始任务清单与确定性分块使用同一个任务边界解析器。逗号后的普通补充说明留在原任务中；只有后面明确开始另一个项目时才拆分。引号和括号内的命令分隔符不会被拆成任务。

模型规划必须返回原始 T001 等任务 ID。主持按 ID 恢复原文后再分块，所以模型改写摘要不会让完整覆盖检查失效。遗漏、重复或未知 ID 会拒绝该规划，不丢任务。

内存上限为 `floor(机器内存MB / 2000)`（每块按 2 GB 预算，取机器检测到的物理内存）。任务块仍按依赖和资源冲突合并，合并块内部串行执行；每个块携带主控生成的全局 TodoList 和本块待办视图。

## 当时的验证入口

- `node --test test/*.test.mjs`：完整回归，包括实际 PowerShell 启动器与 pi 事件协议。
- 从目标工作目录按绝对路径运行 `test/live-pi.mjs`：pi 的真实 8 窗 / 9 项验收。
- 设置 `ORCH_LIVE_AGENT=pi` 后运行 `test/live-recovery.mjs`：真实主持中断与原窗口接管。
- 使用 `ORCH_LIVE_ENTRY` 指向专用 SDK，再运行 `test/live-codex.mjs`：检查专用入口未回归。

真实测试会使用本地已配置服务的额度。具体结果以本轮独立验收报告为准；接通 pi 不代表其它 CLI 已经兼容。

## 当时的本机验收（2026-09-06）

| 场景 | 结果 |
|---|---|
| open 与专用入口完整回归 | 各 124/124 通过 |
| pi 真实并发 | 8 窗完成 9 项，8 个探针重叠 15.617 秒 |
| Codex 专用入口真实并发 | 8 窗完成 9 项，8 个探针重叠 17.180 秒 |
| 原始逗号请求 | 两种 agent 都使用带逗号的请求，分配为 7 个单任务块 + 1 个双任务块 |
| pi 主持中断 | 原窗被新主持接管，2 项任务完成，第一项只执行一次 |
| 最终代码恢复已完成 pi 批次 | 成功，未新开窗口、未增加任务执行尝试 |

两次容量测试的严格轮询均返回 0，所有测试窗口已关闭。pi 的实际会话目录和 cwd 均经检查，保留它自己的配置，无需用户手动批准窗口执行。

真实运行回执属于本机审计资料，未纳入公开仓库。报告应分开记录实测时与最终核心的哈希，并明确哪些收尾修改只经过离线回归验证。

本轮 19 个一次性探针脚本的收尾删除被宿主自动审批拒绝（host automatic approval review denied cleanup，未提供具体原因），因此按实际状态保留；未换工具绕过。该拒绝发生在测试后的清理阶段，不是 TUI 执行批准。

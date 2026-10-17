[English](README.md)

## 作者声明

> 本项目由AI Agent（先codex后hermes）全程制作完成，除了这个作者声明外，我没有看过或写过任何代码，是一个纯粹的AI Agent产物。实际测试并验证支持的Agents CLI有hermes、codex、pi、opencode、kimicode，而事实上这个编排器从codex刚被做出来时，没有做任何针对性的优化，pi就可以直接正常使用，所以除了我验证过的Agents外，究竟还能支持或不支持什么Agents我也不确定，还请各位酌情使用。
>
> 这个编排器，一开始是我在用codex的时候，我发现一个对话只能串行执行，就算是开了subagent，也是把一个任务给拆开并发后再合并结果的，而我的使用习惯就是一次性给Agent发一次长任务清单，而有些任务就是八竿子打不着的，所以完全可以并发执行，于是我就做了这个编排器，利用对话所在的Agent的CLI实现多任务并发执行，实现之后，我就在想，codex有这么个编排器，而我电脑上还有其它Agents，那为什么不给它做成一个通用的工具呢，于是在codex-tui-orchestrator的基础上，就有了open-tui-orchestrator，基本上底层执行思路是一模一样的，就是形式不同，codex-tui-orchestrator是codex的plugin，open-tui-orchestrator是npm工具。
>
> 我是一个在大学期间有过两年开发经验的个人开发者，我从来都没有在大厂上过班，也很少上班，现在我做这些，就是觉得这是我的人生钥匙，所以我边指挥Agent开发边在抖音上看各种视频去学习或了解信息，每天能沉浸在这项活动中十几个小时不觉得累，并且AI Agent开发已经完全成了我日常中最让我觉得有意思的事了，这让我每天过的充实又开心，希望未来可以产出更多，找到属于自己的路。

**仓库范围。** 本仓库只包含 Codex 插件；上文所述的多 Agent 兼容能力属于独立的 `open-tui-orchestrator` 项目。

# CTUI — Codex TUI Orchestrator

**CTUI** 是 **codex-tui-orchestrator** 的简称：一个面向 Windows 的 Codex 插件，把一长串任务拆成执行块，只并发其中已确认独立的部分。它是仅面向 Codex 的插件，通过 GitHub 的 [checkout 安装](#checkout-安装) 或 [GitHub marketplace catalog](#github-marketplace-catalog) 分发，不会发布到 npm。

## 快速开始

在 Codex 对话中（推荐）：

1. 用下面两种方式之一安装插件。
2. 给 Codex 一个列出两个以上独立项目/任务块的清单，例如 `项目1：更新文档；项目2：检查测试`。
3. CTUI 给出拆分计划，每个确认独立的块开一个 TUI 窗口；有依赖、冲突或不确定的工作保持串行。任务在满足父任务定义的验收条件前始终处于“待验证”。

在终端中使用（计划与检查）：

```powershell
$pluginRoot = Join-Path $HOME 'plugins\codex-tui-orchestrator'
$workspace  = 'C:\path\to\workspace'
$env:ORCH_SANDBOX  = 'read-only'   # 也可用 workspace-write / danger-full-access
$env:ORCH_APPROVAL = 'never'       # 或 on-request
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$pluginRoot\scripts\bootstrap.ps1" -Action doctor
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$pluginRoot\scripts\bootstrap.ps1" -Action run --workspace $workspace --plan '项目1：更新文档；项目2：检查测试'
```

- `--plan` 把计划 JSON 打到 stdout，诊断走 stderr。
- 请求里出现两个以上项目时走确定性拆分（秒级、不调用模型）；其余请求由宿主 CLI 规划，失败时回退为单个串行块。
- 单块计划返回 `"mode":"inline"`：应在当前对话里直接执行，而不是开窗口。

## 工作方式

- 保留任务身份，把有依赖、有冲突或不确定的工作归入串行执行块。
- 只并发确认独立的执行块，按配置的资源预算排队。
- 任务只有满足父任务定义的验收条件才会标记为已验证；子窗口自报或窗口关闭本身不能证明成功。
- 原生 TodoList/spawn 卡片属于宿主 UI，插件输出状态事件供宿主消费。

## 运行状态与恢复

- `--tasks` / `--status [--run-id <id>]` 查看任务清单与每个块的执行状态。
- `--verify-run <id>` 复核已保存的运行；`--resume-run <id>` 恢复运行。
- 运行记录与检查点位于 `<workspace>\temp\orchestrator`。

## Checkout 安装

安装已审阅的 release tag：

```powershell
$pluginRoot = Join-Path $HOME 'plugins\codex-tui-orchestrator'
$ref = '<release-tag>'
git clone --branch $ref --depth 1 https://github.com/yechang1450/codex-tui-orchestrator.git $pluginRoot
Set-Location $pluginRoot
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$pluginRoot\scripts\bootstrap.ps1" -Action install
```

执行 bootstrap 前请使用 release tag，不要直接执行会持续变化的默认分支；默认分支 checkout 只用于开发。

## GitHub marketplace catalog

这与 checkout install 是两条不同的路径。某个公开 commit 或 tag 可用后，可让 Codex 直接从 GitHub 获取本仓库的 catalog：

```powershell
$ref = '<最终 commit 或 tag>'
codex plugin marketplace add yechang1450/codex-tui-orchestrator --ref $ref
codex plugin add codex-tui-orchestrator@yechang1450-codex-tui-orchestrator
```

GitHub marketplace catalog 与官方公共插件目录不同。此插件使用 lifecycle hook，因此通过仓库 marketplace 路径安装。

## 常见问题

- `INITIATOR_POLICY_UNAVAILABLE`：终端命令要么在目标工作区的 Codex 对话内运行，要么显式设置 `ORCH_SANDBOX` 与 `ORCH_APPROVAL`；与 Codex 绑定的 shell 按设计拒绝不同工作区。
- doctor 默认对路径与 CLI 位置脱敏；设置 `ORCH_DIAGNOSTIC_FULL_PATHS=1` 可显示完整路径。
- 首次运行会准备固定版本的 Node 运行时与锁定的 Codex CLI/SDK，需要网络；0.9.29-rc.11 起支持较深的安装路径。
- 不含独立项目的请求由宿主 CLI 规划，需要已登录的 Codex CLI；规划失败会回退为单个串行块。
- 不要在任务提示里放密钥；脱敏与存储边界见[隐私说明](docs/privacy.md)。执行计划前请阅读[执行约定](docs/execution-contract.md)。

## 隐私与法律

- [隐私说明](docs/privacy.md)
- [条款](docs/terms.md)
- [MIT License](LICENSE)

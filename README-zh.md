[English](README.md)

## 作者声明

> 本项目由AI Agent（先codex后hermes）全程制作完成，除了这个作者声明外，我没有看过或写过任何代码，是一个纯粹的AI Agent产物。实际测试并验证支持的Agents CLI有hermes、codex、pi、opencode、kimicode，而事实上这个编排器从codex刚被做出来时，没有做任何针对性的优化，pi就可以直接正常使用，所以除了我验证过的Agents外，究竟还能支持或不支持什么Agents我也不确定，还请各位酌情使用。
>
> 这个编排器，一开始是我在用codex的时候，我发现一个对话只能串行执行，就算是开了subagent，也是把一个任务给拆开并发后再合并结果的，而我的使用习惯就是一次性给Agent发一次长任务清单，而有些任务就是八竿子打不着的，所以完全可以并发执行，于是我就做了这个编排器，利用对话所在的Agent的CLI实现多任务并发执行，实现之后，我就在想，codex有这么个编排器，而我电脑上还有其它Agents，那为什么不给它做成一个通用的工具呢，于是在codex-tui-orchestrator的基础上，就有了open-tui-orchestrator，基本上底层执行思路是一模一样的，就是形式不同，codex-tui-orchestrator是codex的plugin，open-tui-orchestrator是npm工具。
>
> 我是一个在大学期间有过两年开发经验的个人开发者，我从来都没有在大厂上过班，也很少上班，现在我做这些，就是觉得这是我的人生钥匙，所以我边指挥Agent开发边在抖音上看各种视频去学习或了解信息，每天能沉浸在这项活动中十几个小时不觉得累，并且AI Agent开发已经完全成了我日常中最让我觉得有意思的事了，这让我每天过的充实又开心，希望未来可以产出更多，找到属于自己的路。

以上是作者个人声明。其中列出的 Agent 是作者的实测经验，不构成本插件对其他 CLI 的兼容承诺。

# codex-tui-orchestrator

> 版本：`0.9.29-rc.1`；执行核心：`1.4.4-rc.1`。这是一个面向 Codex CLI 的 Codex plugin，运行环境为 Windows + Node.js 22+。

让一次长任务清单按依赖、冲突和资源约束安全并发执行，并逐项验收真实结果。

## 核心思路

编排器不把任务简单切成窗口，而是先保留原始任务身份：

1. **识别任务关系**：保留原始任务 ID 和原文，分析依赖、文件冲突、父子路径和未知作用域。
2. **形成执行块**：有依赖、有冲突或作用域不明的任务放入同一串行块；只有确认相互独立的块才并发。
3. **按资源启动**：每次开窗前重新检查实时内存，预留 `1000 MB` 安全余量；在可运行块中优先启动预计峰值更高的块，放不下的块排队。
4. **逐项验收**：每个任务必须经过 `started → completed → verified`。主控按独立验收条件读回工作区产物；关窗、结束标记或子窗口自报都不能单独证明成功。

`1000 MB` 是调度底线，不是机器永不耗尽内存的数学保证。实际并发还受实时内存、已有租约和任务依赖影响。

## 执行模式

| 模式 | 用途 |
| --- | --- |
| `--plan "<请求>"` | 只规划，供主控检查拆分结果 |
| `--exec "<请求>"` | 默认无弹窗执行，使用持久账本 |
| `--run-windows "<请求>"` | 显式打开可见 Windows TUI |
| `--status --run-id <ID> --watch` | 观察 TodoList、执行块和等待原因 |
| `--resume-run <ID>` | 沿用原计划和任务身份恢复 |
| `--verify-run <ID> --acceptance-file <JSON>` | 不重跑任务，重新核对已有产物 |

子窗口继承发起对话的工作区、执行策略和模型设置；可见窗口也以发起工作区作为启动目录。受限会话不能借此切换到别的工作区。

Codex 原生 TodoList/spawn 卡片属于宿主界面；插件提供状态事件供宿主消费。

## 快速开始

从 GitHub 获取源码并安装、注册当前 checkout：

```powershell
git clone https://github.com/yechang1450/codex-tui-orchestrator.git "$HOME\plugins\codex-tui-orchestrator"
Set-Location "$HOME\plugins\codex-tui-orchestrator"
powershell.exe -NoProfile -File ".\scripts\bootstrap.ps1" -Action install
```

安装不会提供账号凭据；实际运行还需要宿主启用并信任 SessionStart hook，并完成 Codex CLI 登录。

先查看计划，再执行：

```powershell
node scripts/orchestrate-sdk.mjs --plan "项目 1：清理 build\80；项目 2：清理 build\81；项目 3：清理 build\82"
node scripts/orchestrate-sdk.mjs --run-id demo-cleanup --acceptance-file .\temp\acceptance.json --exec "按计划完成这些任务，并逐项写入可核对的结果"
```

需要观察窗口时，把 `--exec` 换成 `--run-windows`。`acceptance.json` 必须位于发起工作区内，由发起方定义每个任务的文件、JSON 或删除检查；没有独立验收条件的任务不会被宣称为成功。完整环境准备说明见 [环境准备](docs/environment-setup.md)。

## 安全边界

- 入口、插件封印、CLI 身份和工作区关系校验失败时停止，不静默替换。
- 未知路径或未知副作用按保守规则串行；结果不明时进入 `needs-reconciliation`，不盲目重跑。
- 控制器保存原始清单、尝试令牌、检查点和验收报告；每个任务只由当前运行的证据完成。
- 子窗口不得递归启动编排器、子代理或额外编排窗口。
- 运行账本、检查点和验收报告留在发起工作区的 `temp/orchestrator`；窗口注册、协调租约和不可变绑定等控制器状态留在独立的 Codex 状态目录。两者共同用于恢复和对账。

## 验证与开发

```powershell
npm ci --prefix scripts --omit=optional --ignore-scripts --no-audit --no-fund
node --test --test-concurrency=1 test/*.test.mjs
node scripts/release-integrity.mjs --verify
```

- [执行与验收协议](docs/execution-contract.md)：完整状态、恢复和验收契约。
- [RC 验收记录](docs/rc-validation.md)：按提交和版本保存的实测证据。
- [贡献指南](CONTRIBUTING.md)：本地开发约定。
- 本项目是独立个人项目，不代表或得到 OpenAI 背书。插件打包和本地 marketplace 结构参考 [OpenAI 插件文档](https://developers.openai.com/plugins/build/plugins)。

## 相关项目

`open-tui-orchestrator` 是另一个 npm 工具；它沿用相同的底层编排思路，面向更通用的 Agent CLI。它不包含在本 Codex plugin 中。

## 隐私与法律

- [隐私说明](docs/privacy.md)
- [使用条款](docs/terms.md)
- [MIT License](LICENSE)

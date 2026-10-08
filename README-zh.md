[English](README.md)

## 作者声明

> 本项目由AI Agent（先codex后hermes）全程制作完成，除了这个作者声明外，我没有看过或写过任何代码，是一个纯粹的AI Agent产物。实际测试并验证支持的Agents CLI有hermes、codex、pi、opencode、kimicode，而事实上这个编排器从codex刚被做出来时，没有做任何针对性的优化，pi就可以直接正常使用，所以除了我验证过的Agents外，究竟还能支持或不支持什么Agents我也不确定，还请各位酌情使用。
>
> 这个编排器，一开始是我在用codex的时候，我发现一个对话只能串行执行，就算是开了subagent，也是把一个任务给拆开并发后再合并结果的，而我的使用习惯就是一次性给Agent发一次长任务清单，而有些任务就是八竿子打不着的，所以完全可以并发执行，于是我就做了这个编排器，利用对话所在的Agent的CLI实现多任务并发执行，实现之后，我就在想，codex有这么个编排器，而我电脑上还有其它Agents，那为什么不给它做成一个通用的工具呢，于是在codex-tui-orchestrator的基础上，就有了open-tui-orchestrator，基本上底层执行思路是一模一样的，就是形式不同，codex-tui-orchestrator是codex的plugin，open-tui-orchestrator是npm工具。
>
> 我是一个在大学期间有过两年开发经验的个人开发者，我从来都没有在大厂上过班，也很少上班，现在我做这些，就是觉得这是我的人生钥匙，所以我边指挥Agent开发边在抖音上看各种视频去学习或了解信息，每天能沉浸在这项活动中十几个小时不觉得累，并且AI Agent开发已经完全成了我日常中最让我觉得有意思的事了，这让我每天过的充实又开心，希望未来可以产出更多，找到属于自己的路。

列出的 Agent 是作者的个人实测经验，不构成对其他 CLI 的兼容承诺。

# codex-tui-orchestrator

这是一个面向 Windows 的 Codex plugin：当长任务清单中的任务已确认互不依赖、无冲突且资源允许时，它会并发执行这些任务。

## 工作方式

编排器保留每项任务的原始身份，把有依赖、有冲突或作用域不明的工作归入串行执行块，只并发确认独立的执行块。它会记录执行状态，并用独立验收条件逐项核对结果；子窗口自报或窗口关闭本身不能证明任务成功。

使用 `--plan` 检查拆分建议。`--exec` 以无窗口方式执行，`--run-windows` 打开可见 Windows 会话，`--status` 观察运行状态，`--resume-run` 与 `--verify-run` 用于已保存的运行记录。

## 快速开始

克隆并安装当前 checkout：

```powershell
$pluginRoot = Join-Path $HOME 'plugins\codex-tui-orchestrator'
git clone https://github.com/yechang1450/codex-tui-orchestrator.git $pluginRoot
Set-Location $pluginRoot
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$pluginRoot\scripts\bootstrap.ps1" -Action install
```

在拥有任务的工作区中，通过 bootstrap 入口检查计划：

```powershell
$pluginRoot = Join-Path $HOME 'plugins\codex-tui-orchestrator'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$pluginRoot\scripts\bootstrap.ps1" -Action run -Arguments @('--plan', '任务 1：更新文档；任务 2：检查测试')
```

`-ExecutionPolicy Bypass` 只作用于这个 PowerShell 子进程。安装和执行仍需要已登录的 Codex CLI，以及已受信任的 SessionStart hook。

## 相关项目

[open-tui-orchestrator](https://github.com/yechang1450/open-tui-orchestrator) 是同一通用编排思路的独立 npm 实现。

## 隐私与法律

- [隐私说明](docs/privacy.md)
- [使用条款](docs/terms.md)
- [MIT License](LICENSE)

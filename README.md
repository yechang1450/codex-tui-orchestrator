[中文](README-zh.md)

## Author's statement

> This project was built end to end by AI agents (Codex first, then Hermes). Apart from this author statement, I have not read or written any code; it is a pure AI-agent product. I have personally tested and verified the Hermes, Codex, Pi, OpenCode, and KimiCode agent CLIs. When the orchestrator was first built for Codex, Pi worked normally without any targeted optimization. Beyond the agents I have verified, I am not sure which agents the orchestrator may or may not support; please use your own judgment.
>
> I first made this orchestrator while using Codex. I found that one conversation could only execute serially. Even when using subagents, a task would be split for parallel work and then merged. My habit is to send an agent one long task list at a time, and some tasks have nothing to do with each other, so they can run in parallel. I built this orchestrator to use the CLI of the agent hosting the conversation to run multiple tasks concurrently. After that, I thought: Codex has an orchestrator, and I have other agents on my computer, so why not make it a general tool? That led from codex-tui-orchestrator to open-tui-orchestrator. Their underlying execution idea is essentially the same, but their form differs: codex-tui-orchestrator is a Codex plugin, while open-tui-orchestrator is an npm tool.
>
> I am an independent developer with two years of development experience during university. I have never worked at a large technology company and have rarely had a conventional job. I do this because it feels like the key to my life. While directing agents to develop, I watch videos on Douyin to learn and understand things; I can stay immersed in this activity for more than ten hours a day without feeling tired. AI-agent development has become the most interesting part of my daily life. It makes every day feel full and happy, and I hope to create more and find my own path in the future.

The listed agents reflect the author's personal testing experience. They do not promise compatibility with other CLIs.

# codex-tui-orchestrator

A Windows-focused Codex plugin for running a long, unrelated task list concurrently when dependencies, conflicts, and available resources permit it.

Current sealed core: `1.4.4-rc.1`.

## The model

The orchestrator keeps each task's original identity, groups dependent, conflicting, or uncertain work into serial blocks, and launches only independent blocks in parallel. It records execution state and checks each task against independent acceptance conditions; a worker report or window closure alone does not prove success.

Native TodoList/spawn cards belong to the host UI; the plugin emits status events for the host to consume.

Use `--plan` to inspect a proposed split. `--exec` runs headlessly, `--run-windows` opens visible Windows sessions, `--status` observes a run, and `--resume-run` or `--verify-run` works with a saved run.

## Quick start

Clone and install the checkout:

```powershell
$pluginRoot = Join-Path $HOME 'plugins\codex-tui-orchestrator'
git clone https://github.com/yechang1450/codex-tui-orchestrator.git $pluginRoot
Set-Location $pluginRoot
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$pluginRoot\scripts\bootstrap.ps1" -Action install
```

From the workspace that owns the task, inspect a plan through the bootstrap entry point:

```powershell
$pluginRoot = Join-Path $HOME 'plugins\codex-tui-orchestrator'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$pluginRoot\scripts\bootstrap.ps1" -Action run -Arguments @('--plan', 'Project 1: update the documentation; Project 2: review the tests')
```

`-ExecutionPolicy Bypass` applies only to that child PowerShell process. Installation and execution still require a logged-in Codex CLI and a trusted SessionStart hook.

## Related project

[open-tui-orchestrator](https://github.com/yechang1450/open-tui-orchestrator) is the separate npm implementation of the same general orchestration idea.

## Privacy and legal

- [Privacy](docs/privacy.md)
- [Terms](docs/terms.md)
- [MIT License](LICENSE)

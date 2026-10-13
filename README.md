[中文](README-zh.md)

## Author's statement

> This project was built end to end by AI agents (Codex first, then Hermes). Apart from this author statement, I have not read or written any code; it is a pure AI-agent product. I have personally tested and verified the Hermes, Codex, Pi, OpenCode, and KimiCode agent CLIs. When the orchestrator was first built for Codex, Pi worked normally without any targeted optimization. Beyond the agents I have verified, I am not sure which agents the orchestrator may or may not support; please use your own judgment.
>
> I first made this orchestrator while using Codex. I found that one conversation could only execute serially. Even when using subagents, a task would be split for parallel work and then merged. My habit is to send an agent one long task list at a time, and some tasks have nothing to do with each other, so they can run in parallel. I built this orchestrator to use the CLI of the agent hosting the conversation to run multiple tasks concurrently. After that, I thought: Codex has an orchestrator, and I have other agents on my computer, so why not make it a general tool? That led from codex-tui-orchestrator to open-tui-orchestrator. Their underlying execution idea is essentially the same, but their form differs: codex-tui-orchestrator is a Codex plugin, while open-tui-orchestrator is an npm tool.
>
> I am an independent developer with two years of development experience during university. I have never worked at a large technology company and have rarely had a conventional job. I do this because it feels like the key to my life. While directing agents to develop, I watch videos on Douyin to learn and understand things; I can stay immersed in this activity for more than ten hours a day without feeling tired. AI-agent development has become the most interesting part of my daily life. It makes every day feel full and happy, and I hope to create more and find my own path in the future.

**Repository scope.** This repository contains only the Codex plugin. The multi-agent compatibility described in the statement above belongs to the separate `open-tui-orchestrator` project.

# codex-tui-orchestrator

A Windows-focused Codex plugin that concurrently runs task blocks only when they are confirmed independent and resources allow it.

This is a Codex-only plugin.

It is distributed from GitHub through checkout install or a GitHub marketplace
catalog. It is not published to npm.

## How it works

The orchestrator preserves task identity, groups dependent, conflicting, or
uncertain work into serial blocks, and launches only confirmed-independent
blocks in parallel. A task remains awaiting verification until it meets
parent-defined acceptance conditions; a worker report or window closure alone
does not prove success.

Native TodoList/spawn cards belong to the host UI; the plugin emits status events for the host to consume.

Use `--plan` to inspect a proposed split without executing it. Use `--status`,
`--resume-run`, or `--verify-run` for a saved run.

## Checkout install

Install a reviewed release tag:

```powershell
$pluginRoot = Join-Path $HOME 'plugins\codex-tui-orchestrator'
$ref = '<release-tag>'
git clone --branch $ref --depth 1 https://github.com/yechang1450/codex-tui-orchestrator.git $pluginRoot
Set-Location $pluginRoot
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$pluginRoot\scripts\bootstrap.ps1" -Action install
```

Use a release tag rather than a moving default branch before executing the
bootstrap script. A checkout of the default branch is for development.

## GitHub marketplace catalog

This is an alternative to checkout install. After a public commit or tag is
available, Codex can fetch this repository's catalog directly from GitHub:

```powershell
$ref = '<final-commit-or-tag>'
codex plugin marketplace add yechang1450/codex-tui-orchestrator --ref $ref
codex plugin add codex-tui-orchestrator@yechang1450-codex-tui-orchestrator
```

A GitHub marketplace catalog is distinct from the official public plugin
directory. This plugin uses lifecycle hooks, so install it through this
repository route.

## Plan a task

From the workspace that owns the task, inspect a plan through the bootstrap
entry point:

```powershell
$pluginRoot = Join-Path $HOME 'plugins\codex-tui-orchestrator'
$workspace = 'C:\path\to\workspace'
Set-Location -LiteralPath $workspace
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$pluginRoot\scripts\bootstrap.ps1" -Action run --workspace $workspace --plan 'Project 1: update the documentation; Project 2: review the tests'
```

Read the [execution contract](docs/execution-contract.md) before executing a
plan, and keep secrets out of task prompts. See the [privacy policy](docs/privacy.md)
for the redaction and storage boundary.

## Privacy and legal

- [Privacy](docs/privacy.md)
- [Terms](docs/terms.md)
- [MIT License](LICENSE)

[中文](README-zh.md)

## Author's statement

> This project was built end to end by AI agents (Codex first, then Hermes). Apart from this author statement, I have not read or written any code; it is a pure AI-agent product. I have personally tested and verified the Hermes, Codex, Pi, OpenCode, and KimiCode agent CLIs. When the orchestrator was first built for Codex, Pi worked normally without any targeted optimization. Beyond the agents I have verified, I am not sure which agents the orchestrator may or may not support; please use your own judgment.
>
> I first made this orchestrator while using Codex. I found that one conversation could only execute serially. Even when using subagents, a task would be split for parallel work and then merged. My habit is to send an agent one long task list at a time, and some tasks have nothing to do with each other, so they can run in parallel. I built this orchestrator to use the CLI of the agent hosting the conversation to run multiple tasks concurrently. After that, I thought: Codex has an orchestrator, and I have other agents on my computer, so why not make it a general tool? That led from codex-tui-orchestrator to open-tui-orchestrator. Their underlying execution idea is essentially the same, but their form differs: codex-tui-orchestrator is a Codex plugin, while open-tui-orchestrator is an npm tool.
>
> I am an independent developer with two years of development experience during university. I have never worked at a large technology company and have rarely had a conventional job. I do this because it feels like the key to my life. While directing agents to develop, I watch videos on Douyin to learn and understand things; I can stay immersed in this activity for more than ten hours a day without feeling tired. AI-agent development has become the most interesting part of my daily life. It makes every day feel full and happy, and I hope to create more and find my own path in the future.

**Repository scope.** This repository contains only the Codex plugin. The multi-agent compatibility described in the statement above belongs to the separate `open-tui-orchestrator` project.

# CTUI — Codex TUI Orchestrator

**CTUI** is the short name of **codex-tui-orchestrator**: a Windows-focused Codex plugin that splits one long task list into blocks and runs only confirmed-independent blocks concurrently. It is a Codex-only plugin, distributed from GitHub through [checkout install](#checkout-install) or the [GitHub marketplace catalog](#github-marketplace-catalog). It is not published to npm.

## Quick start

Inside a Codex conversation (recommended):

1. Install the plugin with one of the two routes below.
2. Give Codex a task list that names two or more independent projects or blocks, for example `Project 1: update the documentation; Project 2: review the tests`.
3. CTUI plans the split, opens one TUI window per confirmed-independent block, and keeps dependent, conflicting, or uncertain work serial. Each task stays unverified until it meets the parent-defined acceptance conditions.

From a terminal (planning and inspection):

```powershell
$pluginRoot = Join-Path $HOME 'plugins\codex-tui-orchestrator'
$workspace  = 'C:\path\to\workspace'
$env:ORCH_SANDBOX  = 'read-only'   # workspace-write / danger-full-access also allowed
$env:ORCH_APPROVAL = 'never'       # or on-request
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$pluginRoot\scripts\bootstrap.ps1" -Action doctor
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$pluginRoot\scripts\bootstrap.ps1" -Action run --workspace $workspace --plan 'Project 1: update the documentation; Project 2: review the tests'
```

- `--plan` prints the plan as JSON on stdout; diagnostics go to stderr.
- Requests that name two or more projects use a deterministic split (seconds, no model call). Other requests use the host CLI planner and fall back to one serial block when planning fails.
- A single-block plan reports `"mode":"inline"`: run it in the current conversation instead of opening a window.

## How it works

- Preserves task identity and groups dependent, conflicting, or uncertain work into serial blocks.
- Launches only confirmed-independent blocks in parallel, queued by the configured resource budget.
- Keeps every task awaiting verification until its parent-defined acceptance conditions pass; a worker report or window closure alone never proves success.
- Native TodoList/spawn cards belong to the host UI; the plugin emits status events for the host to consume.

## Run status and recovery

- `--tasks` / `--status [--run-id <id>]` show the TodoList and each block's execution state.
- `--verify-run <id>` re-checks a saved run; `--resume-run <id>` resumes it.
- Run ledgers and checkpoints live under `<workspace>\temp\orchestrator`.

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

## Troubleshooting

- `INITIATOR_POLICY_UNAVAILABLE`: terminal commands must either run inside the Codex conversation whose workspace you target, or set `ORCH_SANDBOX` and `ORCH_APPROVAL` explicitly. A Codex-bound shell refuses a different workspace by design.
- The doctor report redacts paths and the CLI location by default; set `ORCH_DIAGNOSTIC_FULL_PATHS=1` to show them.
- The first run prepares a pinned Node runtime and the locked Codex CLI/SDK, which needs network access. Deep install paths are supported since 0.9.29-rc.11.
- Planning for requests that do not name distinct projects uses the host CLI and needs a signed-in Codex CLI; if planning fails, CTUI falls back to one serial block.
- Keep secrets out of task prompts; see the [privacy policy](docs/privacy.md) for the redaction and storage boundary. Read the [execution contract](docs/execution-contract.md) before executing a plan.

## Privacy and legal

- [Privacy](docs/privacy.md)
- [Terms](docs/terms.md)
- [MIT License](LICENSE)

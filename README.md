[中文](README-zh.md)

## Author's statement

> This project was built end to end by AI agents (Codex first, then Hermes). Apart from this author statement, I have not read or written any code; it is a pure AI-agent product. I have personally tested and verified it with the Hermes, Codex, Pi, OpenCode, and KimiCode CLIs. When the orchestrator was first built for Codex, Pi worked without any targeted optimization. I have not determined which other agents it may or may not support; please use your own judgment.
>
> I originally built this while using Codex. A single conversation executes serially, and even with subagents, a task is usually split into parallel pieces and then merged. My habit is to send an agent a long list of tasks at once; some are completely unrelated and can run in parallel. I built this orchestrator to use the initiating agent's CLI for concurrent task execution. Once that worked, I generalized the idea for the other agents on my computer: `open-tui-orchestrator` has the same underlying execution model in a different form. `codex-tui-orchestrator` is a Codex plugin; `open-tui-orchestrator` is an npm tool.
>
> I am an independent developer with two years of development experience during university. I have never worked at a large technology company and have rarely held a conventional job. I am doing this because it feels like a key to my life. I direct agents while watching videos on Douyin to learn and explore; I can stay immersed for more than ten hours a day without feeling tired. AI-agent development is now the most interesting part of my daily life, and it makes my days feel full and happy. I hope to create more and find my own path.

The text above is the author's personal statement. The listed agents are personal test experience, not a compatibility promise for every CLI.

# codex-tui-orchestrator

> Version: `0.9.29-rc.1`; execution core: `1.4.4-rc.1`. This is a Codex plugin for the Codex CLI on Windows with Node.js 22+.

Run a long task list in parallel when dependencies, conflicts, and resources allow, then verify each result independently.

## How it works

The orchestrator preserves task identity before it opens any window:

1. **Map relationships**: keep the original task IDs and text, then analyze dependencies, file conflicts, parent/child paths, and unknown scope.
2. **Build execution blocks**: tasks with dependencies, conflicts, or uncertain scope share a serial block; only confirmed-independent blocks run in parallel.
3. **Admit by resources**: before each launch, recheck live memory and keep a `1000 MB` reserve. Among runnable blocks, prefer the one with the higher predicted peak; queue blocks that do not fit.
4. **Verify each task**: every task moves through `started → completed → verified`. The controller reads the workspace back against independent acceptance checks; window closure, a completion marker, or a worker's self-report is not proof of success.

The `1000 MB` value is a scheduling floor, not a mathematical guarantee that the machine cannot run out of memory. Actual concurrency also depends on live memory, existing leases, and task dependencies.

## Modes

| Mode | Use |
| --- | --- |
| `--plan "<request>"` | Plan only, so the initiating agent can inspect the split |
| `--exec "<request>"` | Default headless execution with a durable ledger |
| `--run-windows "<request>"` | Explicit visible Windows TUI execution |
| `--status --run-id <ID> --watch` | Watch the TodoList, blocks, and wait reasons |
| `--resume-run <ID>` | Resume the saved plan and task identities |
| `--verify-run <ID> --acceptance-file <JSON>` | Recheck existing outputs without rerunning tasks |

Workers inherit the initiating conversation's workspace, execution policy, and model settings. Visible windows also start in that workspace. A restricted session cannot use the orchestrator to switch workspaces.

Codex 原生 TodoList/spawn 卡片属于宿主界面；插件提供状态事件供宿主消费。 Native TodoList and spawn cards belong to the host UI; the plugin exposes status events for host consumption.

## Quick start

Clone the repository, then install and register the checkout:

```powershell
git clone https://github.com/yechang1450/codex-tui-orchestrator.git "$HOME\plugins\codex-tui-orchestrator"
Set-Location "$HOME\plugins\codex-tui-orchestrator"
powershell.exe -NoProfile -File ".\scripts\bootstrap.ps1" -Action install
```

The checkout includes `.agents/plugins/marketplace.json`. Bootstrap registers this checkout as the local `codex-tui-orchestrator-local` marketplace, installs `codex-tui-orchestrator` through the host CLI, and verifies the installed copy. It does not reuse an earlier plugin cache.

Installation does not provide credentials. Actual runs also require an enabled and trusted SessionStart hook and a logged-in Codex CLI.

Inspect the plan before executing it:

```powershell
node scripts/orchestrate-sdk.mjs --plan "Project 1: clean build\80; Project 2: clean build\81; Project 3: clean build\82"
node scripts/orchestrate-sdk.mjs --run-id demo-cleanup --acceptance-file .\temp\acceptance.json --exec "Perform the plan and write a checkable result for each task"
```

Use `--run-windows` instead of `--exec` when you need visible windows. `acceptance.json` must stay inside the initiating workspace; the initiating agent defines file, JSON, or deletion checks for each task. Without independent acceptance, a task is not reported as successful. See [environment setup](docs/environment-setup.md) for the full preparation flow.

## Safety boundaries

- If entrypoint, release seal, CLI identity, or workspace checks fail, stop instead of silently substituting another executable.
- Unknown paths or uncertain side effects use conservative serialization; an unproven result becomes `needs-reconciliation` instead of an automatic replay.
- The controller stores the original inventory, attempt tokens, checkpoints, and verification reports; a task is complete only with evidence from the current run.
- Workers must not recursively start the orchestrator, subagents, or extra orchestration windows.
- Run ledgers, checkpoints, and verification reports stay under `temp/orchestrator` in the initiating workspace. Window registration, coordination leases, and immutable bindings stay in Codex's separate state directory; both layers are used for recovery and reconciliation.

## Verification and development

```powershell
npm ci --prefix scripts --omit=optional --ignore-scripts --no-audit --no-fund
node --test --test-concurrency=1 test/*.test.mjs
node scripts/release-integrity.mjs --verify
```

- [Execution and acceptance contract](docs/execution-contract.md): full lifecycle, recovery, and verification rules.
- [RC validation records](docs/rc-validation.md): evidence organized by commit and version.
- [Contributing guide](CONTRIBUTING.md): local development conventions.
- This is an independent personal project and is not endorsed by OpenAI. Packaging and local marketplace conventions follow the [OpenAI plugin documentation](https://developers.openai.com/plugins/build/plugins).

## Related project

`open-tui-orchestrator` is a separate npm tool with the same underlying orchestration model for more general Agent CLIs. It is not bundled in this Codex plugin.

## Privacy and legal

- [Privacy statement](docs/privacy.md)
- [Terms of service](docs/terms.md)
- [MIT License](LICENSE)

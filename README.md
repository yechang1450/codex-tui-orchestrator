# codex-tui-orchestrator

> Author: **Yang Wenchàng**

Split a multi-part request into **safe parallel blocks** and execute them through **real, visible Codex TUI windows** — independent work runs concurrently, anything that would break if run simultaneously stays serialized.

> Plugin name note: the plugin id is `codex-tui-orchestrator` (lowercase hyphen-case, as required by the Codex plugin manifest spec). The `TUI` in the *display name* is uppercase, but the plugin `name` field / directory / GitHub repo are all lowercase `codex-tui-orchestrator`.

## Orchestration design (dependency graph, bounded parallelism)

This orchestrator classifies by a conservative axis:

> **Would running these two tasks at the SAME TIME break something?**

- If **yes** (both edit the same file/config, restart the same service, use the same port/DB, one needs the other's output, one is a prerequisite) → **linked** → merge into ONE block, run **strictly serialized**.
- If **no** (they touch disjoint files/subsystems) → **independent** → each gets its OWN block, run **in parallel**.

## How it runs

- **`--run-windows` (THE engine for real work)** — decomposes, then each **independent** block opens its OWN real **interactive** Codex TUI window (Windows Terminal default) and runs in parallel; each **linked** block stays in ONE window serialized. Before executing it SDK-pre-checks each block against running windows — conflict → it **waits** then executes; still-conflicting blocks are **locked**. Every window **auto-closes** when its task finishes (via session `task_complete`, with a result-written fallback), and results aggregate to `temp/win-summary.json`.
- **`--spawn` (real interactive window)** — opens an actual popup terminal running Codex interactively with the prompt pre-seeded.
- **`--run` / `--exec` (Codex SDK, headless)** — pure automation only (per AGENTS.md, real changes must use `--run-windows`).

## Usage

```bash
node orchestrate-sdk.mjs --plan "1. ... 2. ... 3. ..."
node orchestrate-sdk.mjs --run-windows "1. ... 2. ... 3. ..."
node orchestrate-sdk.mjs --spawn "My Task" "./temp/my-task.md"
```

## Decompose cache (越用越快)

Identical requests are cached for **1 year** and **auto-refresh every Jan 1** (`orchestrator-decompose-cache.json`). The first time a request is seen it is decomposed (rule + LLM); the next identical request hits the cache immediately. This is portable — it works for *any* user, no hardcoded paths.

## Configuration (env, all optional)

| Var | Default | Meaning |
|-----|---------|---------|
| `WORKSPACE_DIR` | `process.cwd()` | Working dir threads/windows operate in (auto-detected; never hardcoded). |
| `CODEX_EXE` | auto-detect | Path to the `codex` CLI. |
| `PYTHON` | `python` | Python to prepend to the spawned window's PATH. |
| `ORCH_MODEL` | `Codex 默认模型（不指定时用 Codex 自身默认）` | Model the threads use. |
| `ORCH_EFFORT` | `high` | Reasoning effort (low/high/max, portable). |
| `ORCH_TIMEOUT_MS` | `20000000` | Total wait for ALL windows to finish before the aggregator stops. |
| `ORCH_DECOMPOSE_TIMEOUT_MS` | `6000000` | Timeout for the read-only LLM decompose/classification. |
| `ORCH_RETRIES` | `2` | Retries before giving up on a block. |
| `ORCH_WAIT_MS` | `120000` | Max wait for a conflicting window to close. |
| `ORCH_CLOSE_DELAY_MS` | `1000` | Read-buffer before a finished window auto-closes. |
| `ORCH_TUI` | `wt` | `wt` = Windows Terminal (best CJK IME), `conhost` = classic console. |

## Encoding & IME

All text I/O is **explicit UTF-8**; launchers set `[Console]::OutputEncoding`/`$OutputEncoding = UTF-8` and read prompts with `-Encoding UTF8`. `.ps1` launchers are written **UTF-8 with BOM** (and `chcp 65001`), so Chinese never becomes mojibake on a Chinese-locale Windows (GBK/936).

## Dependencies

- Node 18+ (ESM).
- `@openai/codex-sdk` (declared in `scripts/package.json`).
- A working Codex CLI (model configurable via `ORCH_MODEL`).

## License

MIT — see `LICENSE`.

## Disclaimer

THIS TOOL AUTOMATES REAL EXECUTIONS. Review the plan first (`--plan`) and back up as needed. Provided **"AS IS"** without warranty; the copyright holders are not liable for damage arising from its use.

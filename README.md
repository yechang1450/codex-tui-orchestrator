# codex-tui-orchestrator

> Author: **Yang Wenchàng**

Split a multi-part request into **safe parallel blocks** and execute them through **real, visible Codex TUI windows** — independent work runs concurrently, anything that would break if run simultaneously stays serialized.

> **搭配 Superpowers 使用，就等于拥有了 plan 并行 + work 并行的完整能力**：Superpowers 负责把"该做什么/怎么拆/步骤"planning 好（brainstorming/writing-plans/subagent-driven-development 的并行计划编排），codex-tui-orchestrator 负责把这些真实执行拆成互不冲突的**独立块并行弹 TUI 窗**落地（work 并行）。二者一"计划并行"、一"执行并行"，配合即得到"从头到尾的高吞吐编排"。

> Plugin name note: the plugin id, `name` field, directory, GitHub repo, and display name are all lowercase hyphen-case `codex-tui-orchestrator`, as required by the Codex plugin manifest spec.

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

Identical requests are cached **indefinitely** (`orchestrator-decompose-cache.json`) and **never auto-expire** — only a manual `--clear-cache` (or deleting the cache file) resets them. The first time a request is seen it is decomposed (rule + LLM); the next identical request hits the cache immediately. This is portable — it works for *any* user, no hardcoded paths.

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

## Sub-skills (disablable, defaults all-on)

The orchestrator is decomposed into a bundle of capability sub-skills under `skills/`, each an independent switch:

| Sub-skill | Purpose | Knob |
|---|---|---|
| `decompose-classify` | request → linked/independent blocks + read-only→inline gate | `ORCH_DECOMPOSE` |
| `conflict-lock` | live-window resource conflicts → wait/lock/rerun | `ORCH_CONFLICT` |
| `dependency-order` | `dependsOn` prerequisite ordering | `ORCH_DEPENDS` |
| `prototype-gate` | deterministic feasibility (L1/L2) | `ORCH_PROTOTYPE` |
| `prototype-llm` | LLM feasibility (L3; disable to save tokens) | `ORCH_PROTOTYPE_LLM` |
| `registry` | cross-process windows/locks store + mutex | `ORCH_REGISTRY` |
| `window-runtime` | launcher / spawn / watchdog / close + result capture | `ORCH_TUI`,`ORCH_CLOSE_DELAY_MS` |
| `gather-results` | poll-windows require-all-success contract | — |
| `enforcement` | armed/assert/kind fail-closed + headless gate | `ORCH_ALLOW_HEADLESS` |
| `decompose-cache` | cache + `--clear-cache` | `ORCH_CACHE` |
| `hygiene` | use-and-discard temp cleanup | `ORCH_KEEP_TEMP` |
| `verify` | `--verify` conflict-key attribution | — |

Disabling a sub-skill turns that capability off (the agent won't set its knob ON). The entry skill (`skills/codex-tui-orchestrator/SKILL.md`) aggregates them and wires the knobs. All LLM reasoning effort defaults to `high`.

## Disclaimer

THIS TOOL AUTOMATES REAL EXECUTIONS. Review the plan first (`--plan`) and back up as needed. Provided **"AS IS"** without warranty; the copyright holders are not liable for damage arising from its use.

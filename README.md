# codex-orchestrator

> Author: **Yang Wenchàng**

Split a multi-part request into **safe parallel blocks** and execute them, so independent work runs concurrently while anything that would break if run simultaneously stays serialized.

## Orchestration design (dependency graph, bounded parallelism)

The underlying model is still a **dependency graph**, but it applies a cap on how much runs at once: **bounded parallelism**. Most orchestrators maximize throughput; this one classifies by a more conservative axis:

> **Would running these two tasks at the SAME TIME break something?**

- If **yes** (both edit the same file/config, restart the same service, use the same port/DB, one needs the other's output, one is a prerequisite) → they are **linked** → merge into ONE block, run **strictly serialized**, never in parallel.
- If **no** (they touch disjoint files/subsystems) → **independent** → each gets its OWN block, run **in parallel**.

This is the dependency graph, **bounded** to only the tasks that provably don't clash: independent blocks run concurrently up to the concurrency limit, while dependent/linked blocks stay serialized. Parallelizing two tasks that both write the same config is exactly how you corrupt a project; the orchestrator refuses to do it.

## How it runs

- **`--run-windows` (THE engine for real work)** — decomposes, then each **independent** block opens its OWN real **interactive** Codex TUI window (Windows Terminal by default) and runs in parallel; each **linked** block stays in ONE window and runs serialized. Before executing it SDK-pre-checks each block against running windows — if it conflicts it **waits** for the conflicting window to close, then executes. Every window **auto-closes** when its task finishes (detected via the session's `task_complete`); the agent's final message aggregates to `temp/win-summary.json`. A block still conflicting after the wait, or colliding with another block in the same batch, is **locked** (not spawned).
- **`--spawn` (real interactive TUI window)** — opens an actual popup terminal running Codex **interactively** with the prompt pre-seeded (Windows Terminal when `ORCH_TUI=wt`, else a classic `cmd /c start` conhost). Best when you want to watch AND interact with a single task; close it manually with `/exit` or Ctrl+C.
- **`--run` / `--exec` (Codex SDK, reliable, headless)** — decomposes and runs each block as a Codex SDK thread (independent blocks concurrent, linked blocks serialized per block), **auto-retries a failed block once**, and writes `temp/win-summary.json` with per-block results. Kept for pure automation only; **not** sanctioned for real changes (see AGENTS.md).

## Usage

```bash
node orchestrate-sdk.mjs --plan "1. ... 2. ... 3. ..."
node orchestrate-sdk.mjs --run-windows "1. ... 2. ... 3. ..."
node orchestrate-sdk.mjs --spawn "My Task" "./temp/my-task.md"
```

`--plan` uses a read-only thread and prints the block classification so you can review it before executing. `--run-windows` is the engine to use for real executions.

## Install

```bash
npm install @openai/codex-sdk
```

Then run the script from `scripts/`. Set the Codex CLI executable via `CODEX_EXE` (it auto-detects a few common locations, and falls back to `codex` on PATH).

## Configuration (env vars, all optional)

| Var | Default | Meaning |
|-----|---------|---------|
| `WORKSPACE_DIR` | `process.cwd()` | Working directory the threads/windows operate in. |
| `CODEX_EXE` | auto-detect | Path to the `codex` CLI binary. |
| `PYTHON` | `python` | Python to prepend to the spawned window's `PATH` (for model/venv scripts). |
| `ORCH_MODEL` | `deepseek-v4-flash-vision-exp` | Model the threads use. |
| `ORCH_EFFORT` | `high` | Reasoning effort. |
| `ORCH_TIMEOUT_MS` | `420000` | Treat a block attempt as failed after this long. |
| `ORCH_RETRIES` | `2` | How many retries before giving up on a block. |
| `ORCH_WAIT_MS` | `120000` | Max time to WAIT for a conflicting running window to close before executing. |
| `ORCH_CLOSE_DELAY_MS` | `1000` | Read-buffer before a finished window auto-closes (~1s). The interactive launcher also self-closes via its own watchdog when the session rollout reaches `task_complete`, so auto-close never depends on the orchestrator being alive. |
| `ORCH_TUI` | `wt` | Terminal hosting the visible Codex window: `wt` = Windows Terminal (best IME/输入法 support for CJK), `conhost` = classic console (reliable but limited IME for TUI apps). |

## Encoding & IME (hard-won lessons)

All text I/O is **explicit UTF-8**. The window launcher sets `[Console]::OutputEncoding`/`$OutputEncoding = UTF-8` and reads the prompt with `-Encoding UTF8`, and `.ps1` launchers are written **UTF-8 with BOM**. This is what prevents Chinese text from becoming mojibake on a Chinese-locale Windows (the OS default is GBK/codepage 936 — do not rely on it).

The launchers also run `chcp 65001` and set `[Console]::InputEncoding = UTF-8`, so the **input** code page (default 936/GBK on Chinese-locale Windows) no longer clashes with what Codex expects. Without this, the Microsoft Pinyin IME can intermittently fail to commit in the TUI. For the strongest IME/TSF support, host the TUI in **Windows Terminal** with `ORCH_TUI=wt` (conhost is reliable but its IME support for full-screen TUI apps is limited).

The `--run-windows` window runs the **interactive** TUI (`codex --cd <workspace> -a never --sandbox danger-full-access <prompt>`), which does not auto-exit on completion; the orchestrator watches the session rollout for `task_complete` and terminates the window. `codex exec` (headless) is still used by `--run`/`--exec` for pure automation.

## Dependencies (@openai/codex-sdk)

- Node 18+ (ESM modules).
- `@openai/codex-sdk` — the SDK this orchestrator drives; declared in `scripts/package.json` (`"@openai/codex-sdk": "0.149.0"`).
- A working Codex CLI (OpenAI Codex or a compatible provider; the model is configurable via `ORCH_MODEL`).

## Implementation / 实现思路

1. **拆块**：把多步骤请求按「并发冲突」拆成 `linked`（联动→单窗串行）与 `independent`（独立→并行多窗）两类块。
2. **只读分析先过**：先 `--plan`（只读线程）打印块结构供审阅；真执行才 `--run-windows`。
3. **真实 TUI 窗执行**：`--run-windows` 为每个 independent 块弹真可见、可交互的 Codex TUI 窗并并行运行；linked 块单窗串行。
4. **冲突上锁**：执行前 SDK 预检与运行中窗口冲突，冲突则等待/上锁，完成后自动关窗并归档 `temp\win-summary.json`。
5. **强制门**：`codex-TUI-orchestrator-force.mjs` 做可检查门禁（`--assert`/`--status`/`--verify`），`codex-TUI-orchestrator-preflight.mjs` 做只读预检，禁止 headless 绕过弹窗。

## Effect / 效果

- 多步任务按冲突自动并行/串行，最大化并发又不冲突。
- 每次真实执行都有可见 TUI 窗，用户能看进程、能盯输出、能手动介入。
- 强制门禁保证真实执行只走 TUI 窗，headless 绕过被拒；结果自动汇总到 `win-summary.json`。

## License

Released under the [MIT License](./LICENSE). See the `LICENSE` file for the full text together with a Chinese explanation of what it permits, the single condition, and the warranty disclaimer.

## Disclaimer

THIS TOOL AUTOMATES REAL EXECUTIONS (write / build / install / test / restart / process management). It can modify project files, restart services, and carry operational or data risk. Review the plan first (`--plan`) and back up as needed before running. It is provided **"AS IS"** without warranty of any kind; the copyright holders are not liable for any direct or indirect damage arising from its use.

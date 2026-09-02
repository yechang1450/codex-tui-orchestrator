# agent-tui-orchestrator

> Author: **Yang Wenchàng**

Split a multi-part request into **safe parallel blocks** and execute them through **real, visible Codex TUI windows** — independent work runs concurrently, anything that would break if run simultaneously stays serialized.

> **搭配 Superpowers 使用，就等于拥有了 plan 并行 + work 并行的完整能力**：Superpowers 负责把"该做什么/怎么拆/步骤"planning 好（brainstorming/writing-plans/subagent-driven-development 的并行计划编排），agent-tui-orchestrator 负责把这些真实执行拆成互不冲突的**独立块并行弹 TUI 窗**落地（work 并行）。二者一"计划并行"、一"执行并行"，配合即得到"从头到尾的高吞吐编排"。

> Plugin name note: the plugin id, `name` field, directory, GitHub repo, and display name are all lowercase hyphen-case `agent-tui-orchestrator`, as required by the Codex plugin manifest spec.

## Complete implementation approach (request → on-disk)

### 0. The core classification axis

The orchestrator is driven by one conservative question:

> **Would running these two tasks at the SAME TIME break something?**

- If **yes** (same file/config, same service restart, same port/DB, one needs the other's output, one is a prerequisite) → **linked** → merged into ONE block, run **strictly serialized**.
- If **no** (disjoint files/subsystems) → **independent** → its own block, run **in parallel**.

Two orthogonal dimensions are modeled separately and deliberately:
- **Logical order (dependency)** → `dependsOn` → decides *when* a block runs (prerequisite ordering).
- **Resource overlap (conflict)** → `conflictKeys` → decides *whether* two blocks may start at the same time.

Dependencies are about ordering; conflicts are about mutual exclusion — they are **not** the same thing, and this separation is the backbone of the design.

### 1. Lifecycle

```
request → ①mode-classify → ②decompose(cache/rule/LLM/fallback) → ③normalize
        → ④level-waves → ⑤per-wave conflict-gate + prototype-gate + popup
        → ⑥in-window authorized exec + self-verify → ⑦report-triggered auto-close
        → ⑧aggregate win-summary → ⑨poll contract → ⑩cleanup + parent re-verify
```

#### ① Execution-mode classify (`classifyExecutionMode`)
Read-only vs real detection. Read-only words with no real action → `inline` (stay in the main conversation, no popup). Real action with no read-only → `execute` (must popup). Ambiguous / neither → let the LLM decide, and on LLM failure **fail-safe `execute`** (never skip a real execution by misclassifying it as read-only).

#### ② Two-stage decompose (`decomposeSafely`) — the core
**LLM is qualitative; determinism decides how to block/order.** The LLM only says "which natural tasks exist", never how to group/sort/place them (that is code, and reliable). Path order:

1. **Cache first** (hints-aware). Key = `sha1(requestText + projectHints)` — hints (module→project map, fold rules, tail keywords) are project-specific config and MUST be part of the key, or the same sentence would collide across projects. Never auto-expires; only `--clear-cache` resets it.
2. **`genericProjectSplit`** — request names several distinct project dirs → split into independent blocks (no LLM, instant, cached).
3. **`trySingleBlock`** — a clear single action → one block (no LLM).
4. **LLM two-stage**:
   - `classifyPrompt` → flat task list `{tasks:[{id,summary,kind,project,hint,conflict_hints,depends_on,feasible,already_done}]}` (few fields, no tools, pure JSON).
   - `extractTasks` → parse JSON (strip code fences, tolerant).
   - `buildBlocksFromTasks` → deterministic block engine: group by project, tool tasks independent, unknown items → linked, dependency mapping (guards self-references with `i !== j`), **feasibility filter** (`feasible=false` / `already_done=true` tasks are dropped here — this is the "no wasted window" guarantee).
5. LLM failure/timeout is retried, then `fallbackPlan` → single serial window (guarantees the batch lands).

#### ③ Normalize (`normalizePlan`) — anti-over-merge / anti-self-conflict
- An `independent` block carrying multiple tasks → split into one block per task (prevents the model over-merging into a single parallel block).
- Two blocks sharing a `conflictKey` → merged into one linked block (prevents a block fighting itself).

#### ④ Level waves (`levelWaves`)
Normalize every block's `dependsOn` to block keys, **strip self-references and unknown targets**, then level into waves: same wave = parallelizable; between waves = ordered. This makes real ordering reliable — a self-referential `dependsOn` (e.g. `task-2:["task-1","task-2"]`) previously defeated serialization by never being satisfiable.

#### ⑤ Per-wave spawn (conflict lock + prototype gate + popup)
For each block, before spawning:
- **Conflict check** `conflictByKeys` against **running windows** (registry + `windowAlive`). Overlap → `waitClear` (poll); still conflicting → **lock** (terminal, not a false window); released → auto-rerun (never silently dropped).
- **In-batch double-check** — re-check against already-spawned blocks this wave.
- **Prototype gate** `runPrototypeGate` — L1 empty/no-action → reject; L2 complexity (multi-sentence / analysis / long → complex, informational only). Feasibility is already decided at decompose (no extra per-block LLM, cost-friendly).
- **Registry write** `updateWindows` (load+mutate+save inside an exclusive lock, append-only, no cross-process lost-update).
- **`writeInteractiveLauncher`** — prompt = `buildBlockPrompt(blockBody, token)` + `auth`; writes `win-launch-*.ps1` (UTF-8 + BOM + `chcp 65001`), `codex-win-*.md`, `window-*.pid`.
- **`spawnWindowWithRetry`** — pop a real visible window (Windows Terminal preferred, conhost fallback); popup detection (poll pid file, up to 3 retries); if it truly never popped → `popup-failed`, never treated as running.

#### ⑥ In-window authorized execution + self-verify
The window agent receives a full-authorization prompt with hard constraints baked in: no nesting (no `--run-windows`/`--spawn`/new window), no stalling (must not ask "need authorization?"), must self-verify every change (read back + UTF-8 no BOM, run regression, no leftover temp / no mojibake), and must report honestly.

#### ⑦ Report-triggered auto-close
The launcher runs a watchdog over the session rollout. A window only auto-closes once a message containing **this block's real token + 完成** is captured (`own completion report CAPTURED`), then waits ~1s before closing. Planned/intermediate messages (without 完成) are never misfired. Fallback: even if rollout matching fails, if the result file has `__DONE__` the parent does `done-and-close`.

#### ⑧ Aggregate → `win-summary.json`
Each block writes a result. Completion is judged by **"have all results truly returned"**, not "are all windows closed": a block resolves when it has a real report, or was correctly intercepted (`preflight-failed`/`locked`/`unfinished`/`popup-failed`). `uncaptured`/`failed`/`timeout` remain unresolved — never finish early.

#### ⑨ Poll contract (`poll-windows.mjs --require-all-success`)
After `--run-windows`, the initiator MUST poll until all blocks are in the success set (`done/ok/completed/done-retried` + correctly-intercepted `preflight-failed/locked/unlocked`) and no windows alive → exit 0. Otherwise poll to timeout and exit 1 (never claim success on `uncaptured`/`failed`/`timeout`). Anti-race: summary must be fresh (mtime) + stable for 2 cycles; a zero-window-but-complete summary also terminates (closes the "window closed before summary refreshed" race).

#### ⑩ Cleanup + parent verification
- `ORCH_KEEP_TEMP!=1` → use-and-discard: delete `win-launch-*`/`codex-win-*`/`window-*.pid`/`win-*.result.json`; **never** delete `win-summary.json`.
- Parent independently re-verifies with `--verify`/read-back, never trusts the in-window self-report; mismatch → disk truth wins and is corrected.

### 2. Enforcement (real work must go through a window)

`force.mjs` turns "real execution goes through a visible TUI window" into a checkable invariant:
- **armed** via `.orchestrator-enabled` (timestamp). Once armed, a real-execution kind from a non-window context is refused.
- **`--assert <kind>`** → 0(ok)/1(refused). A window sets `CODEX_ORCH_WINDOW=1`, but that env alone is not trusted — it must be backed by a live registered window (registry + pid + tasklist + command line matching `win-launch-*.ps1`/`orchestrate-sdk`). Read-only kinds pass; unknown kinds **fail-closed**.
- **`--verify <file>`** — attribute a changed file to an authorized in-window write via `conflictKeys`, using **path-aware matching** (strip `file:/dir:/port:/service:` prefixes; exact / dir-prefix / basename / path-segment). No live window → VIOLATION; multiple live windows → INDETERMINATE; exactly one with a hit → PASS.
- **`preflight.mjs`** — a before-you-run decision, reusing force's `armed`/`liveWindows` (read-only → ok; real + not-a-window → REFUSED).

### 3. Cross-process registry & concurrency

- **`withRegistryLock`** — `openSync('wx')` atomic exclusive lock to serialize registry writes; **stale-lock age-out** (>30s holder considered dead, removed and retried); warned if still unacquired.
- **`saveJson`** — `tmp + rename`; Windows `renameSync` won't overwrite → `rm` then `rename`, no half-write; readers briefly retry over the transient gap.
- **`updateWindows`/`updateLocks`** — the whole `load+mutate+save` happens under one lock → no cross-process lost-update.
- **`windowAlive`** — pid file exists + process in tasklist + result file has no `__EXIT__` (so a done-but-zombie launcher isn't treated as running).

### 4. Correctness invariants

1. **No nesting** — a window may not re-invoke the orchestrator or open another window.
2. **No wasted window** — feasibility decided at decompose + deterministic L1/L2 gate.
3. **No fake success** — report must contain the real token + 完成, and must self-verify; capture uses the token as the sole anchor.
4. **No lost report** — close anchor = report captured; delay before closing.
5. **No broken serialization** — `levelWaves` strips self/unknown dependencies.
6. **No cross-project collision** — cache key includes the project-hints fingerprint.
7. **No forged pass** — fail-closed enforcement; command-line + live-window-backed auth.
8. **No pollution** — use-and-discard temp; explicit UTF-8; `.ps1` with BOM; source==cache (one-family consistency).
9. **Fail-safe execution** — ambiguous mode → execute; LLM failure → serial fallback.
10. **Cost-friendly** — deterministic fast paths avoid the LLM; feasibility is not re-queried per block; decompose cache hits reuse.

### 5. Initial environment check

Before real work the orchestrator verifies: the codex CLI (detect/install) and **disk space** on the workspace drive via `statfsSync`. Free space below `ORCH_MIN_FREE_MB` (default 12000MB ≈12GB) warns; below `ORCH_MIN_FREE_HARD_MB` (default 3600MB ≈3.6GB) refuses (fail-closed) — a low disk cannot even write the launcher/temp files. If `ORCH_MIN_FREE_HARD_MB` is set above `ORCH_MIN_FREE_MB`, the hard floor is clamped to the warn threshold.

The disk check is **strict** for the real-execution entry points (`--run-windows`/`--spawn`), **warn-only** for the read-only `--plan` (it never blocks a plan), and **not invoked** for `--status` (runtime state, unrelated to disk; also called in the poll loop).

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
| `ORCH_MIN_FREE_MB` | `12000` | Workspace drive free space (MB) below which a warning is emitted before running (≈12GB). |
| `ORCH_MIN_FREE_HARD_MB` | `3600` | Hard floor (MB) below which the orchestrator refuses to run (fail-closed, ≈3.6GB); clamped to `ORCH_MIN_FREE_MB` if set higher. |

## Encoding & IME

All text I/O is **explicit UTF-8**; launchers set `[Console]::OutputEncoding`/`$OutputEncoding = UTF-8` and read prompts with `-Encoding UTF8`. `.ps1` launchers are written **UTF-8 with BOM** (and `chcp 65001`), so Chinese never becomes mojibake on a Chinese-locale Windows (GBK/936).

## Dependencies

- Node 18+ (ESM).
- `@openai/codex-sdk` (declared in `scripts/package.json`).
- A working Codex CLI (model configurable via `ORCH_MODEL`).

## License

MIT — see `LICENSE`.

## Capabilities (single skill, multi-in-one)

The plugin exposes **one skill** (`skills/agent-tui-orchestrator/SKILL.md`) that embeds all orchestrator capabilities. There are no per-capability sub-skills and no switches; everything is always enabled:

| Capability | Purpose |
|---|---|
| Decompose/classify | request → linked/independent blocks + read-only→inline gate |
| Conflict lock | live-window resource conflicts → wait/lock/rerun |
| Dependency order | `dependsOn` prerequisite ordering |
| Prototype gate | deterministic L1 empty-check + L2 complexity; feasibility decided at decompose |
| Registry | cross-process windows/locks store + mutex |
| Window runtime | launcher / spawn / watchdog / close + result capture |
| Gather results | poll-windows require-all-success contract |
| Enforcement | armed/assert/kind fail-closed + headless gate |
| Decompose cache | cache + `--clear-cache` |
| Hygiene | use-and-discard temp cleanup |
| Verify | `--verify` conflict-key attribution |

Tunable knobs are environment variables only (`ORCH_*`); none of them disables a capability. All LLM reasoning effort defaults to `high`.

## Disclaimer

THIS TOOL AUTOMATES REAL EXECUTIONS. Review the plan first (`--plan`) and back up as needed. Provided **"AS IS"** without warranty; the copyright holders are not liable for damage arising from its use.

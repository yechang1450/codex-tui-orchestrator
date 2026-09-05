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
- **`blockBody` serial fallback** — as long as one window carries >1 task it NEVER says "mutually independent / run in parallel"; it always says "serial: do task 1, then task 2". A cascade block (write s.txt → read it and append z.txt) was once mis-typed `independent` and told the window "parallel", misleading the in-window agent to treat dependent tasks as independent and skip the second step (disk missing but status=done). This fallback guarantees any multi-task window receives serial semantics.

#### ④ Level waves (`levelWaves`)
Normalize every block's `dependsOn` to block keys, **strip self-references and unknown targets**, then level into waves: same wave = parallelizable; between waves = ordered. This makes real ordering reliable — a self-referential `dependsOn` (e.g. `task-2:["task-1","task-2"]`) previously defeated serialization by never being satisfiable.

#### ⑤ Per-wave spawn (conflict lock + prototype gate + popup)
For each block, before spawning:
- **Conflict check** `conflictByKeys` against **running windows** (registry + `windowAlive`). Overlap → `waitClear` (poll); still conflicting → **lock** (terminal, not a false window); released → auto-rerun (never silently dropped).
- **In-batch double-check** — re-check against already-spawned blocks this wave.
- **Atomic claim** — before the real popup, write a `pending` reservation (`pid=0`) under the registry lock; it is immediately visible to other processes as occupied, closing the "two processes both checked clear" race. Commit the real pid after popup; stale pending (>120s) self-expires.
- **Prototype gate** `runPrototypeGate` — L1 empty/no-action → reject; L2 complexity (multi-sentence / analysis / long → complex, informational only). Feasibility is already decided at decompose (no extra per-block LLM, cost-friendly).
- **Registry write** `updateWindows` (load+mutate+save inside an exclusive lock, append-only, no cross-process lost-update; reservations + live windows share the same conflict-key space).
- **`writeInteractiveLauncher`** — prompt = `buildBlockPrompt(blockBody, token)` + `auth`; writes `win-launch-*.ps1` (UTF-8 + BOM + `chcp 65001`), `codex-win-*.md`, `window-*.pid`.
- **`spawnWindowWithRetry`** — pop a real visible window (Windows Terminal preferred, conhost fallback); popup detection uses **pid file + launcher (WT pane host) process alive** double evidence (up to 3 retries); if it truly never popped → `popup-failed`, never treated as running.

#### ⑥ In-window authorized execution + self-verify
The window agent receives a full-authorization prompt with hard constraints baked in: no nesting (no `--run-windows`/`--spawn`/new window), no stalling (must not ask "need authorization?"), must self-verify every change (read back + UTF-8 no BOM, run regression, no leftover temp / no mojibake), and must report honestly.

#### ⑦ Getting the result: `done` = "work finished" (NOT "succeeded") — the orchestrator goes on-site, not on-trust

**Design rationale (from a childhood memory):** As a kid in the factory office, a worker would come up to my father, deliver a report, and leave. I asked my father: aren't you afraid that person didn't report truthfully? He said, **after every report he personally walks over to see how the work actually turned out — and the timing is deliberately unpredictable.** Precisely because "he goes on-site to spot-check, at random times," nobody dares to deceive him. Inspecting the actual site is both more reliable and more direct than reading paper reports. After repeatedly failing to get TUI windows to report-and-self-close, I remembered this lesson and transplanted the idea here.

**How it lands in the orchestrator:**

- **The TUI window does NOT write a long report — it emits exactly one ending marker `__ORCH_DONE__ <window-token>`.** That marker means only "I stopped working" (`done` = finished), **not "I succeeded."**
- **The launcher watchdog accepts ONLY that ending line** — and only when it is an `agent_message` / `"role":"assistant"` message, never the injected prompt text (which literally teaches the agent to end with `__ORCH_DONE__ <token>`; without a role/type filter, the watchdog would misread that instruction as completion and self-close before the agent did any work, dropping the task). On hit it writes `.self-closed`, kills the codex tree, and `exit 0` auto-closes.
- **`Write-Result` no longer requires captured report text** — once codex ends, it writes result + `.self-closed`; it best-efforts the report text (records it if present, else flags "verify disk state").
- **The parent judges completion as "execution ended => `done`"** — never `uncaptured`/failed/retry for a missing token or missing report text.
- **Whether the work actually met the prompt is judged AFTER close by checking real on-disk state** (file/state level), not by analyzing the in-window self-report. That is "father walks to the site": reports can lie, the site cannot.
- Watchdog horizon follows the parent poll ceiling (+10 min; `ORCH_WATCHDOG_MAX_MIN` overrides), so long tasks still auto-close if the parent dies.

#### ⑧ Aggregate → `win-summary.json`
Each block writes a result. `status` is based on "execution ended = done" (marker/`.self-closed`/codex exit => done), **never unresolved for missing report text**; `result` best-efforts the window text (records it if present, else notes "verify real on-disk state per the task prompt"). Real success/failure is decided by the orchestrator reading the site after close, not by the summary's self-reported text.

#### ⑨ Poll contract (`poll-windows.mjs --require-all-success`)
After `--run-windows`, the initiator MUST poll until all blocks are in the success set (`done/ok/completed/done-retried/done-on-disk` + correctly-intercepted `preflight-failed/locked/unlocked`) and no windows alive → exit 0. Otherwise poll to timeout and exit 1 (never claim success on blocks that did not execute to end, e.g. `timeout`/`popup-failed`/`preflight-failed`). Anti-race: summary must be fresh (mtime) + stable for 2 cycles; a zero-window-but-complete summary also terminates (closes the "window closed before summary refreshed" race).

#### ⑩ Cleanup + parent verification
- `ORCH_KEEP_TEMP!=1` → use-and-discard: delete `win-launch-*`/`codex-win-*`/`window-*.pid`/`win-*.result.json` plus `.self-closed` markers; cleanup protects any file whose pid process is still alive (never deletes a running window's artifacts); **never** delete `win-summary.json`.
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
3. **No fake success** — the TUI window emits only `__ORCH_DONE__ <token>`; it needn't compose a "success report." Whether it met the prompt is judged by the orchestrator on-site against real on-disk state, which can't lie.
4. **No lost task** — `done` = execution ended (marker/`.self-closed`/codex exit), never misjudged as incomplete/retried for missing report text; `warmupWindow` waits for the codex child to actually start after popup so the parent never races the session rollout.
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
| `CODEX_HOME` | `~/.codex` | Authoritative Codex home dir. **Cross-user / cross-device / cross-host** adaptation point: every `.codex` path is derived from it (never hardcoded `C:\Users\<user>\.codex`). |
| `ORCH_STATE_DIR` | `$CODEX_HOME/orchestrator` | Stable runtime/state dir (registry, locks). Must NOT live in a dir wiped on plugin upgrade. |
| `ORCH_SESSION_DIR` | `$CODEX_HOME/sessions` | Session rollout dir. |
| `ORCH_SUPERPOWERS_CACHE_DIR` | auto-detect | Override superpowers plugin cache path (different host/market layouts). |
| `ORCH_AGENT` | `codex` | Which agent to run: `codex`\|`claude`\|`gemini`\|`opencode`\|`aichat`. Falls back to `codex` automatically if the requested CLI is absent. |
| `CODEX_EXE` | auto-detect | Path to the `codex` CLI. |
| `PYTHON` | `python` | Python to prepend to the spawned window's PATH. |
| `ORCH_MODEL` | `deepseek-v4-flash-vision-exp` | Model the threads use. |
| `ORCH_EFFORT` | `high` | Reasoning effort (low/high/max, portable). |
| `ORCH_TIMEOUT_MS` | `21600000` | Total wait for ALL windows to finish before the aggregator stops (6h default). |
| `ORCH_DECOMPOSE_TIMEOUT_MS` | `60000` | Timeout for the read-only LLM decompose/classification. |
| `ORCH_DECOMPOSE_RETRIES` | `2` | Decompose LLM retries before the deterministic fallback is used. |
| `ORCH_WAIT_MS` | `120000` | Max wait for a conflicting window to close. |
| `ORCH_WATCHDOG_MAX_MIN` | `poll ceiling + 10 min` | In-window auto-close watchdog horizon (min). |
| `ORCH_CLOSE_DELAY_MS` | `1000` | Read-buffer before a finished window auto-closes. |
| `ORCH_TUI` | `wt` | `wt` = Windows Terminal (best CJK IME), `conhost` = classic console. |
| `ORCH_MIN_FREE_MB` | `12000` | Workspace drive free space (MB) below which a warning is emitted before running (≈12GB). |
| `ORCH_MIN_FREE_HARD_MB` | `3600` | Hard floor (MB) below which the orchestrator refuses to run (fail-closed, ≈3.6GB); clamped to `ORCH_MIN_FREE_MB` if set higher. |

### Generalization (cross-device / cross-agent / cross-user)

The orchestrator is **generalized**: a host only needs to inject `CODEX_HOME` (plus optional `ORCH_STATE_DIR` / `ORCH_SESSION_DIR` / `ORCH_AGENT`) and the *same* code runs on any user's Windows device and any mainstream agent — no source change required.
- **Different users/devices**: all `.codex` paths come from `CODEX_HOME` (not `C:\Users\<user>\.codex`); agent cache + transient artifacts live in a stable home dir, never in a plugin dir wiped by cachebuster.
- **Different agents**: `agent.mjs` ships a table for `codex`/`claude`/`gemini`/`opencode`/`aichat`, probes each CLI, `ORCH_AGENT` selects it; the launcher/watchdog closes on the generic end marker `__ORCH_DONE__ <token>` for all of them.
- **Different users**: read-only capability probes (superpowers/config/CLI) degrade silently instead of erroring; unauthorised writes (e.g. hosts) emit a copyable elevation command rather than hard-writing.
- **Cross-platform windows**: prefers Windows Terminal (`wt`), falls back to `conhost` (`cmd /c start`).

## Encoding & IME

All text I/O is **explicit UTF-8**; launchers set `[Console]::OutputEncoding`/`$OutputEncoding = UTF-8` and read prompts with `-Encoding UTF8`. `.ps1` launchers are written **UTF-8 with BOM** (and `chcp 65001`), so Chinese never becomes mojibake on a Chinese-locale Windows (GBK/936).

> **TUI render-overlap fix**: the in-window prompt markers (three-pass check, on-site self-verify) previously used `①②③`, whose ambiguous CJK width can overlap the adjacent glyph in Windows Terminal. They are now `1)`/`2)`/`3)` (pure ASCII width) to avoid that overlap.

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
| Conflict lock | live-window resource conflicts → wait/lock/rerun; atomic pre-spawn reservation closes cross-process double-popup races |
| Dependency order | `dependsOn` prerequisite ordering |
| Prototype gate | deterministic L1 empty-check + L2 complexity; feasibility decided at decompose |
| Registry | cross-process windows/locks store + mutex + `pending` reservations |
| Window runtime | launcher / spawn / watchdog / close + result capture |
| Gather results | poll-windows require-all-success contract |
| Enforcement | armed/assert/kind fail-closed + headless gate |
| Decompose cache | cache + `--clear-cache` |
| Hygiene | use-and-discard temp cleanup (incl. `.self-closed` markers; live windows protected) |
| Verify | `--verify` conflict-key attribution |

Tunable knobs are environment variables only (`ORCH_*`); none of them disables a capability. Model/effort default to `deepseek-v4-flash-vision-exp` / `high` (`ORCH_MODEL`/`ORCH_EFFORT` override).

## Disclaimer

THIS TOOL AUTOMATES REAL EXECUTIONS. Review the plan first (`--plan`) and back up as needed. Provided **"AS IS"** without warranty; the copyright holders are not liable for damage arising from its use.

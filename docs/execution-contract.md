# Dedicated execution contract (core 1.4.0-rc.1, run protocol 2)

The dedicated Codex plugin uses a physical release snapshot of scripts/core and verifies release.json at startup. Generic development is isolated from the dedicated source and installed cache. Changes are promoted explicitly only after verification; repair.mjs --target creates a fresh release directory. See release-policy.md. This repository accepts Codex only; generic adapters evolve separately in open-tui-orchestrator.

## Planning and capacity

Concurrency is governed by a runtime memory budget (`ORCH_CAPACITY_MODE=dynamic`): planning preserves every atomic task and only groups dependency, conflict or unknown-scope components into serial blocks. Blocks with no cross-block dependency or resource conflict remain independent. If the result has one block, the initiating conversation executes it directly. Before orchestration, available memory below 4000 MB returns inline. Before every launch, the coordinator atomically reads available memory and reserves the block's predicted peak plus existing unconsumed reservations. A block starts only when the predicted peak remains strictly below available memory minus the mandatory 4000 MB reserve. A block that does not fit is deferred and rechecked after a running block releases its lease; there is no merge-to-fit and no hard-run escape. Every window uses the rolling observed cost (default 400 MB, with declared task memory added once per serial block); observed peaks above 800 MB are retained. Each block starts as soon as its own prerequisites are verified and a memory/resource lease is available. A dependent of A does not wait for unrelated B. Reject unknown, self and cyclic dependencies before launching. Merge transitive resource conflicts and preserve dependency order. Windows file locks normalize case, separators and existing junction ancestors, and account for directory containment.

The parent persists manifest.json with the original request, the structured TodoList and T001... task identities before asking the planner. Model already_done/feasible flags never authorize omission. Uncertain model coverage falls back to the complete original inventory in a serial block. Each block receives the global TodoList plus its current block view.

Task parsing preserves ordinary comma continuations and quoted command separators. Deterministic planning uses the same boundaries as the original ledger. Semantic classification must return the original IDs; the parent restores original text by ID before grouping. A paraphrased summary cannot silently collapse otherwise valid parallel work into the coverage fallback.

## Execution and verification

The initiating agent chooses a unique run ID and defines independent acceptance checks before launch. This is automatic parent preparation, not a user approval prompt.

Global CLI options precede the free-form execution request. Option-like words after the request begins remain task text. Commands that take a run ID, such as `--verify-run`, also accept their options after that ID. JSON acceptance compares nested object contents structurally, so object key order does not change the result; array order and actual values still matter.

- Execute: node <absolute-entry> --run-id <id> --acceptance-file <absolute-json> --exec <request>
- Poll: node <absolute-scripts>/poll-windows.mjs --run-id <id> --require-all-success
- Recheck outputs without rerunning tasks: node <absolute-entry> --verify-run <id> --acceptance-file <absolute-json>
- Recover the saved plan after interruption: node <absolute-entry> --resume-run <id>

Capacity retries require a structured provider error. A user prompt, tool result, final answer or unstructured stderr containing an overload phrase is not permission to replay work. A completed checkpoint with independently verified output remains successful even if the provider subsequently reports overload. A started task with an unproven result keeps `needs-reconciliation` in task status when its execution block times out or exhausts retries.

Recoverable reconnect notifications do not invalidate a later successful `turn.completed` and zero CLI exit. A terminal `turn.failed`, invalid stream, nonzero exit or cancellation still fails execution. Completed tasks without parent checks keep `awaiting-verification`; neither network recovery nor capacity handling supplies missing acceptance conditions.

A known failed CLI exit is published as `failed`, not as a polling timeout. The planner and both execution modes inherit the latest structured settings of the initiating Codex turn: model, reasoning effort and service tier. Native `CODEX_HOME/config.toml` fills missing turn fields; `ORCH_MODEL`, `ORCH_EFFORT` and `ORCH_SERVICE_TIER` are fallback values only when no initiating or native value exists.

Visible watchdog self-close is an execution exit rather than a timeout; it still requires independent task verification. The settings snapshot is applied to every visible and headless worker before launch, so a worker cannot silently select another model or reasoning level. They inherit the configured model provider and credentials by default, including third-party providers configured in CODEX_HOME. `ORCH_PROVIDER=openai-https` selects the hardened OpenAI-authenticated HTTPS Responses provider instead; a configured `ORCH_OPENAI_BASE_URL` (or legacy `ORCH_STEADY_RELAY_BASE_URL`) implies that mode and is normalized and passed to the planner and the visible/headless workers alike. An explicit `ORCH_PROVIDER=inherit` keeps inheritance even when a relay URL is set, and any other value fails closed.

Each run owns workspace/temp/orchestrator/runs/<id>/{manifest.json,summary.json,acceptance.json,attempts/,verification-report.jsonl}. Every attempt records its exact remaining task IDs and a unique token. The TUI runs the supplied checkpoint command before and immediately after each task. The start record is created exclusively; a duplicate start fails. Poll requires the exact run ID, every planned block, every original task, verified statuses and closed launcher identities. An unrelated or previous run never satisfies this check. Failed prerequisites block dependants and remain in the task ledger. After a worker exits and its owned process is proven gone, its block enters one FIFO verification queue; verification never runs concurrently and never inspects live blocks. A completion marker or window closure alone is not success. Missing acceptance checks produce awaiting-verification, never a false pass. The parent can supply checks and recheck the same run without another TUI execution.

Acceptance JSON maps T001, T002... to arrays of parent-defined checks. Supported checks:

    {"T001":[{"type":"json","path":"temp/result.json","equals":{"answer":42}}]}

file checks require a regular file and optionally sha256; json checks compare specified top-level values; absent checks confirm deletion. Check paths stay inside the initiating workspace and cannot traverse an existing symbolic link or junction. command checks run an explicit executable with an args array, shell disabled, from the initiating workspace; they check exitCode (default 0) and optional stdout. Checks may run repeatedly, so they must be read-only. The parent must choose checks that establish the intended result: file existence alone is insufficient for semantic correctness. Acceptance commands are parent-authored verification code and are not a sandbox or trust boundary; do not accept task-controlled command strings. Checkpoint tokens identify this execution; they are not a security boundary against an intentionally malicious agent.

## Interruption and recovery

Typed provider account-quota errors such as usage_limit_exceeded are terminal for the invocation. The adapter accepts them from a typed `error`/`turn.failed` event or a structured `task_complete.error`; task text and tool output remain data. The runner records the provider error, closes the owned window, and skips both capacity backoff and the ordinary replacement-window budget; a later invocation may retry after the provider quota resets.

The launcher invokes the CLI once. It preserves failure evidence instead of blindly replaying a whole block. The controller independently rechecks every checkpoint and retries only remaining work, with a bounded attempt count (default two per block per controller) and backoff. Replacement windows use the same planned block and cannot exceed global concurrent capacity; verified tasks are omitted from their prompts.

If a task started but its output cannot be proven, automatic retry requires an explicit parent-defined policy:

    {"T002":{"retrySafe":true,"checks":[{"type":"json","path":"temp/result.json","equals":{"done":true}}]}}

retrySafe means repeating the operation cannot create an unintended duplicate effect; it is not a user approval switch. It defaults to false. Tasks with uncertain effects stay in the ledger as needs-reconciliation, and their dependants do not run. The parent investigates actual state and supplies meaningful verification; it must not mark arbitrary commands retry-safe to force progress. Exactly-once execution of arbitrary external effects cannot be guaranteed without an external idempotency mechanism.

A `started` checkpoint without `completed` is not automatic success, even if the output already satisfies the checks. Ordinary completion and recovery leave it in `needs-reconciliation`. After inspecting the effect, the parent may explicitly use `--verify-run` with meaningful checks to record a reconciled result; later recovery rechecks that result without executing the task again. Saved checkpoints must match the task, run, attempt token and allowed state, including when the standalone checkpoint file is missing.

--resume-run reuses the saved task inventory, acceptance checks and original workspace. It never calls the planner again. A live launcher is adopted by PID, creation time, executable and command line; no replacement is opened while it survives. A dead controller's ownership is reclaimed under the coordinator mutex, and a second live controller is rejected. Run release checks both the recorded token and the current controller's PID, creation time, executable name and command line; a worker that merely reads the token cannot call the release API on behalf of a live controller. Completed tasks are rechecked; successful finalized runs resume without opening any window. Recovery of protocol-1 runs is not supported; their original explicit acceptance checks can still be used with --verify-run. After a controller crash, the initiating agent invokes --resume-run; there is no background service that restarts controllers automatically.

## Acceptance-contract binding

`<runDir>/acceptance.json` lives in the workspace the execution windows can write to, so the contract itself needs integrity before it can establish anything about a task. At run start the controller records the SHA-256 of the canonical contract (object keys sorted, formatting ignored, `null`/`Infinity`/`-0` kept distinct) as `acceptance` in `manifest.json` and `summary.json`. `--verify-run` and `--resume-run` reload the contract from disk and compare digests before touching task state; a mismatch raises `Acceptance contract changed since the run was recorded` and no verification, recovery or window is performed. The same check runs for an explicitly supplied `--acceptance-file`, so a rewritten copy cannot be substituted for the recorded one. If the two ledger bindings disagree or only one remains, including after an interrupted rebinding, verification and recovery refuse to choose either record. The parent must inspect the contract and explicitly use `--allow-acceptance-change` to rebind both records.

Deliberately replacing a contract — the parent narrowing or extending checks after inspecting an uncertain result — requires the explicit `--allow-acceptance-change` flag (place it after the run ID) or `ORCH_ACCEPTANCE_OVERRIDE=1`. The override prints a warning, rebinds the new digest in both ledgers and appends an `acceptanceRebound` entry (`from`, `to`, timestamp, generation, and the conflict when present) to the run history, so the change stays visible in the record. Ledgers written by earlier versions carry no recorded digest; they keep verifying with the on-disk contract and a one-line `no recorded acceptance binding (historical ledger)` warning.

The binding protects the recorded contract, not the ledger around it: an actor that can rewrite `summary.json` and `manifest.json` consistently, or delete both bindings, is outside what a same-directory hash can prove. Keeping the run directory out of the executing agent's write path, or anchoring the digest outside the workspace, remains the stronger boundary.

## Global coordination and process identity

Codex runs use an independent window coordinator across this Windows user session, including different workspaces. The first Codex workspace owns `temp/orchestrator/codex-coordinator`; HKCU `Software/CodexTuiOrchestrator` stores only its locator. This namespace is separate from open-tui-orchestrator's generic pool, so either tool's identity sweeper cannot remove the other's reservations. A Windows named mutex serializes lease changes and is released on crashes. Other workspaces keep their own run outputs in their own temp directories. `ORCH_COORDINATOR_DIR` is an explicit advanced override; use it only when every participating Codex caller intentionally shares the same pool. Resuming a run reuses the coordinator recorded in its validated ledger for compatibility with older runs.

A lease is held before launch and records owner and launcher identity. Capacity counts pending and active windows across runs. Busy resources wait without dropping tasks. Only resource/dependency waits and pre-existing global occupancy delay execution; overflow tasks never create extra windows. Launcher identity includes PID, creation time, executable name and command line. Close operations recheck identity and kill descendants deepest first; they do not kill the shared Windows Terminal host. Headless prompts travel over stdin. Visible TUI prompts must be supplied to the interactive CLI at startup, so another same-user local process with permission to inspect process command lines may observe that prompt; use headless mode for sensitive prompt text.

## 双通道实时状态

TodoList（原始任务清单）保留 T001 等任务身份。Execution（执行块状态面板，也称 spawn 状态）显示每个块的模式、PID、尝试次数、等待原因和重试时间。块已启动不代表其中每个任务都已开始。

- started 检查点使任务进入 running；completed 进入 awaiting-verification；独立验收通过才显示 verified。
- 执行输出持续显示双状态。交互终端固定刷新面板，普通输出按状态变化追加。
- manifest.json 从规划开始保存清单；summary.json 是权威快照，events.jsonl 是带序号事件，goal.json 是派生镜像。文件都归当前工作区 temp/orchestrator/runs/<ID>。

~~~powershell
node scripts/status.mjs --workspace D:\your-project --run-id <ID> --watch
node scripts/status.mjs --workspace D:\your-project --run-id <ID> --watch --json
~~~

status.mjs 只读且不依赖 SDK，退出观察不会终止执行。JSONL（逐行 JSON 事件）用于接入宿主界面；重连先读最新快照再跟随事件，--after 指定已观察序号。默认每 250ms 观察检查点，系统和同步协调可能延迟显示，不承诺硬实时。

Codex 原生 TodoList/spawn 卡片属于宿主界面。本插件提供持续终端面板和状态事件；原生卡片需要宿主消费同一接口，不能仅靠技能文件注入。可以随时打开观察面板；选择下一次任务的执行模式不会重启当前任务。

恢复沿用原来的执行模式和任务身份。旧记录未声明模式时仍按 visible 恢复，不会因新默认值改变执行方式。

## Execution modes

--exec/--headless uses a durable hidden worker running codex exec --json. --run and bare requests respect ORCH_EXEC_MODE (headless by default); --run-windows/--visible explicitly selects visible TUI. Both use the same runner and leases. Workers wait for controller admission, then own their CLI child, logs and result. Controller loss does not lose the pipes or replay the block.

Each run saves executionMode. Legacy missing values mean visible. Worker adoption checks PID, start time and exact worker/configuration command line. Ordinary and capacity failure budgets remain separate. Only unstarted or explicitly retry-safe tasks can be repeated. Readers ignore truncated final event lines; the next claimed writer repairs them. Invalid complete event records fail visibly. Stale goal mirrors rebuild from the validated summary.

## Runtime policy

Visible windows default to Windows Terminal (`ORCH_TUI=wt`). PowerShell remains the internal lifecycle-script interpreter. Explicit `ORCH_TUI=inactive` selects direct console creation with a non-activation request; neither path is certified universally interruption-free. Focus behavior and its measured limitations are documented in [inactive windows](inactive-windows.md).

Windows inherit the initiating directory; do not derive cwd from a target filename. Orchestrator-owned transient files stay under that workspace/temp. Codex-owned configuration and sessions remain under CODEX_HOME. Approval stays never; there is no manual TUI approval step. When the effective policy is never + danger-full-access, the Codex TUI launcher carries `--dangerously-bypass-approvals-and-sandbox` so the project trust confirmation cannot pause an already-authorized window; restricted sandbox values remain unchanged. Existing external host restrictions still apply. The Codex adapter inherits the initiating provider and credentials by default, including third-party providers, so it needs no OpenAI session of its own. The opt-in OpenAI HTTPS provider keeps the existing OpenAI login, uses HTTPS Responses and disables WebSocket probing. Network loss can still cause HTTPS retries. Windows PowerShell native argv escaping preserves JSON, quotes, Chinese and paths with spaces.

## Regression commands

Run node --test --test-concurrency=1 test/*.test.mjs in the dedicated plugin directory. node scripts/coverage.mjs runs the same serial suite with Node's built-in coverage and writes lcov to `.plugin-eval/coverage/lcov.info` (git-ignored, never published); it accepts `--test <path|glob>`, `--out <file>` and `--concurrency <n>`, and its exit code reports the suite, not the coverage percentage. Invoke test/live-codex.mjs by absolute path from the desired workspace for the opt-in calculated-capacity real-model acceptance. ORCH_LIVE_ENTRY can select the Codex-specific scripts/orchestrate-sdk.mjs entry to run the same acceptance contract. Existing historical result files are not evidence for a changed core version; retain newly generated run IDs and summaries.

## Operational flags and environment

`--clear-cache` removes the deterministic decomposition cache. `--selftest-close` opens a bounded self-test window and records `temp/selftest-close.json`; it is a diagnostic gate, not task execution. `ORCH_TASK_HINTS`, `ORCH_TASK_FOLD` and `ORCH_TASK_TAIL` provide optional JSON routing hints. `ORCH_STATUS_FORMAT=json` emits status events as JSON. `ORCH_OPENAI_BASE_URL` (legacy alias `ORCH_STEADY_RELAY_BASE_URL`) is the optional relay base URL for the opt-in OpenAI HTTPS provider; it must end in `/v1`, may use `http` only for loopback hosts, and cannot contain credentials, query parameters or fragments. `ORCH_PROVIDER` selects `inherit` (default) or `openai-https`. Neither selection collects telemetry.

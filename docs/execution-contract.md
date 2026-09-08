# Dedicated execution contract (core 1.3.1, run protocol 2)

The dedicated Codex plugin uses a physical release snapshot of scripts/core and verifies release.json at startup. Generic development is isolated from the dedicated source and installed cache. Changes are promoted explicitly only after verification; repair.mjs --target creates a fresh release directory. See release-policy.md. The generic entry implements Codex and pi adapters; the dedicated Codex plugin still accepts Codex only. See pi-adapter.md for Pi-specific CLI, planning, session and shutdown behavior.

## Planning and capacity

Detect memory first: min(8, round(memoryGiB * 1024 / 2000)). The complete plan contains at most this many blocks. Overflow tasks run serially inside existing blocks; no additional capacity waves. Each block starts as soon as its own prerequisites are verified and a capacity/resource lease is available. A dependent of A does not wait for unrelated B. Reject unknown, self and cyclic dependencies before launching. Merge transitive resource conflicts and preserve dependency order. Windows file locks normalize case, separators and existing junction ancestors, and account for directory containment.

The parent persists manifest.json with the original request and T001... task identities before asking the planner. Model already_done/feasible flags never authorize omission. Uncertain model coverage falls back to the complete original inventory in a serial block.

Task parsing preserves ordinary comma continuations and quoted command separators. Deterministic planning uses the same boundaries as the original ledger. Semantic classification must return the original IDs; the parent restores original text by ID before grouping. A paraphrased summary cannot silently collapse otherwise valid parallel work into the coverage fallback.

## Execution and verification

The initiating agent chooses a unique run ID and defines independent acceptance checks before launch. This is automatic parent preparation, not a user approval prompt.

- Execute: node <absolute-entry> --run-id <id> --acceptance-file <absolute-json> --run-windows <request>
- Poll: node <absolute-scripts>/poll-windows.mjs --run-id <id> --require-all-success
- Recheck outputs without rerunning tasks: node <absolute-entry> --verify-run <id> --acceptance-file <absolute-json>
- Recover the saved plan after interruption: node <absolute-entry> --resume-run <id>

Each run owns workspace/temp/orchestrator/runs/<id>/{manifest.json,summary.json,acceptance.json,attempts/}. Every attempt records its exact remaining task IDs and a unique token. The TUI runs the supplied checkpoint command before and immediately after each task. The start record is created exclusively; a duplicate start fails. Poll requires the exact run ID, every planned block, every original task, verified statuses and closed launcher identities. An unrelated or previous run never satisfies this check. Failed prerequisites block dependants and remain in the task ledger. A completion marker or window closure alone is not success. Missing acceptance checks produce awaiting-verification, never a false pass. The parent can supply checks and recheck the same run without another TUI execution.

Acceptance JSON maps T001, T002... to arrays of parent-defined checks. Supported checks:

    {"T001":[{"type":"json","path":"temp/result.json","equals":{"answer":42}}]}

file checks require a regular file and optionally sha256; json checks compare specified top-level values; absent checks confirm deletion. command checks run an explicit executable with an args array, shell disabled, from the initiating workspace; they check exitCode (default 0) and optional stdout. Checks may run repeatedly, so they must be read-only. The parent must choose checks that establish the intended result: file existence alone is insufficient for semantic correctness. Checkpoint tokens identify this execution; they are not a security boundary against an intentionally malicious agent.

## Interruption and recovery

The launcher invokes the CLI once. It preserves failure evidence instead of blindly replaying a whole block. The controller independently rechecks every checkpoint and retries only remaining work, with a bounded attempt count (default two per block per controller) and backoff. Replacement windows use the same planned block and cannot exceed global concurrent capacity; verified tasks are omitted from their prompts.

If a task started but its output cannot be proven, automatic retry requires an explicit parent-defined policy:

    {"T002":{"retrySafe":true,"checks":[{"type":"json","path":"temp/result.json","equals":{"done":true}}]}}

retrySafe means repeating the operation cannot create an unintended duplicate effect; it is not a user approval switch. It defaults to false. Tasks with uncertain effects stay in the ledger as needs-reconciliation, and their dependants do not run. The parent investigates actual state and supplies meaningful verification; it must not mark arbitrary commands retry-safe to force progress. Exactly-once execution of arbitrary external effects cannot be guaranteed without an external idempotency mechanism.

--resume-run reuses the saved task inventory, acceptance checks and original workspace. It never calls the planner again. A live launcher is adopted by PID, creation time, executable and command line; no replacement is opened while it survives. A dead controller's ownership is reclaimed under the coordinator mutex, and a second live controller is rejected. Completed tasks are rechecked; successful finalized runs resume without opening any window. Recovery of protocol-1 runs is not supported; their original explicit acceptance checks can still be used with --verify-run. After a controller crash, the initiating agent invokes --resume-run; there is no background service that restarts controllers automatically.

## Global coordination and process identity

Runs in both tools share a window coordinator across this Windows user session, including different workspaces. The first workspace owns temp/orchestrator/coordinator; HKCU Software/TuiOrchestrator stores only its locator. A Windows named mutex serializes lease changes and is released on crashes. Other workspaces keep their own run outputs in their own temp directories. ORCH_COORDINATOR_DIR is an explicit advanced override; all related callers must use the same value to share the cap.

A lease is held before launch and records owner and launcher identity. Capacity counts pending and active windows across runs. Busy resources wait without dropping tasks. Only resource/dependency waits and pre-existing global occupancy delay execution; overflow tasks never create extra windows. Launcher identity includes PID, creation time, executable name and command line. Close operations recheck identity and kill descendants deepest first; they do not kill the shared Windows Terminal host.

## Runtime policy

Visible windows default to Windows Terminal (`ORCH_TUI=wt`). PowerShell remains the internal lifecycle-script interpreter. Explicit `ORCH_TUI=inactive` selects direct console creation with a non-activation request; neither path is certified universally interruption-free. Focus behavior and its measured limitations are documented in [inactive windows](inactive-windows.md).

Windows inherit the initiating directory; do not derive cwd from a target filename. Orchestrator-owned transient files stay under that workspace/temp. Codex-owned configuration and sessions remain under CODEX_HOME. Approval stays never; there is no manual TUI approval step. When the effective policy is never + danger-full-access, the Codex TUI launcher carries `--dangerously-bypass-approvals-and-sandbox` so the project trust confirmation cannot pause an already-authorized window; restricted sandbox values remain unchanged. Existing external host restrictions still apply. The current Codex adapter uses the existing OpenAI login with HTTPS Responses and disables WebSocket probing. Network loss can still cause HTTPS retries; other model providers require a separately tested adapter policy. Windows PowerShell native argv escaping preserves JSON, quotes, Chinese and paths with spaces.

## Regression commands

Run node --test test/*.test.mjs in the dedicated plugin directory. Invoke test/live-codex.mjs by absolute path from the desired workspace for the opt-in 8-window/9-task real-model acceptance. ORCH_LIVE_ENTRY can select the Codex-specific scripts/orchestrate-sdk.mjs entry to run the same acceptance contract. Existing historical result files are not evidence for a changed core version; retain newly generated run IDs and summaries.

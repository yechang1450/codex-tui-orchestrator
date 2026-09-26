# Independent blocks, memory admission and serial inspection

## User contract

The initiating Codex decomposes the complete authorized request into atomic work items, retaining every original instruction. The planner identifies dependencies and overlapping resources, validates the graph, and groups each connected component into one serial block in topological order. Unknown independence is conservative. Final blocks have no cross-block dependencies or conflicting resources. One resulting block stays in the initiating conversation.

Environment setup restores missing locked dependencies and the native CLI automatically. A PowerShell bootstrap supplies a user-local Node runtime if needed. Authentication cannot be manufactured: a missing login is diagnosed and returned to the caller. Plugin installation does not provide a background daemon or an undocumented host install hook: the installer and the skill's first-use bootstrap own this check.

Before orchestration, available memory below 4000 MB returns an inline decision. Independent blocks are never merged to satisfy memory pressure. Before every launch, the coordinator atomically reads available memory and reserves the predicted peak. A block starts only when its peak is strictly less than available memory minus 4000 MB minus unconsumed peak reservations. Existing process working sets are already reflected in OS available memory; the lease only reserves the predicted future peak growth once, so the same current working set is not subtracted twice. The reserve cannot be disabled or reduced. Unfit blocks wait without a hard-run escape. A user-configured overall timeout can end a wait, but cannot launch a block over budget.

Default execution is headless Codex exec; visible interactive TUI follows the same scheduler. Every launcher explicitly receives the initiating model, reasoning effort and service tier. Thread metadata outranks stale overrides; native configuration fills missing metadata. Unknown required settings prevent launching. Worker prompts prohibit nested orchestration or subagents.

Each finished or failed worker is closed and its owned process exit is checked before releasing memory. The controller places its block in one serial verification queue. It inspects parent-defined content/behavior checks against the real workspace; a child report, checkpoint, exit code or closing window cannot grant success. A missing child completion checkpoint cannot veto independently proven work. Live blocks are never inspected. Verification appends evidence to the same run report. The queue cannot launch new orchestrations. Final cleanup revisits owned unfinished processes, drains verification and returns the complete factual report to the initiating model. Further action belongs to that model.

## Boundaries

Peak memory remains an estimate, with explicit task budgets and observed process-tree peaks; no finite test proves a universal absence of defects. Failed provider access, login, an OS privilege requirement, or memory that never becomes available is reported rather than bypassed. Verification success requires every requested task to have actual evidence and all owned processes to be gone.

## Validation

Test dependency/conflict transitivity, reversed task order, cyclic/unknown dependencies, unknown scope, one-block inline fallback, 4000 MB boundaries, parallel reservation races, queued replenishment, retained peak estimates above 800 MB, settings mismatch repair, missing setup dependencies, report-free completion, nonzero exit with valid/invalid artifacts, verification serialization, cleanup failures and resume. Run full Windows regression, at least four independent real blocks in headless and visible modes, Plugin Eval and Codex Security. Fix reproducible findings, repeat applicable regression, update both READMEs and GitHub About, reinstall a new cache version, then commit and push.

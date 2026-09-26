# Implementation plan

Spec: ../specs/2026-09-24-independent-memory-queue-design.md

Execution: inline in the initiating conversation, as authorized by the user. Keep source in the canonical repository. Test workspaces live under workspace/temp. No reset or restore of workspace documents.

## Review focus

- A valid dependency hidden inside a merged block must retain task order.
- Concurrent controllers must not both consume the same free-memory sample.
- Live process memory is included in available memory; only future peak growth remains reserved.
- A slow verification must not stop finished workers from being reclaimed or new workers from starting.
- CLI settings and environment installation must not silently diverge from the initiating session.

## 1. Planning and capacity

Files: scripts/core/plan-policy.mjs, memory-budget.mjs, leases.mjs, runner.mjs, orchestrate-sdk.mjs; test/independent-plan.test.mjs, memory-queue.test.mjs.

First write failing assertions for a dependency chain plus an independent block, transitive directory locks, one-block fallback, exact memory boundary and an 800+ MB observed peak. Implement partitionIndependentBlocks(input, infer), strict admissionOk and atomic lease reservations. Remove runtime budgetMergePlan and hard-run branches. Keep legacy helpers only for old callers, without using them in new execution. Run focused tests before proceeding.

## 2. Serial inspection

Files: scripts/core/verification-queue.mjs, contracts.mjs, runner.mjs, recovery.mjs; test/verification-queue.test.mjs and runner integration fixtures.

Write asynchronous tests whose verifier pauses while another completion arrives: peak verifier concurrency must be one, FIFO completion order must be preserved, rejected jobs must not poison following jobs. Use asynchronous command checks, parent-owned check definitions and a single UTF-8 verification report. Enqueue only after process exit is proven, record failure evidence as well as success, and inspect no live blocks. Persist verification mode for recovery compatibility.

## 3. Setup and initiating settings

Files: scripts/bootstrap.ps1, entry-bootstrap.mjs, sdk-dependency-check.mjs, core/initiator-settings.mjs, core/orchestrate-sdk.mjs, wsl/orch.sh; corresponding bootstrap/settings tests.

Test missing SDK restoration and read-only diagnostics, malformed settings, thread metadata versus environment mismatch, native config fallback and explicit identical args in both launch modes. Resolve parent settings before planning, bind them to the run, and apply the same snapshot at every worker launch. Bootstrap Node from a verified user-local runtime when unavailable, then restore locked packages and discover/install CLI. Preserve provider and proxy credentials.

## 4. Integration and documentation

Update README.md, README-zh.md, execution-contract.md, skill, manifest, changelog and release snapshot together. Explain install/first-use behavior, atomic task preparation, no-cross-dependency grouping, 4000 MB reserve, waiting, model parity and single serial verification report. Replace outdated two-window/formula-only acceptance assumptions.

## 5. Validation and release

Run doctor, focused tests, the complete native Windows suite and four-block real tests for both execution modes. Exercise admission waiting with simulated memory in deterministic tests; do not exhaust the user's real RAM. Evaluate the clean distributed plugin with Plugin Eval, run a complete Codex Security scan and remediate validated findings. Repeat regression after fixes. Bump version, seal, reinstall, verify installed integrity/doctor, clean only this run's temporary artifacts, git diff --check, commit, push and verify remote HEAD. Update repository About through authenticated GitHub API with the reviewed description.

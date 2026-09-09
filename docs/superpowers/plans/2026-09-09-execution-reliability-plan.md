# Execution Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dedicated Codex TUI orchestrator execute from one verified release, calculate capacity from the agreed memory formula, recover provider-capacity failures without corrupting task state, keep TodoList and local goal mirrors consistent, and verify foreground protection with a real Windows probe.

**Architecture:** `contracts.mjs` owns the one capacity calculation and TodoList projection. `runner.mjs` owns the execution ledger and derives every persisted view from it. `recovery.mjs` validates the ledger and its derived views. The visible-window helper remains a Windows host integration boundary; its behavior is validated by a controlled live probe rather than a source-regex assertion.

**Tech Stack:** Node.js 22, native `node:test`, PowerShell/Win32 window APIs, existing Codex CLI launcher and release-integrity manifest.

**Spec:** Approved chat design in the 2026-09-09 implementation turn.

## Global Constraints

- Change only `codex-tui-orchestrator`; do not modify `open-tui-orchestrator`.
- Keep the current test runtime model and maximum effort defaults unchanged.
- Capacity is `floor(reportedGiB * 1024 / 1000 * 3 / 4)` with no arbitrary eight-window cap.
- Do not claim native host Goal integration; `goal.json` is a controller-owned local mirror.
- Do not retry a task blindly after a durable `started` or `completed` checkpoint.
- Every production behavior change gets a failing regression test before implementation.
- Finish with source, clean-package, installed-copy, doctor, status, and release-integrity verification.

---

### Task 1: Centralize the agreed capacity formula

**Files:**
- Modify: `scripts/core/contracts.mjs`
- Modify: `scripts/core/orchestrate-sdk.mjs`
- Modify: `scripts/core/recovery.mjs`
- Test: `test/orchestrator.test.mjs`
- Test: `test/concurrency.test.mjs`
- Test: `test/live-codex.mjs`
- Test: `test/live-concurrency.mjs`

**Interfaces:**
- `computeMaxWindows(reportedGiB)` remains the public function used by planning, admission, and recovery.
- All callers pass the same OS-reported GiB value; no caller recomputes the formula.

- [ ] Add a failing boundary test proving decimal-to-binary conversion occurs before multiplication and flooring is used.
- [ ] Run the focused capacity tests and confirm the new assertion fails against the current round-only implementation.
- [ ] Implement the single formula and align the low-memory guard and test helpers.
- [ ] Run the focused capacity, planning, and recovery tests.

### Task 2: Separate provider-capacity retries from normal recovery attempts

**Files:**
- Modify: `scripts/core/runner.mjs`
- Modify: `scripts/core/retry-policy.mjs`
- Test: `test/capacity-retry.test.mjs`
- Test: `test/runner.test.mjs`
- Test: `test/recovery-runtime.test.mjs`

**Interfaces:**
- The runner tracks `controllerAttempts` and `capacityRetries` independently.
- A capacity retry is eligible only when the current attempt has no durable task checkpoint.

- [ ] Add a failing runner test with three provider-capacity failures and no checkpoints; assert the configured capacity retry budget is honored.
- [ ] Add a failing test proving a capacity failure does not leave task results as `failed` in the next TodoList.
- [ ] Run those tests and confirm they fail for the current shared attempt counter and stale state.
- [ ] Implement independent counters, pending-state restoration, and immediate TodoList/goal persistence.
- [ ] Verify started-checkpoint and completed-checkpoint cases still enter reconciliation and never blindly replay.

### Task 3: Make TodoList and local goal state derived and recoverable

**Files:**
- Modify: `scripts/core/contracts.mjs`
- Modify: `scripts/core/runner.mjs`
- Modify: `scripts/core/recovery.mjs`
- Test: `test/runner.test.mjs`
- Test: `test/recovery-ledger.test.mjs`
- Test: `test/recovery-runtime.test.mjs`

**Interfaces:**
- Add one projection path from `summary.tasks`, `summary.blocks`, and `summary.taskResults` to TodoList and `goal.json`.
- `goal.json` carries controller-mirror metadata, run identity, summary generation, and a summary digest.

- [ ] Add failing tests for `verifyRun` refreshing goal/task statuses, resume rejecting an identity-mismatched mirror, and resume rebuilding a missing mirror.
- [ ] Add a failing test for the running task state and for rejecting a TodoList with mismatched statuses.
- [ ] Run the focused ledger tests and confirm the current stale mirror behavior fails.
- [ ] Implement the shared projection, verification refresh, mirror validation/rebuild policy, and atomic digest binding.
- [ ] Verify that native host Goal tools are not claimed or invoked by the plugin.

### Task 4: Validate visible-window foreground behavior

**Files:**
- Modify: `scripts/core/inactive-window.ps1`
- Modify: `scripts/core/inactive-window.mjs` only if the live probe identifies a launcher defect
- Modify: `test/live-inactive-window.ps1`
- Modify: `test/inactive-window.test.mjs`
- Modify: `docs/inactive-windows.md`

**Interfaces:**
- The helper keeps the initiating window as the baseline and never treats source-regex matching as acceptance evidence.
- The live probe records actual foreground samples, input delivery, visibility, minimization, execution receipt, and closure.

- [ ] Add a failing acceptance assertion that continuously sends input to the initiating window while the TUI starts.
- [ ] Run the probe once and preserve only its result under the existing test evidence directory.
- [ ] Adjust the guard only for a demonstrated failure; do not add a promise that Windows can never change focus.
- [ ] Run helper unit tests and the controlled live focus probe.

### Task 5: Rebuild and verify the installed copy

**Files:**
- Modify: `release.json` only through the existing release sealing script
- Modify: installed cache under `cache/personal/codex-TUI-orchestrator/0.4.43-rc.1` through the existing package/install workflow
- Test: `test/current-package-validation.test.mjs`

**Interfaces:**
- The installed copy must be byte-consistent with the sealed source release before it is considered active.

- [ ] Add or update a package validation assertion that detects source/cache drift.
- [ ] Run source release-integrity and package validation before copying anything.
- [ ] Rebuild the cache through the existing workflow, then run cache release-integrity, doctor, and readonly status.
- [ ] Confirm no live TUI windows, reservations, or temporary test artifacts remain.

### Task 6: Full verification and handoff

**Files:**
- Check: all modified files under `codex-tui-orchestrator`
- Check: `README-zh.md`, `docs/execution-contract.md`, `docs/rc-validation.md`, and `skills/codex-TUI-orchestrator/SKILL.md` for behavior consistency

- [ ] Run the full source test suite and record the exact pass/fail counts.
- [ ] Run release-integrity, doctor, readonly status, package validation, and the controlled live checks.
- [ ] Inspect the diff for accidental `open-tui-orchestrator` changes, stale model claims, and temporary artifacts.
- [ ] Report any live-check limitation explicitly; do not call the release complete when a required gate is red.

# Codex CLI and TUI Full Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Validate and repair Codex CLI discovery/automatic installation, model and reasoning parity, visible concurrent TUI execution, default headless exec execution, and the complete codex-tui-orchestrator regression surface.

**Architecture:** Keep host discovery synchronous and fail closed after a bounded automatic installation attempt. Prefer a verified native binary shipped in the installed plugin dependency tree, then use a user-scoped npm installation only when no usable binary exists. Keep model and reasoning overrides explicit at the launcher boundary and verify the same argv contract for visible and headless modes.

**Tech Stack:** Node.js 22, `node:test`, Windows native Codex CLI, PowerShell/Windows Terminal launchers, WSL test wrapper.

**Spec:** User request in the current Codex task: test missing CLI auto-install, visible concurrent TUI with `gpt-6-luna + max`, headless exec, then repeat full testing after every bug fix.

## Global Constraints

- Source target: `%USERPROFILE%\plugins\codex-tui-orchestrator`.
- Real execution is Windows-only and must use the native Windows Node/CLI path.
- Default execution remains headless; visible mode is explicit.
- Every real run requires acceptance evidence and independent verification.
- Temporary run state stays under the initiating workspace `temp/orchestrator`.
- Never expose credentials or write them to logs.

## Review Focus

- Missing native CLI with a usable plugin-local binary must resolve without network installation.
- Missing CLI with no local binary must attempt one bounded npm installation and report the exact failure.
- Explicit `ORCH_CLI` must remain authoritative and must never be replaced by auto-install.
- `gpt-6-luna` and `max` must reach both visible and headless launch argv as one argument each.
- Concurrent visible blocks must not lose leases, receipts, or cleanup state.

### Task 1: Baseline and failure reproduction

**Files:**
- Read: `scripts/core/host-cli.mjs`, `scripts/core/orchestrate-sdk.mjs`, `test/host-cli.test.mjs`, `test/execution-acceptance.test.mjs`.
- Test: existing offline suite and `scripts/wsl/orch.sh --doctor`.
- Evidence: `workspace/temp/orchestrator` logs only.

- [ ] Reproduce `CLI_MISSING` with the current PATH and record the exact error.
- [ ] Confirm the plugin-local Windows binary path and current package version.
- [ ] Run the unmodified offline suite on a writable test workspace.

### Task 2: Native CLI discovery and bounded auto-install

**Files:**
- Modify: `scripts/core/host-cli.mjs`.
- Test: `test/host-cli.test.mjs`.
- Modify: `CHANGELOG.md`, `.codex-plugin/plugin.json`, `scripts/package.json`, `scripts/package-lock.json`, and `release.json` only if the implementation changes the shipped release.

- [ ] Write failing tests for plugin-local native binary discovery, successful injected installation, bounded failed installation, and explicit CLI override precedence.
- [ ] Run the focused tests and confirm the new tests fail for the missing behavior.
- [ ] Implement the smallest discovery and installation path with injectable process calls and no credential logging.
- [ ] Run the focused tests, then the full offline suite.

### Task 3: Model and mode acceptance

**Files:**
- Read/modify only if needed: `scripts/core/execution-mode.mjs`, `scripts/core/orchestrate-sdk.mjs`, `test/execution-acceptance.test.mjs`, `test/live-execution-mode.mjs`.

- [ ] Run deterministic argv acceptance with `ORCH_MODEL=gpt-6-luna` and `ORCH_EFFORT=max` for visible and headless modes.
- [ ] Run one real headless acceptance task with a JSON receipt.
- [ ] Run one real visible acceptance task and verify the terminal process, receipt, and cleanup.
- [ ] Run a multi-block visible concurrency probe with bounded timeouts and independent process/ledger sampling.

### Task 4: Full regression and package verification

**Files:**
- Read: all existing test files and release manifests.
- Test: full offline suite, release integrity, source and installed-cache doctor/check, plugin-eval report, and targeted live probes.

- [ ] Run every existing test file serially on a writable Windows test workspace.
- [ ] Run `release-integrity`, package validation, install/check, and doctor.
- [ ] Run plugin-eval and record `Fix First` findings.
- [ ] If any test fails, return to the relevant task, add a regression test first, fix one root cause, and restart the full loop.

### Task 5: Final verification and cleanup

**Files:**
- Modify: only the source, tests, release metadata, and documentation required by confirmed fixes.
- Remove: temporary mirrors, logs, and run state owned by this validation.

- [ ] Rebuild clean distribution and reinstall the plugin cache.
- [ ] Re-run the complete verification set from a fresh process.
- [ ] Confirm the source tree, distribution, installed cache, and release hashes agree.
- [ ] Report any provider/quota or desktop-window limitation separately from code defects.

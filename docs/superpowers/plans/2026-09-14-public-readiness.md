# Public Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Keep runtime edits in the main conversation.

**Goal:** Close verifiable publication gates with fresh artifacts while retaining unresolved provider and OS evidence limits.

**Architecture:** Reuse the official plugin manager and existing lifecycle probes. Isolate test marketplaces, Git revisions, settings and receipts under this repository's temp directory. Do not alter active installed runtime code or infer task success from a process exit alone.

**Tech Stack:** Node.js, Windows PowerShell, Git, Codex CLI 0.154.0, node:test.

**Spec:** docs/execution-contract.md and docs/release-policy.md; user's publication-readiness acceptance request.

## Global Constraints

- Keep the repository Private until publication gates are satisfied.
- Preserve task IDs, checkpoints, independent verification and declared capacity.
- Never replay uncertain side effects or label simulated transport/boot events as real provider/OS events.
- Keep all isolated validation data under temp and remove completed throwaway fixtures after retaining useful evidence.

### Task 1: Official manager version lifecycle

**Files:** test/manager-lifecycle-validation.json; 本机历史账本（已移除）; docs/release-policy.md.

**Interfaces:** consume sealed source via scripts/release-integrity.mjs; produce version, source-commit, install-state and integrity receipts for each manager operation.

- [x] Use a scoped CODEX_HOME and Git marketplace with two sealed fixture versions.
- [x] Run official marketplace add, plugin add and list; read installed files and verify the release.
- [x] Advance the marketplace ref, run marketplace upgrade and plugin add; verify selected version and cache bytes.
- [x] Return the ref to the initial revision, upgrade/reinstall and verify rollback; remove plugin and read back uninstall.
- [x] Record exact transport, package scope and manager limitations; clean only this fixture.

### Task 2: Capacity and foreground probes

**Files:** test/live-codex.mjs; test/live-inactive-window.ps1; their existing regression tests; docs/rc-validation.md.

**Interfaces:** preserve configured task inventory, measured process ancestry and independent result JSON.

- [x] Review the failed provider/foreground attempts before choosing a changed experiment.
- [x] Reproduce the recovery finalization defect, add regression tests, fix and rerun focused and full source suites.
- [ ] Execute the provider-backed capacity acceptance; current account/provider capacity evidence remains incomplete.

### Task 3: Recovery and release closure

**Files:** existing recovery probes; docs/execution-contract.md; docs/release-policy.md; 本机历史账本（已移除）.

**Interfaces:** authoritative summary/checkpoint ledger and independently verified side effects.

- [x] Strengthen controller/process-loss and bounded-outage evidence with owned test processes.
- [x] Keep provider outage, OS task recovery and auxiliary login collector claims distinct.
- [x] Run complete source regression (248 tests, 247 passed, 1 skipped), locked dependency install, integrity and public-entry diagnostics.
- [x] Synchronize evidence and user documentation; retain provider/OS publication blockers without weakening acceptance.

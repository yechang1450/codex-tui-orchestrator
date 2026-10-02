# Codex TUI Orchestrator Full Exam and Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a complete, evidence-backed examination of the local Codex TUI Orchestrator, record every reproducible defect or security boundary failure, and apply the smallest repository-native fixes with regression proof.

**Architecture:** Treat the repository checkout as authoritative. Test the public entry points and state transitions through disposable fixtures, then validate the installed checkout registration and cache independently. Security findings follow discovery → validation → minimal fix → bypass/regression review.

**Tech Stack:** Node.js ESM, PowerShell, Windows Codex CLI, repository test suites, release-integrity manifest, local Laya hook boundary.

**Spec:** `README.md`, `README-zh.md`, `skills/codex-tui-orchestrator/SKILL.md`, `SECURITY.md`, `release.json`, and the current user requirements in this conversation.

## Global Constraints

- Preserve the current working-tree changes, source, tests, Git history, and installed plugin cache.
- Keep the single-checkout marketplace source; do not recreate `build\dist`.
- Keep the memory reserve at 1000 MB and the release at `0.9.29-rc.1` until a separate release request.
- Do not modify Laya service code, model files, or official presets; test only the HTTP integration boundary.
- Do not invent protocol criteria: use repository and official preset wording already present in the checkout.
- Any automatic action based on Laya requires confidence at least `0.85`; lower-confidence answers remain advisory.
- Do not push, publish, merge, or change external registrations until the corresponding release step is explicitly authorized.

## Review Focus

- Planner stability under duplicate, empty, cyclic, and mixed dependency declarations; pin this to the planner/plan-policy tests.
- `--tasks` help and machine-readable output across normal, malformed, and missing-state inputs; pin this to CLI contract tests.
- Concurrent leases, shared project conflicts, stale owners, and crash/restart recovery; pin this to lease/recovery tests.
- Windows launch, timeout, close, orphan, and cleanup paths; pin this to process lifecycle tests.
- Plugin registration, source/cache drift, release-integrity, and Laya hook boundaries; pin this to install/security integration checks.

### Task 1: Baseline, inventory, and exam harness

**Files:**
- Create: `docs/superpowers/plans/2026-10-01-codex-tui-orchestrator-full-exam.md`
- Create: disposable evidence under `workspace\temp\codex-tui-full-exam-*`
- Test: existing focused suites and CLI probes

- [ ] Record branch, status, release metadata, marketplace source, installed cache, and current process state.
- [ ] Run release integrity, installation check, cache doctor with an explicitly selected Codex executable, and `git diff --check`.
- [ ] Build a bounded exam matrix and preserve raw outputs for every scenario.

### Task 2: Static contract and plugin evaluation

**Files:**
- Inspect: `.codex-plugin/plugin.json`, `skills/codex-tui-orchestrator/SKILL.md`, `README*.md`, `SECURITY.md`, `scripts/entry-options.mjs`, `scripts/core/plan-policy.mjs`
- Evidence: plugin-eval report and contract findings

- [ ] Run the local plugin evaluation workflow and inspect manifest, skill, documentation, and fix-first findings.
- [ ] Cross-check public claims against executable behavior and release-integrity coverage.
- [ ] Turn only source-backed, reproducible findings into candidate defects.

### Task 3: Planner and CLI contract exam

**Files:**
- Inspect/modify only if proven: `scripts/core/plan-policy.mjs`, `scripts/core/orchestrate-sdk.mjs`, `scripts/entry-options.mjs`
- Test: `test/*plan*`, `test/*native-argv*`, focused new regression tests if needed

- [ ] Exercise normal, empty, duplicate, cyclic, conflicting, and malformed task graphs.
- [ ] Exercise `--tasks`, `--help`, `--status`, `--plan`, and invalid combinations in headless and visible modes.
- [ ] For each failure, write a failing regression test before the smallest fix, then rerun the focused suite.

### Task 4: Concurrency, resources, and recovery exam

**Files:**
- Inspect/modify only if proven: `scripts/core/leases.mjs`, `scripts/core/controller-state.mjs`, `scripts/core/recovery.mjs`, `scripts/core/memory-budget.mjs`, `scripts/core/verification-queue.mjs`
- Test: existing lease, conflict, recovery, and orchestrator suites plus focused regressions

- [ ] Test independent tasks running concurrently and conflicting tasks serializing.
- [ ] Test lease expiry, stale owner reclamation, duplicate admission, crash/restart, checkpoint ordering, and memory reserve enforcement.
- [ ] Verify raw checkpoints, receipts, tokens, timestamps, and task state independently before accepting completion.

### Task 5: Windows lifecycle and cleanup exam

**Files:**
- Inspect/modify only if proven: `scripts/core/runner.mjs`, `scripts/core/headless-executor.mjs`, `scripts/core/headless-worker.mjs`, `scripts/core/inactive-window.mjs`, `scripts/core/owned-launcher-final-close.test.mjs`
- Test: lifecycle, reboot, timeout, orphan, and cleanup suites

- [ ] Exercise launch, timeout, visible-window close, headless exit, orphan detection, and repeated cleanup.
- [ ] Verify no unrelated process is terminated and no generated residue survives the run.
- [ ] Add regression tests for any reproducible process or cleanup defect.

### Task 6: Security discovery and validation

**Files:**
- Inspect: all runtime scripts, hooks, marketplace registration, network policy, path handling, and generated state boundaries
- Evidence: security scan artifacts under the local scan-artifact directory

- [ ] Run the standard/deep repository security scan and plugin evaluation without changing source.
- [ ] Validate each plausible finding with a realistic local reproduction, tracing attacker input to the sink and checking alternate representations.
- [ ] Classify each finding as reportable, suppressed, not applicable, or deferred with evidence.

### Task 7: Minimal remediation and review

**Files:**
- Modify only the files owned by validated findings.
- Test: one regression test per fixed finding plus owning focused suites

- [ ] For every validated bug or vulnerability, write the failing test first.
- [ ] Implement the narrowest repository-native fix, preserving legitimate behavior and public errors.
- [ ] Run a fresh bypass/regression review, then rerun the original trigger, an alternate input class, the legitimate control, and the owning suite.

### Task 8: Full regression, release-readiness, and residue cleanup

**Files:**
- Inspect: complete working-tree diff, release metadata, marketplace registration, installed cache
- Evidence: final exam report under `docs/` or the disposable evidence directory

- [ ] Run the full applicable test suite with the correct trusted-project environment and capture pass/fail counts.
- [ ] Re-run release integrity, install check, cache doctor, `git diff --check`, and ignored-file dry-run.
- [ ] Remove only generated evidence and temporary dependencies, preserving source, tests, Git history, user artifacts, and active plugin/Laya state.
- [ ] Produce a table of every finding, proof, fix, regression test, and any remaining uncertainty.

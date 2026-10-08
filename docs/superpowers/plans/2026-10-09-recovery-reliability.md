# Windows Recovery Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a reproducibly reliable Windows coordinator and launcher path so the recovered orchestrator can resume its public-readiness validation.

**Architecture:** The coordinator will coalesce burst process observations through an advisory cache and use cryptographic ledger revisions as a fail-closed fence inside its mutex. Only a fresh cache producer may use negative process evidence; cache hits can only retain state. The runner and generated launchers will make PID publication/read races explicit and bounded while retaining the existing identity and exit-evidence gates. Test fixtures will isolate restored host state instead of weakening production containment.

**Tech Stack:** Node.js ESM, Windows PowerShell 5+, named mutexes, filesystem atomic moves, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-09-windows-recovery-reliability-design.md`

## Global Constraints

- Support Windows PowerShell 5 and the restored Codex desktop runtime without adding a runtime dependency.
- Take no CIM/WMI process snapshot while `lease-lock.ps1` holds the coordinator mutex.
- Bound a concurrent coordinator burst to a small number of full CIM enumerations; cached snapshot data is advisory and cannot authorize lease/run-owner reclamation, PID identity, process termination, exit proof, or lower memory admission.
- Preserve fail-closed behaviour for unreadable PID files, unverified launchers, ledger read errors, unknown ledger revisions, capacity, conflicts, and workspace containment.
- Never use PID-file existence or a result file as launcher identity or exit proof.
- Keep every launched TUI/EXEC window in the initiating Codex workspace; never close user-owned windows.
- Keep `master` unchanged; integrate only reviewed commits into `codex/reinstall-recovery`.
- Do not claim a test, release, security scan, or live TUI check passed without its recorded command result.

## Review Focus

- A lease written after the caller's snapshot but before its mutex turn must remain counted; cover it in the coordinator revision-fence test.
- An unreadable PID file on an existing launcher must preserve recovery artifacts rather than start a second window; cover it in the runner permanent-EBUSY test.
- A temporary PID sharing lock must recover without duplicating side effects; cover it in the runner transient-EBUSY test.
- A stale `run-owners.json` observation must not allow a second controller for the same run; cover it in the run-owner revision-fence test.
- A host `WORKSPACE_DIR` outside a test fixture must not alter the public invalid-mode contract; cover it in the fatal-entry fixture test.

---

### Task 1: Fence coordinator state with a single pre-lock process observation

**Files:**
- Modify: `scripts/core/leases.mjs:188-324`
- Test: `test/coordinator-process.test.mjs`
- Test: `test/lease-poison.test.mjs` or a focused new coordinator observation test

**Interfaces:**
- Consumes: `processSnapshot() -> Map<number, ProcessIdentity>` and `readUtf8Bounded()`.
- Produces: an internal observation `{ processes, fresh, changed(file): boolean }` passed as the fourth argument to `transaction` callbacks.

- [ ] **Step 1: Write failing coordinator cache and revision-fence tests**

Assert that cache-hit absence preserves a valid stale lease or run owner even when the ledger revision is unchanged; only a fresh snapshot may reclaim it when revisions are stable. Add instrumentation proving a burst shares a small number of full enumerations, a caller absent from cache obtains targeted identity, and cached working-set data cannot lower memory admission.

- [ ] **Step 2: Run the focused coordinator tests to verify they fail**

Run: `node --test --test-concurrency=1 test/coordinator-process.test.mjs test/lease-poison.test.mjs`

Expected: FAIL because current `transaction()` takes a full snapshot for every contender and has no advisory-cache distinction.

- [ ] **Step 3: Implement cached pre-lock observation and revision comparison in `leases.mjs`**

Build a bounded, atomically published coordinator-scoped cache outside the workspace. Only its producer has fresh complete identity evidence. Hash bounded raw ledger bytes before and during the mutex; treat `unknown` and any inequality as changed. Apply the changed fence to fresh observations and unconditional conservative retention to cache-hit negative evidence, including `run-owners.json`. Preserve the helper's PID/start-time handshake and use a fresh targeted identity when the cache lacks the caller.

- [ ] **Step 4: Run focused and cross-process coordinator checks**

Run: `node --test --test-concurrency=1 test/coordinator-process.test.mjs test/lease-poison.test.mjs`

Expected: PASS, including repeated 40-contender bursts producing exactly 16 admissions and 24 capacity rejections without increasing the existing timeout.

- [ ] **Step 5: Commit the coordinator fix**

Commit message: `fix: prevent coordinator snapshot convoy`

### Task 2: Make launcher PID publication and reads resilient to transient Windows locks

**Files:**
- Modify: `scripts/core/runner.mjs:760-950`
- Modify: `scripts/core/orchestrate-sdk.mjs` PID launcher generation
- Modify: `scripts/core/pi-runtime.mjs` PID launcher generation
- Test: `test/recovery-runtime.test.mjs`
- Test: existing launcher/runtime tests that assert generated PowerShell content

**Interfaces:**
- Produces: an internal async PID reader returning `{ pid, error }` after a bounded retry budget.
- Consumes: `hooks.readPid(pidFile)` and existing `identifyWithRetry()`; identity verification remains separate.

- [ ] **Step 1: Write failing PID-read tests**

Make `readPid` throw `EBUSY` twice then return the legitimate PID; assert safe retry succeeds and the completed task executes once. Add permanent-EBUSY and identity-mismatch cases that remain `needs-reconciliation` with artifacts retained.

- [ ] **Step 2: Run the focused recovery test to verify it fails**

Run: `node --test --test-concurrency=1 test/recovery-runtime.test.mjs`

Expected: FAIL because raw hook PID reads escape before identity retry.

- [ ] **Step 3: Implement bounded PID retries and atomic PID publish**

Retry only temporary sharing/access failures and startup `0`, then pass a positive PID through the existing identity checks. Publish generated launcher PID files by closing a temporary file before an atomic same-directory move. Preserve all fail-closed cleanup and recovery branches.

- [ ] **Step 4: Run focused launcher and recovery tests**

Run: `node --test --test-concurrency=1 test/recovery-runtime.test.mjs test/orchestrate-sdk*.test.mjs test/pi-*.test.mjs`

Expected: PASS with no duplicate task side effects and no relaxed identity assertion.

- [ ] **Step 5: Commit the PID reliability fix**

Commit message: `fix: tolerate transient launcher PID locks`

### Task 3: Isolate the public fatal-entry fixture from restored host state

**Files:**
- Modify: `test/malformed-contract-fuzz.test.mjs:373-390`

**Interfaces:**
- Consumes: existing `cli(args, { workspace, env })` fixture helper.
- Produces: deterministic normal and `ORCH_DEBUG=1` invalid-mode assertions.

- [ ] **Step 1: Write the fixture setup that supplies a sibling workspace and explicit debug values**

Use a per-test workspace outside the temporary controller root, clear debug for the normal assertion, and set it only for the debug assertion.

- [ ] **Step 2: Run the focused fatal-contract test to verify it now exercises invalid-mode handling**

Run: `node --test --test-concurrency=1 --test-name-pattern="公开入口任何失败" test/malformed-contract-fuzz.test.mjs`

Expected: PASS with the one-line invalid-mode FATAL in normal mode and stack details only in debug mode.

- [ ] **Step 3: Commit the fixture isolation correction**

Commit message: `test: isolate public fatal contract fixture`

### Task 4: Integrate publication documentation and seal the next release candidate

**Files:**
- Integrate: reviewed commit `5c4041122df6a0498a13f62f3a7530777c4a8a59`
- Modify: version, changelog, and release manifest files identified by `scripts/bump-version.mjs` and `scripts/release-integrity.mjs`

**Interfaces:**
- Consumes: final frozen source tree and `release-integrity` release workflow.
- Produces: version `0.9.29-rc.2` and a release manifest matching every runtime file.

- [ ] **Step 1: Cherry-pick and review the documentation commit after code fixes are green**

Confirm it only corrects public guidance and historical labels; resolve no conflict by weakening current contracts.

- [ ] **Step 2: Bump the RC suffix through the repository version tool**

Run the project version command so `0.9.29-rc.1` becomes `0.9.29-rc.2`.

- [ ] **Step 3: Seal and verify release integrity**

Run the repository release-integrity seal command followed by its verification command.

- [ ] **Step 4: Commit the frozen release candidate**

Commit message: `chore: prepare 0.9.29-rc.2`

### Task 5: Validate the frozen candidate before public-readiness work

**Files:**
- Modify only if evidence requires it: validation documentation and release notes.

**Interfaces:**
- Consumes: frozen `codex/reinstall-recovery` candidate.
- Produces: evidence for full tests, isolated package installation, visible TUI execution, and the official deep security scan.

- [ ] **Step 1: Run the full serial test suite**

Run: `node --test --test-concurrency=1 test/*.test.mjs`

Expected: zero failures; record intentional skips separately.

- [ ] **Step 2: Validate a fresh isolated distribution install**

Use a clean temporary `CODEX_HOME`, install only the packaged candidate, and run release-integrity verification without reusing an existing plugin cache.

- [ ] **Step 3: Run real visible TUI execution from `C:\workspace`**

Use actual launched windows, task receipts, and the initiating workspace evidence. Close only test-owned windows after their confirmed exits.

- [ ] **Step 4: Run the official deep security scan after the tree is frozen**

Use the Codex Security deep-scan workflow once, preserve its canonical artifacts, triage each validated finding, and make no release claim if it reports unresolved high-severity issues.

- [ ] **Step 5: Prepare the final review package without publishing**

Include source/test/security evidence, history and secret audit results, GitHub settings review, and the exact remaining decision needed for the user to approve publication.

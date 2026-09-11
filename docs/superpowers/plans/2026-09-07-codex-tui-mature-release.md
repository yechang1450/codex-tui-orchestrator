# Codex TUI Orchestrator Mature Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the dedicated Codex TUI orchestrator from a locally verified candidate to a reproducible, current-core, cross-environment stable release while improving its Plugin Eval structure without breaking the historical plugin identity.

**Architecture:** Keep the existing physical core snapshot, memory-derived eight-block cap, dependency/resource scheduler, typed completion watchdog, Windows Terminal launcher and recovery ledger. Improve the skill and manifest at the package boundary, then validate the current core through repeatable offline, live, recovery, packaging, compatibility, focus and security gates.

**Tech Stack:** Node.js 22, Codex CLI, Windows Terminal, PowerShell lifecycle helpers, Node test runner, `release-integrity.mjs`, `repair.mjs`, Plugin Eval and Codex Security.

**Spec:** `docs/release-policy.md` and `docs/execution-contract.md`.

## Global Constraints

- Preserve the historical plugin ID and installation path; use compatibility metadata or an alias before any lowercase migration.
- Keep all run state and disposable artifacts below the initiating workspace `temp` directory.
- Keep the default visible launcher on Windows Terminal and carry only the initiating effective authorization envelope.
- Never increase the effective sandbox for a restricted caller.
- Cap one invocation at `min(8, round(memoryGiB * 1024 / 2000))` blocks and retain every original task.
- Do not run a live model test while another orchestration run is active.
- Run a focused failing test before each production behavior change, then run the complete regression suite before release claims.

---

### Task 1: Establish a current baseline and Plugin Eval brief

**Files:**
- Create: `docs/superpowers/plans/2026-09-07-codex-tui-mature-release.md`
- Read: `.codex-plugin/plugin.json`, `skills/codex-tui-orchestrator/SKILL.md`, `release.json`
- Evidence: `.plugin-eval/` report and `docs/release-policy.md`

**Interfaces:**
- Consumes: current manifest, skill frontmatter, release hashes and the existing 143-test baseline.
- Produces: a before JSON/Markdown evaluation and a recorded list of structural versus runtime gaps.

- [x] Run `node <cache>/openai-curated-remote/plugin-eval/0.1.2/scripts/plugin-eval.js start <repo> --request "Evaluate this plugin and tell me what remains before a mature stable release." --format markdown`.
- [x] Run `node <cache>/openai-curated-remote/plugin-eval/0.1.2/scripts/plugin-eval.js analyze <repo> --format markdown --brief-out <repo>/temp/plugin-eval-before.json`.
- [x] Record that the static 63/100 result is driven by naming, trigger wording, deferred cost and absent coverage artifacts; do not rename the historical ID blindly.

### Task 2: Improve manifest and skill routing without breaking identity

**Files:**
- Modify: `.codex-plugin/plugin.json`
- Modify: `skills/codex-tui-orchestrator/SKILL.md`
- Modify: `skills/codex-tui-orchestrator/agents/openai.yaml`
- Test: `test/orchestrator.test.mjs` or a new focused skill metadata test.

**Interfaces:**
- Consumes: the existing `codex-TUI-orchestrator` ID and user authorization boundary.
- Produces: concise, discriminating trigger metadata and a compatibility note for any lowercase display alias.

- [x] Write a failing metadata test that requires an explicit `Use when` trigger, a concise exclusion for read-only/self-modification requests, and preservation of the historical ID.
- [x] Run the focused metadata test and observe the expected failure against the current frontmatter/description.
- [x] Rewrite only the trigger description and UI metadata; move long execution details to the existing execution-contract and release-policy references.
- [x] Add a lowercase display/alias field only if the manifest schema supports it; otherwise document the evaluator naming exception and keep the ID unchanged.
- [x] Run the metadata test, the available plugin validator, and Plugin Eval analyze again.

### Task 3: Refresh current-core release metadata and documentation

**Files:**
- Modify: `README.md`, `README-zh.md`
- Modify: `docs/compatibility.md`, `docs/live-validation-1.2.1.md`, `docs/live-validation-1.2.3.md`, `docs/release-policy.md`
- Modify: `release.json` only through `scripts/release-integrity.mjs --seal`

**Interfaces:**
- Consumes: current `coreVersion` 1.3.1 and the historical evidence files.
- Produces: a clear current-versus-historical evidence map with no stale current-version claims.

- [x] Add a failing documentation consistency check that compares the current release core version with every “current” version statement.
- [x] Run it and confirm the stale 1.2.x statements are detected.
- [x] Rewrite current sections to identify 1.3.1; retain older sections as explicitly historical evidence.
- [x] Add verified privacy and terms pages to the manifest and link them from the documentation.
- [x] Run the documentation check and `node scripts/release-integrity.mjs`.

### Task 4: Repeat current-core live acceptance and permission/focus checks

**Files:**
- Modify: `test/live-concurrency.mjs`, `test/live-recovery.mjs`, `test/live-inactive-window.ps1` only when a failing current-core assertion requires it.
- Create: `test/live-current-1.3.1.json` and `docs/live-validation-1.3.1.md` as retained evidence.

**Interfaces:**
- Consumes: current public entry, Windows Terminal launcher, 8-block cap, acceptance receipts and recovery ledger.
- Produces: current-hash evidence for eight windows/nine tasks, controller adoption, completed-run resume, no trust prompt and focus observations.

- [x] Add an acceptance assertion that the current `release.json` hash is recorded and that authorized launcher args contain the no-prompt permission envelope.
- [x] Run the assertion against a current-core controlled run and confirm the precondition before model execution.
- [ ] Run the real eight-window/nine-task acceptance from the initiating directory; verify peak 8, eight unique launchers, nine receipts, serial overflow, strict poll exit 0 and zero final live windows.
- Latest current-core attempts did schedule eight blocks for nine tasks, but the account-limited Codex run produced no receipts and the Spark retry ended before durable launcher identity; the gate remains open.
- [ ] Run controller interruption/adoption and completed-run resume; verify no duplicate side effects.
- [x] Run the visible inactive/focus probe and retain both successful observations and any activation/minimization observations without overstating the result.
- [x] Store only the final machine-readable evidence under the workspace test/docs family and clean dead probe state through the existing scoped cleanup protocol.

### Task 5: Verify clean packaging, install, upgrade and rollback

**Files:**
- Modify: `repair.mjs`, `docs/publication-validation.md` only for verified gaps.
- Create: `test/current-package-validation.json`.

**Interfaces:**
- Consumes: source tree, release manifest, pinned SDK lockfile and actual plugin-manager activation paths.
- Produces: a fresh, self-contained package with reproducible integrity and rollback evidence.

- [x] Add a package check that rejects a package whose core hash, manifest version or required links do not match the source.
- [x] Run it against deliberately damaged/stale staging copies and observe rejection.
- [x] Publish a fresh r11 package to `<cache>/personal/codex-tui-orchestrator-validation-20260907-r11` and verify it through the package validator.
- [x] Verify the copied package, install its locked SDK, run doctor, read-only status and repair/public entry checks.
- [x] Record the exact package path, versions and hashes; actual plugin-manager activation/rollback remains explicitly unverified.

### Task 6: Build a CLI and clean-environment compatibility matrix

**Files:**
- Modify: `docs/compatibility.md`
- Create: `test/compatibility-matrix-1.3.1.json` and a focused matrix runner under `test/`.

**Interfaces:**
- Consumes: Codex CLI 0.149.0, 0.153.4 and the installed current CLI; Node 22; Windows Terminal; isolated `CODEX_HOME` and PATH.
- Produces: pass/fail evidence for doctor, public status, one-window execution and permission/trust startup in each environment.

- [x] Add a matrix assertion requiring every row to include CLI version, Node version, terminal, CODEX_HOME mode and result.
- [x] Run the matrix validator and observe missing-row failures.
- [x] Execute the matrix on the available versions and an isolated configuration without developer PATH assumptions.
- [x] Mark unavailable rows as unverified with the exact reason; never infer compatibility from another row.
- [x] Update compatibility documentation and rerun the validator.

### Task 7: Exercise prolonged weak-network and reboot recovery

**Files:**
- Modify: `test/live-recovery.mjs` only for missing current-version evidence hooks.
- Create: `test/network-reboot-validation-1.3.1.json`, `docs/network-reboot-validation.md`.

**Interfaces:**
- Consumes: HTTPS-only transport configuration, run ledger, process identity and bounded retry/reconciliation behavior.
- Produces: evidence for disconnect/reconnect, response timeout after server-side effect, TUI/host shutdown and Windows restart recovery.

- [x] Add a scenario assertion requiring uncertain effects to remain `needs-reconciliation` and never be blindly repeated.
- [x] Run the scenario against the existing controlled HTTP/process harness and verify the recovery invariant.
- [x] Run controlled response-reset, response-timeout and partial-process scenarios; verify retry bounds, preserved evidence and independent reconciliation.
- [ ] Run TUI/controller termination and, where operationally safe, Windows restart recovery; verify adoption or explicit failure without task loss.
- [ ] Record limitations when the host cannot be rebooted during this session; do not label an unrun scenario as passed.

### Task 8: Re-run security review and close release gates

**Files:**
- Modify: `docs/release-policy.md` with current scan IDs, coverage and residual risks.
- Create: `test/security-validation-1.3.1.json`.

**Interfaces:**
- Consumes: current source/release hash, typed completion watchdog, permission envelope and state-directory boundary.
- Produces: current-hash Codex Security scan, targeted regression evidence and an explicit release decision.

- [x] Add a security evidence check that rejects a report whose source hash differs from the current core or whose coverage lacks a recorded limitation.
- [x] Run Codex Security standard scans for both implementations; verify typed `task_complete`, token ownership, state path containment and restricted authorization behavior through the source audit and local regression.
- [x] Re-run full source tests, release-integrity, doctor, package smoke and Plugin Eval analyze; compare before/after JSON.
- [ ] Declare the result as mature stable only when all required gates pass; otherwise list the exact remaining gate and keep the package a candidate.

## Self-Review Checklist

- [x] Current 1.3.1 live evidence is distinct from historical 1.2.x/1.2.3 evidence.
- [ ] Every original task remains accounted for in live and recovery evidence.
- [x] No restricted sandbox receives the dangerous bypass flag.
- [x] The historical plugin ID remains installable while Plugin Eval routing improves.
- [x] All retained artifacts live under the project/workspace family and no active run is removed.
- [x] The final report states verified facts and unverified boundaries separately.


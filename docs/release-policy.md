# Release policy

The dedicated Codex plugin ships a physical, versioned core snapshot. Its installed `scripts/core` must never be a junction into open-tui-orchestrator or another development checkout. Generic changes are not automatically promoted into the dedicated plugin.

Plugin package versions use standard `MAJOR.MINOR.PATCH-rc.N` form. Run `npm --prefix scripts run version:next` for each subsequent release candidate; it increments only `N` and updates `.codex-plugin/plugin.json`, `scripts/package.json` and `scripts/package-lock.json` together. The first candidate in a new line can be set explicitly with `node scripts/bump-version.mjs --set <version>`. Then record the version in CHANGELOG, reseal dependency and release manifests, and validate a fresh distribution. The execution core version remains a separate sealed contract version in `scripts/core/contracts.mjs` and `release.json`.

`scripts/codex-entry.mjs` verifies `release.json` at public execution and polling entry points. Schema 2 records core hashes plus all scripts, the publisher, plugin metadata and skills. Changes, additions, removals and symlinks fail with an explicit integrity error. Legacy schema 1 remains readable for earlier releases. This detects accidental release drift, not malicious modification of both code and manifest.

Maintainer procedure:

1. Confirm no active or pending orchestration windows. Finish or recover live runs before changing runtime code.
2. Review the candidate core and documentation in the dedicated source tree. Keep changes out of installed versions during development.
3. Run the complete regression suite and relevant live acceptance. Existing live evidence is valid only for its recorded core hash.
4. Run `node scripts/release-integrity.mjs --seal`, then `node scripts/release-integrity.mjs` and the public entry smoke check.
5. When a clean package is needed for release review, use `node repair.mjs --target <fresh-version-parent>` or `node scripts/publish-dist.mjs --target <fresh-version-parent>`. Source and copied package must pass integrity verification. Existing targets are rejected to avoid stale mixed releases. Runtime temp, dependencies, evaluation state and git metadata are excluded. Core directory links are rejected rather than materialized. This is an explicit export step; the normal local install does not create a `dist` directory.
6. Verify the copied release before activation. The plugin manager remains responsible for version activation and rollback; never hot-replace a running core.

Activation uses the single checkout by default: the local marketplace entry points at `<checkout>/<plugin-name>` and the installer does not create a `dist` directory. The manager copies the checkout as-is, including any local `.git/` and `temp/` state, so use the explicit clean export flow above when static package evaluation or a release artifact needs those files excluded. `node scripts/repair-plugin-registration.mjs <tree> --check` accepts either the checkout or an explicitly registered `dist` source; a dist source is accepted only while its core inventory matches the checkout, and reports `stale_dist` otherwise.

Runtime upgrades must retain the task ledger, calculated memory capacity, independent acceptance, process identity and bounded recovery contracts. Uncertain external effects cannot be made exactly-once by a local retry mechanism. Git marketplace installs are checked after checkout with LF-only text, locked dependency restoration in the manager-created cache, release integrity and doctor; sealing rejects CRLF runtime text so a Windows working copy cannot produce a package whose hashes change after Git checkout.

The legacy mixed-case invocation remains documented for existing local references, while the canonical manifest and skill identifiers use lowercase hyphen-case. On Windows the existing marketplace source path remains compatible; any non-Windows migration must update that path explicitly.

## Current candidate: core 1.4.4-rc.1

Plugin 0.9.29-rc.1 introduces the current release candidate on the 1.4.4-rc.1 execution core. The planner and both execution modes inherit the initiating Codex provider and credentials by default, including third-party providers configured in CODEX_HOME; only `ORCH_PROVIDER=openai-https` or an explicit relay base URL selects the hardened OpenAI HTTPS provider, and any other `ORCH_PROVIDER` value fails closed. The current candidate remains Private until the installed selftest-close, capacity run and environment gates are recorded as passed. See [RC validation](rc-validation.md) for fresh source/package and live results. Publication still requires the complete source and fresh package gates. The official manager Git lifecycle (add, install, upgrade, rollback, remove and uninstall) is recorded in [manager lifecycle evidence](../test/manager-lifecycle-validation.json) using an isolated local Git transport; it validates manager/cache behavior, not external GitHub reachability. Native Codex UI cards are a host integration interface, not injected by the skill.

## Install tooling (2026-09-21, core 1.4.0-rc.1 unchanged)

Installing from GitHub used to be a four-step manual sequence, and two of those steps had no tooling at all: on a host without `<home>/.agents/plugins/marketplace.json` the registration check only reported `missing_entry` or `invalid_marketplace` and never created an entry, and the manager-created cache never carries `scripts/node_modules`, so skipping the restore leaves a plugin whose skill loads but whose runtime entry fails. `scripts/install-plugin.mjs` now performs the whole sequence and re-verifies against the cache path that install returned; `repair-plugin-registration.mjs --ensure` covers first-time registration, creating the marketplace file only at the personal marketplace path, preserving existing entries and metadata, and stopping on duplicate, foreign or remote sources. `install-plugin.mjs --check` is read-only (registration, distribution freshness, cache dependencies, host enablement) and `--verify-skills` renders one host prompt context to assert the skills are listed.

No execution-core file, capacity contract or acceptance path changed: `scripts/core` and the sealed core version stay at 1.4.0-rc.1, while the cachebuster moves to `+codex.20260921125337` so a reinstall creates a fresh cache. Evidence collected with this change: the targeted registration and install suites plus the new install tests pass against the sealed tree, and the manager install on the documented machine was re-run end to end. A fresh clean-user installation, manager upgrade/rollback for this cachebuster, and live model-backed acceptance for the new entry points remain open gates and must not be reported as covered.

Second-machine validation (sandbox with a fresh HOME and a fresh CODEX_HOME, 2026-09-21) confirmed the install path works end to end from an empty environment, and found two portability defects that are fixed here: the cache check assumed `~/.codex` instead of following `CODEX_HOME` (a relocated CODEX_HOME could therefore be reported as installed while the host CLI used another root, or the reverse), and a marketplace entry still pointing at a previous clone or another machine stopped the installer with a manual-edit instruction. `--check` and install cache discovery now follow `CODEX_HOME` and report `codexHome`, `environment` and `warnings`; `--set-source` re-points the single matching entry to this machine's distribution while preserving other entries, policies and categories; `--verify-skills` degrades to a warning when the host build does not expose the debug entry point, with `--strict-skills` available as a hard gate; child processes are bounded by a timeout. Re-verified in the sandbox after the change: empty-environment install, relocated `CODEX_HOME`, and a stale entry repaired by `--set-source`. A clean-user installation on a physically separate machine, host CLI versions other than the documented one, and non-Windows hosts remain open gates.

## Earlier validation (core 1.3.4-rc.1)

Plugin version `0.4.43-rc.1` fixes asynchronous PowerShell startup and Unicode process identity. RC means a release candidate with a declared, reproducible verification scope; it does not certify every Windows installation or provider condition. See [RC validation](rc-validation.md) for current results and remaining acceptance gates.

The required local gates are the full source regression, a fresh self-contained package regression, locked dependency installation, release integrity, public doctor/status and real Windows process lifecycle/Unicode/startup tests. A model-backed run at the calculated capacity, with valid task receipts and serial overflow coverage, is tracked separately and must be reported honestly; the current-core controller adoption gate is now recorded in [current live evidence](../test/controller-adoption-validation-1.3.4-rc.1.json). The repaired planner now records 12 capacity blocks for the 13-task acceptance, while the host run reached six live descendants before popup startup failures; it remains blocked with invalid/incomplete receipts in [capacity evidence](../test/concurrency-validation-1.3.4-rc.1.json). A broad stable release additionally requires clean-user installation, actual manager upgrade/rollback, prolonged provider outage and OS reboot evidence.

## Earlier validation (core 1.3.1)

The machine-readable release seal covered a 19-file execution core and 40-file runtime/configuration inventory in this historical 1.3.1 snapshot. The canonical plugin and skill identifiers use lowercase hyphen-case; the former mixed-case invocation remains documented as a compatibility alias. The historical Plugin Eval report was 96/100 (A); static score is not a current release gate. The remaining 4.5-point warning is the evaluator's deferred-text budget for the source, tests and documentation; the real Node coverage run reports 81.76% lines, 81.32% branches and 87.50% functions.

The 153/153 and 149/149 figures in this historical section are 1.3.1 evidence, not a current-suite result; the machine-readable record is [regression-validation-1.3.1.json](../test/regression-validation-1.3.1.json). The fresh external validation package recorded in [package-validation-1.3.4-rc.1-historical.json](../test/package-validation-1.3.4-rc.1-historical.json) passes locked dependency install, release verification, doctor, read-only status, repair and plugin validation; manager activation/rollback remains unverified. Native Codex 0.153.4, Windows Terminal selection, initiating-directory propagation and the no-prompt `danger-full-access` envelope have been checked by doctor, generated-launcher tests and a direct CLI argument probe. The retained live run observed eight Codex children but stopped at the account usage limit before task receipts and predates the current focus guard; it is recorded as incomplete and pre-change in [1.3.1 live evidence](live-validation-1.3.1.md). A later current-core Spark attempt also produced eight blocks but ended before durable launcher identity and receipts; both attempts remain explicitly incomplete. The current focus guard has its own visible, no-target-foreground observation.

Codex Security completed standard scans with zero findings: dedicated scan `2350bc0e-afa1-451e-a746-8b36e917ee8c` remains bound to the current dedicated core, while generic scan `7f121996-73fe-4b81-bbce-2d02c9cdc0f6` is explicitly retained as a historical baseline because the generic core changed afterward. The reports are marked partial because an independent baseline worker was unavailable and long-running environment gates remain separate; a generic current-core rescan is required before calling that evidence current. The current 153/153 and 149/149 regressions are recorded in [security evidence](../test/security-validation-1.3.1.json), along with the explicit follow-up limits.

Clean-user install, a model-backed current-core eight-window/nine-task run with receipts and serial overflow, controller adoption after interruption, a prolonged provider outage and an operating-system reboot remain separate acceptance gates. The manager lifecycle is covered by an isolated official Git transport fixture; a public GitHub fetch should be rechecked after the repository is public. These gates must be recorded with current hashes before calling this a broad stable release.

## Historical validation (core 1.2.0)

The installed release passed 126/126 regressions on 2026-09-06. Source and cache both verify the same 17-file core 1.2.0 inventory. The generic project is now core 1.3.0 and can evolve without changing this release.

The source and cache test inventories were reconciled. Watchdog fixtures wait for a parsed positive PID instead of mere file existence, eliminating the empty-file readiness race. Publisher tests reject an existing destination and confirm git metadata and runtime temp files are not shipped. Integrity tests reject modified and newly injected core files.

This is a locally verified release candidate, not a claim of broad clean-machine, cross-version or prolonged-network-outage coverage. The existing plugin identity and installation path are retained; no new marketplace version was published.

## Release hardening on 2026-09-06

Schema 2 covers 37 shipped execution/configuration files (installed dependencies and runtime caches are excluded) while retaining the unchanged 17-file core 1.2.0. Polling also uses the release guard. Publishing verifies both input and output and no longer follows a legacy shared-core junction. The regression fixture exercises publication, refusal of an existing target, rejection of changed runtime files and protection of Git history and workspace temp during cleanup.

`repair.mjs --clean` never traverses .git, node_modules, temp or .plugin-eval. In particular, it is not a run-directory cleanup command: active and retained run evidence must remain owned by their respective controllers. No previously rejected cleanup was retried.

Stable-release gaps still requiring evidence: a clean Windows user account without developer PATH/config dependencies; a declared Codex CLI version matrix; prolonged disconnect/reconnect and shutdown/reboot recovery; installation upgrade/rollback through the actual plugin manager. Existing single-host live concurrency evidence is useful but cannot establish these properties. The manifest now points to the verified project repository and omits unpublished privacy/terms URLs; a marketplace release still requires public support, privacy and terms pages.

The clean-package regression creates a fresh distribution, checks missing-SDK diagnostics, supplies the existing validated SDK as a fixture, runs the packaged doctor and rejects a modified polling runtime. It does not claim a fresh network npm install or clean-machine acceptance.

Final validation of this hardening: source 127/127 and installed cache 127/127 regressions passed. Both verify schema 2, core 1.2.0 (17 core files, 37 shipped runtime/configuration files). Installed doctor from D:\ reports the initiating workspace, Windows Terminal, never approvals and direct HTTPS transport. The execution core was not changed, so prior real-window acceptance is historical evidence for that same core, not a newly repeated load test.

## Dependency and publication resilience (2026-09-06)

The shared release guard no longer requires the SDK: polling remains usable when planning dependencies are absent. Only the orchestration entry checks SDK availability and its exact pinned package version. This validates the SDK version, not every SDK byte or arbitrary Codex CLI versions.

Publication assembles a uniquely named sibling staging directory, verifies its inventory, and renames it to the final directory only after success. Caught copy/validation failures remove that invocation's staging directory. Abrupt process termination can leave an explicitly named staging directory; it is never a valid published release. Physical parent paths are checked to reject source-tree destinations hidden by directory junctions; names beginning with two dots are handled as ordinary names, not parent traversal.

Regression coverage includes missing-SDK polling, wrong-version SDK rejection, injected copy failure, junction aliases and two-dot directory names. The unchanged 17-file core remains 1.2.0; the shipped runtime/configuration inventory now contains 38 files.

Validation after these changes: source and installed cache each passed 127/127 tests; added scenarios extend the existing package tests. Release manifests match byte-for-byte. Installed doctor confirms D:\ as the workspace and D:\temp\orchestrator as state storage. The execution core and its previous live-load evidence were not changed or rerun in this maintenance pass.

## Core 1.2.1: bounded polling (2026-09-06)

Polling validates its supported arguments and safe timer ranges before waiting. Deadlines use a monotonic clock; each sleep and process-inspection call receives at most the remaining budget. Windows process enumeration treats PowerShell errors as failures instead of accepting partial output. OS process startup/termination overhead means this is not a hard real-time guarantee.

Verification still requires the full task inventory, terminal results and two consecutive observations with no matching live launcher. Process-inspection failure never becomes success. New regressions exercise malformed flags/timing, a short remaining deadline, failed inspection, repeated closed observations, and the public poll against a real owned Windows process before and after its exit.

This patch changes poll-windows.mjs, the process-inspection timeout/error handling in leases.mjs, and the core version. Previous eight-window, weak-network and recovery live evidence was recorded for core 1.2.0; it does not certify 1.2.1. The process-lifecycle integration test validates the changed polling behavior, not a new eight-window load test.

Core 1.2.1 final validation: source 132/132 and installed cache 132/132 regressions passed, including the real Windows process lifecycle test. No eight-window model load test was rerun. The installed core, release manifest and documentation were synchronized after confirming no live or reserved orchestration windows.

## Updated live evidence for core 1.2.1

The previously pending current-core eight-window and controller-crash acceptance now passed on this host. See [current live validation](live-validation-1.2.1.md) and its linked machine-readable evidence. This supersedes earlier statements that 1.2.1 had not yet repeated these two live tests; clean-machine, prolonged-outage, reboot and version-matrix limitations remain.

## Installation and second CLI validation update

A fresh-cache lockfile installation and real recovery on CLI 0.149.0 now passed; see [compatibility evidence](compatibility.md). This narrows the earlier unverified-install/version-matrix gaps but does not establish a clean-user installation or multi-window load compatibility on 0.149.0. SDK entry/package-metadata damage now yields an explicit repair diagnostic. Both final regression suites passed 132/132. Cleanup of this turn's standalone install/probe directories was rejected by host automatic approval review; no cleanup executed or bypass was attempted.

## Core 1.2.2: checkpoint identity validation

See the subsequent 1.2.3 section below for the current recovery entry validation.

Recovery now compares each on-disk attempt's run ID, token and ordered task IDs against the controller ledger before reading its checkpoints. A mismatch marks the ledger's affected tasks as needing reconciliation instead of accepting a foreign attempt or treating its omitted task list as unstarted work. Checkpoint writes also reject previous records with a foreign task/run/token or invalid state before accepting completion or overwriting any bytes.

Fault injection covers changed run IDs, tokens, missing/replaced task IDs, and foreign or invalid previous checkpoints, including the controller's verification result and preservation of rejected records. The complete source and installed-cache regression suites each passed 133/133, including controlled Windows process recovery without repeating a completed side effect. This patch does not establish integrity of a jointly edited controller ledger and checkpoint set, or reconstruct a deleted checkpoint that has no other durable evidence. The eight-window and model-driven crash-recovery evidence remains specific to core 1.2.1; no new model-driven load test is claimed for 1.2.2.

## Core 1.2.3: validate the saved recovery ledger before execution

Resume and protocol-2 result verification now validate the original request/task inventory, exact once-only block coverage, correspondence between the saved plan and blocks, complete result maps, attempt identities and task membership, and the dependency graph. A block with launch evidence cannot have an empty attempt inventory. Validation runs before changing the saved generation, writing acceptance/summary files or invoking execution/acceptance hooks. Invalid records fail with `Invalid recovery ledger`; the records remain available for diagnosis.

Regression tests inject 16 forms of inconsistent saved state. An integration test checks that both resume and verification reject a corrupted ledger and that resume invokes zero execution hooks and preserves both saved files. Normal controlled Windows process recovery still checks that completed side effects are not repeated. Three existing 1.2.1 real-run ledgers (eight-window acceptance, resumed generation 3 and CLI 0.149.0 recovery) passed the new validator read-only. This is format compatibility evidence, not another model-driven live run. Full current-suite results are recorded in `test/recovery-ledger-1.2.3.json`.

This validation detects structural inconsistencies; it is not authentication against coordinated edits of every saved record. It cannot reconstruct all externally deleted evidence. Prolonged network outage, reboot and fresh-user installation still require separate acceptance; the previous eight-window live evidence remains version-specific.

## Updated live evidence for core 1.2.3

The 1.2.3 eight-window/nine-task acceptance, live controller-crash adoption and completed-run resume are historical evidence; see [historical live validation](live-validation-1.2.3.md). The current 1.3.1 run is documented separately and remains incomplete because the model account limit was reached. Prolonged-outage, reboot and fresh-user installation remain unverified.

## Task-side response-loss coverage (unchanged core 1.2.3)

Real local HTTP connection loss and response timeout after a server-side effect now have process-level recovery coverage. Both require no duplicate request or attempt, preservation of uncertain status across resume, and success only after independent reconciliation. See [network recovery validation](network-recovery-validation.md). Only tests and documentation changed; this does not replace prolonged provider-network outage acceptance.

## Publisher staged-package completeness

The publisher now checks required non-runtime files in the staged package immediately before committing the destination directory. Injected README and LICENSE omissions must fail without leaving a final package or altering an existing release; a subsequent fresh-directory publication succeeds. See [publication validation](publication-validation.md). `repair.mjs` and its release-manifest hash changed, while execution core 1.2.3 remained unchanged. Actual desktop plugin-manager activation/rollback is not claimed by this package-level test.

## SDK import diagnostics and ordered public startup

SDK validation now loads the module and checks required interfaces before the public entry imports the engine. Four damaged-module scenarios require actionable repair diagnostics. Public exports are checked against the full engine export list. See [SDK diagnostic validation](sdk-diagnostic-validation.md). The entry wrapper and validator changed, but core 1.2.3 did not; this is not a new visible eight-window acceptance of the changed wrapper.

## Core 1.3.0 inactive visible startup

The default described in this historical section was superseded by core 1.3.1: Windows Terminal is again the default, matching the open orchestrator. Internal PowerShell lifecycle scripts remain. Neither default Terminal startup nor the explicit inactive-console option is certified to prevent all foreground activation.

The default launcher requests a non-activated real console via native process startup flags. Windows Terminal remains an explicit option. A real Codex controller-crash/recovery test passed with one inactive-console launch, same-launcher adoption and automatic closure. One full focus probe observed zero activation, but repeated observations also contained activation/minimization of uncertain origin. This is not certification of universally interruption-free startup. See [inactive window details](inactive-windows.md) and its evidence. Eight-window load was not repeated for this version.

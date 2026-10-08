# Windows Recovery Reliability Design

## Context

The recovered Windows environment completed 594 of 603 serial tests. Three failures remain before any release, publish, or public-readiness claim:

1. A 40-process coordinator admission burst exceeds its bounded result wait because `transaction()` runs a global CIM process snapshot after acquiring the coordinator mutex.
2. A PowerShell launcher can expose its PID file before the writer closes it. A transient `EBUSY` then escapes a raw runner hook read and causes a safe recovery attempt to fail closed before the worker runs.
3. The public fatal-contract test inherits the restored host's `WORKSPACE_DIR`, so its temporary controller root violates the real containment invariant before its intended invalid-mode assertion.

## Required behaviour

- A coordinator transaction may take one full process snapshot before acquiring the coordinator mutex. It must never enumerate CIM while that mutex is held.
- A transaction must not discard a structurally valid lease or run owner merely because an earlier snapshot did not contain it when the corresponding ledger changed after that snapshot. It may temporarily preserve capacity in that condition.
- PID publication and reading must tolerate a short Windows file-sharing race without treating a PID file as proof of launcher identity. A missing, unreadable, or mismatched identity remains fail-closed.
- The public-entry test must create an initiating workspace that is a sibling of its controller state, so it tests the promised invalid-mode contract rather than bypassing the containment guard.
- No fix may weaken launcher identity, exit evidence, lease ownership, capacity, conflict, or workspace-containment checks.

## Design decisions

### Coordinator observation fence

Before the mutex is requested, `transaction()` captures one process snapshot and an observation revision for `leases.json` and `run-owners.json`. A revision is a SHA-256 hash of bounded raw file bytes, `absent`, or `unknown`. The latter includes a read error, reparse point, oversized artifact, or another condition that prevents a trustworthy comparison.

Inside the mutex, `transaction()` may compare the current local file revision with the observation, but it may not take a second process snapshot. If either revision is unknown or the revisions differ, a negative process match is not authority to reclaim a valid entry. The entry stays in the ledger and continues to count against admission. A later transaction with a stable revision and a new snapshot can reclaim it.

The same fence applies to `run-owners.json`. Otherwise a stale snapshot could remove a controller claim written while another process waited for the coordinator mutex.

### PID publication and reading

The generated PowerShell launchers publish their PID by writing a same-directory temporary file, closing it, then atomically moving it into place. The runner also reads launcher PID files through one bounded retry helper. It retries only temporary sharing/access failures (`EBUSY`, `EPERM`, `EACCES`) and the short startup period with PID `0`.

The helper returns a valid positive integer only. Identity still has to pass the existing launcher verification. On permanent unreadability, a malformed PID, or identity mismatch, the runner preserves the lease, artifacts, and recovery state and reports the real reason. It never opens a replacement window or treats a result file as exit proof.

### Test isolation

The malformed-contract test explicitly supplies a clean sibling workspace and explicit debug settings for both assertions. Production workspace containment remains unchanged.

## Evidence required before release work resumes

- The three focused regression groups pass with their new red-to-green coverage.
- The full serial suite completes with no failures.
- A fresh isolated distribution installation and release-integrity verification succeed after all source and documentation changes are sealed.
- A real visible TUI execution from `C:\workspace` proves that launched windows inherit the initiating workspace and produces task receipts.
- The official deep security scan runs only after the code and release artifact are frozen.

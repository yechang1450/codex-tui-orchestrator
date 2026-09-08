# Core 1.2.3 live validation (historical evidence)

The installed dedicated plugin passed both visible Codex TUI acceptance scenarios from `D:\` on 2026-09-06. No runtime files changed during either run. The source and installed core hashes match the tested hash recorded in [machine-readable evidence](../test/live-stability-1.2.3.json).

- Eight windows, nine tasks: eight unique launchers and eight simultaneous Codex processes; the first eight probes overlapped for 16,405 ms. The ninth task ran after the eighth in the same block. All nine result receipts passed independent verification. Engine and strict window polling both exited zero, with all windows closed.
- Controller interruption: after the first task completed and the second was running, the test terminated only its own controller. A new controller adopted the same surviving window. Both tasks passed verification; the first task executed once, with one attempt and one window total.
- Completed-run resume: another resume advanced the saved generation to three, returned success and created no new attempt or window. The first-task execution count remained one.
- Final public status showed no active windows, reservations or pending locks.

These results supersede the earlier pending current-core eight-window and live recovery items. They do not establish behavior during a prolonged network outage, an operating-system reboot or installation under a fresh Windows user. The full regression result remains 135/135 in both source and installed snapshots, as recorded in [ledger validation evidence](../test/recovery-ledger-1.2.3.json).

The host rejected the probe-cleanup command before execution. Probe/barrier files therefore remain in the two test roots listed in the evidence. No alternate cleanup mechanism was attempted.

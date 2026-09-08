# Core 1.3.1 live validation

The retained live probe was run from `D:\` on 2026-09-07 with Node 22.23.2, Codex CLI 0.153.4 and the default Windows Terminal launcher. It used core hash `a48a...`, before the later focus guard; [machine-readable evidence](../test/live-current-1.3.1.json) records that mismatch explicitly. The separate current-hash focus observation is in [1.3.1 focus evidence](../test/inactive-window-validation-1.3.1.json).

The scheduler calculated a capacity of eight and admitted eight visible Windows Terminal launchers. Process sampling observed eight live Codex descendants at the peak, so the admission limit was respected. The plan contained nine tasks and compacted them into eight blocks, with the ninth task retained in the eighth serial block.

The model-backed portion did not finish: the Codex account usage limit was reached after the eight windows and their Codex children started. The engine and strict poll therefore exited with code 1, no task receipt was produced, and the report is recorded as incomplete. This evidence establishes the current startup, directory propagation and capacity observation; it does not claim successful nine-task execution, overflow ordering or provider availability.

A second current-core attempt used `gpt-5.3-codex-spark` after the primary Codex window was exhausted. The scheduler again produced eight blocks for nine tasks, but the provider child exited before a durable launcher identity could be observed; the run closed all reservations with zero receipts and remains a failed acceptance attempt. It is recorded in the `latestAttempt` field of the machine-readable evidence and does not replace the earlier eight-window observation.

The earlier 1.2.1 and 1.2.3 reports remain historical evidence. Controlled current-hash response-loss and partial-process recovery are recorded in [network/reboot evidence](../test/network-reboot-validation-1.3.1.json). Controller adoption with a completed model-backed task, clean-user installation, plugin-manager rollback, prolonged outage and operating-system reboot still require separate current-core evidence before a broad stable-release claim.

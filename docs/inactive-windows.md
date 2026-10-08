# Historical execution-visibility notes (core 1.4.2-rc.1)

> **Historical record:** this document describes the 1.4.2-rc.1 implementation and its dated single-host observations. It does not certify the current core, installed plugin, or release candidate. Rerun the probe and bind new evidence to the commit under review before making a current claim.

In that core snapshot, headless exec was the default without a terminal window. `--run-windows` or `--visible` selected visible execution. `ORCH_TUI` applied only to visible mode.

In that snapshot, Windows Terminal was the preferred visible host. Its launcher requested `SW_SHOWNOACTIVATE` and briefly restored the initiating foreground window during startup. Input accompanied by a focus change ended that guard. This was a request to the host, not a guarantee against external focus changes; Windows restricts which processes can set the foreground window ([Microsoft documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)).

The fallback explicitly started Windows `conhost.exe`. Directly launching PowerShell could be delegated to the system's default terminal: a probe previously called “Legacy” actually observed `CASCADIA_HOSTING_WINDOW_CLASS`, the Windows Terminal window class. The fallback initialized its console hidden, located only the `ConsoleWindowClass` window owned by the newly created host PID, and showed it with `SW_SHOWNOACTIVATE`. It did not remain hidden or minimized. Admission failure stopped that owned host rather than leaving hidden work running. It did not change the user's default terminal settings.

The helper and probe preserved task/checkpoint/close behavior at the window layer; end-to-end selftest-close and rollout ownership were tracked separately in the RC checklist. The helper and probe used UTF-8 console and pipeline encodings. Default headless execution was unaffected.

## Recorded measurements for that snapshot

The corrected probe measured foreground events and sampled **during** asynchronous helper startup, window class, visibility, minimized state, launcher exit, and automatic closure. It read the execution receipt and checked its task title and working directory. Windows Terminal received an explicit `-d` in the probe; relying only on its parent process working directory had previously run the probe in the user's home directory.

The recorded Windows Terminal and explicit legacy-console observations both passed for that snapshot, including valid receipts and zero target foreground samples. See the [dated focus evidence](../test/inactive-window-validation-current.json), which records the helper and probe hashes. These are single-host observations, not cross-machine guarantees and do not certify a later core.

```powershell
powershell.exe -NoProfile -File test/live-inactive-window.ps1 -Workspace (Get-Location).Path
powershell.exe -NoProfile -File test/live-inactive-window.ps1 -Workspace (Get-Location).Path -Legacy
```

`-SystemDefaultConsole` retained the direct-PowerShell diagnostic path so terminal delegation could be reproduced without confusing it with the explicit legacy fallback.

## Continuous input

In that snapshot, `-ContinuousInput` created an owned WinForms text box and required foreground readiness **before** starting a target. If readiness failed, it recorded a skipped, non-passing result and sent no keys. During startup it pumped window messages, sent synthetic periods only while the owned text box was focused, and permanently stopped sending after observed focus loss. As with any global synthetic keyboard input, the foreground could change between the ownership check and delivery; run a fresh opt-in test on an otherwise idle desktop before relying on this behavior.

The report recorded `inputReady`, `inputAttempts`, `inputDelivered`, `inputDuringLaunch`, `inputLostFocus`, and `inputLossHwnd`. Acceptance required delivery during startup and complete delivery without focus loss. A plain startup pass did not satisfy this gate. The recorded attempted input runs did not pass; they are historical evidence and cannot establish a later release gate.

Historical [1.3.4 input evidence](../test/inactive-window-validation-1.3.4-rc.1.json) used a synchronous helper call and sent input only after the startup guard ended. It proves that input arrived later, not that typing remained uninterrupted during startup. Older focus files remain historical records and do not certify the corrected probe or current core.

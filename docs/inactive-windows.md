# Execution visibility

Core 1.4.1-rc.1 defaults to headless exec without a terminal window. `--run-windows` or `--visible` selects visible execution. `ORCH_TUI` applies only to visible mode.

Windows Terminal remains the preferred visible host. Its launcher requests `SW_SHOWNOACTIVATE` and briefly restores the initiating foreground window during startup. Input accompanied by a focus change ends that guard. This is a request to the host, not a guarantee against external focus changes; Windows restricts which processes can set the foreground window ([Microsoft documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)).

The fallback explicitly starts Windows `conhost.exe`. Directly launching PowerShell can be delegated to the system's default terminal: a probe previously called “Legacy” actually observed `CASCADIA_HOSTING_WINDOW_CLASS`, the Windows Terminal window class. The fallback now initializes its console hidden, locates only the `ConsoleWindowClass` window owned by the newly created host PID, and shows it with `SW_SHOWNOACTIVATE`. It does not remain hidden or minimized. Admission failure stops that owned host rather than leaving hidden work running. It does not change the user's default terminal settings.

The helper and probe preserve task/checkpoint/close behavior at the window layer; end-to-end selftest-close and rollout ownership are tracked separately in the RC checklist. The helper and probe use UTF-8 console and pipeline encodings. Default headless execution is unaffected.

## Current measurements

The corrected probe measures foreground events and samples **during** asynchronous helper startup, window class, visibility, minimized state, launcher exit, and automatic closure. It reads the execution receipt and checks its task title and working directory. Windows Terminal receives an explicit `-d` in the probe; relying only on its parent process working directory previously ran the probe in the user's home directory.

The current Windows Terminal and explicit legacy-console observations both passed, including valid receipts and zero target foreground samples. See [current focus evidence](../test/inactive-window-validation-current.json), which records the helper and probe hashes. These are single-host observations, not cross-machine guarantees.

```powershell
powershell.exe -NoProfile -File test/live-inactive-window.ps1 -Workspace (Get-Location).Path
powershell.exe -NoProfile -File test/live-inactive-window.ps1 -Workspace (Get-Location).Path -Legacy
```

`-SystemDefaultConsole` retains the direct-PowerShell diagnostic path so terminal delegation can be reproduced without confusing it with the explicit legacy fallback.

## Continuous input

`-ContinuousInput` creates an owned WinForms text box and requires foreground readiness **before** starting a target. If readiness fails, it records a skipped, non-passing result and sends no keys. During startup it pumps window messages, sends synthetic periods only while the owned text box is focused, and permanently stops sending after observed focus loss. As with any global synthetic keyboard input, the foreground can change between the ownership check and delivery; run this opt-in test on an otherwise idle desktop.

The report records `inputReady`, `inputAttempts`, `inputDelivered`, `inputDuringLaunch`, `inputLostFocus`, and `inputLossHwnd`. Acceptance requires delivery during startup and complete delivery without focus loss. A plain startup pass does not satisfy this gate. The latest attempted input runs did not pass; this remains a release blocker.

Historical [1.3.4 input evidence](../test/inactive-window-validation-1.3.4-rc.1.json) used a synchronous helper call and sent input only after the startup guard ended. It proves that input arrived later, not that typing remained uninterrupted during startup. Older focus files remain historical records and do not certify the corrected probe or current core.

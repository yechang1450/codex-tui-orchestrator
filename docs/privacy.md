# Privacy

`codex-tui-orchestrator` runs locally in the workspace chosen by the initiating
conversation. It does not add telemetry, collect account data, or send task
content to a service operated by this plugin.

The Codex CLI or another supported host may contact its own provider according
to that host's configuration. Credentials, model selection, provider requests,
and provider retention are controlled by that host and its published policy.

The initiating workspace's `temp` directory holds run ledgers, checkpoints,
receipts, and verification evidence. Controller-owned launch files, the shared
coordinator, acceptance and immutable run-plan bindings, and supervisor authority live under
`CODEX_HOME/state/plugins/codex-tui-orchestrator` by default. Headless launch
files there include task prompts and CLI output streams. Credential-shaped fields
are redacted at the provider output boundary, while task text and local paths
remain available for protocol recovery. A headless
run successfully finalized by its controller removes its launch files; an unfinished or
failed run retains them for recovery and inspection. Visible launch files are
removed after their owned process exits. A user who discards a failed run must
clean its workspace run record and associated controller files together after
confirming no worker is active. Use headless mode when prompt text must not
appear in a visible TUI process command line.

The coordinator location is derived from `CODEX_HOME` unless an explicit
`ORCH_COORDINATOR_DIR` outside the initiating workspace is supplied. The plugin
does not use the former `HKCU\\Software\\CodexTuiOrchestrator\\CoordinatorRoot`
locator for new runs.

Questions about this policy can be raised in the project repository:
<https://github.com/yechang1450/codex-tui-orchestrator>.

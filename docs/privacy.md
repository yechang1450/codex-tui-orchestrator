# Privacy

`codex-tui-orchestrator` runs locally in the workspace chosen by the initiating
conversation. It does not add telemetry, collect account data, or send task
content to a service operated by this plugin.

The Codex CLI or another supported host may contact its own provider according
to that host's configuration. Credentials, model selection, provider requests,
and provider retention are controlled by that host and its published policy.

The plugin writes run state, receipts, and temporary launch data below the
initiating workspace's `temp` directory. Users can remove completed run data
with the normal workspace cleanup process.

For Codex coordination across workspaces, the plugin also stores the path to
the shared coordinator directory in the current user's Windows registry at
`HKCU\\Software\\CodexTuiOrchestrator\\CoordinatorRoot`. It stores a locator
only; task content, credentials, and provider responses are not written there.

Questions about this policy can be raised in the project repository:
<https://github.com/yechang1450/codex-tui-orchestrator>.

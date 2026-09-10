// Compatibility entry for the current run-ledger calculated-capacity acceptance.
// Invoke from the initiating workspace. This opens real Codex TUI windows.
process.env.ORCH_LIVE_AGENT='codex';
await import('./live-codex.mjs');

// Uses the same calculated-capacity contract with the installed Pi CLI.
process.env.ORCH_LIVE_AGENT='pi';
await import('./live-codex.mjs');

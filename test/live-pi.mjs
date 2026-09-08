// Uses the same real 8-window / 9-task contract with the installed Pi CLI.
process.env.ORCH_LIVE_AGENT='pi';
await import('./live-codex.mjs');

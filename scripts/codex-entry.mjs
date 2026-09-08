import {verifyRelease} from './release-integrity.mjs';
verifyRelease();
if(process.env.ORCH_AGENT&&process.env.ORCH_AGENT!=='codex')throw new Error('Codex-specific adapter requires Codex');
process.env.ORCH_AGENT='codex';

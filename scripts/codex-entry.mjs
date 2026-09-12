import {verifyRelease} from './release-integrity.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {configureEntryArgs} from './entry-options.mjs';
verifyRelease();
const publicEntry=fileURLToPath(new URL('./orchestrate-sdk.mjs',import.meta.url));
if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===publicEntry.toLowerCase()){
  process.argv=[...process.argv.slice(0,2),...configureEntryArgs(process.argv.slice(2))];
}
if(process.env.ORCH_AGENT&&process.env.ORCH_AGENT!=='codex')throw new Error('Codex-specific adapter requires Codex');
process.env.ORCH_AGENT='codex';

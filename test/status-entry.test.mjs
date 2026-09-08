import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('public SDK status dispatch returns an actual read-only status, not usage',()=>{
 const file=fileURLToPath(new URL('../scripts/orchestrate-sdk.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[file,'--status','--readonly'],{env:{...process.env,ORCH_AGENT:'codex'},encoding:'utf8',windowsHide:true,timeout:20000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/=== alive agent TUI windows ===/);assert.doesNotMatch(result.stdout,/Usage:/);
});

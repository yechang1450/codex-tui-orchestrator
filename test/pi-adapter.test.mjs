import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveHost,launchArgs} from '../scripts/core/host-cli.mjs';
import {resolvePiHost} from '../scripts/core/pi-host.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const piAvailable=(()=>{try{resolveHost({env:{...process.env,ORCH_AGENT:'pi'}});return true;}catch(error){if(/CLI_MISSING/.test(String(error?.message||error)))return false;throw error;}})();
test('installed pi resolves its own CLI and never receives Codex flags',{skip:!piAvailable},()=>{
 const host=resolveHost({env:{...process.env,ORCH_AGENT:'pi'}});
 assert.equal(host.agent,'pi');assert.ok(host.config.prefixArgs.at(-1).endsWith('cli.js'));
 assert.match(host.config.version,/^\d+\.\d+\.\d+$/);
 const args=launchArgs(host.config,{cwd:process.cwd(),sandbox:'danger-full-access',approval:'never'});
 assert.ok(args.includes('--approve'));assert.ok(args.includes('--offline'));
 assert.ok(!args.includes('--sandbox'));assert.ok(!args.includes('--cd'));
});
test('an explicit missing pi CLI never falls back to PATH or Codex',()=>{
 assert.throws(()=>resolveHost({env:{...process.env,ORCH_AGENT:'pi',ORCH_CLI:'fixture:/no-such-pi-orchestrator-test.exe'}}),/CLI_MISSING/);
 assert.throws(()=>launchArgs({id:'pi'},{sandbox:'read-only'}),/PI_SANDBOX_UNSUPPORTED/);
});
test('unverified pi PATH and explicit candidates are rejected before execution',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-trust-')),fake=path.join(dir,'pi.exe');
 try { fs.writeFileSync(fake,'not a real executable');
   assert.throws(()=>resolvePiHost({PATH:dir,Path:''},{verifyPublisher:()=>false}),/CLI_MISSING/);
   assert.throws(()=>resolvePiHost({ORCH_CLI:fake},{verifyPublisher:()=>false}),/CLI_MISSING/);
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

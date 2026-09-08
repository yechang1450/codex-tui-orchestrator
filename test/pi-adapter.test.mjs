import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveHost,launchArgs} from '../scripts/core/host-cli.mjs';
test('installed pi resolves its own CLI and never receives Codex flags',()=>{
 const host=resolveHost({env:{...process.env,ORCH_AGENT:'pi'}});
 assert.equal(host.agent,'pi');assert.ok(host.config.prefixArgs.at(-1).endsWith('cli.js'));
 assert.match(host.config.version,/^\d+\.\d+\.\d+$/);
 const args=launchArgs(host.config,{cwd:process.cwd()});
 assert.ok(args.includes('--approve'));assert.ok(args.includes('--offline'));
 assert.ok(!args.includes('--sandbox'));assert.ok(!args.includes('--cd'));
});
test('an explicit missing pi CLI never falls back to PATH or Codex',()=>{
 assert.throws(()=>resolveHost({env:{...process.env,ORCH_AGENT:'pi',ORCH_CLI:'D:/temp/no-such-pi-orchestrator-test.exe'}}),/CLI_MISSING/);
 assert.throws(()=>launchArgs({id:'pi'},{sandbox:'read-only'}),/PI_SANDBOX_UNSUPPORTED/);
});

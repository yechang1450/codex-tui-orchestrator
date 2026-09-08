import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {processSnapshot} from '../scripts/core/leases.mjs';
const source=fileURLToPath(new URL('..',import.meta.url));
test('public poll times out while a recorded real process lives, then succeeds after it exits',{skip:process.platform!=='win32'},async()=>{
 const family=path.join(source,'temp');fs.mkdirSync(family,{recursive:true});
 const root=fs.mkdtempSync(path.join(family,'poll-process-'));
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
 const closed=once(child,'exit');
 try{
  await once(child,'spawn');
  const launcher=processSnapshot().get(child.pid);assert.ok(launcher);
  const dir=path.join(root,'temp','orchestrator','runs','real-process');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify({runId:'real-process',finishedAt:Date.now(),blocks:[{key:'B1'}],tasks:[{id:'T1'}],results:{B1:{status:'verified',launcher}},taskResults:{T1:{status:'verified'}}}));
  const poll=timeout=>spawnSync(process.execPath,[path.join(source,'scripts','poll-windows.mjs'),'--run-id','real-process','--timeoutMs',String(timeout),'--intervalMs','500'],{cwd:root,env:{...process.env,WORKSPACE_DIR:root,ORCH_AGENT:'codex'},windowsHide:true,encoding:'utf8',timeout:20000});
  const alive=poll(1800);assert.notEqual(alive.status,0);assert.doesNotMatch(alive.stdout,/'success':true|"success":true/);
  child.kill();await closed;
  const done=poll(15000);assert.equal(done.status,0,done.stderr);assert.match(done.stdout,/"success":true/);
 }finally{
  if(child.exitCode===null&&child.signalCode===null){child.kill();await closed;}
  fs.rmSync(root,{recursive:true,force:true});
 }
});

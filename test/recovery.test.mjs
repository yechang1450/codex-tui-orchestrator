import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const runner=await import('../scripts/core/runner.mjs');
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('a dependent starts after its own prerequisite, while unrelated work remains running',async()=>{
 assert.equal(typeof runner.scheduleReady,'function');
 const events=[],recs=[{key:'A',dependsOn:[]},{key:'B',dependsOn:[]},{key:'C',dependsOn:['A']}];
 const statuses={};let finishB;const bDone=new Promise(r=>finishB=r);
 const work=runner.scheduleReady(recs,async r=>{events.push('start-'+r.key);if(r.key==='B')await bDone;if(r.key==='A')await pause(10);statuses[r.key]='verified';events.push('end-'+r.key);},key=>statuses[key]);
 try{await pause(60);assert.ok(events.includes('end-C'));assert.ok(!events.includes('end-B'));}finally{finishB();await work;}
});
test('recovery rechecks partial work and never repeats verified or uncertain side effects',()=>{
 assert.equal(typeof runner.recoveryTasks,'function');
 fs.mkdirSync(family,{recursive:true});const dir=fs.mkdtempSync(path.join(family,'resume-ledger-'));
 try{
  fs.writeFileSync(path.join(dir,'one.json'),JSON.stringify({count:1}));
  const tasks=['T1','T2','T3','T4'].map(id=>({id,prompt:id}));
  const checkpoints={T1:{state:'completed'},T2:{state:'started'},T4:{state:'started'}};
  const checks={T1:[{type:'json',path:'one.json',equals:{count:1}}],T2:[{type:'file',path:'missing'}],T4:{checks:[{type:'file',path:'missing'}],retrySafe:true}};
  const result=runner.recoveryTasks(tasks,checkpoints,checks,dir);
  assert.deepEqual(result.verified,['T1']);assert.deepEqual(result.pending,['T3','T4']);assert.deepEqual(result.uncertain,['T2']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('new launcher preserves a failed CLI exit and never blindly repeats the prompt',async()=>{
 process.env.ORCH_AGENT='codex';const sdk=await import('../scripts/orchestrate-sdk.mjs');
 const la=sdk.writeInteractiveLauncher('recovery-contract','read-only probe','test-'+process.pid);
 const dir=fs.mkdtempSync(path.join(family,'failed-cli-')),counter=path.join(dir,'count'),fake=path.join(dir,'fake.ps1');
 const lit=s=>"'"+s.replaceAll("'","''")+"'";
 try{
  fs.writeFileSync(fake,`Add-Content -LiteralPath ${lit(counter)} -Value called\nexit 23`);
  const text=fs.readFileSync(la.lp,'utf8').replace(/^    & '[^\r\n]+' @agentArgs$/m,`    & powershell.exe -NoProfile -File ${lit(fake)}`);
  fs.writeFileSync(la.lp,text);
  const result=spawnSync('powershell.exe',['-NoProfile','-File',la.lp],{windowsHide:true,encoding:'utf8',timeout:30000,env:{...process.env,ORCH_SESSION_DIR:dir,ORCH_SDIR:dir}});
  assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(counter,'utf8').trim(),'called');
  assert.equal(JSON.parse(fs.readFileSync(la.rf,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/)[0]).__EXIT__,23);
 }finally{for(const p of [...Object.values(la),la.rf+'.self-closed',la.pidf+'.self-closed'])if(typeof p==='string'&&fs.existsSync(p))fs.rmSync(p,{force:true});fs.rmSync(dir,{recursive:true,force:true});}
});

test('failed prerequisites block only their own dependents',async()=>{
 const statuses={},executed=[],blocked=[];
 await runner.scheduleReady([{key:'A',dependsOn:[]},{key:'B',dependsOn:[]},{key:'C',dependsOn:['A']}],async r=>{executed.push(r.key);statuses[r.key]=r.key==='A'?'failed':'verified';},k=>statuses[k],r=>blocked.push(r.key));
 assert.deepEqual(executed.sort(),['A','B']);assert.deepEqual(blocked,['C']);
});

test('a saved verified checkpoint is rechecked if its separate file is missing',()=>{
 const dir=fs.mkdtempSync(path.join(family,'saved-checkpoint-'));
 try{
  fs.writeFileSync(path.join(dir,'result.json'),'{"count":1}');
  const sum={runId:'r',blocks:[{key:'B1',taskIds:['T1']}],results:{B1:{endedAt:1,attempts:[]}},taskResults:{T1:{status:'verified',checkpoint:{state:'completed'}}}};
  runner.collectVerification(sum,{T1:[{type:'json',path:'result.json',equals:{count:1}}]},dir);
  assert.equal(sum.taskResults.T1.status,'verified');
  fs.writeFileSync(path.join(dir,'result.json'),'{"count":2}');
  runner.collectVerification(sum,{T1:[{type:'json',path:'result.json',equals:{count:1}}]},dir);
  assert.equal(sum.taskResults.T1.status,'failed');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('failed rechecks preserve execution evidence so a later resume cannot repeat an uncertain task',()=>{
 const dir=fs.mkdtempSync(path.join(family,'checkpoint-evidence-'));
 try{
  const sum={runId:'r',blocks:[{key:'B1',taskIds:['T1']}],results:{B1:{endedAt:1,attempts:[]}},taskResults:{T1:{status:'verified',checkpoint:{state:'started'}}}};
  const checks={T1:[{type:'file',path:'missing'}]};
  runner.collectVerification(sum,checks,dir);
  assert.equal(sum.taskResults.T1.checkpoint?.state,'started');
  runner.collectVerification(sum,checks,dir);
  assert.equal(sum.taskResults.T1.status,'needs-reconciliation');
  const recovery=runner.recoveryTasks([{id:'T1'}],{T1:sum.taskResults.T1.checkpoint},checks,dir);
  assert.deepEqual(recovery.pending,[]);assert.deepEqual(recovery.uncertain,['T1']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

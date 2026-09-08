import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateRecoverySummary} from '../scripts/core/recovery.mjs';
import {runWindows,verifyRun} from '../scripts/core/runner.mjs';

function fixture(workspace) {
 return {protocol:2,runId:'ledger',workspace,request:'first;second',generation:1,history:[],
  tasks:[{id:'T001',prompt:'first'},{id:'T002',prompt:'second'}],
  plan:[{key:'B1',title:'both',keys:[],dependsOn:[],b:{tasks:[{sourceIds:['T001','T002']}]}}],
  blocks:[{key:'B1',taskIds:['T001','T002']}],results:{B1:{status:'pending',attempts:[]}},
  taskResults:{T001:{status:'pending'},T002:{status:'pending'}}};
}
test('saved recovery ledger rejects inconsistent inventories without mutating input',()=>{
 const valid=fixture(process.cwd()),before=JSON.stringify(valid);
 validateRecoverySummary(valid);assert.equal(JSON.stringify(valid),before);
 const changes=[s=>s.tasks.pop(),s=>s.tasks[0].prompt='changed',s=>s.blocks[0].taskIds.pop(),
  s=>s.blocks[0].taskIds.push('T001'),s=>s.plan=[],s=>s.plan[0].b.tasks[0].sourceIds.reverse(),
  s=>delete s.results.B1,s=>s.results.extra={},s=>delete s.taskResults.T001,
  s=>s.generation=0,s=>s.history=null,s=>s.plan[0].dependsOn=['B1'],
  s=>s.results.B1.status='running',s=>s.results.B1.launcherFiles={pidf:'window.pid'},
  s=>s.results.B1.attempts=null,s=>s.results.B1.attempts=[{runId:'foreign',token:'t',file:'x',taskIds:['T001']}]];
 for(const change of changes){const value=structuredClone(valid);change(value);const saved=JSON.stringify(value);
  assert.throws(()=>validateRecoverySummary(value),/Invalid recovery ledger/);
  assert.equal(JSON.stringify(value),saved);
 }
});
test('resume rejects damaged ledger before any hook or persisted state changes',async()=>{
 const family=fileURLToPath(new URL('../temp/',import.meta.url));fs.mkdirSync(family,{recursive:true});
 const root=fs.mkdtempSync(path.join(family,'ledger-corruption-'));
 try{
  const dir=path.join(root,'temp/orchestrator/runs/ledger');fs.mkdirSync(dir,{recursive:true});
  const saved=fixture(root);saved.blocks[0].taskIds.pop();saved.finishedAt=1;
  const file=path.join(dir,'summary.json'),raw=JSON.stringify(saved);fs.writeFileSync(file,raw);
  const checks=path.join(dir,'acceptance.json');fs.writeFileSync(checks,'{}');let calls=0;
  const hooks=new Proxy({}, {get(){calls++;throw new Error('Unexpected execution hook');}});
  await assert.rejects(runWindows('',hooks,{workspace:root,capacity:8,runId:'ledger',resume:true}),/Invalid recovery ledger/);
  assert.throws(()=>verifyRun(root,'ledger'),/Invalid recovery ledger/);
  assert.equal(calls,0);assert.equal(fs.readFileSync(file,'utf8'),raw);assert.equal(fs.readFileSync(checks,'utf8'),'{}');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

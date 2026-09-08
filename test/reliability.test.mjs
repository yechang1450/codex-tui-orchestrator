import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SUCCESS,summaryComplete,keysOverlap,levelWaves,ledgerPlan,verifyTask} from '../scripts/core/contracts.mjs';
import {reserve,release,sameProcess} from '../scripts/core/leases.mjs';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
fs.mkdirSync(family,{recursive:true});
test('strict accounting rejects missing blocks, missing tasks, extra identities and unverified termination',()=>{
 const base={runId:'run',blocks:[{key:'B1'},{key:'B2'}],tasks:[{id:'T1'},{id:'T2'}],results:{B1:{status:'verified'}},taskResults:{T1:{status:'verified'}}};
 assert.equal(summaryComplete(base),false);
 base.results.B2={status:'verified'};base.taskResults.T2={status:'verified'};assert.equal(summaryComplete(base),true);
 for(const status of ['done','locked','preflight-failed','awaiting-verification','failed']){base.results.B2.status=status;assert.equal(summaryComplete(base),false);assert.equal(SUCCESS.has(status),false);}
 base.results.B2.status='verified';base.taskResults.extra={status:'verified'};assert.equal(summaryComplete(base),false);
});
test('cycles, self references and unknown dependency IDs are rejected',()=>{
 const rec=(key,deps)=>({key,title:key,b:{title:key},dependsOn:deps});
 for(const recs of [[rec('A',['B']),rec('B',['A'])],[rec('A',['A'])],[rec('A',['missing'])]])assert.throws(()=>levelWaves(recs),/dependenc/i);
 assert.deepEqual(levelWaves([rec('B',['A']),rec('A',[])]).map(w=>w.map(r=>r.key)),[['A'],['B']]);
});
test('path aliases and ancestor locks conflict without false sibling prefix conflicts',()=>{
 assert.equal(keysOverlap(['file:D:/DEMO/a.txt'],['file:d:\\demo\\a.txt']),true);
 assert.equal(keysOverlap(['dir:D:/demo'],['file:D:/demo/sub/a.txt']),true);
 assert.equal(keysOverlap(['dir:D:/demo'],['file:D:/demo-other/a.txt']),false);
});
test('incomplete model plan retains every original task in a serial fallback',()=>{
 const {tasks,plan}=ledgerPlan('执行甲；执行乙',[{tasks:[{prompt:'执行甲'}]}],8,p=>p);
 assert.equal(tasks.length,2);assert.deepEqual(plan.flatMap(b=>b.tasks.flatMap(t=>t.sourceIds)),['T001','T002']);
});
test('process ID reuse never matches an old launcher identity',()=>{
 const a={ProcessId:42,Started:'first',Name:'powershell.exe',CommandLine:'launcher.ps1'};
 assert.equal(sameProcess(a,{...a}),true);assert.equal(sameProcess(a,{...a,Started:'second'}),false);
 assert.equal(sameProcess(a,{...a,CommandLine:'other.ps1'}),false);
});
test('global coordinator capacity counts all runs, not only resource conflicts',()=>{
 const dir=fs.mkdtempSync(path.join(family,'lease-test-'));
 const owner={ProcessId:process.pid,Started:'generation',Name:'node',CommandLine:'test'};
 const snapshot=()=>new Map([[process.pid,owner]]);
 try {
  for(let i=0;i<8;i++)assert.equal(reserve(dir,{id:'L'+i,runId:'run'+i,keys:['file:D:/p'+i]},8,snapshot).ok,true);
  assert.equal(reserve(dir,{id:'L9',runId:'other',keys:['file:D:/unrelated']},8,snapshot).reason,'capacity');
  release(dir,'L0',snapshot);assert.equal(reserve(dir,{id:'L9',runId:'other',keys:['file:D:/unrelated']},8,snapshot).ok,true);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('receipts require exact identity and independently checked content',()=>{
 const dir=fs.mkdtempSync(path.join(family,'receipt-test-')),file=path.join(dir,'out.json');
 try {
  fs.writeFileSync(file,JSON.stringify({sum:3}));const ctx={workspace:dir,runId:'R',token:'secret'},task={id:'T1'},receipt={id:'T1',runId:'R',token:'secret',status:'completed'};
  assert.equal(verifyTask(receipt,task,[],ctx).status,'awaiting-verification');
  assert.equal(verifyTask(receipt,task,[{type:'json',path:file,equals:{sum:4}}],ctx).status,'failed');
  assert.equal(verifyTask({...receipt,runId:'old'},task,[{type:'file',path:file}],ctx).status,'failed');
  assert.equal(verifyTask(receipt,task,[{type:'json',path:file,equals:{sum:3}}],ctx).status,'verified');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

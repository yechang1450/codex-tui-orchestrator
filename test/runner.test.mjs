import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWindows,runDirectory,verifyRun} from '../scripts/core/runner.mjs';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
test('failed prerequisite retains both original tasks and never starts its dependent',async()=>{
 fs.mkdirSync(family,{recursive:true});const workspace=fs.mkdtempSync(path.join(family,'runner-'));
 let launches=0;
 const hooks={
  plan:async()=>[{title:'A',tasks:[{prompt:'执行甲'}]},{title:'B',dependsOn:['A'],tasks:[{prompt:'执行乙'}]}],
  compact:p=>p,infer:()=>[],prompt:p=>p,
  launcher:key=>{launches++;return{pidf:path.join(workspace,'window-'+key+'.pid')};},
  register:()=>{},unregister:()=>{},cleanup:()=>{},spawn:async()=>false,readPid:()=>0,
 };
 try{
  const sum=await runWindows('执行甲；执行乙',hooks,{workspace,capacity:8,runId:'failure',auth:'test',coordinator:path.join(workspace,'temp','coordinator')});
  assert.equal(launches,1);assert.equal(sum.success,false);
  assert.deepEqual(Object.keys(sum.taskResults),['T001','T002']);
  assert.equal(sum.taskResults.T001.status,'popup-failed');assert.equal(sum.taskResults.T002.status,'blocked');
  const manifest=JSON.parse(fs.readFileSync(path.join(runDirectory(workspace,'failure'),'manifest.json'),'utf8'));
  assert.equal(manifest.tasks.length,2);
  await assert.rejects(()=>runWindows('执行甲',hooks,{workspace,runId:'failure'}),/already exists/);
  assert.throws(()=>verifyRun(workspace,'other-run'),/ENOENT/);
 }finally{await new Promise(r=>setTimeout(r,500));fs.rmSync(workspace,{recursive:true,force:true});}
});

import {testTempFamily} from './test-temp-root.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as runner from '../scripts/core/runner.mjs';
import {recordCheckpoint} from '../scripts/core/checkpoint.mjs';
import {launcherIdentity,sameProcess} from '../scripts/core/leases.mjs';

test('task progress follows each durable checkpoint while a linked block stays running',()=>{
  const family=testTempFamily('runner-progress');fs.mkdirSync(family,{recursive:true});
  const dir=fs.mkdtempSync(path.join(family,'progress-')),file=path.join(dir,'attempt.json');
  const attempt={runId:'r',token:'token',file,number:1,taskIds:['T001','T002']};fs.writeFileSync(file,JSON.stringify(attempt));
  const sum={runId:'r',blocks:[{key:'B1',taskIds:attempt.taskIds}],results:{B1:{status:'running',attempts:[attempt]}},taskResults:{T001:{status:'pending'},T002:{status:'pending'}}};
  try{
    assert.equal(typeof runner.refreshTaskProgress,'function');
    assert.equal(runner.refreshTaskProgress(sum),false);
    recordCheckpoint(file,'T001','started');assert.equal(runner.refreshTaskProgress(sum),true);
    assert.equal(sum.taskResults.T001.status,'running');assert.equal(sum.taskResults.T002.status,'pending');
    recordCheckpoint(file,'T001','completed');runner.refreshTaskProgress(sum);
    assert.equal(sum.taskResults.T001.status,'awaiting-verification');assert.equal(sum.results.B1.status,'running');
    sum.taskResults.T001.status='verified';recordCheckpoint(file,'T002','started');runner.refreshTaskProgress(sum);
    assert.equal(sum.taskResults.T001.status,'verified');assert.equal(sum.taskResults.T002.status,'running');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('headless process identity requires the exact worker and attempt configuration, preventing PID reuse adoption',()=>{
  const dir=path.join(testTempFamily('runner-progress'),'identity');
  const pidf=path.join(dir,'exec-B1.pid'),config=path.join(dir,'exec-B1.json');
  const worker=fileURLToPath(new URL('../scripts/core/headless-worker.mjs',import.meta.url));
  const process={ProcessId:9,Name:'node.exe',Started:'now',CommandLine:`node.exe "${worker}" "${config}"`};
  const identity=launcherIdentity(9,pidf,new Map([[9,process]]));
  assert.equal(identity.CommandLine,undefined,'durable launcher identity excludes the raw process command line');
  assert.equal(sameProcess(identity,process),true);
  assert.equal(launcherIdentity(9,pidf,new Map([[9,{...process,CommandLine:`node.exe "${worker}" "${config}.foreign"`}]])),null);
  assert.equal(launcherIdentity(9,pidf,new Map([[9,{...process,Name:'unrelated.exe'}]])),null);
});

test('a controller-provided fixture worker still requires its exact entry and attempt configuration',()=>{
  const dir=path.join(testTempFamily('runner-progress'),'fixture-identity');
  const pidf=path.join(dir,'exec-B1.pid'),config=path.join(dir,'exec-B1.json');
  const fixtureWorker=fileURLToPath(new URL('./headless-worker-fixture.mjs',import.meta.url));
  const process={ProcessId:10,Name:'node.exe',Started:'now',CommandLine:`node.exe "${fixtureWorker}" "${config}"`};
  const options={workerEntry:fixtureWorker};
  assert.ok(launcherIdentity(10,pidf,new Map([[10,process]]),options));
  assert.equal(launcherIdentity(10,pidf,new Map([[10,{...process,CommandLine:`node.exe "${fixtureWorker}" "${config}.foreign"`}]]),options),null);
  assert.equal(launcherIdentity(10,pidf,new Map([[10,{...process,CommandLine:`node.exe "${fileURLToPath(new URL('../scripts/core/headless-worker.mjs',import.meta.url))}" "${config}"`}]]),options),null);
});

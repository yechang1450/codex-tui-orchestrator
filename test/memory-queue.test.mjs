import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {budgetSettings, admissionOk, observedCostMB, updateRollingCost, unconsumedReservationMB} from '../scripts/core/memory-budget.mjs';
import {reserve, release} from '../scripts/core/leases.mjs';

test('1000 MB reserve is mandatory even with a stale lower override',()=>{
  for(const env of [{},{ORCH_MIN_AVAILABLE_MB:'512'},{ORCH_MIN_AVAILABLE_MB:'0'}])assert.equal(budgetSettings(env).floorMB,1000);
  assert.equal(budgetSettings({ORCH_MIN_AVAILABLE_MB:'2000'}).floorMB,2000);
});
test('memory admission is strict and never bypassed by zero or invalid floors',()=>{
  assert.equal(admissionOk({availableMB:1500,blockCostMB:500,floorMB:1000}),false);
  assert.equal(admissionOk({availableMB:1501,blockCostMB:500,floorMB:1000}),true);
  assert.equal(admissionOk({availableMB:10,blockCostMB:500,floorMB:0}),false);
  assert.equal(admissionOk({availableMB:2000,blockCostMB:NaN,floorMB:1000}),false);
});
test('large observed peaks are not truncated to 800 MB',()=>{
  assert.equal(observedCostMB({processPeakMB:2000}),3000);
  assert.equal(updateRollingCost({windowCostMB:400,samples:4},{observedMB:3000}).windowCostMB,3000);
});

test('memory reservations only subtract future peak growth for an owned live process tree',()=>{
  const identity={ProcessId:11,Started:'one',Name:'node.exe',CommandLine:'worker'};
  const snapshot=new Map([[11,{...identity,WorkingSet64:200*1024**2}],[12,{ProcessId:12,ParentProcessId:11,WorkingSet64:100*1024**2}]]);
  const leases=[{memoryCostMB:500,launcher:identity},{memoryCostMB:400}];
  assert.equal(unconsumedReservationMB(leases,snapshot),600);
  assert.equal(unconsumedReservationMB([{memoryCostMB:100,launcher:identity}],snapshot),0);
  assert.equal(unconsumedReservationMB(leases,new Map()),900,'unavailable process consumption stays fully reserved');
  assert.equal(unconsumedReservationMB([{memoryCostMB:500,launcher:{...identity,Started:'reused'}}],snapshot),500,'PID reuse cannot reduce reservation');
});

test('memory admission is checked atomically with the lease reservation',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-memory-'));
  const owner={ProcessId:process.pid,Started:'test-owner',Name:'node',CommandLine:'node --test'};
  const snapshot=()=>new Map([[process.pid,owner]]);
  const admit=leases=>leases.every(lease=>lease.memoryCostMB!==600);
  try {
    assert.deepEqual(reserve(dir,{id:'B1',keys:['file:/one'],memoryCostMB:600},99,snapshot,admit),{ok:true});
    assert.deepEqual(reserve(dir,{id:'B2',keys:['file:/two'],memoryCostMB:600},99,snapshot,admit),{ok:false,reason:'memory'});
    const leases=JSON.parse(fs.readFileSync(path.join(dir,'leases.json'),'utf8'));
    assert.deepEqual(leases.map(lease=>lease.id),['B1']);
    release(dir,'B1',snapshot);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'leases.json'),'utf8')),[]);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

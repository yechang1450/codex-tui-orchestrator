import test from 'node:test';
import assert from 'node:assert/strict';
import {admitAuxiliaryWindow} from '../scripts/core/auxiliary-admission.mjs';

const args={coordinator:'fixture',stateDir:'missing-budget-state',id:'aux-1',keys:['aux:1'],env:{ORCH_WINDOW_COST_MB:'400',ORCH_FIRST_RUN_HEADROOM:'1.25'}};
function fakeReserve(calls) {
  return (_dir,rec,_capacity,_snapshot,admission)=>{
    calls.push(rec);
    return admission([],rec,new Map())?{ok:true}:{ok:false,reason:'memory'};
  };
}

test('auxiliary admission enforces the strict 1000 MB reserve and records its predicted peak',async()=>{
  const calls=[];
  await assert.rejects(admitAuxiliaryWindow({...args,available:()=>1000,reserveLease:fakeReserve(calls)}),/1000 MB reserve/);
  assert.equal(calls.length,0);
  await assert.rejects(admitAuxiliaryWindow({...args,available:()=>1500,reserveLease:fakeReserve(calls),timeoutMs:1,pause:async()=>{}}),/timed out/);
  assert.equal(calls[0].memoryCostMB,500);
  const accepted=await admitAuxiliaryWindow({...args,available:()=>1501,reserveLease:fakeReserve(calls)});
  assert.equal(accepted.costMB,500);
});

test('auxiliary memory wait queues until a later capacity check succeeds',async()=>{
  const calls=[],readings=[1501,1500,1500,1501];
  const accepted=await admitAuxiliaryWindow({...args,available:()=>readings.shift()??1501,reserveLease:fakeReserve(calls),pause:async()=>{}});
  assert.equal(calls.length,3);
  assert.equal(accepted.id,'aux-1');
});
test('auxiliary admission also waits for an existing run capacity lease',async()=>{
  let attempts=0;
  const accepted=await admitAuxiliaryWindow({...args,available:()=>8000,pause:async()=>{},
    reserveLease:()=>++attempts<3?{ok:false,reason:'capacity'}:{ok:true}});
  assert.equal(attempts,3);
  assert.equal(accepted.costMB,500);
});

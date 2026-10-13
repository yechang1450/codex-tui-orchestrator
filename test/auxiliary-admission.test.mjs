import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {admitAuxiliaryWindow} from '../scripts/core/auxiliary-admission.mjs';
import * as auxiliary from '../scripts/core/auxiliary-admission.mjs';
import {processSnapshot,release} from '../scripts/core/leases.mjs';

const args={
  coordinator:'fixture',
  stateDir:'missing-budget-state',
  id:'aux-1',
  keys:['aux:1'],
  env:{ORCH_WINDOW_COST_MB:'400',ORCH_FIRST_RUN_HEADROOM:'1.25'},
  reservationReceipt:()=>({
    reservationProof:Object.freeze({}),
    leaseInstanceId:'00000000-0000-4000-8000-000000000001',
  }),
};
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

test('auxiliary admission refuses a committed reservation without its in-process acknowledgement',async()=>{
  let reserves=0;
  await assert.rejects(admitAuxiliaryWindow({...args,available:()=>1501,
    reserveLease:()=>{reserves++;return {ok:true};},
    reservationReceipt:()=>null}),/acknowledgement/i);
  assert.equal(reserves,1);
});

test('auxiliary lifecycle binds its private receipt and rejects a same-id replacement',{skip:process.platform!=='win32'},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-auxiliary-receipt-'));
  const coordinator=path.join(root,'coordinator'),stateDir=path.join(root,'state');
  const env={ORCH_MIN_AVAILABLE_MB:'1000',ORCH_WINDOW_COST_MB:'400',ORCH_FIRST_RUN_HEADROOM:'1.25'};
  const base={coordinator,stateDir,id:'aux-reused',keys:['aux:receipt-reuse'],env,available:()=>8000};
  let replacement,active;
  t.after(()=>{
    try{if(active&&typeof auxiliary.releaseAuxiliaryLease==='function')auxiliary.releaseAuxiliaryLease(active);}catch{}
    try{if(replacement&&typeof auxiliary.releaseAuxiliaryLease==='function')auxiliary.releaseAuxiliaryLease(replacement);}catch{}
    fs.rmSync(root,{recursive:true,force:true});
  });

  const first=await admitAuxiliaryWindow(base);
  assert.equal(typeof auxiliary.prepareAuxiliaryLease,'function','the auxiliary admission module must own proof-bound prepare');
  assert.equal(typeof auxiliary.bindAuxiliaryLease,'function','the auxiliary admission module must own proof-bound bind');
  assert.equal(typeof auxiliary.releaseAuxiliaryLease,'function','the auxiliary admission module must own proof-bound release');
  assert.equal(Object.hasOwn(first,'reservationProof'),false,'the private receipt must never be projected into the public admission');
  assert.match(first.leaseInstanceId,/^[0-9a-f-]{36}$/);
  assert.match(first.runId,/^[0-9a-f-]{36}$/);

  release(coordinator,first.id);
  replacement=await admitAuxiliaryWindow(base);
  const leasesFile=path.join(coordinator,'leases.json');
  const replacementBytes=fs.readFileSync(leasesFile,'utf8');
  const identity=processSnapshot().get(process.pid);
  assert.ok(identity,'the test process must have a live process identity');
  assert.throws(()=>auxiliary.prepareAuxiliaryLease(first,path.join(root,'stale.pid')),/RESERVATION_PROOF_STALE|no longer matches/i);
  assert.throws(()=>auxiliary.bindAuxiliaryLease(first,identity),/RESERVATION_PROOF_STALE|no longer matches/i);
  assert.throws(()=>auxiliary.releaseAuxiliaryLease(first),/RESERVATION_PROOF_STALE|no longer matches/i);
  assert.equal(fs.readFileSync(leasesFile,'utf8'),replacementBytes,'a stale auxiliary admission must not modify the replacement lease');
  assert.equal(auxiliary.releaseAuxiliaryLease(replacement),true);
  replacement=null;

  active=await admitAuxiliaryWindow({...base,id:'aux-active',keys:['aux:receipt-active']});
  auxiliary.prepareAuxiliaryLease(active,path.join(root,'active.pid'));
  auxiliary.bindAuxiliaryLease(active,identity);
  assert.equal(auxiliary.releaseAuxiliaryLease(active),true);
  assert.equal(auxiliary.releaseAuxiliaryLease(active),true,'a confirmed duplicate cleanup must remain a no-op');
  active=null;
});

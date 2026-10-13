import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {claimRun, processIdentityBinding, processSnapshot, releaseRun, reserve, transaction} from '../scripts/core/leases.mjs';
import {providerFixtureToken} from './fixture-provider-tokens.mjs';

function fixture(prefix) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),prefix));
  const runtime={
    ProcessId:process.pid,
    Started:'2026-10-10T00:00:00.000Z',
    Name:'node.exe',
    CommandLine:'node ledger-boundary-test.mjs',
  };
  return {dir,runtime,binding:processIdentityBinding(runtime),snapshot:()=>new Map([[process.pid,runtime]])};
}

function assertExactBinding(value) {
  assert.deepEqual(Object.keys(value).sort(),['Name','ProcessId','Started','commandLineSha256']);
}

test('reserve persists only its explicit public lease schema',()=>{
  const f=fixture('orch-reserve-serialization-');
  const secret=providerFixtureToken('openai-named','reserve-boundary');
  try{
    const result=reserve(f.dir,{
      id:'reserve-safe',
      runId:'run-safe',
      keys:['dir:C:/safe'],
      memoryCostMB:256,
      CommandLine:`node --secret "${secret}"`,
      nested:{CommandLine:`node --secret "${secret}"`},
      arbitrary:{deep:{CommandLine:`node --secret "${secret}"`}},
    },4,f.snapshot);
    assert.deepEqual(result,{ok:true});

    const saved=JSON.parse(fs.readFileSync(path.join(f.dir,'leases.json'),'utf8'));
    assert.equal(JSON.stringify(saved).includes(secret),false,'reserve must not retain caller-owned command text');
    assert.deepEqual(Object.keys(saved[0]).sort(),['capacity','id','keys','leaseInstanceId','memoryCostMB','owner','reservedAt','runId']);
    assert.match(saved[0].leaseInstanceId,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assertExactBinding(saved[0].owner);
    assert.deepEqual(saved[0].keys,['dir:C:/safe']);
    assert.equal(saved[0].memoryCostMB,256);
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('transaction normalizes existing and callback-added lease records before persistence',()=>{
  const f=fixture('orch-transaction-serialization-');
  const secret=providerFixtureToken('openai-named','transaction-boundary');
  const makeLease=id=>({
    id,
    runId:'run-'+id,
    keys:['dir:C:/'+id],
    owner:f.binding,
    capacity:3,
    memoryCostMB:128,
    reservedAt:123,
    pidFile:'C:/controller/'+id+'.pid',
    CommandLine:`node --secret "${secret}"`,
    nested:{CommandLine:`node --secret "${secret}"`},
    arbitrary:{deep:{CommandLine:`node --secret "${secret}"`}},
  });
  try{
    fs.writeFileSync(path.join(f.dir,'leases.json'),JSON.stringify([makeLease('existing')]));
    transaction(f.dir,(leases,owner)=>{
      const added=makeLease('callback');
      added.owner=owner;
      leases.push(added);
    },f.snapshot);

    const saved=JSON.parse(fs.readFileSync(path.join(f.dir,'leases.json'),'utf8'));
    assert.equal(JSON.stringify(saved).includes(secret),false,'transaction must rewrite untrusted extra fields out of every persisted lease');
    assert.deepEqual(saved.map(record=>record.id),['existing','callback']);
    for(const record of saved){
      assert.deepEqual(Object.keys(record).sort(),['capacity','id','keys','memoryCostMB','owner','pidFile','reservedAt','runId']);
      assertExactBinding(record.owner);
      assert.equal(record.pidFile,'C:/controller/'+record.id+'.pid');
      assert.equal(record.memoryCostMB,128);
    }
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('claimRun rewrites surviving owner records to the explicit public schema',()=>{
  const f=fixture('orch-claim-serialization-');
  const secret=providerFixtureToken('openai-named','claim-boundary');
  try{
    const poisoned={
      owner:f.binding,
      token:'still-live-token',
      CommandLine:`node --secret "${secret}"`,
      nested:{CommandLine:`node --secret "${secret}"`},
      arbitrary:{deep:{CommandLine:`node --secret "${secret}"`}},
    };
    fs.writeFileSync(path.join(f.dir,'run-owners.json'),JSON.stringify({existing:poisoned}));

    const claim=claimRun(f.dir,'new',f.snapshot);
    assert.ok(claim.token);
    assertExactBinding(claim.owner);

    const saved=JSON.parse(fs.readFileSync(path.join(f.dir,'run-owners.json'),'utf8'));
    assert.equal(JSON.stringify(saved).includes(secret),false,'claimRun must not carry forward extra owner data');
    assert.deepEqual(Object.keys(saved).sort(),['existing','new']);
    for(const entry of Object.values(saved)){
      assert.deepEqual(Object.keys(entry).sort(),['owner','token']);
      assertExactBinding(entry.owner);
    }
    assert.equal(saved.existing.token,'still-live-token','a valid live owner remains protected after normalization');
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('releasing one owner cannot preserve extra data in surviving owner records',()=>{
  const f=fixture('orch-release-serialization-');
  const secret=providerFixtureToken('openai-named','release-boundary');
  try{
    const live=processSnapshot().get(process.pid);
    assert.ok(live,'the live process snapshot must include this test process');
    const liveBinding=processIdentityBinding(live);
    const claim=claimRun(f.dir,'released');
    const remaining={
      owner:liveBinding,
      token:'still-live-token',
      CommandLine:`node --secret "${secret}"`,
      nested:{CommandLine:`node --secret "${secret}"`},
    };
    fs.writeFileSync(path.join(f.dir,'run-owners.json'),JSON.stringify({released:claim,remaining}));

    releaseRun(f.dir,'released',claim);

    const saved=JSON.parse(fs.readFileSync(path.join(f.dir,'run-owners.json'),'utf8'));
    assert.equal(JSON.stringify(saved).includes(secret),false,'a release write must not carry another owner\'s raw fields forward');
    assert.deepEqual(Object.keys(saved.remaining).sort(),['owner','token']);
    assertExactBinding(saved.remaining.owner);
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});

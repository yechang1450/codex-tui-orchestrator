import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {processIdentityBinding,publicLeaseKeys,reserve} from '../scripts/core/leases.mjs';
import {keysOverlap} from '../scripts/core/contracts.mjs';
import {providerFixtureSuffix,providerFixtureToken} from './fixture-provider-tokens.mjs';

function liveSnapshot(){
  const runtime={ProcessId:process.pid,Started:'lease-key-privacy',Name:'node',CommandLine:'lease-key-privacy'};
  return {runtime,snapshot:()=>new Map([[process.pid,runtime]])};
}

test('legacy raw lease keys migrate to the public key namespace before conflict admission',{skip:process.platform!=='win32'},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-lease-key-private-'));
  const secret=providerFixtureToken('openai-project');
  const raw=`file:C:/fixture/${secret}/artifact.json`,projected=publicLeaseKeys([raw],{scopeDir:dir})[0];
  const {runtime,snapshot}=liveSnapshot();
  try{
    fs.writeFileSync(path.join(dir,'leases.json'),JSON.stringify([{
      id:'legacy',keys:[raw],owner:processIdentityBinding(runtime),capacity:4,reservedAt:Date.now(),
    }]));
    const conflict=reserve(dir,{id:'candidate',keys:[projected]},4,snapshot);
    assert.deepEqual(conflict,{ok:false,reason:'conflict'},'mixed raw/projected rows must still conflict');
    const persisted=fs.readFileSync(path.join(dir,'leases.json'),'utf8');
    assert.equal(persisted.includes(secret),false,'migration must remove the legacy raw key');
    assert.deepEqual(JSON.parse(persisted)[0].keys,[projected]);
    assert.deepEqual(reserve(dir,{id:'ordinary',keys:['file:C:/fixture/ordinary.json']},4,snapshot),{ok:true});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('public lease keys retain an opaque per-secret path identity for both overlap and parallel admission',{skip:process.platform!=='win32'},()=>{
  const scope=fs.mkdtempSync(path.join(os.tmpdir(),'orch-lease-key-overlap-'));
  const alpha=providerFixtureToken('openai-project');
  const beta=providerFixtureToken('openai-project',providerFixtureSuffix.slice(0,-1)+'1');
  try{
    const [alphaDir]=publicLeaseKeys([`dir:C:/fixture/${alpha}`],{scopeDir:scope});
    const [alphaChild]=publicLeaseKeys([`file:c:\\FIXTURE\\${alpha.toLowerCase()}\\artifact.json`],{scopeDir:scope});
    const [betaChild]=publicLeaseKeys([`file:C:/fixture/${beta}/artifact.json`],{scopeDir:scope});
    for(const key of [alphaDir,alphaChild,betaChild]){
      assert.equal(key.includes(alpha),false);
      assert.equal(key.includes(beta),false);
      assert.match(key,/\[REDACTED\]~hmac-sha256-v1-/);
    }
    assert.equal(keysOverlap([alphaDir],[alphaChild],{canonical:true}),true,'the same protected path must still retain parent-child conflict semantics across Windows case and slash aliases');
    assert.equal(keysOverlap([alphaDir],[betaChild],{canonical:true}),false,'different protected path components must remain independently admissible');
    assert.notEqual(alphaChild,betaChild,'the public projection must not collapse distinct protected path components');
  }finally{fs.rmSync(scope,{recursive:true,force:true});}
});

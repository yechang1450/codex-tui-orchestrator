import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {privateRunStateFile,writePrivateRunState,readPrivateRunState,writeProtectedText,readProtectedText} from '../scripts/core/private-run-state.mjs';
import {providerFixtureToken} from './fixture-provider-tokens.mjs';

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-private-state-'));
  const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
  return {root,workspace,env:{...process.env,ORCH_CONTROLLER_ROOT:path.join(root,'controller')}};
}

test('private run state is DPAPI-sealed, bound to its workspace projection, and recoverable by the current Windows user',()=>{
  const f=fixture(),runId='private-'+crypto.randomUUID().replaceAll('-','');
  const secret='PRIVATE⟪raw-prompt-secret⟫';
  const payload={request:`clean artifacts; OPENAI_API_KEY=${secret}`,tasks:[{id:'T001',prompt:`use ${secret}`}],plan:[{key:'B1',prompt:`GITHUB_TOKEN=${secret}`}],blocks:[{key:'B1',taskIds:['T001']}]};
  try{
    const marker=writePrivateRunState({workspace:f.workspace,runId,payload,env:f.env});
    const file=privateRunStateFile(f.workspace,runId,f.env);
    assert.deepEqual(marker,{version:2,projectionVersion:2,publicSha256:marker.publicSha256});
    assert.match(marker.publicSha256,/^[a-f0-9]{64}$/);
    assert.equal(fs.readFileSync(file,'utf8').includes(secret),false,'sealed file must not contain the raw task text');
    assert.deepEqual(readPrivateRunState({workspace:f.workspace,runId,expectedPublicSha256:marker.publicSha256,env:f.env}),payload);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('private run state fails closed when its sealed record is modified or its public projection does not match',()=>{
  const f=fixture(),runId='private-'+crypto.randomUUID().replaceAll('-','');
  const payload={request:'Authorization: Bearer PRIVATE⟪token⟫',tasks:[],plan:[],blocks:[]};
  try{
    const marker=writePrivateRunState({workspace:f.workspace,runId,payload,env:f.env});
    assert.throws(()=>readPrivateRunState({workspace:f.workspace,runId,expectedPublicSha256:'0'.repeat(64),env:f.env}),/private recovery projection mismatch/);
    const file=privateRunStateFile(f.workspace,runId,f.env);
    fs.writeFileSync(file,'not-a-dpapi-record','utf8');
    assert.throws(()=>readPrivateRunState({workspace:f.workspace,runId,expectedPublicSha256:marker.publicSha256,env:f.env}),/private recovery state is unreadable/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('private run state rejects lossy JavaScript values before deriving its persisted projection',()=>{
  const f=fixture(),runId='private-'+crypto.randomUUID().replaceAll('-','');
  const file=privateRunStateFile(f.workspace,runId,f.env);
  try{
    for(const nested of [{missing:undefined},{nonFinite:Infinity},{custom:new Date(0)},{large:1n}]){
      assert.throws(()=>writePrivateRunState({workspace:f.workspace,runId,payload:{request:'ordinary',tasks:[],plan:[],blocks:[],nested},env:f.env}),/stable JSON values/);
      assert.equal(fs.existsSync(file),false,'invalid state must fail before a sealed record is created');
    }
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('private recovery APIs reject a credential-shaped run identity before creating controller state',()=>{
  const f=fixture(),runId=providerFixtureToken('openai-project','abcdefghijklmnopqrstuvwxyz0123456789');
  try{
    for(const invoke of [
      ()=>privateRunStateFile(f.workspace,runId,f.env),
      ()=>writePrivateRunState({workspace:f.workspace,runId,payload:{request:'ordinary',tasks:[],plan:[],blocks:[]},env:f.env}),
    ]){
      assert.throws(invoke,error=>/SENSITIVE_RUN_IDENTITY/.test(String(error?.message))&&!String(error?.message).includes(runId));
      assert.equal(fs.existsSync(f.env.ORCH_CONTROLLER_ROOT),false,'a rejected run identity must not construct a private recovery filename or create controller state');
    }
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('one-time protected prompt text never reaches its controller file in plaintext',()=>{
  const f=fixture(),secret='PRIVATE⟪one-time-prompt⟫',file=path.join(f.env.ORCH_CONTROLLER_ROOT,'prompts','one.dpapi');
  try{
    writeProtectedText({workspace:f.workspace,file,text:`complete task with OPENAI_API_KEY=${secret}`,env:f.env});
    assert.equal(fs.readFileSync(file,'utf8').includes(secret),false);
    assert.equal(readProtectedText({workspace:f.workspace,file,env:f.env}),`complete task with OPENAI_API_KEY=${secret}`);
    fs.writeFileSync(file,'tampered','utf8');
    assert.throws(()=>readProtectedText({workspace:f.workspace,file,env:f.env}),/protected controller text is unreadable/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

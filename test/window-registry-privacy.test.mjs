import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {publicLeaseKeys} from '../scripts/core/leases.mjs';
import {providerFixtureToken} from './fixture-provider-tokens.mjs';

process.env.ORCH_AGENT='codex';
const {tryReserveWindow,__setOrchHooks,cancelReservation}=await import('../scripts/core/orchestrate-sdk.mjs');

test('headless-sensitive registration never persists the original title or conflict key',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-window-registry-private-'));
  const db=path.join(root,'orchestrator-windows.json');
  const scope=path.join(root,'coordinator');
  const secret=providerFixtureToken('openai-named','private-window-registry-value-1234567890');
  __setOrchHooks({db,leaseScopeDir:scope,alive:()=>true,lock:fn=>fn(),now:()=>Date.now()});
  try{
    const conflict=tryReserveWindow({
      id:'headless-sensitive',runId:'private-run',title:`headless task OPENAI_API_KEY=${secret}`,
      keys:[`file:C:\\work\\OPENAI_API_KEY=${secret}.json`],pidFile:'C:\\controller\\window.pid',pid:0,pending:true,reservedAt:Date.now(),mode:'headless',
    });
    assert.equal(conflict,null);
    const persisted=fs.readFileSync(db,'utf8');
    assert.equal(persisted.includes(secret),false,'window registry must not retain credential-shaped headless task data');
    const record=JSON.parse(persisted)[0];
    assert.match(record.title,/\[REDACTED\]/);
    assert.match(record.keys[0],/\[REDACTED\]/);
  }finally{
    __setOrchHooks(null);
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('ordinary window registration retains its conflict key for registry behavior',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-window-registry-public-'));
  const db=path.join(root,'orchestrator-windows.json');
  __setOrchHooks({db,leaseScopeDir:path.join(root,'coordinator'),alive:()=>true,lock:fn=>fn(),now:()=>Date.now()});
  try{
    const record={id:'ordinary',runId:'ordinary-run',title:'ordinary task',keys:['file:C:\\work\\ordinary.json'],pidFile:'C:\\controller\\ordinary.pid',pid:0,pending:true,reservedAt:Date.now(),mode:'headless'};
    assert.equal(tryReserveWindow(record),null);
    assert.deepEqual(JSON.parse(fs.readFileSync(db,'utf8'))[0].keys,record.keys);
    cancelReservation(record.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(db,'utf8')),[]);
  }finally{
    __setOrchHooks(null);
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('legacy raw registry keys are normalized before conflict checks and rewritten without the secret',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-window-registry-legacy-key-'));
  const db=path.join(root,'orchestrator-windows.json');
  const scope=path.join(root,'coordinator');
  const secret=providerFixtureToken('openai-project');
  const raw=`file:C:/fixture/${secret}/artifact.json`,projected=publicLeaseKeys([raw],{scopeDir:scope})[0];
  __setOrchHooks({db,leaseScopeDir:scope,alive:()=>true,lock:fn=>fn(),now:()=>Date.now()});
  try{
    fs.writeFileSync(db,JSON.stringify([{id:'legacy',runId:'legacy-run',title:'legacy window',keys:[raw],pidFile:'C:/controller/legacy.pid',pending:true,reservedAt:Date.now()}]));
    assert.equal(tryReserveWindow({id:'candidate',runId:'candidate-run',title:'candidate',keys:[projected],pidFile:'C:/controller/candidate.pid',pending:true,reservedAt:Date.now()}),'legacy window');
    const persisted=fs.readFileSync(db,'utf8');
    assert.equal(persisted.includes(secret),false);
    assert.deepEqual(JSON.parse(persisted)[0].keys,[projected]);
    assert.equal(tryReserveWindow({id:'ordinary',runId:'ordinary-run',title:'ordinary',keys:['file:C:/fixture/ordinary.json'],pidFile:'C:/controller/ordinary.pid',pending:true,reservedAt:Date.now()}),null);
  }finally{
    __setOrchHooks(null);
    fs.rmSync(root,{recursive:true,force:true});
  }
});

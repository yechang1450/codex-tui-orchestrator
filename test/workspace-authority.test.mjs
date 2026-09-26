import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {controllerStateDir} from '../scripts/core/controller-state.mjs';
import {coordinatorDir} from '../scripts/core/leases.mjs';
import {runWindows,runDirectory} from '../scripts/core/runner.mjs';

const family=fileURLToPath(new URL('../temp/',import.meta.url));

test('an explicit direct-API coordinator cannot be controlled by a workspace child',async()=>{
  fs.mkdirSync(family,{recursive:true});
  const workspace=fs.mkdtempSync(path.join(family,'api-authority-'));
  const coordinator=path.join(workspace,'coordinator');
  try{
    await assert.rejects(()=>runWindows('task',{plan:async()=>{throw new Error('planner reached');}},
      {workspace,capacity:1,runId:'api-boundary',coordinator}),/inside the initiating workspace/i);
    assert.equal(fs.existsSync(coordinator),false);
    assert.equal(fs.existsSync(runDirectory(workspace,'api-boundary')),false);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('a nonexistent workspace rejects its physical UNC alias as controller and coordinator',t=>{
  if(process.platform!=='win32')return t.skip('Windows UNC path alias only');
  fs.mkdirSync(family,{recursive:true});
  const drive=path.parse(family).root.slice(0,2);
  if(!/^[A-Za-z]:$/.test(drive))return t.skip('fixture needs a local drive');
  const nativeParent=family;
  const uncParent=`\\\\localhost\\${drive[0]}$${family.slice(2)}`;
  try{
    const native=fs.statSync(nativeParent,{bigint:true});
    const unc=fs.statSync(uncParent,{bigint:true});
    if(native.dev!==unc.dev||native.ino!==unc.ino)return t.skip('UNC alias is unavailable');
    if(fs.realpathSync.native(nativeParent).toLowerCase()===fs.realpathSync.native(uncParent).toLowerCase())
      return t.skip('realpath already normalizes this UNC alias');
  }catch{return t.skip('UNC administrative share is unavailable');}
  const name=`future-workspace-${process.pid}-${Date.now()}`;
  const workspace=path.join(nativeParent,name);
  const candidate=path.join(uncParent,name,'controller');
  assert.equal(fs.existsSync(workspace),false);
  assert.throws(()=>controllerStateDir(workspace,{ORCH_CONTROLLER_ROOT:candidate}),/inside the initiating workspace/i);
  assert.throws(()=>coordinatorDir(workspace,{ORCH_COORDINATOR_DIR:candidate}),/inside the initiating workspace/i);
  const external=path.join(uncParent,`other-${name}`);
  assert.equal(controllerStateDir(workspace,{ORCH_CONTROLLER_ROOT:external}),external);
  assert.equal(coordinatorDir(workspace,{ORCH_COORDINATOR_DIR:external}),external);
});

test('a workspace containing CODEX_HOME fails closed unless controller state is moved outside it',()=>{
  const workspace=os.homedir();
  const home=path.join(workspace,'.codex');
  assert.throws(()=>controllerStateDir(workspace,{CODEX_HOME:home}),/inside the initiating workspace/i);
  assert.throws(()=>coordinatorDir(workspace,{CODEX_HOME:home,ORCH_COORDINATOR_DIR:''}),/inside the initiating workspace/i);
  const external=path.resolve(workspace,'..','external-controller-root');
  assert.equal(controllerStateDir(workspace,{CODEX_HOME:home,ORCH_CONTROLLER_ROOT:external}),external);
});

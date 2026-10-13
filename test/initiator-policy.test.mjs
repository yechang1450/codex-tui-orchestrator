import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveInitiatorPolicy,assertInitiatorWorkspace} from '../scripts/core/initiator-settings.mjs';

const id='11111111-1111-4111-8111-111111111111';

function withHome(context, config, action) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'orch-policy-'));
  try {
    fs.writeFileSync(path.join(home,'config.toml'),config,'utf8');
    if(context) {
      const dir=path.join(home,'sessions','2026','09','26');
      fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,`rollout-2026-09-26T00-00-00-${id}.jsonl`),JSON.stringify({type:'turn_context',payload:context})+'\n','utf8');
    }
    return action(home);
  } finally {fs.rmSync(home,{recursive:true,force:true});}
}

test('restricted initiating turn keeps its sandbox, approval, and workspace despite unrestricted overrides',()=>{
  const cwd=path.resolve('trusted-workspace');
  withHome({cwd,sandbox_policy:{type:'workspace-write'},approval_policy:'on-request'},'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n',home=>{
    assert.deepEqual(resolveInitiatorPolicy({CODEX_HOME:home,CODEX_THREAD_ID:id,ORCH_SANDBOX:'danger-full-access',ORCH_APPROVAL:'never'}),
      {sandbox:'workspace-write',approval:'on-request'});
    const env={CODEX_HOME:home,CODEX_THREAD_ID:id};
    assert.doesNotThrow(()=>assertInitiatorWorkspace(cwd,{sandbox:'workspace-write'},env));
    assert.throws(()=>assertInitiatorWorkspace(path.resolve('other-workspace'),{sandbox:'workspace-write'},env),/workspace differs/);
  });
});

test('missing initiating turn policy fails closed before a child can inherit broader native config',()=>{
  withHome(null,'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n',home=>{
    assert.throws(()=>resolveInitiatorPolicy({CODEX_HOME:home,CODEX_THREAD_ID:id}),/INITIATOR_POLICY_UNAVAILABLE/);
  });
});

test('caller-controlled session and environment metadata cannot delegate broad child authority',()=>{
  withHome({cwd:path.resolve('trusted-workspace'),sandbox_policy:{type:'danger-full-access'},approval_policy:'never'},'',home=>{
    assert.deepEqual(resolveInitiatorPolicy({CODEX_HOME:home,CODEX_THREAD_ID:id}),
      {sandbox:'workspace-write',approval:'on-request'});
    assert.deepEqual(resolveInitiatorPolicy({CODEX_HOME:home,CODEX_THREAD_ID:id,
      CODEX_PERMISSION_PROFILE:':danger-full-access',CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY:'host-binding-opaque',WORKSPACE_DIR:path.resolve('trusted-workspace')}),
      {sandbox:'workspace-write',approval:'on-request'});
  });
});

test('a broad initiating turn remains bound to its recorded workspace after policy reduction',()=>{
  const workspace=path.resolve('trusted-workspace');
  withHome({cwd:workspace,sandbox_policy:{type:'danger-full-access'},approval_policy:'never'},'',home=>{
    const env={CODEX_HOME:home,CODEX_THREAD_ID:id,CODEX_PERMISSION_PROFILE:':danger-full-access',
      CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY:'host-binding-opaque',WORKSPACE_DIR:path.resolve('other-workspace')};
    const initiatorContext=Object.freeze({threadId:id,workspace});
    assert.throws(()=>assertInitiatorWorkspace(path.resolve('other-workspace'),{sandbox:'workspace-write',approval:'on-request'},env,initiatorContext),/workspace differs/);
  });
});

test('direct CLI use reduces unattended workspace write to interactive approval',()=>{
  withHome(null,'sandbox_mode = "workspace-write"\napproval_policy = "never"\n',home=>{
    assert.deepEqual(resolveInitiatorPolicy({CODEX_HOME:home}),{sandbox:'workspace-write',approval:'on-request'});
  });
});

test('direct environment and native config cannot request a danger-full-access worker',()=>{
  withHome(null,'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n',home=>{
    assert.deepEqual(resolveInitiatorPolicy({CODEX_HOME:home}),{sandbox:'workspace-write',approval:'on-request'});
    assert.deepEqual(resolveInitiatorPolicy({CODEX_HOME:home,ORCH_SANDBOX:'danger-full-access',ORCH_APPROVAL:'never'}),
      {sandbox:'workspace-write',approval:'on-request'});
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSafeWorkerArgs} from '../scripts/core/worker-authorization.mjs';

test('worker authorization rejects every known Codex privilege-bypass route',()=>{
  for(const args of [
    ['--profile','elevated'],
    ['--add-dir','C:\\outside'],
    ['--dangerously-bypass-approvals-and-sandbox'],
    ['--dangerously-bypass-hook-trust'],
    ['--sandbox','danger-full-access'],
    ['--sandbox=danger-full-access'],
    ['-s','danger-full-access'],
    ['-sdanger-full-access'],
    ['-a','never','--sandbox','workspace-write'],
    ['-anever','--sandbox','workspace-write'],
    ['--approve-for-me'],
    ['-c','projects."C:\\\\work".trust_level="trusted"'],
    ['-c','sandbox_permissions="danger-full-access"'],
    ['--config=sandbox_mode="danger-full-access"'],
  ]) assert.throws(()=>assertSafeWorkerArgs(args),/CHILD_AUTHORIZATION_UNAVAILABLE/);
});

test('worker authorization accepts only a bound read-only Codex exec invocation',()=>{
  const workspace=process.cwd();
  assert.doesNotThrow(()=>assertSafeWorkerArgs(['exec','--ignore-rules','--cd',workspace,'-a','never','--sandbox','read-only','-c','approval_policy="never"','--disable','hooks','--json'],{workspace}));
  assert.throws(()=>assertSafeWorkerArgs(['--cd',workspace,'-a','never','--sandbox','read-only']),/CHILD_AUTHORIZATION_UNAVAILABLE/);
  assert.throws(()=>assertSafeWorkerArgs(['exec','--cd',workspace,'-a','on-request','--sandbox','workspace-write','--disable','hooks'],{workspace}),/CHILD_AUTHORIZATION_UNAVAILABLE/);
});

test('worker authorization accepts only the builder\'s read-only noninteractive approval config',()=>{
  const workspace=process.cwd(),base=['exec','--cd',workspace,'--sandbox','read-only'];
  assert.doesNotThrow(()=>assertSafeWorkerArgs([...base,'--ignore-rules','-c','approval_policy="never"','--json'],{workspace}));
  assert.doesNotThrow(()=>assertSafeWorkerArgs([...base,'--ignore-rules','-c','sandbox_workspace_write.writable_roots=[]','-c','approval_policy="never"','--json'],{workspace}));
  assert.throws(()=>assertSafeWorkerArgs([...base,'-c','approval_policy="never"','--json'],{workspace}),/CHILD_AUTHORIZATION_UNAVAILABLE/);
  assert.throws(()=>assertSafeWorkerArgs([...base,'--ignore-rules=true','-c','approval_policy="never"','--json'],{workspace}),/CHILD_AUTHORIZATION_UNAVAILABLE/);
  assert.throws(()=>assertSafeWorkerArgs([...base,'--ignore-rules','--ignore-rules','-c','approval_policy="never"','--json'],{workspace}),/CHILD_AUTHORIZATION_UNAVAILABLE/);
  assert.throws(()=>assertSafeWorkerArgs([...base,'--sandbox','workspace-write','-c','approval_policy="never"','--json'],{workspace}),/CHILD_AUTHORIZATION_UNAVAILABLE/);
  assert.throws(()=>assertSafeWorkerArgs([...base,'-capproval_policy=never','--json'],{workspace}),/CHILD_AUTHORIZATION_UNAVAILABLE/);
  assert.throws(()=>assertSafeWorkerArgs([...base,'-c','approval_policy="never"; sandbox_mode="danger-full-access"','--json'],{workspace}),/CHILD_AUTHORIZATION_UNAVAILABLE/);
});

test('headless Codex argv cannot expand or replace the controller workspace',()=>{
  const workspace=process.cwd(),base=['exec','--cd',workspace,'--sandbox','read-only','-c','approval_policy="never"','--json'];
  for(const args of [
    [...base,'--add-dir',process.env.SystemRoot||'C:\\Windows'],
    [...base,'--worktree'],
    [...base,'--remote','ws://127.0.0.1:9999'],
    [...base,'-c','sandbox_workspace_write.writable_roots=["C:\\\\other"]'],
    ['exec','--cd',process.env.SystemRoot||'C:\\Windows','--sandbox','read-only','-c','approval_policy="never"','--json'],
  ]) assert.throws(()=>assertSafeWorkerArgs(args,{workspace}),/CHILD_AUTHORIZATION_UNAVAILABLE/);
});

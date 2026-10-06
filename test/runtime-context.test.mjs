import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { resolveRuntimeContext, physicalPathIdentity } from '../scripts/runtime-context.mjs';
import { launchArgs } from '../scripts/host-cli.mjs';
import { runDirectory } from '../scripts/core/runner.mjs';

test('invocation directory owns windows and all default orchestration state', () => {
  const cwd = path.resolve('temp', 'caller workspace');
  const context = resolveRuntimeContext({}, cwd);
  assert.equal(context.workspace, cwd);
  assert.equal(context.temp, path.join(cwd, 'temp'));
  assert.equal(context.state, path.join(cwd, 'temp', 'orchestrator'));
});
test('explicit workspace resolves against caller and propagates without relocating it', () => {
  const cwd = path.resolve('temp');
  const context = resolveRuntimeContext({ WORKSPACE_DIR: 'project' }, cwd);
  assert.equal(context.workspace, path.join(cwd, 'project'));
  assert.equal(context.state, path.join(cwd, 'project', 'temp', 'orchestrator'));
});
test('physical workspace identity falls back when native realpath is denied', () => {
  const cwd = fs.mkdtempSync(path.join(path.resolve('temp'), 'realpath-fallback-'));
  const native = fs.realpathSync.native;
  try {
    fs.realpathSync.native = () => {
      const error = new Error('native realpath denied by host');
      error.code = 'EACCES';
      throw error;
    };
    assert.equal(physicalPathIdentity(cwd), cwd.toLowerCase());
  } finally {
    fs.realpathSync.native = native;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
test('physical workspace identity remains fail-closed when both realpath paths are denied', () => {
  const cwd = fs.mkdtempSync(path.join(path.resolve('temp'), 'realpath-denied-'));
  const native = fs.realpathSync.native;
  const regular = fs.realpathSync;
  try {
    const denied = () => {
      const error = new Error('realpath denied by host');
      error.code = 'EACCES';
      throw error;
    };
    fs.realpathSync.native = denied;
    fs.realpathSync = denied;
    assert.throws(() => physicalPathIdentity(cwd), /EACCES|realpath denied/i);
  } finally {
    fs.realpathSync.native = native;
    fs.realpathSync = regular;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
test('state override stays inside the initiating workspace temp directory', () => {
  const cwd = path.resolve('temp', 'state-owner');
  const relative = resolveRuntimeContext({ ORCH_STATE_DIR: 'custom', }, cwd);
  assert.equal(relative.state, path.join(cwd, 'temp', 'custom'));
  assert.throws(
    () => resolveRuntimeContext({ ORCH_STATE_DIR: path.join(cwd, '..', 'outside-state') }, cwd),
    /ORCH_STATE_DIR.*workspace temp/i,
  );
});
test('runtime state rejects symlinked workspace temp and state paths', () => {
  const root=fs.mkdtempSync(path.join(path.resolve('temp'),'runtime-links-'));
  try {
    const target=path.join(root,'real');fs.mkdirSync(target);
    fs.mkdirSync(path.join(root,'temp'));
    try { fs.symlinkSync(target,path.join(root,'temp','workspace-temp'),'junction'); }
    catch { try { fs.symlinkSync(target,path.join(root,'temp','workspace-temp'),'dir'); } catch { return; } }
    assert.throws(() => resolveRuntimeContext({WORKSPACE_DIR:root,ORCH_STATE_DIR:'workspace-temp'}, root), /symbolic link|junction|reparse/i);
    const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(workspace,'temp'));
    const stateTarget=path.join(root,'state-target');fs.mkdirSync(stateTarget);
    try { fs.symlinkSync(stateTarget,path.join(workspace,'temp','linked'),'junction'); }
    catch { try { fs.symlinkSync(stateTarget,path.join(workspace,'temp','linked'),'dir'); } catch { return; } }
    assert.throws(() => resolveRuntimeContext({ORCH_STATE_DIR:'linked'},workspace), /symbolic link|junction|reparse/i);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('run directory rejects a nested runs junction before any ledger write',()=>{
  const root=fs.mkdtempSync(path.join(path.resolve('temp'),'run-junction-'));
  try{
    const workspace=path.join(root,'workspace'),state=path.join(workspace,'temp','orchestrator'),outside=path.join(root,'outside');
    fs.mkdirSync(state,{recursive:true});fs.mkdirSync(outside);
    try{fs.symlinkSync(outside,path.join(state,'runs'),'junction');}
    catch{try{fs.symlinkSync(outside,path.join(state,'runs'),'dir');}catch{return;}}
    assert.throws(()=>runDirectory(workspace,'new-run'),/symbolic link|junction|reparse/i);
    assert.equal(fs.existsSync(path.join(outside,'new-run')),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('child windows preserve restricted authorization and bypass only an unrestricted initiator', () => {
  const cwd = path.resolve('temp', "caller's workspace");
  const args = launchArgs({id:'codex'}, {cwd});
  assert.equal(args[args.indexOf('-a') + 1], 'on-request');
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  const restricted = launchArgs({id:'codex'}, {cwd, approval:['on','request'].join('-'), sandbox:'read-only'});
  assert.equal(restricted[restricted.indexOf('-a') + 1], 'on-request');
  assert.equal(restricted[restricted.indexOf('--sandbox') + 1], 'read-only');
  const unrestricted = launchArgs({id:'codex'}, {cwd, approval:'never', sandbox:'danger-full-access'});
  assert.equal(unrestricted.includes('-a'), false);
  assert.ok(unrestricted.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(unrestricted.includes(`projects.${JSON.stringify(cwd)}.trust_level="trusted"`));
});

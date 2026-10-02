import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {assertNoReparsePoints,physicallySameOrChild,physicalPathIdentity} from './runtime-context.mjs';

// Controller authority must be outside a workspace-write child's writable root.
export function controllerStateDir(workspace,env=process.env){
  const home=path.resolve(String(env.CODEX_HOME||'').trim()||path.join(os.homedir(),'.codex'));
  const dir=path.resolve(String(env.ORCH_CONTROLLER_ROOT||'').trim()||path.join(home,'state','plugins','codex-tui-orchestrator'));
  if(physicallySameOrChild(workspace,dir))throw new Error('Codex controller state cannot be inside the initiating workspace');
  return assertNoReparsePoints(dir,'Codex controller state');
}

export function assertControllerPath(workspace,candidate,label='controller path'){
  const root=controllerStateDir(workspace);
  const target=path.resolve(candidate);
  if(!physicallySameOrChild(root,target))throw new Error(label+' must be inside Codex controller state');
  return assertNoReparsePoints(target,label);
}

export function controllerWindowsDir(workspace){
  const identity=physicalPathIdentity(workspace);
  return assertControllerPath(workspace,path.join(controllerStateDir(workspace),'windows',crypto.createHash('sha256').update(identity).digest('hex')),'controller windows');
}

export function controllerHeadlessBase(workspace,attemptFile,key){
  if(!physicallySameOrChild(workspace,attemptFile))throw new Error('Headless attempt must be inside the initiating workspace');
  const workspaceId=crypto.createHash('sha256').update(physicalPathIdentity(workspace)).digest('hex');
  const attemptId=crypto.createHash('sha256').update(path.resolve(attemptFile).toLowerCase()).digest('hex');
  const stem='exec-'+String(key).replace(/[^A-Za-z0-9_-]/g,'_');
  return assertControllerPath(workspace,path.join(controllerStateDir(workspace),'headless',workspaceId,attemptId,stem),'headless controller files');
}

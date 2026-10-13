import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {assertNoReparsePoints,physicallySameOrChild,physicalPathIdentity} from './runtime-context.mjs';
import {isCredentialShapedText} from './redaction.mjs';
import {assertPrivateWindowsRoot} from './private-root.mjs';
import {trustedWindowsHelper} from './windows-system.mjs';

const privateControllerRootCache=new Map();
function cachePrivateControllerRoot(identity){
  if(privateControllerRootCache.has(identity))return;
  if(privateControllerRootCache.size>=32)privateControllerRootCache.delete(privateControllerRootCache.keys().next().value);
  privateControllerRootCache.set(identity,true);
}

// Durable controller state owns plans, launchers, and recovery authority. A
// different Windows principal must not be able to replace its directory even
// when the caller supplies a custom root.
export function assertPrivateControllerRoot(candidate){
  const root=assertNoReparsePoints(candidate,'Codex controller state');
  let identity=null;
  if(fs.existsSync(root)){
    identity=physicalPathIdentity(root);
    if(privateControllerRootCache.has(identity))return root;
  }
  try{assertPrivateWindowsRoot(root,{powershell:trustedWindowsHelper('powershell')});}
  catch{throw new Error('CONTROLLER_ROOT_UNSAFE_ACL: controller storage must be a local directory writable only by the current Windows user, SYSTEM, and Administrators');}
  if(identity)cachePrivateControllerRoot(identity);
  return root;
}

export function assertPublicControllerIdentity(label,value){
  if(isCredentialShapedText(value))throw new Error('SENSITIVE_RUN_IDENTITY: credential-shaped '+label+' cannot be used in durable controller state');
  return value;
}

// Call this on an external entry point before it creates controller artifacts
// (notably isolated-acceptance proof files).  Unlike a public projection,
// identities are rejected because changing one would make later recovery bind
// a different workspace, run, or coordinator.
export function assertPublicExecutionIdentities({workspace,runId,env=process.env}={}){
  const resolvedWorkspace=path.resolve(String(workspace??''));
  assertPublicControllerIdentity('workspace',resolvedWorkspace);
  if(runId!==undefined&&runId!==null&&String(runId)!=='')assertPublicControllerIdentity('runId',String(runId));
  const root=controllerStateDir(resolvedWorkspace,env);
  const coordinator=env.ORCH_COORDINATOR_DIR
    ?path.resolve(resolvedWorkspace,String(env.ORCH_COORDINATOR_DIR))
    :path.join(root,'codex-coordinator');
  assertPublicControllerIdentity('coordinator',coordinator);
  return Object.freeze({workspace:resolvedWorkspace,controllerRoot:root,coordinator});
}

// Controller authority must be outside a workspace-write child's writable root.
export function controllerStateDir(workspace,env=process.env){
  const home=path.resolve(String(env.CODEX_HOME||'').trim()||path.join(os.homedir(),'.codex'));
  const dir=path.resolve(String(env.ORCH_CONTROLLER_ROOT||'').trim()||path.join(home,'state','plugins','codex-tui-orchestrator'));
  assertPublicControllerIdentity('CODEX_HOME',home);
  assertPublicControllerIdentity('controller root',dir);
  if(physicallySameOrChild(workspace,dir))throw new Error('Codex controller state cannot be inside the initiating workspace');
  return assertPrivateControllerRoot(dir);
}

export function assertControllerPath(workspace,candidate,label='controller path',env=process.env){
  const root=controllerStateDir(workspace,env);
  const target=path.resolve(candidate);
  if(!physicallySameOrChild(root,target))throw new Error(label+' must be inside Codex controller state');
  return assertNoReparsePoints(target,label);
}

export function controllerWindowsDir(workspace,env=process.env){
  const identity=physicalPathIdentity(workspace);
  return assertControllerPath(workspace,path.join(controllerStateDir(workspace,env),'windows',crypto.createHash('sha256').update(identity).digest('hex')),'controller windows',env);
}

export function controllerHeadlessBase(workspace,attemptFile,key,env=process.env){
  if(!physicallySameOrChild(workspace,attemptFile))throw new Error('Headless attempt must be inside the initiating workspace');
  const workspaceId=crypto.createHash('sha256').update(physicalPathIdentity(workspace)).digest('hex');
  const attemptId=crypto.createHash('sha256').update(path.resolve(attemptFile).toLowerCase()).digest('hex');
  const stem='exec-'+String(key).replace(/[^A-Za-z0-9_-]/g,'_');
  return assertControllerPath(workspace,path.join(controllerStateDir(workspace,env),'headless',workspaceId,attemptId,stem),'headless controller files',env);
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {controllerStateDir} from './controller-state.mjs';
import {PROCESS_INITIATOR_CONTEXT} from './initiator-context.mjs';
import {assertNoReparsePoints,physicalPathIdentity} from './runtime-context.mjs';

function validRunId(value){return /^[A-Za-z0-9_-]{1,100}$/.test(String(value||''));}
function validBlockKey(value){return /^B[1-9][0-9]*$/.test(String(value||''));}
function validAttempt(value){return Number.isSafeInteger(Number(value))&&Number(value)>0;}
function validToken(value){return /^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/.test(String(value||''));}
// A 32-byte Node base64url capability is always 43 unpadded characters. This
// is intentionally separate from ordinary task tokens: acceptance authority
// must come from a cryptographically random harness value, not a short label.
export function validAbortToken(value){return /^[A-Za-z0-9_-]{43}$/.test(String(value||''));}
const preparedAcceptances=new WeakSet();
const startupBindings=new WeakMap();
const abortBindings=new WeakMap();

const digest=value=>crypto.createHash('sha256').update(String(value),'utf8').digest('hex');
const exactKeys=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&
  JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());
const terminalPayload=record=>record.kind==='acceptance-abort'
  ?JSON.stringify([record.schema,record.kind,record.runId,record.workspaceKeySha256,record.abortTokenSha256,record.reason,record.requestedAt])
  :JSON.stringify([record.schema,record.kind,record.runId,record.workspaceKeySha256,record.abortTokenSha256,record.finalizedAt]);
const terminalAuthenticator=(abortToken,record)=>crypto.createHmac('sha256',abortToken).update(terminalPayload(record),'utf8').digest('hex');
// Kept here so every controller-side and worker-side terminal reader uses the
// identical canonical payload and timing-safe comparison.
export function validTerminalAuthenticator(actual,abortToken,record){
  if(!/^[a-f0-9]{64}$/i.test(String(actual||'')))return false;
  const expected=Buffer.from(terminalAuthenticator(abortToken,record),'hex'),received=Buffer.from(actual,'hex');
  return received.length===expected.length&&crypto.timingSafeEqual(received,expected);
}

function proofDirectory(root){
  return assertNoReparsePoints(path.join(root,'acceptance-proofs'),'isolated acceptance proofs');
}

function abortDirectory(root){
  return assertNoReparsePoints(path.join(root,'acceptance-aborts'),'isolated acceptance aborts');
}

function finalizationDirectory(root){
  return assertNoReparsePoints(path.join(root,'acceptance-finalizations'),'isolated acceptance finalizations');
}

function terminalLockDirectory(root){
  return assertNoReparsePoints(path.join(root,'acceptance-terminal-locks'),'isolated acceptance terminal locks');
}

function proofFile(root,runId){
  return assertNoReparsePoints(path.join(proofDirectory(root),runId+'.json'),'isolated acceptance proof');
}

function abortTokenFromEnvironment(env){
  const token=String(env?.ORCH_ISOLATED_ABORT_TOKEN||'');
  if(!validAbortToken(token))throw new Error('ISOLATED_ACCEPTANCE_REFUSED: a 32-byte base64url isolated abort token is required');
  return token;
}

function readPreparedProof(root,runId,workspaceIdentity,abortToken){
  const file=proofFile(root,runId);let proof;
  try{proof=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){throw new Error('ISOLATED_ACCEPTANCE_REFUSED: prepared acceptance proof is unreadable: '+(error?.message||error));}
  const expected={schema:1,runId,threadBound:true,workspaceIdentity,abortTokenSha256:digest(abortToken)};
  if(JSON.stringify(proof)!==JSON.stringify(expected))throw new Error('ISOLATED_ACCEPTANCE_REFUSED: prepared acceptance proof mismatch');
  return file;
}

function isolatedBinding({workspace,runId,env,initiatorContext}){
  const threadId=String(env.CODEX_THREAD_ID||env.CODEX_SESSION_ID||'').trim();
  const capturedWorkspace=String(initiatorContext?.workspace||'').trim();
  if(!threadId||initiatorContext?.threadId!==threadId||!capturedWorkspace)
    throw new Error('ISOLATED_ACCEPTANCE_REFUSED: immutable initiating workspace binding missing');
  if(!validRunId(runId))throw new Error('ISOLATED_ACCEPTANCE_REFUSED: explicit run ID required');
  const workspaceIdentity=physicalPathIdentity(workspace);
  if(physicalPathIdentity(capturedWorkspace)!==workspaceIdentity)
    throw new Error('ISOLATED_ACCEPTANCE_REFUSED: workspace differs from immutable initiating workspace');
  const configuredRoot=String(env.ORCH_CONTROLLER_ROOT||'').trim();
  if(!configuredRoot)throw new Error('ISOLATED_ACCEPTANCE_REFUSED: explicit controller root required');
  if(String(env.ORCH_COORDINATOR_DIR||'').trim())
    throw new Error('ISOLATED_ACCEPTANCE_REFUSED: caller-selected coordinator directory is forbidden');
  return {root:controllerStateDir(workspace,env),workspaceIdentity};
}

function assertFreshWorkspaceRun(workspace,runId){
  const directory=assertNoReparsePoints(path.join(path.resolve(workspace),'temp','orchestrator','runs',runId),'isolated acceptance run directory');
  if(fs.existsSync(directory))throw new Error('ISOLATED_ACCEPTANCE_REFUSED: fresh workspace run directory required');
}

// A real desktop acceptance run must never share stale-cleanup state with
// ordinary orchestrator work. This guard intentionally accepts only an
// explicit, newly-created controller root and the immutable host snapshot
// captured before public argument parsing.
export function prepareIsolatedAcceptance({workspace,runId,env=process.env,initiatorContext=PROCESS_INITIATOR_CONTEXT,resume=false}={}){
  if(String(env.ORCH_ISOLATED_ACCEPTANCE||'')!=='1')return {enabled:false,skipSharedCleanup:false,file:null};
  if(resume)throw new Error('ISOLATED_ACCEPTANCE_REFUSED: resume is forbidden');
  const {root,workspaceIdentity}=isolatedBinding({workspace,runId,env,initiatorContext});
  const abortToken=abortTokenFromEnvironment(env);
  assertFreshWorkspaceRun(workspace,runId);
  if(fs.existsSync(root))throw new Error('ISOLATED_ACCEPTANCE_REFUSED: fresh empty controller root required');
  try{fs.mkdirSync(root,{recursive:false});}
  catch(error){if(error?.code==='EEXIST')throw new Error('ISOLATED_ACCEPTANCE_REFUSED: fresh empty controller root required');throw error;}
  assertNoReparsePoints(root,'isolated acceptance controller root');
  // The root did not exist during the initial parent check. Revalidate the
  // materialized directory before it receives a proof or authority record.
  if(physicalPathIdentity(controllerStateDir(workspace,env))!==physicalPathIdentity(root))
    throw new Error('ISOLATED_ACCEPTANCE_REFUSED: controller root identity changed during creation');
  const proofDir=proofDirectory(root);
  fs.mkdirSync(proofDir,{recursive:false});
  assertNoReparsePoints(proofDir,'isolated acceptance proofs');
  const file=proofFile(root,runId);
  const temporary=assertNoReparsePoints(file+'.'+crypto.randomUUID()+'.tmp','isolated acceptance proof temporary');
  const proof={schema:1,runId,threadBound:true,workspaceIdentity,abortTokenSha256:digest(abortToken)};
  try{
    fs.writeFileSync(temporary,JSON.stringify(proof),'utf8');
    assertNoReparsePoints(temporary,'isolated acceptance proof temporary');
    fs.renameSync(temporary,file);
  }finally{try{fs.rmSync(temporary,{force:true});}catch{}}
  const acceptance=Object.freeze({enabled:true,skipSharedCleanup:true,file,runId,workspaceIdentity,controllerIdentity:physicalPathIdentity(root)});
  preparedAcceptances.add(acceptance);
  return acceptance;
}

function consumeIsolatedAcceptance(acceptance,{workspace,runId,env,initiatorContext,resume}){
  if(resume)throw new Error('ISOLATED_ACCEPTANCE_REFUSED: resume is forbidden');
  if(!preparedAcceptances.has(acceptance))throw new Error('ISOLATED_ACCEPTANCE_REFUSED: unrecognized prepared acceptance lane');
  const {root,workspaceIdentity}=isolatedBinding({workspace,runId,env,initiatorContext});
  const abortToken=abortTokenFromEnvironment(env);
  if(acceptance.runId!==runId||acceptance.workspaceIdentity!==workspaceIdentity||acceptance.controllerIdentity!==physicalPathIdentity(root))
    throw new Error('ISOLATED_ACCEPTANCE_REFUSED: prepared acceptance lane no longer matches this execution');
  const file=readPreparedProof(root,runId,workspaceIdentity,abortToken);
  if(file!==acceptance.file)throw new Error('ISOLATED_ACCEPTANCE_REFUSED: prepared acceptance proof path mismatch');
  return acceptance;
}

// The launcher itself writes this controller-owned record after publishing its
// PID and before it starts Codex. The spec binds every writable field to the
// already verified isolated acceptance proof; callers never choose a path.
export function startupReceiptSpec({workspace,runId,blockKey,attempt,token,env=process.env}={}){
  if(String(env.ORCH_ISOLATED_ACCEPTANCE||'')!=='1')throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: isolated acceptance is required');
  if(!validRunId(runId)||!validBlockKey(blockKey)||!validAttempt(attempt)||!validToken(token))
    throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: invalid receipt binding');
  const root=controllerStateDir(workspace,env),workspaceIdentity=physicalPathIdentity(workspace),abortToken=abortTokenFromEnvironment(env);
  readPreparedProof(root,runId,workspaceIdentity,abortToken);
  const file=assertNoReparsePoints(path.join(proofDirectory(root),`startup-${runId}-${blockKey}-a${Number(attempt)}.json`),'isolated acceptance startup receipt');
  const spec=Object.freeze({schema:1,kind:'launcher-start',file,runId,blockKey,attempt:Number(attempt),tokenSha256:digest(token),workspaceIdentity,workspaceKeySha256:digest(workspaceIdentity)});
  startupBindings.set(spec,Object.freeze({workspace:String(workspace),token:String(token),env,root}));
  return spec;
}

export function readStartupReceipt(spec,{launcher}={}){
  if(!spec||typeof spec!=='object')throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: startup receipt spec is required');
  const binding=startupBindings.get(spec);
  if(!binding)throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: unrecognized startup receipt spec');
  const root=controllerStateDir(binding.workspace,binding.env);
  if(physicalPathIdentity(root)!==physicalPathIdentity(binding.root))throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: controller root changed');
  const workspaceIdentity=physicalPathIdentity(binding.workspace);
  if(workspaceIdentity!==spec.workspaceIdentity||digest(workspaceIdentity)!==spec.workspaceKeySha256||digest(binding.token)!==spec.tokenSha256)
    throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: receipt spec binding changed');
  readPreparedProof(root,spec.runId,workspaceIdentity,abortTokenFromEnvironment(binding.env));
  const expectedFile=assertNoReparsePoints(path.join(proofDirectory(root),`startup-${spec.runId}-${spec.blockKey}-a${spec.attempt}.json`),'isolated acceptance startup receipt');
  if(expectedFile!==spec.file)throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: receipt path mismatch');
  let record;
  try{
    const stat=fs.statSync(expectedFile);
    if(!stat.isFile()||stat.size<=0||stat.size>64*1024)throw new Error('invalid receipt file size');
    record=JSON.parse(fs.readFileSync(expectedFile,'utf8'));
  }catch(error){throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: startup receipt is unreadable: '+(error?.message||error));}
  const keys=['schema','kind','runId','blockKey','attempt','tokenSha256','workspaceKeySha256','launcherPid','cwd','createdAt'];
  if(!exactKeys(record,keys)||record.schema!==1||record.kind!=='launcher-start'||record.runId!==spec.runId||record.blockKey!==spec.blockKey||
    record.attempt!==spec.attempt||record.tokenSha256!==spec.tokenSha256||record.workspaceKeySha256!==spec.workspaceKeySha256||
    !Number.isSafeInteger(record.launcherPid)||record.launcherPid<=0||typeof record.cwd!=='string'||!path.isAbsolute(record.cwd)||
    !Number.isFinite(record.createdAt)||record.createdAt<=0)
    throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: startup receipt binding is invalid');
  if(physicalPathIdentity(record.cwd)!==workspaceIdentity)throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: startup receipt workspace mismatch');
  if(record.createdAt>Date.now()+60000)
    throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: startup receipt timestamp is in the future');
  if(launcher!==undefined){
    if(Number(launcher?.ProcessId)!==record.launcherPid)
      throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: startup receipt launcher mismatch');
    // A PID alone can be reused. When the observer has the full process
    // identity, the receipt must have been written after that exact process
    // began. The small tolerance only covers timestamp precision differences
    // between the process snapshot and Date.now().
    if(launcher?.Started!==undefined){
      const startedAt=Date.parse(launcher.Started);
      if(!Number.isFinite(startedAt)||record.createdAt<startedAt-5000)
        throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: startup receipt predates its launcher identity');
    }
  }
  return Object.freeze({schema:record.schema,kind:record.kind,runId:record.runId,blockKey:record.blockKey,attempt:record.attempt,
    tokenSha256:record.tokenSha256,workspaceKeySha256:record.workspaceKeySha256,launcherPid:record.launcherPid,
    workspaceIdentity,createdAt:record.createdAt});
}

function validAbortReason(value){return /^[a-z][a-z0-9-]{0,63}$/.test(String(value||''));}

function abortBinding(spec){
  if(!spec||typeof spec!=='object')throw new Error('ISOLATED_ACCEPTANCE_ABORT: abort spec is required');
  const binding=abortBindings.get(spec);
  if(!binding)throw new Error('ISOLATED_ACCEPTANCE_ABORT: unrecognized abort spec');
  const root=controllerStateDir(binding.workspace,binding.env);
  if(physicalPathIdentity(root)!==physicalPathIdentity(binding.root))throw new Error('ISOLATED_ACCEPTANCE_ABORT: controller root changed');
  const workspaceIdentity=physicalPathIdentity(binding.workspace),abortToken=abortTokenFromEnvironment(binding.env);
  if(workspaceIdentity!==spec.workspaceIdentity||digest(workspaceIdentity)!==spec.workspaceKeySha256||digest(abortToken)!==spec.abortTokenSha256)
    throw new Error('ISOLATED_ACCEPTANCE_ABORT: abort spec binding changed');
  readPreparedProof(root,spec.runId,workspaceIdentity,abortToken);
  const file=assertNoReparsePoints(path.join(abortDirectory(root),spec.runId+'.json'),'isolated acceptance abort');
  if(file!==spec.file)throw new Error('ISOLATED_ACCEPTANCE_ABORT: abort path mismatch');
  return {binding,root,runId:spec.runId,workspaceIdentity,abortToken,file};
}

function finalizationFile(root,runId){
  return assertNoReparsePoints(path.join(finalizationDirectory(root),runId+'.json'),'isolated acceptance finalization');
}

// `wx` makes a destination visible before its JSON body is complete. Publish a
// fully synced sibling first, then create the destination as a hard link. The
// controller lock serializes legitimate writers; linkSync supplies no-clobber,
// all-or-nothing visibility when an untrusted task races the path. Isolated
// controller roots are created on the local Windows volume, so lack of hard-link
// support is intentionally a fail-closed error rather than a weaker fallback.
function publishTerminalRecord(file,record,label){
  const temporary=assertNoReparsePoints(file+'.'+crypto.randomUUID()+'.tmp',label+' temporary');
  let descriptor;
  try{
    descriptor=fs.openSync(temporary,'wx',0o600);
    fs.writeFileSync(descriptor,JSON.stringify(record),'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);descriptor=undefined;
    assertNoReparsePoints(temporary,label+' temporary');
    fs.linkSync(temporary,file);
  }finally{
    if(descriptor!==undefined)try{fs.closeSync(descriptor);}catch{}
    try{fs.rmSync(temporary,{force:true});}catch{}
  }
}

function readAcceptanceFinalizationBound({root,workspaceIdentity,abortToken},spec){
  const file=finalizationFile(root,spec.runId);
  if(!fs.existsSync(file))return null;
  let record;
  try{
    const stat=fs.statSync(file);
    if(!stat.isFile()||stat.size<=0||stat.size>64*1024)throw new Error('invalid finalization file size');
    record=JSON.parse(fs.readFileSync(file,'utf8'));
  }catch(error){throw new Error('ISOLATED_ACCEPTANCE_FINALIZATION: finalization record is unreadable: '+(error?.message||error));}
  const keys=['schema','kind','runId','workspaceKeySha256','abortTokenSha256','finalizedAt','authTag'];
  if(!exactKeys(record,keys)||record.schema!==1||record.kind!=='acceptance-finalization'||record.runId!==spec.runId||
    record.workspaceKeySha256!==spec.workspaceKeySha256||record.abortTokenSha256!==spec.abortTokenSha256||
    !Number.isFinite(record.finalizedAt)||record.finalizedAt<=0||record.finalizedAt>Date.now()+60000)
    throw new Error('ISOLATED_ACCEPTANCE_FINALIZATION: finalization record binding is invalid');
  if(digest(workspaceIdentity)!==spec.workspaceKeySha256||digest(abortToken)!==spec.abortTokenSha256)
    throw new Error('ISOLATED_ACCEPTANCE_FINALIZATION: finalization binding changed');
  if(!validTerminalAuthenticator(record.authTag,abortToken,record))
    throw new Error('ISOLATED_ACCEPTANCE_FINALIZATION: finalization record authentication is invalid');
  return Object.freeze({schema:record.schema,kind:record.kind,runId:record.runId,workspaceIdentity,
    workspaceKeySha256:record.workspaceKeySha256,abortTokenSha256:record.abortTokenSha256,finalizedAt:record.finalizedAt});
}

function terminalDecision(state,spec){
  const finalization=readAcceptanceFinalizationBound(state,spec),abort=readAcceptanceAbort(spec);
  if(finalization&&abort)throw new Error('ISOLATED_ACCEPTANCE_TERMINAL: conflicting terminal records');
  return Object.freeze({settled:Boolean(finalization||abort),outcome:abort||null});
}

function terminalTransaction(state,spec,action){
  // This root belongs to one fresh, non-resumable acceptance run. A short-lived
  // mkdir lock is therefore enough to serialize its two one-way terminal
  // records without taking the global WMI-backed coordinator mutex. If a
  // controller crashes holding it, the acceptance fails closed rather than
  // guessing that an incomplete terminal decision was successful.
  const directory=terminalLockDirectory(state.root);
  fs.mkdirSync(directory,{recursive:true});
  assertNoReparsePoints(directory,'isolated acceptance terminal locks');
  const lock=assertNoReparsePoints(path.join(directory,state.runId+'.lock'),'isolated acceptance terminal lock');
  const deadline=Date.now()+5000;
  while(true){
    try{fs.mkdirSync(lock);break;}
    catch(error){
      if(error?.code!=='EEXIST')throw error;
      // A completed writer can leave its private lock behind when Windows
      // rejects its best-effort cleanup. The durable, token-bound terminal
      // record remains authoritative, so waiting peers resolve from it rather
      // than turning a committed decision into a timeout or synthetic abort.
      const decision=terminalDecision(state,spec);
      if(decision.settled)return decision.outcome;
      if(Date.now()>=deadline)throw new Error('ISOLATED_ACCEPTANCE_TERMINAL: terminal decision lock unavailable');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
    }
  }
  try{
    assertNoReparsePoints(lock,'isolated acceptance terminal lock');
    return action();
  }finally{
    // The action either failed closed or made an immutable terminal decision.
    // A cleanup failure cannot invalidate a decision already made durable.
    // A later contender observes that record above and never waits on a stale
    // lock. The whole isolated controller root is per-run and disposable.
    try{fs.rmdirSync(lock);}catch{}
  }
}

// The harness holds the raw token only in its child environment. The durable
// record and every report projection keep only its hash, so a workspace task
// cannot manufacture an abort record or learn a capability from a report.
export function acceptanceAbortSpec({workspace,runId,token,env=process.env}={}){
  if(String(env.ORCH_ISOLATED_ACCEPTANCE||'')!=='1')throw new Error('ISOLATED_ACCEPTANCE_ABORT: isolated acceptance is required');
  if(!validRunId(runId)||!validAbortToken(token))throw new Error('ISOLATED_ACCEPTANCE_ABORT: invalid abort binding');
  const abortToken=abortTokenFromEnvironment(env);
  if(token!==abortToken)throw new Error('ISOLATED_ACCEPTANCE_ABORT: abort token does not match the isolated lane');
  const root=controllerStateDir(workspace,env),workspaceIdentity=physicalPathIdentity(workspace);
  readPreparedProof(root,runId,workspaceIdentity,abortToken);
  const file=assertNoReparsePoints(path.join(abortDirectory(root),runId+'.json'),'isolated acceptance abort');
  const spec=Object.freeze({schema:1,kind:'acceptance-abort',file,runId,workspaceIdentity,
    workspaceKeySha256:digest(workspaceIdentity),abortTokenSha256:digest(abortToken)});
  abortBindings.set(spec,Object.freeze({workspace:String(workspace),env,root}));
  return spec;
}

export function readAcceptanceAbort(spec){
  const {workspaceIdentity,file,abortToken}=abortBinding(spec);
  if(!fs.existsSync(file))return null;
  let record;
  try{
    const stat=fs.statSync(file);
    if(!stat.isFile()||stat.size<=0||stat.size>64*1024)throw new Error('invalid abort file size');
    record=JSON.parse(fs.readFileSync(file,'utf8'));
  }catch(error){throw new Error('ISOLATED_ACCEPTANCE_ABORT: abort record is unreadable: '+(error?.message||error));}
  const keys=['schema','kind','runId','workspaceKeySha256','abortTokenSha256','reason','requestedAt','authTag'];
  if(!exactKeys(record,keys)||record.schema!==1||record.kind!=='acceptance-abort'||record.runId!==spec.runId||
    record.workspaceKeySha256!==spec.workspaceKeySha256||record.abortTokenSha256!==spec.abortTokenSha256||
    !validAbortReason(record.reason)||!Number.isFinite(record.requestedAt)||record.requestedAt<=0||record.requestedAt>Date.now()+60000)
    throw new Error('ISOLATED_ACCEPTANCE_ABORT: abort record binding is invalid');
  if(!validTerminalAuthenticator(record.authTag,abortToken,record))
    throw new Error('ISOLATED_ACCEPTANCE_ABORT: abort record authentication is invalid');
  return Object.freeze({schema:record.schema,kind:record.kind,runId:record.runId,workspaceIdentity,
    workspaceKeySha256:record.workspaceKeySha256,abortTokenSha256:record.abortTokenSha256,reason:record.reason,requestedAt:record.requestedAt});
}

export function readAcceptanceFinalization(spec){
  const state=abortBinding(spec);
  return readAcceptanceFinalizationBound(state,spec);
}

export function requestAcceptanceAbort(spec,{reason='monitor-failed'}={}){
  const state=abortBinding(spec),{file,root,workspaceIdentity,abortToken}=state;
  if(!validAbortReason(reason))throw new Error('ISOLATED_ACCEPTANCE_ABORT: invalid abort reason');
  return terminalTransaction(state,spec,()=>{
    const decision=terminalDecision(state,spec);
    if(decision.settled)return decision.outcome;
    // A runner records the success decision before it writes its public
    // summary. A later monitor observation must not overturn that completed
    // decision, while a crash before the summary remains fail-closed.
    const directory=abortDirectory(root);
    try{fs.mkdirSync(directory,{recursive:false});}
    catch(error){if(error?.code!=='EEXIST')throw error;}
    assertNoReparsePoints(directory,'isolated acceptance aborts');
    const record={schema:1,kind:'acceptance-abort',runId:spec.runId,workspaceKeySha256:digest(workspaceIdentity),
      abortTokenSha256:digest(abortToken),reason,requestedAt:Date.now()};
    record.authTag=terminalAuthenticator(abortToken,record);
    try{publishTerminalRecord(file,record,'isolated acceptance abort');}
    catch(error){
      if(error?.code==='EEXIST'){
        const existing=terminalDecision(state,spec);
        if(existing.settled)return existing.outcome;
      }
      throw new Error('ISOLATED_ACCEPTANCE_ABORT: unable to publish abort: '+(error?.message||error));
    }
    return readAcceptanceAbort(spec);
  });
}

// Commit the success side of the isolated terminal decision. It returns an
// authenticated abort record when a monitor won first, otherwise null. The
// caller must publish success only after this function has returned null.
export function finalizeAcceptanceSuccess(spec){
  const state=abortBinding(spec),{root,workspaceIdentity,abortToken}=state;
  return terminalTransaction(state,spec,()=>{
    const decision=terminalDecision(state,spec);
    if(decision.settled)return decision.outcome;
    const directory=finalizationDirectory(root);
    try{fs.mkdirSync(directory,{recursive:false});}
    catch(error){if(error?.code!=='EEXIST')throw error;}
    assertNoReparsePoints(directory,'isolated acceptance finalizations');
    const file=finalizationFile(root,spec.runId);
    const record={schema:1,kind:'acceptance-finalization',runId:spec.runId,workspaceKeySha256:digest(workspaceIdentity),
      abortTokenSha256:digest(abortToken),finalizedAt:Date.now()};
    record.authTag=terminalAuthenticator(abortToken,record);
    try{publishTerminalRecord(file,record,'isolated acceptance finalization');}
    catch(error){
      if(error?.code==='EEXIST'){
        const existing=terminalDecision(state,spec);
        if(existing.settled)return existing.outcome;
      }
      throw new Error('ISOLATED_ACCEPTANCE_FINALIZATION: unable to publish finalization: '+(error?.message||error));
    }
    if(!readAcceptanceFinalizationBound(state,spec))throw new Error('ISOLATED_ACCEPTANCE_FINALIZATION: finalization record was not durable');
    return null;
  });
}

export function readConfiguredAcceptanceAbort({workspace,runId,env=process.env}={}){
  if(String(env.ORCH_ISOLATED_ACCEPTANCE||'')!=='1')return null;
  const token=abortTokenFromEnvironment(env);
  return readAcceptanceAbort(acceptanceAbortSpec({workspace,runId,token,env}));
}

export function readConfiguredAcceptanceFinalization({workspace,runId,env=process.env}={}){
  if(String(env.ORCH_ISOLATED_ACCEPTANCE||'')!=='1')return null;
  const token=abortTokenFromEnvironment(env);
  return readAcceptanceFinalization(acceptanceAbortSpec({workspace,runId,token,env}));
}

export async function prepareExecutionLane({workspace,runId,env=process.env,initiatorContext=PROCESS_INITIATOR_CONTEXT,resume=false,acceptance,cleanWindows,cleanTransients}={}){
  const lane=acceptance===undefined?prepareIsolatedAcceptance({workspace,runId,env,initiatorContext,resume}):acceptance;
  if(lane?.enabled===true)return consumeIsolatedAcceptance(lane,{workspace,runId,env,initiatorContext,resume});
  if(!lane||lane.enabled!==false||lane.skipSharedCleanup!==false)throw new Error('Invalid execution lane');
  if(typeof cleanWindows!=='function'||typeof cleanTransients!=='function')throw new Error('Execution cleanup callbacks are required');
  await cleanWindows();
  await cleanTransients();
  return lane;
}

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {atomicJson,processIdentityBinding,processSnapshot,sameProcess,trustedWindowsHelper,trustedWindowsRoot,controllerEnvironment,readUtf8Bounded} from './leases.mjs';
import {workerEnvironment} from './network-policy.mjs';
import {isCapacityError,isProviderQuotaError} from './retry-policy.mjs';
import {assertControllerPath,controllerStateDir} from './controller-state.mjs';
import {assertNoReparsePoints,physicallySameOrChild,physicalPathIdentity} from './runtime-context.mjs';
import {redactSensitiveText} from './redaction.mjs';
import {readProtectedText} from './private-run-state.mjs';
import {validAbortToken,validTerminalAuthenticator} from './isolated-acceptance.mjs';
import {assertSafeWorkerArgs} from './worker-authorization.mjs';
import {revalidateHostExecutable} from './host-cli.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const MAX_STREAM_BYTES=64*1024*1024;
const MAX_EVENT_LINE_BYTES=4*1024*1024;
const UNVERIFIED_CHILD_GRACE_MS=2000;
const IDENTITY_CHECK_TIMEOUT_MS=5000;
const digest=value=>crypto.createHash('sha256').update(String(value),'utf8').digest('hex');
const exactKeys=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&
  JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());
function tail(file){
  const fd=fs.openSync(file,'r');
  try{const length=fs.fstatSync(fd).size,buffer=Buffer.alloc(Math.min(length,16384));fs.readSync(fd,buffer,0,buffer.length,Math.max(0,length-buffer.length));return buffer.toString('utf8');}
  finally{fs.closeSync(fd);}
}

function detachUnverifiedChild(child){
  // Once ownership cannot be revalidated, closing the worker's pipe handles
  // prevents a detached child from keeping this worker alive indefinitely.
  // We deliberately do not call taskkill/child.kill without an identity proof.
  try{child?.stdin?.destroy();}catch{}
  try{child?.stdout?.destroy();}catch{}
  try{child?.stderr?.destroy();}catch{}
  // A pending stdin write can remain referenced even after the result is
  // durable. Unref every pipe so the worker can return while preserving the
  // live, unbound child for explicit reconciliation.
  for(const stream of [child?.stdin,child?.stdout,child?.stderr])try{stream?.unref?.();}catch{}
  try{child?.unref?.();}catch{}
}

function startupReceiptBinding(config,lp){
  const receipt=config.startupReceipt;
  if(receipt===null||receipt===undefined)return null;
  const keys=['schema','kind','file','runId','blockKey','attempt','tokenSha256','workspaceIdentity','workspaceKeySha256'];
  if(!exactKeys(receipt,keys)||receipt.schema!==1||receipt.kind!=='launcher-start'||receipt.runId!==config.runId||
    !/^B[1-9][0-9]*$/.test(String(receipt.blockKey||''))||!Number.isSafeInteger(receipt.attempt)||receipt.attempt<=0||
    !/^[a-f0-9]{64}$/i.test(String(receipt.tokenSha256||''))||!/^[a-f0-9]{64}$/i.test(String(receipt.workspaceKeySha256||''))||
    !/^[A-Za-z0-9_-]{1,100}$/.test(String(receipt.runId||''))||typeof receipt.file!=='string'||!path.isAbsolute(receipt.file))
    throw new Error('Invalid headless startup receipt binding');
  const workspaceIdentity=physicalPathIdentity(config.workspace);
  if(receipt.tokenSha256!==digest(config.token)||receipt.workspaceIdentity!==workspaceIdentity||receipt.workspaceKeySha256!==digest(workspaceIdentity))
    throw new Error('Headless startup receipt identity mismatch');
  if(path.basename(lp)!==`exec-${receipt.blockKey}.json`)
    throw new Error('Headless startup receipt block does not match control stem');
  if(typeof config.attemptFile!=='string'||path.basename(path.dirname(path.resolve(config.attemptFile)))!==String(receipt.attempt))
    throw new Error('Headless startup receipt attempt does not match the attempt ledger');
  const headlessRoot=path.resolve(path.dirname(lp),'..','..');
  if(path.basename(headlessRoot)!=='headless')throw new Error('Invalid headless controller layout');
  const controllerRoot=path.dirname(headlessRoot);
  const expected=assertNoReparsePoints(path.join(controllerRoot,'acceptance-proofs',`startup-${config.runId}-${receipt.blockKey}-a${receipt.attempt}.json`),'headless startup receipt');
  if(path.resolve(receipt.file)!==expected)throw new Error('Invalid headless startup receipt path');
  return {...receipt,file:expected};
}

// The worker receives a private abort capability only for the short period it
// needs to authenticate controller-written abort records. It is never written
// to a controller artifact and is explicitly removed before the real Codex CLI
// is spawned.
function invalidAbortAuthority(){return new Error('Invalid headless acceptance abort authority');}

function acceptanceAbortBinding(config,controllerRoot){
  const descriptor=config.acceptanceAbort;
  if(descriptor===undefined){
    // A startup receipt is emitted only for isolated acceptance runs. New
    // isolated records must carry the abort descriptor as well; ordinary v1
    // records retain their old shape for upgrade compatibility.
    if(config.startupReceipt!==undefined&&config.startupReceipt!==null)throw invalidAbortAuthority();
    return null;
  }
  try{
    const keys=['schema','kind','file','runId','workspaceIdentity','workspaceKeySha256','abortTokenSha256'];
    if(!exactKeys(descriptor,keys)||descriptor.schema!==1||descriptor.kind!=='acceptance-abort'||
      descriptor.runId!==config.runId||typeof descriptor.file!=='string'||!path.isAbsolute(descriptor.file)||
      typeof descriptor.workspaceIdentity!=='string'||!path.isAbsolute(descriptor.workspaceIdentity)||
      !/^[a-f0-9]{64}$/i.test(String(descriptor.workspaceKeySha256||''))||
      !/^[a-f0-9]{64}$/i.test(String(descriptor.abortTokenSha256||'')))throw invalidAbortAuthority();
    const abortToken=String(process.env.ORCH_HEADLESS_ABORT_TOKEN||'');
    if(!validAbortToken(abortToken)||digest(abortToken)!==descriptor.abortTokenSha256)
      throw invalidAbortAuthority();
    const workspaceIdentity=physicalPathIdentity(config.workspace);
    if(descriptor.workspaceIdentity!==workspaceIdentity||descriptor.workspaceKeySha256!==digest(workspaceIdentity))
      throw invalidAbortAuthority();
    const directory=assertNoReparsePoints(path.join(controllerRoot,'acceptance-aborts'),'headless acceptance abort');
    const expected=assertNoReparsePoints(path.join(directory,config.runId+'.json'),'headless acceptance abort');
    if(path.resolve(descriptor.file)!==expected)throw invalidAbortAuthority();
    return Object.freeze({schema:1,kind:'acceptance-abort',file:expected,runId:config.runId,
      workspaceKeySha256:descriptor.workspaceKeySha256,abortTokenSha256:descriptor.abortTokenSha256,abortToken});
  }catch(error){
    if(error?.message==='Invalid headless acceptance abort authority')throw error;
    throw invalidAbortAuthority();
  }
}

function readAcceptanceAbort(binding){
  if(!binding)return null;
  // Only a complete, HMAC-authenticated controller record may change the
  // worker's execution. A workspace task can at most discover public path and
  // hash data; a malformed or forged file must not become a cancellation DoS.
  // The parent controller independently treats such corruption as an
  // acceptance failure and owns any eventual cleanup.
  try{
    const file=assertNoReparsePoints(binding.file,'headless acceptance abort');
    let stat;
    try{stat=fs.statSync(file);}
    catch{return null;}
    if(!stat.isFile()||stat.size<=0||stat.size>64*1024)return null;
    const record=JSON.parse(readUtf8Bounded(file,'headless acceptance abort',64*1024)||'');
    const keys=['schema','kind','runId','workspaceKeySha256','abortTokenSha256','reason','requestedAt','authTag'];
    if(!exactKeys(record,keys)||record.schema!==1||record.kind!=='acceptance-abort'||record.runId!==binding.runId||
      record.workspaceKeySha256!==binding.workspaceKeySha256||record.abortTokenSha256!==binding.abortTokenSha256||
      !/^[a-f0-9]{64}$/i.test(String(record.authTag||''))||
      !/^[a-z][a-z0-9-]{0,63}$/.test(String(record.reason||''))||!Number.isFinite(record.requestedAt)||
      record.requestedAt<=0||record.requestedAt>Date.now()+60000)return null;
    if(!validTerminalAuthenticator(record.authTag,binding.abortToken,record))return null;
    // Keep the durable result useful to the controller while never copying a
    // controller path, workspace spelling, or raw capability into it.
    return Object.freeze({kind:'acceptance-abort',runId:record.runId,reason:record.reason,requestedAt:record.requestedAt});
  }catch{return null;}
}

function writeStartupReceipt(receipt,workspace,pid){
  if(!receipt)return null;
  const cwd=process.cwd();
  if(physicalPathIdentity(cwd)!==receipt.workspaceIdentity||physicalPathIdentity(workspace)!==receipt.workspaceIdentity)
    throw new Error('Headless startup working directory mismatch');
  const file=assertNoReparsePoints(receipt.file,'headless startup receipt');
  const record={schema:1,kind:'launcher-start',runId:receipt.runId,blockKey:receipt.blockKey,attempt:receipt.attempt,
    tokenSha256:receipt.tokenSha256,workspaceKeySha256:receipt.workspaceKeySha256,launcherPid:pid,cwd,createdAt:Date.now()};
  fs.writeFileSync(file,JSON.stringify(record),{encoding:'utf8',flag:'wx'});
  return {schema:record.schema,kind:record.kind,runId:record.runId,blockKey:record.blockKey,attempt:record.attempt,
    tokenSha256:record.tokenSha256,workspaceKeySha256:record.workspaceKeySha256,launcherPid:record.launcherPid,
    workspaceIdentity:receipt.workspaceIdentity,createdAt:record.createdAt};
}
export async function runHeadlessWorker(configFile,{snapshot=processSnapshot,unverifiedChildGraceMs=UNVERIFIED_CHILD_GRACE_MS,platform=process.platform}={}){
  const configText=readUtf8Bounded(configFile,'headless config');
  const config=JSON.parse(configText||'');
  if(config.version!==1||typeof config.cli!=='string'||!path.isAbsolute(config.cli)||typeof config.workspace!=='string'||!config.workspace||!path.isAbsolute(config.workspace)||!Array.isArray(config.args)||!config.runId||!config.token||!config.files||!Number.isFinite(config.timeoutMs)||config.timeoutMs<=0)throw new Error('Invalid headless attempt configuration');
  assertNoReparsePoints(config.cli,'headless CLI');
  // v1 records written before the isolated-acceptance bindings intentionally
  // omitted those fields from their digest. Keep that exact normal-record
  // shape executable; records carrying either binding authenticate it before
  // any child can start.
  const digestInput={cli:config.cli,args:config.args,workspace:config.workspace,runId:config.runId,token:config.token,attemptFile:config.attemptFile,timeoutMs:config.timeoutMs,...(Object.hasOwn(config,'privatePrompt')?{privatePrompt:config.privatePrompt}:{}),...(Object.hasOwn(config,'startupReceipt')?{startupReceipt:config.startupReceipt}:{}),...(Object.hasOwn(config,'acceptanceAbort')?{acceptanceAbort:config.acceptanceAbort}:{})};
  const expectedCommandDigest=crypto.createHash('sha256').update(JSON.stringify(digestInput)).digest('hex');
  if(typeof config.commandDigest!=='string'||config.commandDigest!==expectedCommandDigest)throw new Error('Headless command binding mismatch');
  assertSafeWorkerArgs(config.args,{workspace:config.workspace});
  const lp=path.resolve(configFile),files=config.files;
  // The worker is launched from a controller-owned config. Re-derive every
  // sibling path from that config path before creating any file, so a
  // workspace process cannot redirect the worker's durable result outside the
  // controller headless directory by editing one JSON field.
  assertControllerPath(config.workspace,lp,'headless config');
  const workspaceId=crypto.createHash('sha256').update(physicalPathIdentity(config.workspace)).digest('hex');
  const expectedHeadlessRoot=path.join(controllerStateDir(config.workspace),'headless',workspaceId);
  if(!physicallySameOrChild(expectedHeadlessRoot,lp))throw new Error('Invalid headless controller workspace binding');
  // `expectedHeadlessRoot` is <controllerRoot>/headless/<workspaceHash>.
  // Abort records live directly below the controller root, alongside the
  // startup-proof directory, rather than below the headless worker subtree.
  const controllerRoot=path.dirname(path.dirname(expectedHeadlessRoot));
  const privatePrompt=config.privatePrompt===true;
  if(config.privatePrompt!==undefined&&!privatePrompt)throw new Error('Invalid headless private prompt binding');
  const base=lp.slice(0,-'.json'.length),expected={
    lp, pf:base+'.prompt.txt', pidf:base+'.pid', rf:base+'.result.json',
    stdout:base+'.stdout.jsonl', stderr:base+'.stderr.log',
  };
  if(privatePrompt)expected.privatePrompt=base+'.prompt.dpapi';
  for(const [key,value] of Object.entries(expected)){
    if(typeof files[key]!=='string'||path.resolve(files[key])!==value)throw new Error('Invalid headless attempt file binding: '+key);
    assertNoReparsePoints(value,'headless attempt file');
  }
  if(!privatePrompt&&files.privatePrompt!==undefined)throw new Error('Invalid headless private prompt binding');
  for(const key of ['ready','cancel','runtime']){
    const value=files[key]===undefined?config[key]:files[key];
    if(typeof value!=='string'||path.resolve(value)!==base+({ready:'.go',cancel:'.cancel',runtime:'.runtime.json'}[key]))throw new Error('Invalid headless control binding: '+key);
    assertNoReparsePoints(value,'headless control');
  }
  if(config.attemptFile!==undefined){
    if(typeof config.attemptFile!=='string'||!physicallySameOrChild(config.workspace,config.attemptFile))throw new Error('Invalid headless attempt ledger binding');
    assertNoReparsePoints(config.attemptFile,'headless attempt ledger');
    let attempt;
    try{attempt=JSON.parse((readUtf8Bounded(config.attemptFile,'headless attempt ledger')||'').replace(/^\uFEFF/,''));}
    catch(error){throw new Error('Invalid headless attempt ledger: '+(error?.message||error));}
    if(attempt?.runId!==config.runId||attempt?.token!==config.token)throw new Error('Headless attempt ledger identity mismatch');
  }
  const startupReceipt=startupReceiptBinding(config,lp);
  const acceptanceAbort=acceptanceAbortBinding(config,controllerRoot);
  const deadline=Date.now()+config.timeoutMs;
  const runtime={runId:config.runId,token:config.token,pid:process.pid,threadId:null,startedAt:Date.now()};
  const result={...runtime,done:false,exitCode:null,text:''};
  const finishBeforeExecutionAbort=()=>{
    try{
      const aborted=readAcceptanceAbort(acceptanceAbort);
      if(!aborted)return null;
      result.aborted=true;result.acceptanceAbort=aborted;result.text='Headless execution aborted before readiness';result.endedAt=Date.now();
      atomicJson(files.rf,result);return result;
    }catch{
      result.abortAuthorityInvalid=true;result.text='Headless acceptance abort authority is invalid';result.endedAt=Date.now();
      atomicJson(files.rf,result);return result;
    }
  };
  try {
    fs.writeFileSync(files.pidf,String(process.pid),{flag:'wx'});
    const startup=writeStartupReceipt(startupReceipt,config.workspace,process.pid);
    if(startup)runtime.startupReceipt=startup;
    atomicJson(config.runtime,runtime);
  } catch(error) {
    result.text=error?.message||String(error);result.endedAt=Date.now();
    atomicJson(files.rf,result);
    return result;
  }
  const initialAbort=finishBeforeExecutionAbort();
  if(initialAbort)return initialAbort;
  while(!fs.existsSync(config.ready)){
    const preReadyAbort=finishBeforeExecutionAbort();
    if(preReadyAbort)return preReadyAbort;
    if(fs.existsSync(config.cancel)||Date.now()>=deadline){result.text='Cancelled before execution';result.endedAt=Date.now();atomicJson(files.rf,result);return result;}
    await pause(25);
  }
  const preSpawnAbort=finishBeforeExecutionAbort();
  if(preSpawnAbort)return preSpawnAbort;
  let out,err,child,closed,identity,stdoutPending='',stderrPending='',completed=false,failed=false,cancelled=false,lastMessage='',stopping=false,timer,unverifiedTimer,executionEnd;
  let resolveUnverifiedClose;
  const unverifiedClose=new Promise(resolve=>{resolveUnverifiedClose=resolve;});
  let resolvePromptReceipt;
  const promptReceipt=new Promise(resolve=>{resolvePromptReceipt=resolve;});
  let promptDelivered=false,promptReceiptSeen=false,initialIdentityObserved=false;
  let observeInitialIdentity=()=>{};
  const acknowledgePromptReceipt=()=>{
    promptReceiptSeen=true;
    resolvePromptReceipt?.();
    if(promptDelivered&&!initialIdentityObserved){
      initialIdentityObserved=true;
      // Keep the observation in the receipt callback. A short-lived CLI can
      // close between stdout event-loop turns, which would erase the binding
      // even though it proved it had consumed stdin.
      observeInitialIdentity();
    }
  };
  const beginUnverifiedGrace=()=>{
    if(unverifiedTimer!==undefined)return;
    const grace=Math.max(0,Number(unverifiedChildGraceMs)||0);
    unverifiedTimer=setTimeout(()=>resolveUnverifiedClose(null),grace);
  };
  let stdoutBytes=0,stderrBytes=0;
  const eventLine=line=>{
    if(!line.trim())return;
    let event;try{event=JSON.parse(line);}catch{failed=true;result.text='Invalid exec JSONL output';return;}
    acknowledgePromptReceipt();
    const payload=event?.payload&&typeof event.payload==='object'?event.payload:event;
    const type=payload?.type||event?.type;
    if(type==='thread.started')runtime.threadId=payload.thread_id||payload.threadId||null;
    if(type==='turn.completed'||type==='task_complete')completed=true;
    if(type==='turn.failed'||type==='error'){
      // `error` also reports recoverable reconnect notifications. A terminal
      // turn.failed, corrupt stream, nonzero exit or cancellation remains fatal.
      if(type==='turn.failed')failed=true;
      result.text=redactSensitiveText(payload.message||payload.error?.message||JSON.stringify(payload));
      if(isProviderQuotaError(payload)){result.retryable='quota';result.quotaError=redactSensitiveText(JSON.stringify(payload));}
      else if(isCapacityError(payload)){result.retryable='capacity';result.capacityError=result.text;}
    }
    if(type==='item.completed'&&payload.item?.type==='agent_message')lastMessage=redactSensitiveText(payload.item.text||'');
    runtime.updatedAt=Date.now();runtime.event=type;atomicJson(config.runtime,runtime);
  };
  const stop=()=>{
    if(stopping||!child||child.exitCode!==null)return;
    cancelled=true;
    if(platform==='win32'){
      // The worker owns this exec tree, never a Windows Terminal host. Recheck
      // the captured identity before invoking tree termination.
      if(!identity){
        result.text=result.text||'Refused to terminate headless child because its process identity could not be revalidated';
        result.terminationRefused=true;
        stopping=true;
        beginUnverifiedGrace();
        return;
      }
      try{
        // A PID is not an ownership proof. If the process identity cannot be
        // revalidated, refuse termination instead of racing PID reuse and
        // killing an unrelated same-user process. The durable result records
        // the refusal and the controller can reconcile the attempt.
        const current=snapshot(IDENTITY_CHECK_TIMEOUT_MS).get(child.pid);
        if(!sameProcess(identity,current)){
          result.text=result.text||'Refused to terminate headless child because its process identity could not be revalidated';
          result.terminationRefused=true;
          stopping=true;
          beginUnverifiedGrace();
          return;
        }
        stopping=true;
        const killed=spawnSync(trustedWindowsHelper('taskkill'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',shell:false,cwd:trustedWindowsRoot(),env:controllerEnvironment()});
        if(killed.status!==0){
          result.text=result.text||'Refused to terminate headless child because taskkill did not confirm ownership';
          result.terminationRefused=true;
          beginUnverifiedGrace();
        } else {
          const after=snapshot(IDENTITY_CHECK_TIMEOUT_MS).get(child.pid);
          result.terminationTarget=identity;
          result.terminationVerified=!after||!sameProcess(identity,after);
          if(!result.terminationVerified){
            result.text=result.text||'Refused to confirm headless child termination after ownership check';
            result.terminationRefused=true;
            beginUnverifiedGrace();
          }
        }
      }catch{
        result.text=result.text||'Refused to terminate headless child because process identity inspection failed';
        result.terminationRefused=true;
        stopping=true;
        beginUnverifiedGrace();
      }
    }else{
      // A ChildProcess handle alone is not a durable cross-platform ownership
      // proof. Refuse a direct signal when the worker cannot revalidate the
      // child identity, and leave the attempt for explicit reconciliation.
      result.text=result.text||'Refused to terminate headless child because process identity verification is unavailable on this platform';
      result.terminationRefused=true;
      stopping=true;
      beginUnverifiedGrace();
    }
  };
  const observeAcceptanceAbort=()=>{
    try{
      const aborted=readAcceptanceAbort(acceptanceAbort);
      if(!aborted)return false;
      cancelled=true;result.aborted=true;result.acceptanceAbort=aborted;result.text='Headless execution aborted';stop();
      return true;
    }catch{
      // Binding setup is controller-only; an unexpected internal observation
      // failure stops this owned child without copying details into artifacts.
      failed=true;result.abortAuthorityInvalid=true;result.text='Headless acceptance abort authority is invalid';stop();
      return true;
    }
  };
  const fault=error=>{
    failed=true;
    if(!result.aborted&&!result.abortAuthorityInvalid)result.text=redactSensitiveText(error?.message||'Headless execution failed');
    stop();
  };
  const appendStdout=chunk=>{
    const raw=String(chunk),bytes=Buffer.byteLength(raw,'utf8');
    if(stdoutBytes+bytes>MAX_STREAM_BYTES)throw new Error('Headless stdout exceeded the 64 MiB safety limit');
    stdoutBytes+=bytes;stdoutPending+=raw;
    let n;while((n=stdoutPending.indexOf('\n'))>=0){
      const line=stdoutPending.slice(0,n);stdoutPending=stdoutPending.slice(n+1);
      if(Buffer.byteLength(line,'utf8')>MAX_EVENT_LINE_BYTES)throw new Error('Headless JSONL event exceeded the 4 MiB safety limit');
      const text=redactSensitiveText(line);fs.writeSync(out,text+'\n');eventLine(text);
    }
    if(Buffer.byteLength(stdoutPending,'utf8')>MAX_EVENT_LINE_BYTES)throw new Error('Headless JSONL event exceeded the 4 MiB safety limit');
  };
  const flushStdout=()=>{
    if(!stdoutPending)return;
    if(Buffer.byteLength(stdoutPending,'utf8')>MAX_EVENT_LINE_BYTES)throw new Error('Headless JSONL event exceeded the 4 MiB safety limit');
    const text=redactSensitiveText(stdoutPending);stdoutPending='';fs.writeSync(out,text);if(!failed&&text.trim())eventLine(text);
  };
  const appendStderr=chunk=>{
    const raw=String(chunk),bytes=Buffer.byteLength(raw,'utf8');
    if(stderrBytes+bytes>MAX_STREAM_BYTES)throw new Error('Headless stderr exceeded the 64 MiB safety limit');
    stderrBytes+=bytes;stderrPending+=raw;
    let n;while((n=stderrPending.indexOf('\n'))>=0){
      const line=stderrPending.slice(0,n+1);stderrPending=stderrPending.slice(n+1);fs.writeSync(err,redactSensitiveText(line));
    }
  };
  const flushStderr=()=>{if(stderrPending){const text=redactSensitiveText(stderrPending);stderrPending='';fs.writeSync(err,text);}};
  try{
    out=fs.openSync(files.stdout,'a');err=fs.openSync(files.stderr,'a');
    const childEnv=workerEnvironment({ORCH_EXECUTION:'1',ORCH_EXECUTION_MODE:'headless',ORCH_WINDOW:'1'});
    // The controller root is worker-only state. The CLI receives no path that
    // could be used to inspect or influence controller-owned acceptance files.
    delete childEnv.ORCH_CONTROLLER_ROOT;
    delete childEnv.ORCH_HEADLESS_ABORT_TOKEN;
    delete childEnv.ORCH_ISOLATED_ABORT_TOKEN;
    delete childEnv.ORCH_ISOLATED_ACCEPTANCE;
    delete childEnv.ORCH_RUN_ID;
    // Give the CLI its own process group. If this entrypoint later exits only
    // after durably recording an unresolved child, Windows must not take that
    // still-unbound CLI down with the worker process.
    // A controller record can be re-digested by another same-user process, so
    // validate the executable after readiness and immediately before use. Do
    // not honor the explicit-unverified CLI escape hatch for hidden workers.
    revalidateHostExecutable({bin:config.cli},process.env,{allowExplicitUnverified:false});
    child=spawn(config.cli,[...config.args,'-'],{cwd:config.workspace,windowsHide:true,detached:true,shell:false,stdio:['pipe','pipe','pipe'],env:childEnv});
    closed=new Promise(resolve=>{child.once('error',fault);child.once('close',(code,signal)=>resolve({code,signal}));});
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{try{appendStdout(chunk);}catch(error){fault(error);}});
    child.stderr.on('data',chunk=>{try{appendStderr(chunk);}catch(error){fault(error);}});
    child.stdout.on('error',fault);child.stderr.on('error',fault);
    // Keep an error listener for the complete lifetime of the pipe. Prompt
    // delivery below owns the initial error and turns EPIPE/early close into a
    // fail-closed result; a late error after a completed write cannot be left
    // unhandled by EventEmitter.
    child.stdin.on('error',()=>{});
    // The child must receive its already-bound prompt independently of a
    // best-effort CIM observation.  A slow or unavailable identity snapshot
    // cannot leave a legitimate CLI blocked on stdin.  We still retain the
    // identity when available and never use an unbound PID for termination.
    const prompt=privatePrompt
      ?readProtectedText({workspace:config.workspace,file:files.privatePrompt})
      :(readUtf8Bounded(files.pf,'headless prompt')||'');
    runtime.childPid=child.pid;atomicJson(config.runtime,runtime);
    // Start cancellation/deadline observation before awaiting pipe drain. A
    // child which never reads stdin must still reach bounded reconciliation;
    // ordinary identity observation below remains gated on a successful drain.
    timer=setInterval(()=>{try{
      if(observeAcceptanceAbort())return;
      if(fs.existsSync(config.cancel)||Date.now()>=deadline)stop();
    }catch(error){fault(error);}},100);
    observeInitialIdentity=()=>{
      if(platform!=='win32'||!child.pid)return;
      try{identity=processIdentityBinding(snapshot(IDENTITY_CHECK_TIMEOUT_MS).get(child.pid));}
      catch{runtime.childIdentityUnavailableAt=Date.now();}
    };
    if(!observeAcceptanceAbort()){
      const delivery=new Promise((resolve,reject)=>{
          let settled=false;
          const settle=error=>{
            if(settled)return;
            settled=true;
            child.stdin.off('finish',finished);
            child.stdin.off('error',failedWrite);
            child.off('close',closedBeforePrompt);
            if(error)reject(error);else resolve();
          };
          // `finish` proves the writable pipe accepted EOF. It does not prove
          // the CLI consumed the prompt, so wait for its first stdout receipt
          // before beginning a potentially synchronous identity snapshot.
          const finished=()=>{
            promptDelivered=true;
            if(promptReceiptSeen)acknowledgePromptReceipt();
            settle();
          };
          const failedWrite=error=>settle(error||Object.assign(new Error('Headless prompt delivery failed'),{code:'EPIPE'}));
          const closedBeforePrompt=()=>{
            if(!child.stdin.writableFinished)failedWrite(Object.assign(new Error('Headless child exited before prompt delivery completed'),{code:'EPIPE'}));
          };
          child.stdin.once('finish',finished);
          child.stdin.once('error',failedWrite);
          child.once('close',closedBeforePrompt);
          try{child.stdin.end(prompt);}catch(error){failedWrite(error);}
        });
      const promptOutcome=await Promise.race([
        delivery.then(()=>({delivered:true}),()=>({delivered:false})),
        unverifiedClose.then(()=>({unresolved:true})),
      ]);
      if(promptOutcome.delivered){
        const receiptOutcome=await Promise.race([
          promptReceipt.then(()=>({received:true})),
          closed.then(()=>({closed:true})),
          unverifiedClose.then(()=>({unresolved:true})),
        ]);
        if(receiptOutcome.received)acknowledgePromptReceipt();
      }else if(!promptOutcome.unresolved){
        // `end()` only queues bytes. Until its finish event proves the bytes
        // drained, do not block a waiting CLI behind a synchronous snapshot.
        // An EPIPE or early child exit has no safe identity binding, so retain
        // evidence and refuse automatic termination instead of touching a PID.
        failed=true;
        result.promptDeliveryFailed=true;
        result.text='Headless prompt delivery failed before child identity observation';
        if(child?.exitCode===null){
          cancelled=true;
          result.terminationRefused=true;
          stopping=true;
          beginUnverifiedGrace();
        }
      }else{
        failed=true;
        result.promptDeliveryFailed=true;
        result.text=result.text||'Headless prompt delivery did not complete before reconciliation';
      }
    }
    runtime.childIdentity=identity;atomicJson(config.runtime,runtime);
    executionEnd=await Promise.race([closed,unverifiedClose]);
    flushStdout();flushStderr();
    observeAcceptanceAbort();
    if(executionEnd){
      result.exitCode=executionEnd.code;result.signal=executionEnd.signal;result.threadId=runtime.threadId;
      result.done=executionEnd.code===0&&completed&&!failed&&!cancelled;
      if(result.done){result.text=lastMessage;delete result.retryable;delete result.capacityError;}
    }else{
      // A second identity read can fail transiently under Windows CIM load.
      // The worker must not then wait forever for an unowned child: publish a
      // recoverable outcome and leave the lease for explicit reconciliation.
      result.done=false;result.childStillRunning=true;result.exitUnproven=true;
      detachUnverifiedChild(child);
    }
    if(!result.text)result.text=cancelled?'Headless execution cancelled':lastMessage||(!completed?'Exec stream ended before turn.completed':'');
  }catch(error){fault(error);result.done=false;}
  finally{
    clearInterval(timer);
    if(unverifiedTimer!==undefined)clearTimeout(unverifiedTimer);
    // A failed journal write must not leave the owned CLI alive or let its
    // remaining output write into descriptors already closed by this worker.
    if(closed&&!result.childStillRunning){
      let end=executionEnd;
      if(!end&&result.terminationRefused&&child?.exitCode===null){
        end=await Promise.race([closed,pause(Math.max(0,Number(unverifiedChildGraceMs)||0)).then(()=>null)]);
      }else if(!end)end=await closed;
      if(end){result.exitCode=end.code;result.signal=end.signal;}
      else{result.childStillRunning=true;result.exitUnproven=true;detachUnverifiedChild(child);}
    }
    try{flushStdout();flushStderr();}catch(error){fault(error);}
    for(const fd of [out,err])if(fd!==undefined)fs.closeSync(fd);
    if(!result.done&&fs.existsSync(files.stderr)){const diagnostic=redactSensitiveText(tail(files.stderr)).trim();if(diagnostic)result.text+='\n'+diagnostic;}
    result.text=redactSensitiveText(result.text);result.endedAt=Date.now();atomicJson(files.rf,result);
  }
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)runHeadlessWorker(process.argv[2]).then(result=>{
  // A never-reading unbound child can leave libuv's stdin ShutdownWrap pending
  // after the durable reconciliation result is synchronously committed. Exit
  // this worker only; do not signal the child or discard its recovery files.
  if(result?.childStillRunning===true&&result?.exitUnproven===true)process.exit(0);
}).catch(error=>{console.error(error);process.exitCode=1;});

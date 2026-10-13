import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {atomicJson,launcherIdentity,isProcessIdentityBinding,sameProcess,processSnapshot,processSnapshotTimeoutBefore,readUtf8Bounded} from './leases.mjs';
import {workerEnvironment} from './network-policy.mjs';
import {assertNoReparsePoints} from './runtime-context.mjs';
import {controllerHeadlessBase} from './controller-state.mjs';
import {startupReceiptSpec,readStartupReceipt,acceptanceAbortSpec} from './isolated-acceptance.mjs';
import {redactSensitiveText,redactedProjection} from './redaction.mjs';
import {writeProtectedText} from './private-run-state.mjs';
export {redactSensitiveText} from './redaction.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function executionHookContextError(stage){
  const error=new Error('Execution hook context expired during '+stage);
  error.code='ORCH_EXECUTION_HOOK_ABORTED';
  error.stage=stage;
  return error;
}
function assertExecutionHookContext(context,stage){
  if(context===undefined||context===null)return;
  const deadlineAt=context?.deadlineAt;
  if(context?.signal?.aborted===true||
    (deadlineAt!==undefined&&(!Number.isSafeInteger(deadlineAt)||deadlineAt<=Date.now())))
    throw executionHookContextError(stage);
}
async function pauseExecutionHook(timeoutMs,context,stage){
  assertExecutionHookContext(context,stage);
  const deadlineAt=context?.deadlineAt;
  const delay=deadlineAt===undefined||deadlineAt===null
    ?Math.max(1,Number(timeoutMs)||1)
    :Math.max(1,Math.min(Math.max(1,Number(timeoutMs)||1),deadlineAt-Date.now()));
  const signal=context?.signal;
  if(!signal){await pause(delay);assertExecutionHookContext(context,stage);return;}
  await new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener?.('abort',onAbort);
      if(error)reject(error);else resolve();
    };
    const onAbort=()=>finish(executionHookContextError(stage));
    const timer=setTimeout(()=>finish(),delay);
    signal.addEventListener?.('abort',onAbort,{once:true});
  });
  assertExecutionHookContext(context,stage);
}
const worker=fileURLToPath(new URL('./headless-worker.mjs',import.meta.url));
const readJson=file=>JSON.parse(readUtf8Bounded(file,'headless control')||'');
const readPid=file=>{try{return Number((readUtf8Bounded(file,'headless pid',128)||'').trim())||0;}catch{return 0;}};
const DURABLE_RESULT_GRACE_MS=250;
// Prompt/output artifacts may survive a failed run for recovery. Keep normal
// task text intact while removing common credential-bearing forms before they
// reach durable controller files. Quoted replacements preserve JSON and shell
// diagnostic syntax so downstream event parsing remains reliable.
// Environment conventions prepend a provider or service name to the actual
// credential field (for example OPENAI_API_KEY and GITHUB_TOKEN).  Treat the
// final credential segment as authoritative while allowing ordinary prefixes.
const controlPath=(lp,suffix)=>{
  if(typeof lp!=='string'||!lp.endsWith('.json')||!path.basename(lp).startsWith('exec-'))throw new Error('Invalid headless control path');
  return assertNoReparsePoints(lp.slice(0,-'.json'.length)+suffix,'headless control');
};
// Cleanup callers can supply one absolute deadline shared by every close
// operation. Do not turn an expired or malformed value into a new duration:
// lack of proof must retain the attempt for later reconciliation.
function cleanupDeadlineRemaining(deadlineAt){
  if(deadlineAt===undefined||deadlineAt===null)return null;
  if(typeof deadlineAt!=='number'||!Number.isSafeInteger(deadlineAt))return 0;
  const remaining=deadlineAt-Date.now();
  return remaining>0?remaining:0;
}
function cleanupSnapshotBefore(deadlineAt){
  if(deadlineAt===undefined||deadlineAt===null)return processSnapshot();
  const timeout=processSnapshotTimeoutBefore(deadlineAt);
  return timeout===null?null:processSnapshot(timeout);
}

export function createHeadlessHooks({cli,args,workspace,timeoutMs=21600000,readinessTimeoutMs=60000,workerEntry=worker}){
  if(typeof workerEntry!=='string'||!path.isAbsolute(workerEntry))throw new Error('Invalid headless worker entry');
  try{
    assertNoReparsePoints(workerEntry,'headless worker entry');
    if(!fs.statSync(workerEntry).isFile())throw new Error();
  }catch{throw new Error('Invalid headless worker entry');}
  // The controller fixes this entry before spawn. It is never read from the
  // durable worker descriptor, so recovery cannot substitute another Node
  // script while the PID/command-line binding is being established.
  const workerIdentity=(pid,pidFile,snapshot)=>launcherIdentity(pid,pidFile,snapshot,{workerEntry});
  const configs=new Map();
  // An engine owns one acceptance lane for its entire run. Capture that lane
  // once so a mutated process environment cannot produce mixed receipt policy
  // across otherwise equivalent blocks.
  const acceptanceEnv=String(process.env.ORCH_ISOLATED_ACCEPTANCE||'')==='1'?Object.freeze({...process.env}):null;
  const configOf=pidFile=>pidFile.replace(/\.pid$/,'.json');
  const resultOf=rf=>{
    const config=readJson(rf.replace(/\.result\.json$/,'.json')),result=readJson(rf);
    if(result.runId!==config.runId||result.token!==config.token)throw new Error('Headless result identity mismatch');
    return result;
  };
  return {
    launcher(key,prompt,_suffix,{attemptFile,runId,token,blockKey=key,attemptNumber}={}){
      if(!attemptFile||!runId||!token)throw new Error('Headless execution requires a durable attempt');
      const base=controllerHeadlessBase(workspace,attemptFile,key);
      const files={mode:'headless',lp:base+'.json',pf:base+'.prompt.txt',pidf:base+'.pid',rf:base+'.result.json',stdout:base+'.stdout.jsonl',stderr:base+'.stderr.log'};
      fs.mkdirSync(path.dirname(base),{recursive:true});assertNoReparsePoints(path.dirname(base),'headless controller directory');
      // A readable prompt is recovery evidence, not an execution transport.
      // Keep its public projection here and give a sensitive original to the
      // worker only through a current-user-protected sibling.
      const promptProjection=redactedProjection(prompt),privatePrompt=promptProjection.changed;
      fs.writeFileSync(files.pf,promptProjection.value,'utf8');
      if(privatePrompt){
        files.privatePrompt=base+'.prompt.dpapi';
        writeProtectedText({workspace,file:files.privatePrompt,text:prompt});
      }
      const startupReceipt=acceptanceEnv
        ?startupReceiptSpec({workspace,runId,blockKey,attempt:attemptNumber,token,env:acceptanceEnv}):undefined;
      // This descriptor is intentionally public: it selects the controller's
      // abort lane but cannot authenticate an abort record by itself. The
      // controller verifies its HMAC separately; the raw capability stays in
      // the harness environment and is never serialized into an attempt config.
      const acceptanceAbort=acceptanceEnv
        ?acceptanceAbortSpec({workspace,runId,token:acceptanceEnv.ORCH_ISOLATED_ABORT_TOKEN,env:acceptanceEnv}):undefined;
      if(Boolean(startupReceipt)!==Boolean(acceptanceAbort))throw new Error('Isolated headless acceptance bindings are incomplete');
      // Preserve the old digest shape for ordinary persisted attempts. A
      // pending worker written by a prior plugin version must still be able to
      // start after an upgrade, while isolated attempts bind both records.
      const digestInput={cli,args,workspace,runId,token,attemptFile,timeoutMs,...(privatePrompt?{privatePrompt:true}:{}),...(startupReceipt?{startupReceipt}:{}),...(acceptanceAbort?{acceptanceAbort}:{})};
      const commandDigest=crypto.createHash('sha256').update(JSON.stringify(digestInput)).digest('hex');
      atomicJson(files.lp,{version:1,cli,args,workspace,runId,token,attemptFile,timeoutMs,...(privatePrompt?{privatePrompt:true}:{}),...(startupReceipt?{startupReceipt}:{}),...(acceptanceAbort?{acceptanceAbort}:{}),commandDigest,files,ready:base+'.go',cancel:base+'.cancel',runtime:base+'.runtime.json'});
      return files;
    },
    async spawn(lp,_title,pidf,_maxRetry,_token,context={}){
      assertExecutionHookContext(context,'headless spawn');
      if(fs.existsSync(pidf)){
        const pid=readPid(pidf),identity=workerIdentity(pid,pidf);
        if(identity){configs.set(pid,lp);return true;}
        throw new Error('Headless attempt already has a PID; reconcile before launching again');
      }
      // The worker needs the capability only to authenticate controller abort
      // records. It is not serialized into the public attempt config and its
      // own Codex child receives a freshly scrubbed environment below.
      const workerEnv=workerEnvironment();
      if(acceptanceEnv)workerEnv.ORCH_HEADLESS_ABORT_TOKEN=acceptanceEnv.ORCH_ISOLATED_ABORT_TOKEN;
      const child=spawn(process.execPath,[workerEntry,lp],{cwd:workspace,windowsHide:true,detached:true,stdio:'ignore',shell:false,env:workerEnv});
      let error;child.on('error',e=>{error=e;});child.unref();
      const contextDeadline=context?.deadlineAt;
      const deadline=Math.min(Date.now()+Math.max(10,readinessTimeoutMs),contextDeadline??Infinity);
      while(true){
        assertExecutionHookContext(context,'headless spawn');
        if(error)throw error;
        if(readPid(pidf)===child.pid){configs.set(child.pid,lp);return true;}
        if(child.exitCode!==null)throw new Error('Headless worker exited before readiness: '+child.exitCode);
        if(Date.now()>=deadline)break;
        await pauseExecutionHook(Math.min(25,Math.max(1,deadline-Date.now())),context,'headless spawn');
      }
      // Do not spawn a second worker into this attempt on a readiness timeout.
      fs.writeFileSync(controlPath(lp,'.cancel'),'cancel');throw new Error('Headless worker readiness timed out');
    },
    ready(files){fs.writeFileSync(controlPath(files.lp,'.go'),'ready');},
    async verifyStartup(files,launcher){
      if(!acceptanceEnv)return null;
      const config=readJson(files?.lp);
      const receipt=config?.startupReceipt;
      const keys=['schema','kind','file','runId','blockKey','attempt','tokenSha256','workspaceIdentity','workspaceKeySha256'];
      if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||
        JSON.stringify(Object.keys(receipt).sort())!==JSON.stringify(keys.slice().sort()))
        throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: headless startup receipt binding is missing or malformed');
      const spec=startupReceiptSpec({workspace,runId:config.runId,blockKey:receipt.blockKey,attempt:receipt.attempt,token:config.token,env:acceptanceEnv});
      for(const key of keys)if(spec[key]!==receipt[key])
        throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: headless startup receipt binding differs from the controller spec');
      return readStartupReceipt(spec,{launcher});
    },
    identity(pid,pidf){const found=workerIdentity(pid,pidf);if(found)configs.set(Number(pid),configOf(pidf));return found;},
    readPid,
    session:async(_token,_timeout,rf,_shouldAbort,context={})=>{
      assertExecutionHookContext(context,'headless session discovery');
      return rf;
    },
    async wait(_session,timeout,rf,_token,pidf,shouldAbort,context={}){
      assertExecutionHookContext(context,'headless session wait');
      const deadline=Math.min(Date.now()+timeout,context?.deadlineAt??Infinity);
      let workerExitObservedAt=0;
      while(true){
        // The runner owns the abort authority.  Check it before accepting a
        // durable result so an acceptance failure cannot be converted into a
        // late success while this worker is being closed.
        if(typeof shouldAbort==='function'&&shouldAbort())return {done:false,exitCode:null,text:'Acceptance aborted',aborted:true};
        assertExecutionHookContext(context,'headless session wait');
        if(Date.now()>=deadline)break;
        if(fs.existsSync(rf)){const result=resultOf(rf);assertExecutionHookContext(context,'headless session wait');return result;}
        const pid=readPid(pidf);
        try{if(!pid)throw new Error();process.kill(pid,0);workerExitObservedAt=0;}
        catch{
          // The worker writes its result atomically immediately before exit.
          // Windows can expose its terminated PID before the renamed result is
          // observable to this controller, so give that one durable write a
          // short bounded grace rather than discarding an authenticated abort
          // or completion outcome.
          if(!workerExitObservedAt)workerExitObservedAt=Date.now();
          if(Date.now()-workerExitObservedAt>=Math.min(DURABLE_RESULT_GRACE_MS,Math.max(0,deadline-workerExitObservedAt)))
            return {done:false,exitCode:null,text:'Headless worker exited before a durable result'};
        }
        await pauseExecutionHook(Math.min(100,Math.max(1,deadline-Date.now())),context,'headless session wait');
      }
      return {done:false,exitCode:null,text:'Headless execution timed out'};
    },
    exitCode:rf=>{try{return resultOf(rf).exitCode;}catch{return null;}},
    async waitForExit(expected,{deadlineAt}={}){
      // Existence probes are sufficient to prove this PID is gone. Repeating
      // full CIM snapshots for every closing block creates avoidable contention
      // at capacity. A still-existing/reused PID remains conservatively live.
      const bounded=deadlineAt!==undefined&&deadlineAt!==null;
      if(bounded&&cleanupDeadlineRemaining(deadlineAt)===0)return false;
      const deadline=bounded?deadlineAt:Date.now()+15000;
      while(true){
        if(bounded&&cleanupDeadlineRemaining(deadlineAt)===0)return false;
        try{process.kill(expected.ProcessId,0);}catch(error){if(error.code==='ESRCH')return true;throw error;}
        const remaining=deadline-Date.now();
        if(remaining<=0)return false;
        await pause(Math.min(100,remaining));
      }
    },
    async close(pid,expected,{deadlineAt}={}){
      const bounded=deadlineAt!==undefined&&deadlineAt!==null;
      if(bounded&&cleanupDeadlineRemaining(deadlineAt)===0)return false;
      const workerPid=Number(pid),lp=configs.get(workerPid);if(!lp)return;
      const result=controlPath(lp,'.result.json');
      if(!fs.existsSync(result)){
        if(expected){
          if(!isProcessIdentityBinding(expected))return bounded?false:undefined;
          const observed=cleanupSnapshotBefore(deadlineAt);
          if(observed===null)return false;
          if(!sameProcess(expected,observed.get(workerPid)))return;
        }
        if(bounded&&cleanupDeadlineRemaining(deadlineAt)===0)return false;
        fs.writeFileSync(controlPath(lp,'.cancel'),'cancel');
        const deadline=bounded?deadlineAt:Date.now()+10000;
        while(!fs.existsSync(result)){
          const remaining=deadline-Date.now();
          if(remaining<=0)break;
          await pause(Math.min(50,remaining));
        }
      }
      // A failed result can be durable a few milliseconds before the worker
      // has released its stdout/runtime handles.  Do not let callers remove
      // the attempt workspace while that owned process is still unwinding.
      // The wait is bounded and uses a PID existence probe, so it cannot turn
      // cleanup into an unbounded identity/CIM scan.
      if(workerPid>0){
        if(bounded)return await this.waitForExit({ProcessId:workerPid},{deadlineAt});
        await this.waitForExit({ProcessId:workerPid});
      }
    },
    // Attempts are recovery evidence. Only a completed run's owner may remove them.
    cleanup(_launcherFiles,{deadlineAt}={}){
      if(deadlineAt!==undefined&&deadlineAt!==null&&cleanupDeadlineRemaining(deadlineAt)===0)return false;
    },
    cleanupCompleted(sum,{deadlineAt}={}){
      if(sum?.success!==true||!sum.finishedAt)return [];
      const warnings=[];
      const bounded=deadlineAt!==undefined&&deadlineAt!==null;
      const exhausted=()=>bounded&&cleanupDeadlineRemaining(deadlineAt)===0;
      const deadlineWarning=()=>({code:'ORCH_DEADLINE_EXHAUSTED',stage:'headless-cleanup'});
      // This result is copied into the public run summary.  Do not include an
      // absolute artifact path or an adapter error there: callers only need to
      // know that a later best-effort sweep is required.
      const artifactWarning=()=>({code:'ORCH_ARTIFACT_CLEANUP_PENDING',stage:'headless-cleanup'});
      if(exhausted())return [deadlineWarning()];
      for(const block of sum.blocks||[]){
        const entry=sum.results?.[block.key],attempt=entry?.attempts?.at(-1),files=entry?.launcherFiles;
        if(!entry?.exitConfirmed||!attempt||files?.mode!=='headless')continue;
        const base=controllerHeadlessBase(workspace,attempt.file,block.key);
        if(files.lp!==base+'.json')continue;
        for(const suffix of ['.json','.prompt.txt','.prompt.dpapi','.pid','.result.json','.stdout.jsonl','.stderr.log','.go','.cancel','.runtime.json']){
          if(exhausted()){warnings.push(deadlineWarning());return warnings;}
          try{fs.rmSync(base+suffix,{force:true});}
          catch{warnings.push(artifactWarning());}
        }
        if(exhausted()){warnings.push(deadlineWarning());return warnings;}
        try{fs.rmdirSync(path.dirname(base));}catch(error){if(error.code!=='ENOTEMPTY'&&error.code!=='ENOENT')warnings.push(artifactWarning());}
      }
      return warnings;
    },
  };
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {atomicJson,launcherIdentity,sameProcess,processSnapshot,controllerEnvironment,readUtf8Bounded} from './leases.mjs';
import {assertNoReparsePoints} from './runtime-context.mjs';
import {controllerHeadlessBase} from './controller-state.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const worker=fileURLToPath(new URL('./headless-worker.mjs',import.meta.url));
const readJson=file=>JSON.parse(readUtf8Bounded(file,'headless control')||'');
const readPid=file=>{try{return Number((readUtf8Bounded(file,'headless pid',128)||'').trim())||0;}catch{return 0;}};
// Prompt/output artifacts may survive a failed run for recovery. Keep normal
// task text intact while removing common credential-bearing forms before they
// reach durable controller files.
export function redactSensitiveText(value) {
  return String(value??'').slice(0,8*1024*1024)
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)\s*([:=])\s*[^\s,;]+/gi,'$1$2[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [REDACTED]');
}
const controlPath=(lp,suffix)=>{
  if(typeof lp!=='string'||!lp.endsWith('.json')||!path.basename(lp).startsWith('exec-'))throw new Error('Invalid headless control path');
  return assertNoReparsePoints(lp.slice(0,-'.json'.length)+suffix,'headless control');
};

export function createHeadlessHooks({cli,args,workspace,timeoutMs=21600000,readinessTimeoutMs=60000}){
  const configs=new Map();
  const configOf=pidFile=>pidFile.replace(/\.pid$/,'.json');
  const resultOf=rf=>{
    const config=readJson(rf.replace(/\.result\.json$/,'.json')),result=readJson(rf);
    if(result.runId!==config.runId||result.token!==config.token)throw new Error('Headless result identity mismatch');
    return result;
  };
  return {
    launcher(key,prompt,_suffix,{attemptFile,runId,token}={}){
      if(!attemptFile||!runId||!token)throw new Error('Headless execution requires a durable attempt');
      const base=controllerHeadlessBase(workspace,attemptFile,key);
      const files={mode:'headless',lp:base+'.json',pf:base+'.prompt.txt',pidf:base+'.pid',rf:base+'.result.json',stdout:base+'.stdout.jsonl',stderr:base+'.stderr.log'};
      fs.mkdirSync(path.dirname(base),{recursive:true});assertNoReparsePoints(path.dirname(base),'headless controller directory');
      // The prompt carries the controller-issued checkpoint path and must keep
      // that path intact. Redact credential forms before persisting the prompt.
      fs.writeFileSync(files.pf,redactSensitiveText(prompt),'utf8');
      const commandDigest=crypto.createHash('sha256').update(JSON.stringify({cli,args,workspace,runId,token,attemptFile,timeoutMs})).digest('hex');
      atomicJson(files.lp,{version:1,cli,args,workspace,runId,token,attemptFile,timeoutMs,commandDigest,files,ready:base+'.go',cancel:base+'.cancel',runtime:base+'.runtime.json'});
      return files;
    },
    async spawn(lp,_title,pidf){
      if(fs.existsSync(pidf)){
        const pid=readPid(pidf),identity=launcherIdentity(pid,pidf);
        if(identity){configs.set(pid,lp);return true;}
        throw new Error('Headless attempt already has a PID; reconcile before launching again');
      }
      const child=spawn(process.execPath,[worker,lp],{cwd:workspace,windowsHide:true,detached:true,stdio:'ignore',shell:false,env:controllerEnvironment()});
      let error;child.on('error',e=>{error=e;});child.unref();
      const deadline=Date.now()+Math.max(10,readinessTimeoutMs);
      while(true){
        if(error)throw error;
        if(readPid(pidf)===child.pid){configs.set(child.pid,lp);return true;}
        if(child.exitCode!==null)throw new Error('Headless worker exited before readiness: '+child.exitCode);
        if(Date.now()>=deadline)break;
        await pause(25);
      }
      // Do not spawn a second worker into this attempt on a readiness timeout.
      fs.writeFileSync(controlPath(lp,'.cancel'),'cancel');throw new Error('Headless worker readiness timed out');
    },
    ready(files){fs.writeFileSync(controlPath(files.lp,'.go'),'ready');},
    identity(pid,pidf){const found=launcherIdentity(pid,pidf);if(found)configs.set(Number(pid),configOf(pidf));return found;},
    readPid,
    session:async(_token,_timeout,rf)=>rf,
    async wait(_session,timeout,rf,_token,pidf){
      const deadline=Date.now()+timeout;
      while(Date.now()<deadline){
        if(fs.existsSync(rf))return resultOf(rf);
        const pid=readPid(pidf);
        try{if(!pid)throw new Error();process.kill(pid,0);}catch{return {done:false,exitCode:null,text:'Headless worker exited before a durable result'};}
        await pause(Math.min(100,Math.max(1,deadline-Date.now())));
      }
      return {done:false,exitCode:null,text:'Headless execution timed out'};
    },
    exitCode:rf=>{try{return resultOf(rf).exitCode;}catch{return null;}},
    async waitForExit(expected){
      // Existence probes are sufficient to prove this PID is gone. Repeating
      // full CIM snapshots for every closing block creates avoidable contention
      // at capacity. A still-existing/reused PID remains conservatively live.
      const deadline=Date.now()+15000;
      while(true){
        try{process.kill(expected.ProcessId,0);}catch(error){if(error.code==='ESRCH')return true;throw error;}
        if(Date.now()>=deadline)return false;
        await pause(100);
      }
    },
    async close(pid,expected){
      const workerPid=Number(pid),lp=configs.get(workerPid);if(!lp)return;
      const result=controlPath(lp,'.result.json');
      if(!fs.existsSync(result)){
        if(expected&&!sameProcess(expected,processSnapshot().get(workerPid)))return;
        fs.writeFileSync(controlPath(lp,'.cancel'),'cancel');
        const deadline=Date.now()+10000;
        while(!fs.existsSync(result)&&Date.now()<deadline)await pause(50);
      }
      // A failed result can be durable a few milliseconds before the worker
      // has released its stdout/runtime handles.  Do not let callers remove
      // the attempt workspace while that owned process is still unwinding.
      // The wait is bounded and uses a PID existence probe, so it cannot turn
      // cleanup into an unbounded identity/CIM scan.
      if(workerPid>0)await this.waitForExit({ProcessId:workerPid});
    },
    // Attempts are recovery evidence. Only a completed run's owner may remove them.
    cleanup() {},
    cleanupCompleted(sum){
      if(sum?.success!==true||!sum.finishedAt)return [];
      const warnings=[];
      for(const block of sum.blocks||[]){
        const entry=sum.results?.[block.key],attempt=entry?.attempts?.at(-1),files=entry?.launcherFiles;
        if(!entry?.exitConfirmed||!attempt||files?.mode!=='headless')continue;
        const base=controllerHeadlessBase(workspace,attempt.file,block.key);
        if(files.lp!==base+'.json')continue;
        for(const suffix of ['.json','.prompt.txt','.pid','.result.json','.stdout.jsonl','.stderr.log','.go','.cancel','.runtime.json']){
          try{fs.rmSync(base+suffix,{force:true});}
          catch(error){warnings.push({file:base+suffix,code:error.code||'UNKNOWN'});}
        }
        try{fs.rmdirSync(path.dirname(base));}catch(error){if(error.code!=='ENOTEMPTY'&&error.code!=='ENOENT')warnings.push({file:path.dirname(base),code:error.code||'UNKNOWN'});}
      }
      return warnings;
    },
  };
}

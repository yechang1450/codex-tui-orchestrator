import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {atomicJson,launcherIdentity,sameProcess,processSnapshot} from './leases.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const worker=fileURLToPath(new URL('./headless-worker.mjs',import.meta.url));
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const readPid=file=>{try{return Number(fs.readFileSync(file,'utf8').trim())||0;}catch{return 0;}};

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
      const base=path.join(path.dirname(attemptFile),'exec-'+key.replace(/[^A-Za-z0-9_-]/g,'_'));
      const files={mode:'headless',lp:base+'.json',pf:base+'.prompt.txt',pidf:base+'.pid',rf:base+'.result.json',stdout:base+'.stdout.jsonl',stderr:base+'.stderr.log'};
      fs.mkdirSync(path.dirname(base),{recursive:true});fs.writeFileSync(files.pf,prompt,'utf8');
      atomicJson(files.lp,{version:1,cli,args,workspace,runId,token,timeoutMs,files,ready:base+'.go',cancel:base+'.cancel',runtime:base+'.runtime.json'});
      return files;
    },
    async spawn(lp,_title,pidf){
      if(fs.existsSync(pidf)){
        const pid=readPid(pidf),identity=launcherIdentity(pid,pidf);
        if(identity){configs.set(pid,lp);return true;}
        throw new Error('Headless attempt already has a PID; reconcile before launching again');
      }
      const child=spawn(process.execPath,[worker,lp],{cwd:workspace,windowsHide:true,detached:true,stdio:'ignore',shell:false});
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
      fs.writeFileSync(readJson(lp).cancel,'cancel');throw new Error('Headless worker readiness timed out');
    },
    ready(files){const config=readJson(files.lp);fs.writeFileSync(config.ready,'ready');},
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
      const lp=configs.get(Number(pid));if(!lp)return;
      const config=readJson(lp);
      if(fs.existsSync(config.files.rf))return;
      if(expected&&!sameProcess(expected,processSnapshot().get(Number(pid))))return;
      fs.writeFileSync(config.cancel,'cancel');
      const deadline=Date.now()+10000;
      while(!fs.existsSync(config.files.rf)&&Date.now()<deadline)await pause(50);
    },
    // Attempts are recovery evidence. Only a completed run's owner may remove them.
    cleanup() {},
  };
}

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {atomicJson,processSnapshot,sameProcess} from './leases.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function tail(file){
  const fd=fs.openSync(file,'r');
  try{const length=fs.fstatSync(fd).size,buffer=Buffer.alloc(Math.min(length,16384));fs.readSync(fd,buffer,0,buffer.length,Math.max(0,length-buffer.length));return buffer.toString('utf8');}
  finally{fs.closeSync(fd);}
}

export async function runHeadlessWorker(configFile){
  const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
  if(config.version!==1||!Array.isArray(config.args)||!config.runId||!config.token||!config.files||!Number.isFinite(config.timeoutMs)||config.timeoutMs<=0)throw new Error('Invalid headless attempt configuration');
  const {files}=config,deadline=Date.now()+config.timeoutMs;
  const runtime={runId:config.runId,token:config.token,pid:process.pid,threadId:null,startedAt:Date.now()};
  const result={...runtime,done:false,exitCode:null,text:''};
  fs.writeFileSync(files.pidf,String(process.pid),{flag:'wx'});
  atomicJson(config.runtime,runtime);
  while(!fs.existsSync(config.ready)){
    if(fs.existsSync(config.cancel)||Date.now()>=deadline){result.text='Cancelled before execution';result.endedAt=Date.now();atomicJson(files.rf,result);return result;}
    await pause(25);
  }
  let out,err,child,closed,identity,buffer='',completed=false,failed=false,cancelled=false,lastMessage='',stopping=false,timer;
  const eventLine=line=>{
    if(!line.trim())return;
    let event;try{event=JSON.parse(line);}catch{failed=true;result.text='Invalid exec JSONL output';return;}
    const payload=event?.payload&&typeof event.payload==='object'?event.payload:event;
    const type=payload?.type||event?.type;
    if(type==='thread.started')runtime.threadId=payload.thread_id||payload.threadId||null;
    if(type==='turn.completed'||type==='task_complete')completed=true;
    if(type==='turn.failed'||type==='error'){failed=true;result.text=payload.message||payload.error?.message||JSON.stringify(payload);}
    if(type==='item.completed'&&payload.item?.type==='agent_message')lastMessage=payload.item.text||'';
    runtime.updatedAt=Date.now();runtime.event=type;atomicJson(config.runtime,runtime);
  };
  const stop=()=>{
    if(stopping||!child||child.exitCode!==null)return;
    stopping=true;cancelled=true;
    if(process.platform==='win32'){
      // The worker owns this exec tree, never a Windows Terminal host. Recheck
      // the captured identity before invoking tree termination.
      try{
        if(identity&&sameProcess(identity,processSnapshot().get(child.pid))){
          const killed=spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',shell:false});
          if(killed.status!==0)child.kill();
        }else child.kill();
      }catch{child.kill();}
    }else child.kill('SIGTERM');
  };
  const fault=error=>{failed=true;result.text=error.message;stop();};
  try{
    out=fs.openSync(files.stdout,'a');err=fs.openSync(files.stderr,'a');
    child=spawn(config.cli,[...config.args,'-'],{cwd:config.workspace,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],
      env:{...process.env,ORCH_EXECUTION:'1',ORCH_EXECUTION_MODE:'headless',ORCH_WINDOW:'1'}});
    closed=new Promise(resolve=>{child.once('error',fault);child.once('close',(code,signal)=>resolve({code,signal}));});
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{try{fs.writeSync(out,chunk);buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){eventLine(buffer.slice(0,n));buffer=buffer.slice(n+1);}}catch(error){fault(error);}});
    child.stderr.on('data',chunk=>{try{fs.writeSync(err,chunk);}catch(error){fault(error);}});
    child.stdout.on('error',fault);child.stderr.on('error',fault);
    child.stdin.on('error',error=>{if(error.code!=='EPIPE')fault(error);});
    child.stdin.end(fs.readFileSync(files.pf,'utf8'));
    if(process.platform==='win32'&&child.pid)identity=processSnapshot().get(child.pid);
    runtime.childPid=child.pid;runtime.childIdentity=identity;atomicJson(config.runtime,runtime);
    timer=setInterval(()=>{try{if(fs.existsSync(config.cancel)||Date.now()>=deadline)stop();}catch(error){fault(error);}},100);
    const {code,signal}=await closed;if(buffer.trim())eventLine(buffer);
    result.exitCode=code;result.signal=signal;result.threadId=runtime.threadId;
    result.done=code===0&&completed&&!failed&&!cancelled;
    if(!result.text)result.text=cancelled?'Headless execution cancelled':lastMessage||(!completed?'Exec stream ended before turn.completed':'');
  }catch(error){fault(error);result.done=false;}
  finally{
    clearInterval(timer);
    // A failed journal write must not leave the owned CLI alive or let its
    // remaining output write into descriptors already closed by this worker.
    if(closed){const end=await closed;result.exitCode=end.code;result.signal=end.signal;}
    for(const fd of [out,err])if(fd!==undefined)fs.closeSync(fd);
    if(!result.done&&fs.existsSync(files.stderr)){const diagnostic=tail(files.stderr).trim();if(diagnostic)result.text+='\n'+diagnostic;}
    result.endedAt=Date.now();atomicJson(files.rf,result);
  }
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)runHeadlessWorker(process.argv[2]).catch(error=>{console.error(error);process.exitCode=1;});

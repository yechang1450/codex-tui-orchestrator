#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {atomicJson,processSnapshot,sameProcess} from './leases.mjs';
import {isCapacityError,isProviderQuotaError} from './retry-policy.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const MAX_STREAM_BYTES=64*1024*1024;
const MAX_EVENT_LINE_BYTES=4*1024*1024;
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
  let stdoutBytes=0,stderrBytes=0;
  const eventLine=line=>{
    if(!line.trim())return;
    let event;try{event=JSON.parse(line);}catch{failed=true;result.text='Invalid exec JSONL output';return;}
    const payload=event?.payload&&typeof event.payload==='object'?event.payload:event;
    const type=payload?.type||event?.type;
    if(type==='thread.started')runtime.threadId=payload.thread_id||payload.threadId||null;
    if(type==='turn.completed'||type==='task_complete')completed=true;
    if(type==='turn.failed'||type==='error'){
      // `error` also reports recoverable reconnect notifications. A terminal
      // turn.failed, corrupt stream, nonzero exit or cancellation remains fatal.
      if(type==='turn.failed')failed=true;
      result.text=payload.message||payload.error?.message||JSON.stringify(payload);
      if(isProviderQuotaError(payload)){result.retryable='quota';result.quotaError=JSON.stringify(payload);}
      else if(isCapacityError(payload)){result.retryable='capacity';result.capacityError=result.text;}
    }
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
        // A PID is not an ownership proof. If the process identity cannot be
        // revalidated, refuse termination instead of racing PID reuse and
        // killing an unrelated same-user process. The durable result records
        // the refusal and the controller can reconcile the attempt.
        const current=processSnapshot().get(child.pid);
        if(!identity||!sameProcess(identity,current)){
          result.text=result.text||'Refused to terminate headless child because its process identity could not be revalidated';
          result.terminationRefused=true;
          return;
        }
        const killed=spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',shell:false});
        if(killed.status!==0){
          result.text=result.text||'Refused to terminate headless child because taskkill did not confirm ownership';
          result.terminationRefused=true;
        }
      }catch{
        result.text=result.text||'Refused to terminate headless child because process identity inspection failed';
        result.terminationRefused=true;
      }
    }else child.kill('SIGTERM');
  };
  const fault=error=>{failed=true;result.text=error.message;stop();};
  try{
    out=fs.openSync(files.stdout,'a');err=fs.openSync(files.stderr,'a');
    child=spawn(config.cli,[...config.args,'-'],{cwd:config.workspace,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],
      env:{...process.env,ORCH_EXECUTION:'1',ORCH_EXECUTION_MODE:'headless',ORCH_WINDOW:'1'}});
    closed=new Promise(resolve=>{child.once('error',fault);child.once('close',(code,signal)=>resolve({code,signal}));});
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{try{
      const text=String(chunk),bytes=Buffer.byteLength(text,'utf8');
      if(stdoutBytes+bytes>MAX_STREAM_BYTES)throw new Error('Headless stdout exceeded the 64 MiB safety limit');
      stdoutBytes+=bytes;fs.writeSync(out,text);buffer+=text;
      let n;while((n=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,n);
        if(Buffer.byteLength(line,'utf8')>MAX_EVENT_LINE_BYTES)throw new Error('Headless JSONL event exceeded the 4 MiB safety limit');
        eventLine(line);buffer=buffer.slice(n+1);
      }
      if(Buffer.byteLength(buffer,'utf8')>MAX_EVENT_LINE_BYTES)throw new Error('Headless JSONL event exceeded the 4 MiB safety limit');
    }catch(error){fault(error);}});
    child.stderr.on('data',chunk=>{try{
      const text=String(chunk),bytes=Buffer.byteLength(text,'utf8');
      if(stderrBytes+bytes>MAX_STREAM_BYTES)throw new Error('Headless stderr exceeded the 64 MiB safety limit');
      stderrBytes+=bytes;fs.writeSync(err,text);
    }catch(error){fault(error);}});
    child.stdout.on('error',fault);child.stderr.on('error',fault);
    child.stdin.on('error',error=>{if(error.code!=='EPIPE')fault(error);});
    child.stdin.end(fs.readFileSync(files.pf,'utf8'));
    if(process.platform==='win32'&&child.pid)identity=processSnapshot().get(child.pid);
    runtime.childPid=child.pid;runtime.childIdentity=identity;atomicJson(config.runtime,runtime);
    timer=setInterval(()=>{try{if(fs.existsSync(config.cancel)||Date.now()>=deadline)stop();}catch(error){fault(error);}},100);
    const {code,signal}=await closed;if(!failed&&buffer.trim())eventLine(buffer);
    result.exitCode=code;result.signal=signal;result.threadId=runtime.threadId;
    result.done=code===0&&completed&&!failed&&!cancelled;
    if(result.done){result.text=lastMessage;delete result.retryable;delete result.capacityError;}
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

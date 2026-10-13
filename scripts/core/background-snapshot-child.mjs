import {spawn as nodeSpawn} from 'node:child_process';

// The background sampler is advisory, but its child must never pin a run's
// in-flight sampler promise forever. Keep this short grace separate from the
// useful observation timeout: it exists only to bound a child that did not
// deliver its close event after the controller has already terminated it.
export const BACKGROUND_TERMINATION_GRACE_MS=1_000;

function terminalError(reason) {
  if(reason==='timeout')return new Error('Background process snapshot timed out');
  if(reason==='oversize')return new Error('Background process snapshot exceeded bounded output');
  return new Error('Background process snapshot output failed');
}

// This is an internal process adapter. `runtime` is only a deterministic
// core-test seam; the public background snapshot API remains in leases.mjs
// and always supplies the trusted PowerShell command and real Node runtime.
export function runBackgroundSnapshotHelper({
  command,args,spawnOptions,signal,maxOutputBytes,timeoutMs,
  runtime={},
}={}) {
  if(signal?.aborted)return Promise.resolve(null);
  const spawnImpl=runtime.spawnImpl??nodeSpawn;
  const setTimeoutImpl=runtime.setTimeoutImpl??setTimeout;
  const clearTimeoutImpl=runtime.clearTimeoutImpl??clearTimeout;
  const terminationGraceMs=runtime.terminationGraceMs??BACKGROUND_TERMINATION_GRACE_MS;
  return new Promise((resolve,reject)=>{
    let child,settled=false,stdout='',stdoutBytes=0,termination=null,watchdog=null,terminationGrace=null,onAbort=null;
    const finish=(callback,value)=>{
      if(settled)return;
      settled=true;
      if(watchdog!==null)clearTimeoutImpl(watchdog);
      if(terminationGrace!==null)clearTimeoutImpl(terminationGrace);
      if(signal&&onAbort)signal.removeEventListener('abort',onAbort);
      callback(value);
    };
    const settleTermination=()=>{
      if(!termination)return;
      if(termination==='aborted')finish(resolve,null);
      else finish(reject,terminalError(termination));
    };
    const terminate=reason=>{
      if(settled||termination)return;
      termination=reason;
      // Start the bounded settlement guard before signaling: a close emitted
      // synchronously by a test/runtime still clears it through finish().
      terminationGrace=setTimeoutImpl(settleTermination,terminationGraceMs);
      // Never locate a PID or kill a task tree. This is solely the exact
      // ChildProcess handle that this helper started.
      try{child?.kill();}catch{}
      try{child?.stdout?.destroy();}catch{}
      try{child?.unref();}catch{}
    };
    try{
      child=spawnImpl(command,args,spawnOptions);
    }catch{
      finish(reject,new Error('Background process snapshot helper could not start'));
      return;
    }
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on?.('data',chunk=>{
      if(termination)return;
      stdoutBytes+=Buffer.byteLength(chunk,'utf8');
      if(stdoutBytes>maxOutputBytes){terminate('oversize');return;}
      stdout+=chunk;
    });
    child.stdout?.once?.('error',()=>terminate('output'));
    child.once?.('error',()=>{
      if(termination){settleTermination();return;}
      finish(reject,new Error('Background process snapshot helper could not start'));
    });
    child.once?.('close',status=>{
      if(termination){settleTermination();return;}
      finish(resolve,{status,stdout});
    });
    watchdog=setTimeoutImpl(()=>terminate('timeout'),timeoutMs);
    if(signal){
      onAbort=()=>terminate('aborted');
      signal.addEventListener('abort',onAbort,{once:true});
      if(signal.aborted)onAbort();
    }
  });
}

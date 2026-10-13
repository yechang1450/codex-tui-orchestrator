// Dynamic-memory accounting is advisory telemetry.  It must never create one
// full process observation per visible window or let a late sample mutate a
// block that has already completed its own final accounting.
export function treeWorkingSetMB(snapshot,rootPid) {
  const root=Number(rootPid);
  if(!root||!snapshot?.get?.(root))return 0;
  const children=new Map();
  for(const proc of snapshot.values()){
    const parent=Number(proc.ParentProcessId)||0;
    if(!children.has(parent))children.set(parent,[]);
    children.get(parent).push(proc);
  }
  let total=0;
  const seen=new Set(),queue=[root];
  while(queue.length){
    const pid=queue.shift();
    if(seen.has(pid))continue;
    seen.add(pid);
    const proc=snapshot.get(pid);
    if(proc)total+=Number(proc.WorkingSet64)||0;
    for(const child of children.get(pid)||[])queue.push(Number(child.ProcessId));
  }
  return Math.round(total/1024**2);
}

export function createRunMemorySampler({
  sampleProcessSnapshot,
  availableMemoryMB,
  setIntervalFn=setInterval,
  clearIntervalFn=clearInterval,
  intervalMs=5_000,
}={}) {
  if(typeof sampleProcessSnapshot!=='function')throw new TypeError('sampleProcessSnapshot must be a function');
  if(typeof availableMemoryMB!=='function')throw new TypeError('availableMemoryMB must be a function');
  if(typeof setIntervalFn!=='function'||typeof clearIntervalFn!=='function')throw new TypeError('memory sampler timers must be functions');
  if(!Number.isSafeInteger(intervalMs)||intervalMs<1)throw new RangeError('memory sampler interval must be a positive integer');
  const active=new Map();
  let timer=null,inFlight=null,disposed=false;
  const stopTimerIfIdle=()=>{
    if(active.size||timer===null)return;
    clearIntervalFn(timer);
    timer=null;
  };
  const sample=()=>{
    if(disposed||!active.size)return Promise.resolve(false);
    if(inFlight)return inFlight;
    // Bind this observation to the exact active record instances present when
    // it begins. A retry deliberately reuses its block key, so consulting the
    // map only after an awaited snapshot could otherwise write an old sample
    // into a new attempt.
    const targets=Array.from(active.entries());
    // Install the returned promise before calling the hook. A supplied hook is
    // allowed to throw synchronously, while callers still rely on sample()
    // beginning the observation immediately.
    let settle;
    const work=new Promise(resolve=>{settle=resolve;});
    inFlight=work;
    void (async()=>{
      try{
        const snapshot=await sampleProcessSnapshot();
        if(disposed||!snapshot?.get||!snapshot?.values){settle(false);return;}
        const available=availableMemoryMB();
        if(!Number.isFinite(available)){settle(false);return;}
        for(const [key,record] of targets){
          if(!record.active||active.get(key)!==record)continue;
          record.stats.peakProcessMB=Math.max(record.stats.peakProcessMB,treeWorkingSetMB(snapshot,record.identity.ProcessId));
          record.stats.minAvailable=Math.min(record.stats.minAvailable,available);
        }
        settle(true);
      }catch{settle(false);}
      finally{if(inFlight===work)inFlight=null;}
    })();
    return work;
  };
  const start=(key,identity)=>{
    if(disposed)throw new Error('memory sampler is disposed');
    if(typeof key!=='string'||!key)throw new TypeError('memory sampler key must be a non-empty string');
    if(!Number.isSafeInteger(Number(identity?.ProcessId))||Number(identity.ProcessId)<=0)throw new TypeError('memory sampler identity must include a positive ProcessId');
    if(active.has(key))throw new Error('memory sampler already tracks '+key);
    const stats={startAvailable:availableMemoryMB(),peakProcessMB:0,minAvailable:Infinity};
    const record={identity,stats,active:true};
    active.set(key,record);
    if(timer===null)timer=setIntervalFn(()=>{void sample();},intervalMs);
    return stats;
  };
  const stop=key=>{
    const record=active.get(key);
    if(!record)return null;
    record.active=false;
    active.delete(key);
    stopTimerIfIdle();
    return record.stats;
  };
  const dispose=()=>{
    if(disposed)return;
    disposed=true;
    for(const record of active.values())record.active=false;
    active.clear();
    stopTimerIfIdle();
  };
  return {start,stop,sample,dispose};
}

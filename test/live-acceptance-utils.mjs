export function capacityRequest({ids,root,workspace,nonce}) {
  return ids.map(id=>`项目${id}：执行 node "${root.replaceAll('\\','/')}/project-${id}/probe${id}.mjs" 创建 result${id}.json，执行工具的工作目录必须为 "${workspace}"，等待命令完成后读回结果，核验 id="${id}"、cwd="${workspace}"、sum=50005000、nonce="${nonce}"，pid/started/finished 为运行证据。本次回执没有 answer 字段，严格按本次 schema 核验。按主持提供的命令逐项记录 started 和 completed 检查点，禁止另开窗口、提交、读写记忆`).join('；');
}

export function validateCapacitySample(summary,expected,observed=0) {
  if(!Number.isInteger(expected)||expected<2)throw new Error('Capacity acceptance requires at least two windows');
  // These fixtures are independent. Memory may queue them, never merge them.
  if(summary&&(summary.capacity!==expected||summary.blocks?.length!==expected||
      new Set(summary.blocks.map(b=>b.key)).size!==expected||
      summary.blocks.some(b=>b.taskIds?.length!==1)||
      new Set(summary.blocks.flatMap(b=>b.taskIds)).size!==expected||
      summary.blocks.flatMap(b=>b.taskIds).some(id=>!/^T\d{3,}$/.test(id)||Number(id.slice(1))<1||Number(id.slice(1))>expected)))
    throw new Error(`Independent block inventory changed: tasks=${expected}, runner=${summary.capacity}`);
  if(observed>expected)throw new Error(`Capacity exceeded: observed=${observed}, limit=${expected}`);
}

export function liveConcurrencyOptions(env=process.env) {
  const taskCount=Number(env.ORCH_LIVE_TASKS||2);
  const minimumConcurrency=Number(env.ORCH_LIVE_MIN_CONCURRENCY||taskCount);
  if(!Number.isSafeInteger(taskCount)||taskCount<2)throw new Error('ORCH_LIVE_TASKS must be an integer >= 2');
  if(!Number.isSafeInteger(minimumConcurrency)||minimumConcurrency<2||minimumConcurrency>taskCount)
    throw new Error('ORCH_LIVE_MIN_CONCURRENCY must be an integer from 2 to ORCH_LIVE_TASKS');
  return {taskCount,minimumConcurrency};
}

export function capacityBarrierDecision({summary,readyTaskIds,liveBlockKeys,minimumConcurrency}) {
  const ready=new Set(readyTaskIds),live=new Set(liveBlockKeys);
  const active=(summary?.blocks||[]).filter(b=>live.has(b.key));
  const readyActive=active.filter(b=>b.taskIds.some(id=>ready.has(id))).length;
  if(readyActive>=minimumConcurrency)return {release:true,reason:'concurrency-proven',concurrencyProven:true};
  // A deferred block cannot start until an admitted worker exits. Release the
  // admitted probes, but keep the requested concurrency proof unsatisfied.
  const queued=Object.values(summary?.results||{}).some(r=>r.status==='deferred');
  const admitted=(summary?.blocks||[]).filter(b=>['launching','running'].includes(summary.results?.[b.key]?.status));
  if(queued&&admitted.length>0&&admitted.every(b=>live.has(b.key)&&b.taskIds.some(id=>ready.has(id))))
    return {release:true,reason:'memory-queue',concurrencyProven:false};
  return {release:false,reason:'waiting-for-probes',concurrencyProven:false};
}

// Decode native Windows argument quoting; never search the prompt for flags.
export function settingsFromCommandLine(commandLine) {
  const args=[];let value='',quoted=false,started=false;
  const line=String(commandLine||'');
  for(let i=0;i<line.length;i++){
    if(line[i]==='\\'){
      let end=i;while(line[end]==='\\')end++;
      const count=end-i;
      if(line[end]==='"'){
        value+='\\'.repeat(Math.floor(count/2));
        if(count%2)value+='"';else quoted=!quoted;
        i=end;started=true;continue;
      }
      value+='\\'.repeat(count);i=end-1;started=true;continue;
    }
    if(line[i]==='"'){quoted=!quoted;started=true;continue;}
    if(/\s/.test(line[i])&&!quoted){if(started){args.push(value);value='';started=false;}continue;}
    value+=line[i];started=true;
  }
  if(started)args.push(value);
  const settings={};
  for(let i=1;i<args.length;i++){
    const arg=args[i];if(arg==='--')break;
    if(arg==='-m'||arg==='--model'){settings.model=args[++i];continue;}
    if(arg.startsWith('--model=')){settings.model=arg.slice(8);continue;}
    if(arg==='-c'||arg==='--config'){
      const pair=args[++i]||'',at=pair.indexOf('='),key=pair.slice(0,at);
      let setting=pair.slice(at+1);try{setting=JSON.parse(setting);}catch{}
      if(key==='model_reasoning_effort')settings.effort=setting;
      if(key==='service_tier')settings.serviceTier=setting;
    }
  }
  return settings;
}

export function settingsMatch(expected,actual) {
  return !!expected?.model&&!!expected?.effort&&
    ['model','effort','serviceTier'].every(key=>(expected[key]??null)===(actual?.[key]??null));
}

export function receiptConcurrencyPeak(results) {
  const events=[];
  for(const receipt of results){
    if(!Number.isFinite(receipt.started)||!Number.isFinite(receipt.finished)||receipt.finished<=receipt.started)return 0;
    events.push([receipt.started,1],[receipt.finished,-1]);
  }
  events.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  let active=0,peak=0;for(const [,delta] of events){active+=delta;peak=Math.max(peak,active);}return peak;
}

export function observedTerminal(mode,output) {
  if(mode==='headless')return null;
  const wt=/spawned visible .* TUI \(Windows Terminal\)/.test(output);
  const conhost=/spawned visible .* TUI \(inactive console\)/.test(output);
  return wt&&conhost?'mixed':wt?'wt':conhost?'conhost':null;
}

export function capacityAcceptancePassed(r) {
  const blocks=r.taskCount,minimum=r.minimumConcurrency;
  try{validateCapacitySample(r.summary,blocks,r.peak);}catch{return false;}
  return Number.isInteger(minimum)&&minimum>=2&&minimum<=blocks&&!r.monitorError&&r.coreUnchanged===true&&r.closed===true&&r.settingsInherited===true&&r.engineResult.code===0&&r.pollResult.code===0
    &&r.runnerCapacity===blocks&&r.peak>=minimum&&r.receiptPeak>=minimum&&r.receiptsValid===true&&r.ordered===true&&r.overlap===true
    &&r.windowLaunches===blocks&&r.uniqueLaunchers===blocks
    &&(r.executionMode==='headless'||['wt','conhost'].includes(r.terminal))
    &&r.summary?.success===true&&Object.keys(r.summary.results).length===blocks
    &&Object.values(r.summary.results).every(result=>result.status==='verified'&&result.attempts?.length===1);
}

// The overflow ordering check only applies when the fixture intentionally
// creates one task beyond the observed block count. A small two-task probe can
// legitimately have exactly as many receipts as blocks.
export function orderedCapacityReceipts(results, expectedLive, blocks) {
  if (!Array.isArray(results) || !Number.isInteger(expectedLive) || expectedLive < 1) return false;
  if (results.length < expectedLive) return false;
  if(blocks){
    const assigned=new Set();
    for(const block of blocks){
      let previous;
      for(const id of block.taskIds||[]){
        const index=Number(String(id).replace(/^T/,''))-1,receipt=results[index];
        if(assigned.has(index)||!Number.isFinite(receipt?.started)||!Number.isFinite(receipt?.finished)||receipt.finished<receipt.started)return false;
        if(previous&&receipt.started<previous.finished)return false;
        assigned.add(index);previous=receipt;
      }
    }
    return assigned.size===results.length;
  }
  if (results.length === expectedLive) return true;
  const lastConcurrent = results[expectedLive - 1];
  const overflow = results[expectedLive];
  return Number.isFinite(lastConcurrent?.finished) && Number.isFinite(overflow?.started)
    && overflow.started >= lastConcurrent.finished;
}

export function liveTimeout(env=process.env){
  const value=Number(env.ORCH_LIVE_TIMEOUT_MS||600000);
  if(!Number.isSafeInteger(value)||value<1000||value>21600000)throw new Error('Invalid ORCH_LIVE_TIMEOUT_MS: expected 1000..21600000');
  return value;
}

export async function boundedChildResult(item,timeoutMs) {
  let timer;
  try {
    return await Promise.race([item.done,new Promise(resolve=>{timer=setTimeout(()=>{
      item.child.kill();resolve({code:-1,error:'Acceptance child did not exit before its deadline'});
    },timeoutMs);})]);
  } finally {clearTimeout(timer);}
}

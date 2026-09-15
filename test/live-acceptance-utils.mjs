export function capacityRequest({ids,root,workspace,nonce}) {
  return ids.map(id=>`项目${id}：执行 node "${root.replaceAll('\\','/')}/project-${id}/probe${id}.mjs" 创建 result${id}.json，执行工具的工作目录必须为 "${workspace}"，等待命令完成后读回结果，核验 id="${id}"、cwd="${workspace}"、sum=50005000、nonce="${nonce}"，pid/started/finished 为运行证据。本次回执没有 answer 字段，严格按本次 schema 核验。按主持提供的命令逐项记录 started 和 completed 检查点，禁止另开窗口、提交、读写记忆`).join('；');
}

export function validateCapacitySample(summary,expected,observed=0) {
  if(!Number.isInteger(expected)||expected<2)throw new Error('Capacity acceptance requires at least two windows');
  if(summary&&summary.capacity!==expected)throw new Error(`Capacity snapshot changed: harness=${expected}, runner=${summary.capacity}; rerun with a fresh memory snapshot`);
  if(observed>expected)throw new Error(`Capacity exceeded: observed=${observed}, limit=${expected}`);
}

export function observedTerminal(mode,output) {
  if(mode==='headless')return null;
  const wt=/spawned visible .* TUI \(Windows Terminal\)/.test(output);
  const conhost=/spawned visible .* TUI \(inactive console\)/.test(output);
  return wt&&conhost?'mixed':wt?'wt':conhost?'conhost':null;
}

export function capacityAcceptancePassed(r) {
  return !r.monitorError&&r.coreUnchanged===true&&r.closed===true&&r.engineResult.code===0&&r.pollResult.code===0
    &&r.runnerCapacity===r.capacity&&r.peak===r.capacity&&r.receiptsValid===true&&r.ordered===true&&r.overlap===true
    &&r.windowLaunches===r.capacity&&r.uniqueLaunchers===r.capacity
    &&(r.executionMode==='headless'||['wt','conhost'].includes(r.terminal))
    &&r.summary?.success===true&&Object.keys(r.summary.results).length===r.capacity
    &&Object.values(r.summary.results).every(result=>result.status==='verified');
}

export async function boundedChildResult(item,timeoutMs) {
  let timer;
  try {
    return await Promise.race([item.done,new Promise(resolve=>{timer=setTimeout(()=>{
      item.child.kill();resolve({code:-1,error:'Acceptance child did not exit before its deadline'});
    },timeoutMs);})]);
  } finally {clearTimeout(timer);}
}

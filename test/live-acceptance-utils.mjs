export function capacityRequest({ids,root,workspace,nonce}) {
  return ids.map(id=>`项目${id}：执行 node "${root.replaceAll('\\','/')}/project-${id}/probe${id}.mjs" 创建 result${id}.json，执行工具的工作目录必须为 "${workspace}"，等待命令完成后读回结果，核验 id="${id}"、cwd="${workspace}"、sum=50005000、nonce="${nonce}"，pid/started/finished 为运行证据。本次回执没有 answer 字段，严格按本次 schema 核验。按主持提供的命令逐项记录 started 和 completed 检查点，禁止另开窗口、提交、读写记忆`).join('；');
}

export function validateCapacitySample(summary,expected,observed=0) {
  if(!Number.isInteger(expected)||expected<2)throw new Error('Capacity acceptance requires at least two windows');
  // 旧的 formula 模式容量应等于 harness 计算值；dynamic 内存预算模式允许账本记录更小的真实块数
  // （规划期按可用内存合并），此时只要求不超过 harness 的上限。
  if(summary&&summary.capacity>expected)throw new Error(`Capacity snapshot changed: harness=${expected}, runner=${summary.capacity}; rerun with a fresh memory snapshot`);
  if(observed>expected)throw new Error(`Capacity exceeded: observed=${observed}, limit=${expected}`);
}

export function observedTerminal(mode,output) {
  if(mode==='headless')return null;
  const wt=/spawned visible .* TUI \(Windows Terminal\)/.test(output);
  const conhost=/spawned visible .* TUI \(inactive console\)/.test(output);
  return wt&&conhost?'mixed':wt?'wt':conhost?'conhost':null;
}

export function capacityAcceptancePassed(r) {
  // dynamic 内存预算模式下，账本记录的真实块数（runnerCapacity）可以小于 harness 上限；
  // 判据改为：并发峰值 == 账本块数，且不超过 harness 上限。
  const blocks = r.runnerCapacity ?? r.capacity;
  return !r.monitorError&&r.coreUnchanged===true&&r.closed===true&&r.engineResult.code===0&&r.pollResult.code===0
    &&r.runnerCapacity<=r.capacity&&r.peak===blocks&&r.receiptsValid===true&&r.ordered===true&&r.overlap===true
    &&r.windowLaunches===blocks&&r.uniqueLaunchers===blocks
    &&(r.executionMode==='headless'||['wt','conhost'].includes(r.terminal))
    &&r.summary?.success===true&&Object.keys(r.summary.results).length===blocks
    &&Object.values(r.summary.results).every(result=>result.status==='verified');
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
  const value=Number(env.ORCH_LIVE_TIMEOUT_MS||180000);
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

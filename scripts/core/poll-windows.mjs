import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {resolveRuntimeContext} from './runtime-context.mjs';
import {runDirectory} from './runner.mjs';
import {processSnapshot,sameProcess} from './leases.mjs';
import {TERMINAL,SUCCESS,summaryComplete} from './contracts.mjs';
import {readRunStatus} from './status-events.mjs';
import {readConfiguredAcceptanceAbort,readConfiguredAcceptanceFinalization} from './isolated-acceptance.mjs';
export {TERMINAL,SUCCESS,summaryComplete};
export const summaryTerminal=sum=>summaryComplete(sum,false);
export const failures=sum=>Object.entries(sum?.taskResults||{}).filter(([,r])=>!SUCCESS.has(r.status)).map(([id,r])=>id+':'+r.status);
export function loadSummary(workspace,runId){try{return readRunStatus(workspace,runId);}catch{return null;}}
export function parsePollingOptions(argv,env=process.env){
  const result={runId:env.ORCH_RUN_ID,timeoutMs:1800000,intervalMs:5000,requireAllSuccess:true};
  const fields={'--run-id':'runId','--timeoutMs':'timeoutMs','--intervalMs':'intervalMs'};
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];
    if(flag==='--require-all-success'){result.requireAllSuccess=true;continue;}
    const field=Object.hasOwn(fields,flag)?fields[flag]:null,value=argv[++i];
    if(!field||value===undefined||!value.trim()||value.startsWith('--'))throw new Error('POLL_ARGUMENT_INVALID: '+flag);
    result[field]=field==='runId'?value:Number(value);
  }
  if(!result.runId)throw new Error('POLL_ARGUMENT_INVALID: --run-id is required');
  for(const key of ['timeoutMs','intervalMs'])if(!Number.isSafeInteger(result[key])||result[key]<(key==='timeoutMs'?0:1)||result[key]>2147483647)throw new Error('POLL_ARGUMENT_INVALID: '+key);
  result.intervalMs=Math.max(500,result.intervalMs);return result;
}
export async function main(argv=process.argv.slice(2),hooks={}) {
  const {runId,timeoutMs,intervalMs:interval,requireAllSuccess}=parsePollingOptions(argv);
  const {workspace}=resolveRuntimeContext();runDirectory(workspace,runId);
  const now=hooks.now||(()=>performance.now()),sleep=hooks.sleep||(ms=>new Promise(r=>setTimeout(r,ms)));
  const snapshot=hooks.snapshot||processSnapshot,load=hooks.load||loadSummary,log=hooks.log||console.log,error=hooks.error||console.error;
  const readAbort=hooks.abort||(()=>readConfiguredAcceptanceAbort({workspace,runId}));
  const isolatedAcceptance=hooks.isolatedAcceptance??(String(process.env.ORCH_ISOLATED_ACCEPTANCE||'')==='1');
  const readFinalization=hooks.finalization||(()=>readConfiguredAcceptanceFinalization({workspace,runId}));
  const abortRequested=()=>{
    let record;
    try{
      record=readAbort();
      if(record===null||record===undefined)return false;
      if(!record||typeof record!=='object'||record.kind!=='acceptance-abort'||record.runId!==runId)
        throw new Error('invalid acceptance abort record');
    }catch{
      error('[poll-windows] isolated acceptance abort authority unavailable runId='+runId);process.exitCode=1;return true;
    }
    error('[poll-windows] isolated acceptance aborted runId='+runId);process.exitCode=1;return true;
  };
  const finalizationCommitted=()=>{
    if(!isolatedAcceptance)return true;
    try{
      const record=readFinalization();
      if(!record||typeof record!=='object'||record.kind!=='acceptance-finalization'||record.runId!==runId)
        throw new Error('missing acceptance finalization');
      return true;
    }catch{
      error('[poll-windows] isolated acceptance finalization unavailable runId='+runId);process.exitCode=1;return false;
    }
  };
  if(abortRequested())return;
  const deadline=now()+timeoutMs;
  let stable=0;
  while(now()<deadline) {
    if(abortRequested())return;
    const sum=load(workspace,runId);
    if(sum?.runId===runId&&sum.finishedAt&&summaryTerminal(sum)) {
      const remaining=deadline-now();if(remaining<=0)break;
      const processes=snapshot(Math.max(1,Math.ceil(remaining)));
      if(now()>=deadline)break;
      const alive=Object.values(sum.results).some(r=>r.launcher&&sameProcess(r.launcher,processes.get(r.launcher.ProcessId)));
      if(!alive&&++stable>=2){
        if(abortRequested())return;
        if(!finalizationCommitted())return;
        // The isolated finalization marker and abort publisher share one
        // controller lock. Re-read after observing the marker so a malformed
        // or conflicting terminal state fails closed instead of printing 0.
        if(abortRequested())return;
        const ok=summaryComplete(sum,requireAllSuccess);log(JSON.stringify({runId,success:ok,requireAllSuccess,failures:failures(sum)}));process.exitCode=ok?0:1;return;
      }
      if(alive)stable=0;
    }else stable=0;
    log('[poll-windows] runId='+runId+' waiting for finalized inventory and closed windows');
    await sleep(Math.min(interval,Math.max(0,deadline-now())));
  }
  if(abortRequested())return;
  error('[poll-windows] timeout runId='+runId);process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase())main().catch(e=>{console.error(e.message);process.exitCode=2;});

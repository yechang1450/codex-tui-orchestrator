import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {buildTodoList,jsonProblem,describeShape} from './contracts.mjs';
import {atomicJson,readUtf8Bounded,MAX_CONTROLLER_ARTIFACT_BYTES} from './leases.mjs';
import {assertNoReparsePoints,physicalPathIdentity} from './runtime-context.mjs';
import {controllerStateDir} from './controller-state.mjs';

const MAX_STATUS_TEXT_BYTES=Math.min(MAX_CONTROLLER_ARTIFACT_BYTES,4*1024*1024);
const MAX_STATUS_LINE_BYTES=256*1024;
const MAX_RENDERED_FIELD=512;
function statusDigest(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function sameWorkspaceIdentity(left,right){
  if(typeof left!=='string'||!left.trim()||typeof right!=='string'||!right.trim())return false;
  try{return physicalPathIdentity(left)===physicalPathIdentity(right);}catch{return false;}
}
function statusAuthorityFile(workspace,runId){
  const identity=crypto.createHash('sha256').update(physicalPathIdentity(workspace)).digest('hex');
  return assertNoReparsePoints(path.join(controllerStateDir(workspace),'status',identity,runId+'.json'),'status authority');
}
function safeText(value,max=MAX_RENDERED_FIELD){
  return String(value??'').slice(0,max).replace(/[\u0000-\u001f\u007f-\u009f]/g,ch=>'\\u'+ch.charCodeAt(0).toString(16).padStart(4,'0'));
}

function runsDirectory(workspace){
  const root=path.join(path.resolve(workspace),'temp','orchestrator','runs');
  return assertNoReparsePoints(root,'status runs directory');
}
function directory(workspace,runId){
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(runId||''))throw new Error('Invalid run ID');
  return assertNoReparsePoints(path.join(runsDirectory(workspace),runId),'status run directory');
}
export function latestRunId(workspace){
  const root=runsDirectory(workspace);
  let entries;
  try{entries=fs.readdirSync(root,{withFileTypes:true});}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  assertNoReparsePoints(root,'status runs directory');
  const candidates=[];
  for(const entry of entries){
    if(!entry.isDirectory()||!/^[A-Za-z0-9_-]{1,100}$/.test(entry.name))continue;
    for(const name of ['summary.json','manifest.json']){
      const file=path.join(root,entry.name,name);
      let stat;
      try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      if(stat.isFile()){candidates.push({runId:entry.name,mtimeMs:stat.mtimeMs});break;}
    }
  }
  candidates.sort((a,b)=>b.mtimeMs-a.mtimeMs||b.runId.localeCompare(a.runId));
  return candidates[0]?.runId||null;
}
export function buildExecutionStatus(sum){
  return (sum.blocks||[]).map(block=>{
    const entry=sum.results?.[block.key]||{},attempt=entry.attempts?.at(-1);
    return {block:block.key,title:block.title,mode:sum.executionMode||'visible',status:entry.status||'pending',
      attempt:attempt?.number||0,pid:entry.launcher?.ProcessId||null,taskIds:block.taskIds,
      startedAt:entry.startedAt??null,endedAt:entry.endedAt??null,reason:entry.reason||'',
      retryAt:entry.retryAt??null};
  });
}
function readTextWithIdentity(file,label){
  let fd;
  try{fd=fs.openSync(file,'r');}
  catch(error){
    if(error.code==='ENOENT'){
      assertNoReparsePoints(file,label);
      return null;
    }
    throw error;
  }
  try{
    assertNoReparsePoints(file,label);
    const opened=fs.fstatSync(fd,{bigint:true});
    if(opened.size>BigInt(MAX_STATUS_TEXT_BYTES))throw new Error(`${label} exceeds the ${MAX_STATUS_TEXT_BYTES} byte safety limit: ${file}`);
    const text=fs.readFileSync(fd,'utf8');
    const current=fs.statSync(file,{bigint:true});
    if(opened.dev!==current.dev||opened.ino!==current.ino)throw new Error(`${label} changed during read: ${file}`);
    assertNoReparsePoints(file,label);
    return text;
  }finally{fs.closeSync(fd);}
}
// A manifest is written before planning starts and is intentionally readable
// before the controller has produced an authenticated summary.  Keep this
// fallback strictly planning-only: a workspace-controlled manifest must never
// be able to smuggle a completed/successful state past the controller
// authority check below.
function isPlanningManifest(sum){
  return !!sum && typeof sum==='object' && !Array.isArray(sum) &&
    Array.isArray(sum.tasks) && sum.success!==true && sum.finishedAt==null &&
    sum.eventSeq==null && sum.results==null && sum.taskResults==null &&
    sum.executionStatus==null;
}
function eventText(dir){
  const file=assertNoReparsePoints(path.join(dir,'events.jsonl'),'status events file');
  return readTextWithIdentity(file,'status events file')??'';
}
export function readEvents(dir,{after=0,runId:expectedRunId=null}={}){
  const safeDir=assertNoReparsePoints(dir,'status directory');
  const file=assertNoReparsePoints(path.join(safeDir,'events.jsonl'),'status events file'),text=eventText(safeDir),lines=text.slice(0,text.lastIndexOf('\n')+1).split('\n'),events=[];
  let previous=0,runId,lineNumber=0;
  for(const line of lines){
    lineNumber++;
    if(!line.trim())continue;
    let event;
    // 事件账本是审计线索：坏行仍然 fail-closed，但真因必须点名文件 + 行号，
    // 否则调用方只知道"有问题"，不知道是哪一条。
    if(Buffer.byteLength(line,'utf8')>MAX_STATUS_LINE_BYTES)throw new Error('Status event line exceeds the '+MAX_STATUS_LINE_BYTES+' byte safety limit: '+file+':'+lineNumber);
    try{event=JSON.parse(line);}
    catch(error){throw new Error('Invalid status event JSON at '+file+':'+lineNumber+'：'+jsonProblem(line,error));}
    if(event.schema!==1||!Number.isSafeInteger(event.seq)||event.seq<=previous||!event.runId||typeof event.type!=='string'||(runId&&runId!==event.runId)||(expectedRunId&&expectedRunId!==event.runId))
      throw new Error('Invalid status event sequence or identity at '+file+':'+lineNumber+'（要求 schema=1、seq 严格递增、整份文件同一个 runId）');
    previous=event.seq;runId=event.runId;if(event.seq>after)events.push(event);
  }
  return events;
}
export function createStatusPublisher(dir,{onEvent}={}){
  const safeDir=assertNoReparsePoints(dir,'status directory');
  const events=readEvents(safeDir),text=eventText(safeDir),file=assertNoReparsePoints(path.join(safeDir,'events.jsonl'),'status events file');
  let seq=events.at(-1)?.seq||0;
  let boundRunId=events[0]?.runId||null;
  // Only the controller holding the run claim creates a publisher. A partial
  // final append belongs to its dead predecessor; readers never repair files.
  if(text&&!text.endsWith('\n')){
    const truncateFd=fs.openSync(file,'r+');
    try{
      assertNoReparsePoints(safeDir,'status directory');
      assertNoReparsePoints(file,'status events file');
      fs.ftruncateSync(truncateFd,Buffer.byteLength(text.slice(0,text.lastIndexOf('\n')+1)));
    }finally{fs.closeSync(truncateFd);}
  }
  return {publish(sum,type='run.updated'){
    if(boundRunId&&boundRunId!==sum.runId)throw new Error('Status publisher run identity mismatch');
    boundRunId=boundRunId||sum.runId;
    seq=Math.max(seq,sum.eventSeq||0)+1;
    sum.todoList=buildTodoList(sum.tasks,sum.blocks,sum.taskResults);
    sum.executionStatus=buildExecutionStatus(sum);sum.eventSeq=seq;sum.updatedAt=Date.now();
    const event={schema:1,seq,runId:sum.runId,generation:sum.generation,type,at:sum.updatedAt,
      todoList:sum.todoList,executionStatus:sum.executionStatus,finishedAt:sum.finishedAt??null,success:sum.success===true};
    const summaryFile=assertNoReparsePoints(path.join(safeDir,'summary.json'),'status summary file');
    atomicJson(summaryFile,sum,()=>assertNoReparsePoints(safeDir,'status directory'));
    // The workspace summary is a derived mirror. Keep its digest in the
    // controller-owned root so readers can reject a worker-written success.
    atomicJson(statusAuthorityFile(sum.workspace,sum.runId),{version:1,runId:sum.runId,workspace:sum.workspace,sha256:statusDigest(sum)});
    // Recheck after the atomic snapshot and after opening the append handle.
    // If a same-user race swaps the run directory to a junction in either
    // window, fail before appending the event through the redirected handle.
    assertNoReparsePoints(safeDir,'status directory');
    const fd=fs.openSync(file,'a');
    try{
      assertNoReparsePoints(safeDir,'status directory');
      assertNoReparsePoints(file,'status events file');
      fs.writeFileSync(fd,JSON.stringify(event)+'\n');fs.fsyncSync(fd);
    }finally{fs.closeSync(fd);}
    onEvent?.(event);return event;
  }};
}
export function readRunStatus(workspace,runId){
  const dir=directory(workspace,runId),summaryFile=assertNoReparsePoints(path.join(dir,'summary.json'),'status summary file'),manifestFile=assertNoReparsePoints(path.join(dir,'manifest.json'),'status manifest file');
  let source=summaryFile,sum=readLedger(summaryFile);
  if(!sum){source=manifestFile;sum=readLedger(manifestFile);}
  if(!sum)throw new Error('Run ledger not found: '+summaryFile+'（同目录也没有 manifest.json：'+dir+'）');
  if(typeof sum.runId!=='string'||typeof sum.workspace!=='string')throw new Error('Invalid run ledger '+source+'：缺少 runId/workspace 字段（实测 runId='+describeShape(sum.runId)+'，workspace='+describeShape(sum.workspace)+'）');
  if(sum.runId!==runId||!sameWorkspaceIdentity(sum.workspace,workspace))throw new Error('Status run identity mismatch');
  // Before the first controller publication only the planning manifest exists.
  // It may be displayed as pending inventory, but it is never accepted as an
  // authenticated result.  A manifest that looks like a result is rejected.
  if(source===manifestFile){
    if(!isPlanningManifest(sum))throw new Error('Status manifest is not a planning ledger; refusing unauthenticated execution state');
    return {...sum,todoList:buildTodoList(sum.tasks,sum.blocks,sum.taskResults),executionStatus:buildExecutionStatus(sum)};
  }
  let authority;
  let authorityText;
  try{authorityText=readUtf8Bounded(statusAuthorityFile(workspace,runId),'status authority');}
  catch(error){throw new Error('Status authority unavailable: '+(error?.message||error));}
  if(authorityText===null){
    const error=new Error('Status authority is pending for '+runId+'; refusing unauthenticated summary');
    error.code='STATUS_AUTHORITY_PENDING';
    throw error;
  }
  try{authority=JSON.parse(authorityText);}
  catch(error){throw new Error('Status authority unavailable: '+(error?.message||error));}
  if(authority?.version!==1||authority.runId!==runId||!sameWorkspaceIdentity(authority.workspace||'',workspace)||authority.sha256!==statusDigest(sum))throw new Error('Status ledger authority mismatch');
  return {...sum,todoList:buildTodoList(sum.tasks,sum.blocks,sum.taskResults),executionStatus:buildExecutionStatus(sum)};
}
// 坏账本既不能静默当成正常状态读出去（调用方会拿到半份状态），也不能只回裸 SyntaxError。
// ENOENT 返回 null 交给调用方决定回落（summary 缺失时看 manifest）。
function readLedger(file){
  const text=readTextWithIdentity(file,'status ledger file');
  if(text===null)return null;
  let value;
  try{value=JSON.parse(text.replace(/^\uFEFF/,''));}
  catch(error){throw new Error('Invalid run ledger '+file+'：'+jsonProblem(text,error));}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid run ledger '+file+'：顶层必须是 JSON 对象（实测 '+describeShape(value)+'）');
  return value;
}
export function renderRunStatus(state){
  if(!state.runId)return ['No orchestrator runs found in '+safeText(state.workspace),'TodoList','Execution'].join('\n');
  const rows=['Run '+safeText(state.runId)+' | '+(state.finishedAt?(state.success?'verified':'finished with unresolved tasks'):'active'),
    'TodoList',...(state.todoList||[]).map(t=>`${t.status==='verified'?'[x]':'[ ]'} ${safeText(t.id)} ${safeText(t.status)} (${safeText(t.block||'planning')}) ${safeText(t.prompt)}`),
    'Execution',...(state.executionStatus||[]).map(e=>`${safeText(e.block)} ${safeText(e.mode)} ${safeText(e.status)} | attempt ${safeText(e.attempt)} | PID ${safeText(e.pid??'-')} | tasks ${safeText((e.taskIds||[]).join(','))}${e.reason?' | '+safeText(e.reason):''}`)];
  return rows.join('\n');
}
function terminalEventMatchesSummary(workspace,runId,event){
  const sum=readRunStatus(workspace,runId);
  return !!sum.finishedAt&&sum.eventSeq===event.seq&&sum.finishedAt===event.finishedAt&&sum.success===event.success;
}
export async function watchRunStatus({workspace,runId,after=0,intervalMs=250,timeoutMs=21600000,signal,onEvent=console.log}){
  if(!Number.isSafeInteger(after)||after<0||!Number.isFinite(intervalMs)||intervalMs<10||!Number.isFinite(timeoutMs)||timeoutMs<0)throw new Error('Invalid status watch timing or cursor');
  const dir=directory(workspace,runId),deadline=Date.now()+timeoutMs;
  let seq=after,initial=true,lastSize=-1;
  while(!signal?.aborted){
    let sum;
    try{sum=readRunStatus(workspace,runId);}
    catch(error){
      // createStatusPublisher atomically replaces summary.json, then records
      // its controller-owned digest, then appends the event.  If a watcher
      // lands in that tiny interval, wait for the authority instead of
      // surfacing an unauthenticated snapshot.  Any malformed/mismatched
      // authority still fails closed and is not retried.
      if(error?.code!=='STATUS_AUTHORITY_PENDING'||Date.now()>=deadline)throw error;
      try{await sleep(Math.min(intervalMs,deadline-Date.now()),undefined,{signal});}catch(waitError){if(signal?.aborted)return;throw waitError;}
      continue;
    }
    if(initial){onEvent({schema:1,seq:sum.eventSeq||0,type:'snapshot',...sum});seq=Math.max(seq,sum.eventSeq||0);initial=false;if(sum.finishedAt)return;}
    let size=0;try{size=fs.statSync(assertNoReparsePoints(path.join(dir,'events.jsonl'),'status events file')).size;}catch(error){if(error.code!=='ENOENT')throw error;}
    if(size!==lastSize){for(const event of readEvents(dir,{after:seq,runId})){
      seq=event.seq;
      // Events are workspace-readable hints.  A worker can append a forged
      // terminal event, so only a fresh controller-authenticated summary can
      // authorize terminal output and watcher termination.
      if(event.finishedAt){
        if(!terminalEventMatchesSummary(workspace,runId,event))continue;
        onEvent(event);return;
      }
      onEvent(event);
    }lastSize=size;}
    // A controller may die between its atomic snapshot and event append.
    if((sum.eventSeq||0)>seq){onEvent({schema:1,seq:sum.eventSeq,type:'snapshot',...sum});seq=sum.eventSeq;if(sum.finishedAt)return;}
    if(Date.now()>=deadline)throw new Error('Status watch timed out');
    try{await sleep(Math.min(intervalMs,deadline-Date.now()),undefined,{signal});}catch(error){if(signal?.aborted)return;throw error;}
  }
}

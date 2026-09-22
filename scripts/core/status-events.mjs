import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {buildTodoList,jsonProblem,describeShape} from './contracts.mjs';
import {atomicJson} from './leases.mjs';

function directory(workspace,runId){
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(runId||''))throw new Error('Invalid run ID');
  return path.join(path.resolve(workspace),'temp','orchestrator','runs',runId);
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
function eventText(dir){
  try{return fs.readFileSync(path.join(dir,'events.jsonl'),'utf8');}catch(error){if(error.code==='ENOENT')return '';throw error;}
}
export function readEvents(dir,{after=0}={}){
  const file=path.join(dir,'events.jsonl'),text=eventText(dir),lines=text.slice(0,text.lastIndexOf('\n')+1).split('\n'),events=[];
  let previous=0,runId,lineNumber=0;
  for(const line of lines){
    lineNumber++;
    if(!line.trim())continue;
    let event;
    // 事件账本是审计线索：坏行仍然 fail-closed，但真因必须点名文件 + 行号，
    // 否则调用方只知道"有问题"，不知道是哪一条。
    try{event=JSON.parse(line);}
    catch(error){throw new Error('Invalid status event JSON at '+file+':'+lineNumber+'：'+jsonProblem(line,error));}
    if(event.schema!==1||!Number.isSafeInteger(event.seq)||event.seq<=previous||!event.runId||typeof event.type!=='string'||(runId&&runId!==event.runId))
      throw new Error('Invalid status event sequence or identity at '+file+':'+lineNumber+'（要求 schema=1、seq 严格递增、整份文件同一个 runId）');
    previous=event.seq;runId=event.runId;if(event.seq>after)events.push(event);
  }
  return events;
}
export function createStatusPublisher(dir,{onEvent}={}){
  const events=readEvents(dir),text=eventText(dir),file=path.join(dir,'events.jsonl');
  let seq=events.at(-1)?.seq||0;
  // Only the controller holding the run claim creates a publisher. A partial
  // final append belongs to its dead predecessor; readers never repair files.
  if(text&&!text.endsWith('\n'))fs.truncateSync(file,Buffer.byteLength(text.slice(0,text.lastIndexOf('\n')+1)));
  return {publish(sum,type='run.updated'){
    if(events[0]&&events[0].runId!==sum.runId)throw new Error('Status publisher run identity mismatch');
    seq=Math.max(seq,sum.eventSeq||0)+1;
    sum.todoList=buildTodoList(sum.tasks,sum.blocks,sum.taskResults);
    sum.executionStatus=buildExecutionStatus(sum);sum.eventSeq=seq;sum.updatedAt=Date.now();
    const event={schema:1,seq,runId:sum.runId,generation:sum.generation,type,at:sum.updatedAt,
      todoList:sum.todoList,executionStatus:sum.executionStatus,finishedAt:sum.finishedAt??null,success:sum.success===true};
    atomicJson(path.join(dir,'summary.json'),sum);
    const fd=fs.openSync(file,'a');try{fs.writeFileSync(fd,JSON.stringify(event)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    onEvent?.(event);return event;
  }};
}
export function readRunStatus(workspace,runId){
  const dir=directory(workspace,runId),summaryFile=path.join(dir,'summary.json'),manifestFile=path.join(dir,'manifest.json');
  let source=summaryFile,sum=readLedger(summaryFile);
  if(!sum){source=manifestFile;sum=readLedger(manifestFile);}
  if(!sum)throw new Error('Run ledger not found: '+summaryFile+'（同目录也没有 manifest.json：'+dir+'）');
  if(typeof sum.runId!=='string'||typeof sum.workspace!=='string')throw new Error('Invalid run ledger '+source+'：缺少 runId/workspace 字段（实测 runId='+describeShape(sum.runId)+'，workspace='+describeShape(sum.workspace)+'）');
  if(sum.runId!==runId||path.resolve(sum.workspace)!==path.resolve(workspace))throw new Error('Status run identity mismatch');
  return {...sum,todoList:buildTodoList(sum.tasks,sum.blocks,sum.taskResults),executionStatus:buildExecutionStatus(sum)};
}
// 坏账本既不能静默当成正常状态读出去（调用方会拿到半份状态），也不能只回裸 SyntaxError。
// ENOENT 返回 null 交给调用方决定回落（summary 缺失时看 manifest）。
function readLedger(file){
  let text;
  try{text=fs.readFileSync(file,'utf8');}
  catch(error){if(error.code==='ENOENT')return null;throw new Error('Run ledger unreadable ('+error.code+'): '+file);}
  let value;
  try{value=JSON.parse(text.replace(/^\uFEFF/,''));}
  catch(error){throw new Error('Invalid run ledger '+file+'：'+jsonProblem(text,error));}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid run ledger '+file+'：顶层必须是 JSON 对象（实测 '+describeShape(value)+'）');
  return value;
}
export function renderRunStatus(state){
  const rows=['Run '+state.runId+' | '+(state.finishedAt?(state.success?'verified':'finished with unresolved tasks'):'active'),
    'TodoList',...(state.todoList||[]).map(t=>`${t.status==='verified'?'[x]':'[ ]'} ${t.id} ${t.status} (${t.block||'planning'}) ${t.prompt}`),
    'Execution',...(state.executionStatus||[]).map(e=>`${e.block} ${e.mode} ${e.status} | attempt ${e.attempt} | PID ${e.pid??'-'} | tasks ${e.taskIds.join(', ')}${e.reason?' | '+e.reason:''}`)];
  return rows.join('\n');
}
export async function watchRunStatus({workspace,runId,after=0,intervalMs=250,timeoutMs=21600000,signal,onEvent=console.log}){
  if(!Number.isSafeInteger(after)||after<0||!Number.isFinite(intervalMs)||intervalMs<10||!Number.isFinite(timeoutMs)||timeoutMs<0)throw new Error('Invalid status watch timing or cursor');
  const dir=directory(workspace,runId),deadline=Date.now()+timeoutMs;
  let seq=after,initial=true,lastSize=-1;
  while(!signal?.aborted){
    const sum=readRunStatus(workspace,runId);
    if(initial){onEvent({schema:1,seq:sum.eventSeq||0,type:'snapshot',...sum});seq=Math.max(seq,sum.eventSeq||0);initial=false;if(sum.finishedAt)return;}
    let size=0;try{size=fs.statSync(path.join(dir,'events.jsonl')).size;}catch(error){if(error.code!=='ENOENT')throw error;}
    if(size!==lastSize){for(const event of readEvents(dir,{after:seq})){onEvent(event);seq=event.seq;if(event.finishedAt)return;}lastSize=size;}
    // A controller may die between its atomic snapshot and event append.
    if((sum.eventSeq||0)>seq){onEvent({schema:1,seq:sum.eventSeq,type:'snapshot',...sum});seq=sum.eventSeq;if(sum.finishedAt)return;}
    if(Date.now()>=deadline)throw new Error('Status watch timed out');
    try{await sleep(Math.min(intervalMs,deadline-Date.now()),undefined,{signal});}catch(error){if(signal?.aborted)return;throw error;}
  }
}

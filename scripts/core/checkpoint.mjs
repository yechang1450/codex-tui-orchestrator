import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicJson,readUtf8Bounded} from './leases.mjs';
import {assertNoReparsePoints} from './runtime-context.mjs';

function readJson(file,label) {
  const text=readUtf8Bounded(file,label);
  if(text===null)return undefined;
  try{return JSON.parse(text.replace(/^\uFEFF/,''));}
  catch(error){throw new Error(`Invalid ${label}: ${error.message}`);}
}

export function checkpointMatches(record,attempt,id) {
  return !!record&&typeof attempt?.runId==='string'&&!!attempt.runId&&typeof attempt?.token==='string'&&!!attempt.token&&
    record.id===id&&record.runId===attempt.runId&&record.token===attempt.token&&['started','completed'].includes(record.state);
}

export function recordCheckpoint(attemptFile,id,state) {
  assertNoReparsePoints(attemptFile,'checkpoint attempt');
  const attempt=readJson(attemptFile,'checkpoint attempt');
  if(!attempt||!Array.isArray(attempt.taskIds))throw new Error('Invalid checkpoint attempt');
  if(!attempt.taskIds.includes(id)||!['started','completed'].includes(state))throw new Error('Invalid task checkpoint');
  const checkpointDir=assertNoReparsePoints(path.join(path.dirname(attemptFile),'checkpoints'),'checkpoint directory');
  const file=assertNoReparsePoints(path.join(checkpointDir,id+'.json'),'checkpoint file');
  let previous=readJson(file,'checkpoint file');
  if(previous!==undefined&&!checkpointMatches(previous,attempt,id))throw new Error('Invalid checkpoint identity or state');
  if(previous?.state==='completed') {
    if(state==='started')throw new Error('Task already completed; do not execute it again');
    return previous;
  }
  if(state==='completed'&&previous?.state!=='started')throw new Error('Record started before executing a task');
  if(state==='started'&&previous)throw new Error('Task already started; reconcile before retrying');
  const record={id,runId:attempt.runId,token:attempt.token,state,startedAt:previous?.startedAt||Date.now(),updatedAt:Date.now()};
  if(state==='started') {
    fs.mkdirSync(checkpointDir,{recursive:true});
    assertNoReparsePoints(checkpointDir,'checkpoint directory');
    assertNoReparsePoints(file,'checkpoint file');
    const fd=fs.openSync(file,'wx');
    try{fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }else atomicJson(file,record);
  return record;
}
export function readCheckpoints(attemptFile,expected) {
  assertNoReparsePoints(attemptFile,'checkpoint attempt');
  const attempt=readJson(attemptFile,'checkpoint attempt'),out={};
  if(!attempt||!Array.isArray(attempt.taskIds))throw new Error('Invalid checkpoint attempt');
  if(expected&&(!attempt||attempt.runId!==expected.runId||attempt.token!==expected.token||JSON.stringify(attempt.taskIds)!==JSON.stringify(expected.taskIds)))throw new Error('Attempt identity mismatch');
  for(const id of attempt.taskIds) {
    const file=assertNoReparsePoints(path.join(path.dirname(attemptFile),'checkpoints',id+'.json'),'checkpoint file');
    // An absent file means this task has no durable checkpoint yet. Only
    // present but malformed/foreign records are invalid; conflating them
    // prevents safe pre-execution retries and hides saved valid checkpoints.
    try{const r=readJson(file,'checkpoint file');if(r!==undefined)out[id]=checkpointMatches(r,attempt,id)?r:{state:'invalid'};}
    catch(e){out[id]={state:'invalid'};}
  }
  return out;
}
if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase()) {
  try{console.log(JSON.stringify(recordCheckpoint(...process.argv.slice(2))));}catch(e){console.error(e.message);process.exitCode=1;}
}

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicJson} from './leases.mjs';

export function recordCheckpoint(attemptFile,id,state) {
  const attempt=JSON.parse(fs.readFileSync(attemptFile,'utf8'));
  if(!attempt.taskIds.includes(id)||!['started','completed'].includes(state))throw new Error('Invalid task checkpoint');
  const file=path.join(path.dirname(attemptFile),'checkpoints',id+'.json');
  let previous;try{previous=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(previous!==undefined&&(!previous||previous.id!==id||previous.runId!==attempt.runId||previous.token!==attempt.token||!['started','completed'].includes(previous.state)))throw new Error('Invalid checkpoint identity or state');
  if(previous?.state==='completed') {
    if(state==='started')throw new Error('Task already completed; do not execute it again');
    return previous;
  }
  if(state==='completed'&&previous?.state!=='started')throw new Error('Record started before executing a task');
  if(state==='started'&&previous)throw new Error('Task already started; reconcile before retrying');
  const record={id,runId:attempt.runId,token:attempt.token,state,startedAt:previous?.startedAt||Date.now(),updatedAt:Date.now()};
  if(state==='started') {
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const fd=fs.openSync(file,'wx');
    try{fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }else atomicJson(file,record);
  return record;
}
export function readCheckpoints(attemptFile,expected) {
  const attempt=JSON.parse(fs.readFileSync(attemptFile,'utf8')),out={};
  if(expected&&(!attempt||attempt.runId!==expected.runId||attempt.token!==expected.token||JSON.stringify(attempt.taskIds)!==JSON.stringify(expected.taskIds)))throw new Error('Attempt identity mismatch');
  for(const id of attempt.taskIds) {
    const file=path.join(path.dirname(attemptFile),'checkpoints',id+'.json');
    try{const r=JSON.parse(fs.readFileSync(file,'utf8'));out[id]=r.id===id&&r.runId===attempt.runId&&r.token===attempt.token&&['started','completed'].includes(r.state)?r:{state:'invalid'};}
    catch(e){if(e.code!=='ENOENT')out[id]={state:'invalid'};}
  }
  return out;
}
if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase()) {
  try{console.log(JSON.stringify(recordCheckpoint(...process.argv.slice(2))));}catch(e){console.error(e.message);process.exitCode=1;}
}

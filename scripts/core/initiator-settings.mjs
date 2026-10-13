import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {physicalPathIdentity} from './runtime-context.mjs';
import {constrainWorkerPolicy} from './worker-authorization.mjs';

// Read only structured turn metadata belonging to the initiating thread.
// Conversation messages, tool output and other threads never supply settings.
function sessionFile(dir,id,depth=0) {
  if(depth>3)return;
  let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>b.name.localeCompare(a.name));}catch{return;}
  for(const entry of entries){
    if(entry.isFile()&&entry.name.startsWith('rollout-')&&entry.name.endsWith('-'+id+'.jsonl'))return path.join(dir,entry.name);
    if(entry.isDirectory()&&/^\d{2,4}$/.test(entry.name)){
      const file=sessionFile(path.join(dir,entry.name),id,depth+1);if(file)return file;
    }
  }
}

function latestContext(file) {
  if(!file)return {};
  let fd;
  try {
    fd=fs.openSync(file,'r');let end=fs.fstatSync(fd).size,carry=Buffer.alloc(0);
    while(end>0){
      const start=Math.max(0,end-1024*1024),chunk=Buffer.alloc(end-start);
      fs.readSync(fd,chunk,0,chunk.length,start);
      const data=Buffer.concat([chunk,carry]);let boundary=data.length;
      for(let i=data.length-1;i>=0;i--){
        if(data[i]!==10)continue;
        const line=data.subarray(i+1,boundary).toString('utf8');boundary=i;
        try{const event=JSON.parse(line);if(event.type==='turn_context'&&event.payload&&typeof event.payload==='object')return event.payload;}catch{/* partial trailing records are not settings */}
      }
      carry=data.subarray(0,boundary);end=start;
    }
    try{const event=JSON.parse(carry.toString('utf8'));if(event.type==='turn_context')return event.payload||{};}catch{}
  }catch{/* no local rollout: let native Codex use its configuration */}
  finally{if(fd!==undefined)fs.closeSync(fd);}
  return {};
}

function nativeConfigSettings(home) {
  let text;
  try { text=fs.readFileSync(path.join(home,'config.toml'),'utf8'); } catch { return {}; }
  const read=(key)=>new RegExp(String.raw`^\s*${key}\s*=\s*["']([^"']+)["']\s*$`,'m').exec(text)?.[1];
  return Object.fromEntries(Object.entries({model:read('model'),effort:read('model_reasoning_effort'),serviceTier:read('service_tier')}).filter(([,v])=>typeof v==='string'&&v.length>0&&!/\s/.test(v)));
}

function nativeConfigPolicy(home) {
  let text;
  try { text=fs.readFileSync(path.join(home,'config.toml'),'utf8'); } catch { return {}; }
  const policy={};
  for(const line of text.split(/\r?\n/)) {
    if(/^\s*\[/.test(line))break;
    const match=/^\s*(sandbox_mode|approval_policy)\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/.exec(line);
    if(match)policy[match[1]]=match[2];
  }
  return policy;
}

const SANDBOX_MODES=new Set(['read-only','workspace-write','danger-full-access']);
const APPROVAL_MODES=new Set(['never','on-request']);

export function resolveInitiatorPolicy(env=process.env) {
  const id=env.CODEX_THREAD_ID||env.CODEX_SESSION_ID||'';
  const home=env.CODEX_HOME||path.join(os.homedir(),'.codex');
  let sandbox,approval;
  if(id) {
    if(!/^[a-f0-9-]{36}$/i.test(id))throw new Error('INITIATOR_POLICY_UNAVAILABLE: invalid Codex thread identity');
    const context=latestContext(sessionFile(path.join(home,'sessions'),id));
    sandbox=context.sandbox_policy?.type;
    approval=context.approval_policy;
  } else {
    const native=nativeConfigPolicy(home);
    sandbox=env.ORCH_SANDBOX||native.sandbox_mode;
    approval=env.ORCH_APPROVAL||native.approval_policy;
  }
  if(!SANDBOX_MODES.has(sandbox)||!APPROVAL_MODES.has(approval))throw new Error('INITIATOR_POLICY_UNAVAILABLE: explicit sandbox and approval policy required');
  return constrainWorkerPolicy(sandbox,approval);
}

function sameWorkspace(left, right) {
  return physicalPathIdentity(left) === physicalPathIdentity(right);
}

export function assertInitiatorWorkspace(workspace,policy,env=process.env) {
  const id=env.CODEX_THREAD_ID||env.CODEX_SESSION_ID||'';
  if(!id)return;
  if(!/^[a-f0-9-]{36}$/i.test(id))throw new Error('INITIATOR_POLICY_UNAVAILABLE: invalid Codex thread identity');
  const home=env.CODEX_HOME||path.join(os.homedir(),'.codex');
  const context=latestContext(sessionFile(path.join(home,'sessions'),id));
  if(typeof context.cwd!=='string'||!path.isAbsolute(context.cwd))throw new Error('INITIATOR_POLICY_UNAVAILABLE: initiating workspace missing');
  if(!sameWorkspace(workspace,context.cwd))throw new Error('INITIATOR_POLICY_UNAVAILABLE: workspace differs from restricted initiating turn');
}

export function resolveInitiatorSettings(env=process.env) {
  const id=env.CODEX_THREAD_ID||env.CODEX_SESSION_ID||'';
  const home=env.CODEX_HOME||path.join(os.homedir(),'.codex');
  const context=/^[a-f0-9-]{36}$/i.test(id)?latestContext(sessionFile(path.join(home,'sessions'),id)):{};
  const native=nativeConfigSettings(home);
  if(/^[a-f0-9-]{36}$/i.test(id)&&(!context.model||!(context.effort||context.reasoning_effort)||
      ![context.model,context.effort||context.reasoning_effort].every(value=>typeof value==='string'&&value.length>0&&!/\s/.test(value))))
    throw new Error('INITIATOR_SETTINGS_UNAVAILABLE: initiating model and reasoning effort are required');
  // A structured turn is authoritative. Explicit ORCH_* values only fill a
  // missing context field; they cannot silently make a worker differ from its
  // initiating window.
  const values={model:context.model||native.model||env.ORCH_MODEL,
    effort:context.effort||context.reasoning_effort||native.effort||env.ORCH_EFFORT,
    serviceTier:context.service_tier||native.serviceTier||env.ORCH_SERVICE_TIER};
  return Object.fromEntries(Object.entries(values).filter(([,v])=>typeof v==='string'&&v.length>0&&!/\s/.test(v)));
}

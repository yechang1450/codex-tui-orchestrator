import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

export function resolveInitiatorSettings(env=process.env) {
  const id=env.CODEX_THREAD_ID||env.CODEX_SESSION_ID||'';
  const home=env.CODEX_HOME||path.join(os.homedir(),'.codex');
  const context=/^[a-f0-9-]{36}$/i.test(id)?latestContext(sessionFile(path.join(home,'sessions'),id)):{};
  const values={model:env.ORCH_MODEL||context.model,effort:env.ORCH_EFFORT||context.effort||context.reasoning_effort,
    serviceTier:env.ORCH_SERVICE_TIER||context.service_tier};
  return Object.fromEntries(Object.entries(values).filter(([,v])=>typeof v==='string'&&v.length>0&&!/\s/.test(v)));
}

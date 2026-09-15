import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {processSnapshot} from '../scripts/core/leases.mjs';
import {createHeadlessHooks} from '../scripts/core/headless-executor.mjs';
const family=fileURLToPath(new URL('../temp/',import.meta.url));
function fixture(source,options={}){
  fs.mkdirSync(family,{recursive:true});const workspace=fs.mkdtempSync(path.join(family,'headless-中文 '));
  const cli=path.join(workspace,'fixture.mjs');fs.writeFileSync(cli,source);
  const attemptFile=path.join(workspace,'temp','orchestrator','runs','r','attempts','B1','1','attempt.json');fs.mkdirSync(path.dirname(attemptFile),{recursive:true});
  fs.writeFileSync(attemptFile,JSON.stringify({runId:'r',token:'token',taskIds:['T001']}));
  const hooks=createHeadlessHooks({cli:process.execPath,args:[cli],workspace,timeoutMs:10000,...options});
  const files=hooks.launcher('B1','真实 prompt with "quotes" and 中文','r-a1',{attemptFile,runId:'r',token:'token',taskIds:['T001']});
  return {workspace,hooks,files,close:()=>fs.rmSync(workspace,{recursive:true,force:true})};
}
test('headless worker sends prompt over stdin and persists structured completion without a terminal launcher',async()=>{
  const f=fixture(`import fs from 'node:fs';let prompt='';for await(const b of process.stdin)prompt+=b;fs.writeFileSync('received.json',JSON.stringify({prompt,cwd:process.cwd(),args:process.argv.slice(2)}));console.log(JSON.stringify({type:'thread.started',thread_id:'thread-test'}));console.log(JSON.stringify({type:'turn.completed'}));`);
  try{
    assert.equal(await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token'),true);
    f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,true);assert.equal(result.exitCode,0);assert.equal(result.threadId,'thread-test');
    const received=JSON.parse(fs.readFileSync(path.join(f.workspace,'received.json')));
    assert.deepEqual(received,{prompt:'真实 prompt with "quotes" and 中文',cwd:f.workspace,args:['-']});
    assert.equal(f.files.mode,'headless');assert.equal(path.extname(f.files.lp),'.json');
    assert.match(fs.readFileSync(f.files.stdout,'utf8'),/turn.completed/);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('a busy controller checks the durable readiness PID before declaring elapsed timeout',async()=>{
  const f=fixture('console.log(JSON.stringify({type:"turn.completed"}));',{readinessTimeoutMs:100});
  try{
    const starting=f.hooks.spawn(f.files.lp,'test',f.files.pidf);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);
    assert.equal(await starting,true);
    const pid=f.hooks.readPid(f.files.pidf);f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,true);assert.equal(await f.hooks.waitForExit({ProcessId:pid}),true);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('unstructured stderr remains diagnostic and cannot authorize capacity replay',async()=>{
  const f=fixture("console.error('Selected model is at capacity; retry after 1 seconds');process.exitCode=1;");
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,false);assert.match(result.text,/model is at capacity/);assert.equal(result.retryable,undefined);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('headless worker marks a typed provider capacity failure as retryable',async()=>{
  const f=fixture("console.log(JSON.stringify({type:'turn.failed',error:{message:'Selected model is at capacity'}}));process.exitCode=1;");
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,false);assert.equal(result.retryable,'capacity');assert.match(result.capacityError,/model is at capacity/);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('headless worker marks an account usage limit as terminal quota',async()=>{
  const f=fixture("console.log(JSON.stringify({type:'turn.failed',error:{codex_error_info:'usage_limit_exceeded',message:\"You've hit your usage limit\"}}));process.exitCode=1;");
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,false);assert.equal(result.retryable,'quota');assert.match(result.quotaError,/usage_limit_exceeded/);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('recovered reconnect notifications do not invalidate a successful terminal event',async()=>{
  const f=fixture("console.log(JSON.stringify({type:'error',message:'Reconnecting... waiting for network (Connection failed: error sending request)'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'recovered'}}));console.log(JSON.stringify({type:'turn.completed'}));");
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,true);assert.equal(result.text,'recovered');assert.equal(result.retryable,undefined);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('cancelling a running hidden worker terminates its owned exec process and persists failure',async()=>{
  const f=fixture("console.log(JSON.stringify({type:'thread.started',thread_id:'cancel-test'}));setInterval(()=>{},1000);");
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');f.hooks.ready(f.files);
    const runtime=f.files.lp.replace(/\.json$/,'.runtime.json');let childPid;
    const end=Date.now()+10000;
    while(Date.now()<end){childPid=JSON.parse(fs.readFileSync(runtime)).childPid;if(childPid)break;await new Promise(r=>setTimeout(r,50));}
    assert.ok(childPid);await f.hooks.close(f.hooks.readPid(f.files.pidf));
    const result=JSON.parse(fs.readFileSync(f.files.rf));assert.equal(result.done,false);assert.match(result.text,/cancelled/i);
    assert.equal(processSnapshot().has(childPid),false);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('execution guard recognizes a registered hidden worker and rejects an unrelated Node PID',async()=>{
  const f=fixture('console.log(JSON.stringify({type:"turn.completed"}));');
  const state=path.join(f.workspace,'temp','orchestrator');fs.mkdirSync(state,{recursive:true});
  const force=fileURLToPath(new URL('../scripts/codex-TUI-orchestrator-force.mjs',import.meta.url));
  const env={...process.env,WORKSPACE_DIR:f.workspace,ORCH_STATE_DIR:state,ORCH_EXECUTION:'1'};delete env.ORCH_WINDOW;
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');
    fs.writeFileSync(path.join(state,'.orchestrator-enabled'),String(Date.now()));
    const registry=path.join(state,'orchestrator-windows.json');
    fs.writeFileSync(registry,JSON.stringify([{id:'worker',pidFile:f.files.pidf,mode:'headless'}]));
    const allowed=spawnSync(process.execPath,[force,'--assert','exec'],{env,encoding:'utf8',windowsHide:true});
    assert.equal(allowed.status,0,allowed.stdout+allowed.stderr);
    const unrelated=path.join(state,'exec-other.pid');fs.writeFileSync(unrelated,String(process.pid));
    fs.writeFileSync(registry,JSON.stringify([{id:'other',pidFile:unrelated,mode:'headless'}]));
    const denied=spawnSync(process.execPath,[force,'--assert','exec'],{env,encoding:'utf8',windowsHide:true});
    assert.equal(denied.status,1);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('a runtime journal write failure closes the owned exec before publishing a failed result',async()=>{
  const f=fixture("setInterval(()=>console.log(JSON.stringify({type:'thread.started',thread_id:'io-failure'})),100);");
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');
    const config=JSON.parse(fs.readFileSync(f.files.lp));
    const deadline=Date.now()+10000;while(!fs.existsSync(config.runtime)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
    fs.unlinkSync(config.runtime);fs.mkdirSync(config.runtime);f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,false);assert.match(result.text,/EISDIR|EPERM|EACCES/i);
    assert.equal([...processSnapshot().values()].some(p=>p.CommandLine?.includes(path.join(f.workspace,'fixture.mjs'))),false);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});
test('failed or truncated exec streams and nonzero exit codes never produce a completed worker result',async()=>{
  for(const source of ["console.log(JSON.stringify({type:'thread.started',thread_id:'t'}));", "console.log(JSON.stringify({type:'turn.completed'}));process.exitCode=23;", "console.log(JSON.stringify({type:'turn.completed'}));console.log(JSON.stringify({type:'turn.failed',error:{message:'broken stream'}}));"]){
    const f=fixture(source);try{
      await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');
      f.hooks.ready(f.files);
      const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);assert.equal(result.done,false);
    }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
  }
});

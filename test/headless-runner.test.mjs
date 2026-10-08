import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runWindows} from '../scripts/core/runner.mjs';
import {createHeadlessHooks} from '../scripts/core/headless-executor.mjs';
import {processSnapshot,sameProcess} from '../scripts/core/leases.mjs';
const family=fileURLToPath(new URL('../temp/',import.meta.url));
fs.mkdirSync(family,{recursive:true});
const controllerRoot=fs.mkdtempSync(path.join(family,'headless-controller-'));
const oldControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{if(oldControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=oldControllerRoot;fs.rmSync(controllerRoot,{recursive:true,force:true});});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(){
  fs.mkdirSync(family,{recursive:true});const workspace=fs.mkdtempSync(path.join(family,'headless-run-'));
  const cli=path.join(workspace,'cli.mjs'),checks=path.join(workspace,'checks.json');
  const checkpoint=new URL('../scripts/core/checkpoint.mjs',import.meta.url).href;
  fs.writeFileSync(cli,`import fs from 'node:fs';import path from 'node:path';import {recordCheckpoint} from ${JSON.stringify(checkpoint)};
let prompt='';for await(const part of process.stdin)prompt+=part;
const file=/开始前：& '[^']+' '[^']+' '([^']+)'/.exec(prompt)[1],a=JSON.parse(fs.readFileSync(file));
console.log(JSON.stringify({type:'thread.started',thread_id:'controlled-exec'}));
for(const id of a.taskIds){recordCheckpoint(file,id,'started');
if(id==='T001'){const count=fs.existsSync('count.json')?JSON.parse(fs.readFileSync('count.json')).count:0;fs.writeFileSync('count.json',JSON.stringify({count:count+1}));}
if(id==='T002'&&fs.existsSync('hold'))while(!fs.existsSync('release'))await new Promise(r=>setTimeout(r,40));
await new Promise(r=>setTimeout(r,400));fs.writeFileSync(id+'.json',JSON.stringify({done:true}));recordCheckpoint(file,id,'completed');}
console.log(JSON.stringify({type:'turn.completed'}));`);
  fs.writeFileSync(checks,JSON.stringify({T001:[{type:'json',path:'count.json',equals:{count:1}}],T002:[{type:'json',path:'T002.json',equals:{done:true}}]}));
  const options={workspace,capacity:8,executionMode:'headless',runId:'headless',coordinator:path.join(controllerRoot,'coordinator'),acceptanceFile:checks,auth:'Controlled execution',timeoutMs:120000};
  const hooks={...createHeadlessHooks({workspace,cli:process.execPath,args:[cli],timeoutMs:120000}),plan:async()=>[{title:'linked',tasks:[{prompt:'执行甲'},{prompt:'执行乙'}]}],compact:p=>p,infer:()=>[],prompt:p=>p,register:()=>{},commit:()=>{},unregister:()=>{}};
  return {workspace,cli,checks,hooks,options,summary:path.join(workspace,'temp','orchestrator','runs','headless','summary.json')};
}
test('headless runner keeps task progress live and returns independently verified receipts for a linked block',async()=>{
  const f=fixture(),events=[];
  try{
    const sum=await runWindows('执行甲；执行乙',f.hooks,{...f.options,onEvent:event=>events.push(structuredClone(event))});
    assert.equal(sum.success,true,JSON.stringify(sum.results));
    assert.equal(sum.executionMode,'headless');assert.equal(sum.executionStatus[0].status,'verified');
    assert.equal(sum.executionStatus[0].mode,'headless');
    assert.ok(events.some(e=>e.todoList?.[0]?.status==='running'&&e.todoList?.[1]?.status==='pending'));
    assert.ok(events.some(e=>e.todoList?.[0]?.status==='awaiting-verification'&&e.todoList?.[1]?.status==='running'));
    assert.equal(sum.results.B1.attempts.length,1);
    const goalFile=path.join(path.dirname(f.summary),'goal.json');
    const goal=JSON.parse(fs.readFileSync(goalFile));goal.summaryDigest='interrupted-mirror-write';fs.writeFileSync(goalFile,JSON.stringify(goal));
    const resumed=await runWindows('',f.hooks,{...f.options,resume:true});
    assert.equal(resumed.success,true);assert.equal(resumed.results.B1.attempts.length,1);
    assert.equal(resumed.coordinator,f.options.coordinator,'resume must retain its saved coordinator instead of selecting the new default');
    assert.notEqual(JSON.parse(fs.readFileSync(goalFile)).summaryDigest,goal.summaryDigest);
  }finally{await pause(500);fs.rmSync(f.workspace,{recursive:true,force:true});}
});
test('controller restart adopts the same hidden worker without repeating completed side effects',async()=>{
  const f=fixture();fs.writeFileSync(path.join(f.workspace,'hold'),'hold');
  const controller=path.join(f.workspace,'controller.mjs'),runner=new URL('../scripts/core/runner.mjs',import.meta.url).href,executor=new URL('../scripts/core/headless-executor.mjs',import.meta.url).href;
  fs.writeFileSync(controller,`import {runWindows} from ${JSON.stringify(runner)};import {createHeadlessHooks} from ${JSON.stringify(executor)};
const options=${JSON.stringify(f.options)};
const hooks={...createHeadlessHooks({workspace:options.workspace,cli:process.execPath,args:[${JSON.stringify(f.cli)}],timeoutMs:120000}),plan:async()=>[{title:'linked',tasks:[{prompt:'执行甲'},{prompt:'执行乙'}]}],compact:p=>p,infer:()=>[],prompt:p=>p,register:()=>{},commit:()=>{},unregister:()=>{}};
const sum=await runWindows(process.argv[2]?'':'执行甲；执行乙',hooks,{...options,resume:!!process.argv[2]});process.exitCode=sum.success?0:1;`);
  const children=[];let first;
  const start=resume=>{const child=spawn(process.execPath,[controller,...(resume?['resume']:[])],{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);child.stdout.resume();child.stderr.resume();return child;};
  // Windows CIM identity snapshots can queue behind unrelated controllers on a
  // busy host. Keep the restart assertion bounded, while allowing the real
  // hidden-worker fixture to reach its durable checkpoint.
  const waitFor=async condition=>{const end=Date.now()+120000;while(Date.now()<end){try{if(condition())return;}catch{}await pause(100);}throw new Error('Controlled worker readiness timed out');};
  try{
    const parent=start(false);
    const cp=path.join(path.dirname(f.summary),'attempts','B1','1','checkpoints','T002.json');
    await waitFor(()=>fs.existsSync(cp));first=JSON.parse(fs.readFileSync(f.summary));
    const parentExit=new Promise(resolve=>parent.once('close',resolve));parent.kill();await parentExit;
    assert.ok(sameProcess(first.results.B1.launcher,processSnapshot().get(first.results.B1.launcher.ProcessId)));
    const resumed=start(true),finished=new Promise(resolve=>resumed.once('close',resolve));
    await waitFor(()=>JSON.parse(fs.readFileSync(f.summary)).generation===2);
    fs.writeFileSync(path.join(f.workspace,'release'),'go');
    assert.equal(await finished,0);
    const final=JSON.parse(fs.readFileSync(f.summary));
    assert.equal(final.success,true);assert.equal(final.results.B1.attempts.length,1);
    assert.equal(final.results.B1.exitConfirmed,true,'the resumed controller must bind the completed worker exit to its original attempt');
    assert.equal(final.results.B1.exitEvidence.token,first.results.B1.attempts[0].token);
    assert.equal(final.results.B1.launcher.ProcessId,first.results.B1.launcher.ProcessId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.workspace,'count.json'))).count,1);
  }finally{
    fs.writeFileSync(path.join(f.workspace,'release'),'cleanup');
    for(const child of children)if(child.exitCode===null)child.kill();
    if(first){const e=first.results.B1;f.hooks.identity(e.launcher.ProcessId,e.launcherFiles.pidf);await f.hooks.close(e.launcher.ProcessId,e.launcher);}
    await pause(1000);fs.rmSync(f.workspace,{recursive:true,force:true});
  }
});

test('a failed admission commit never starts headless task execution or waits for a blocked worker',async()=>{
  const f=fixture();let waited=false;
  f.hooks.commit=()=>{throw new Error('Injected registry commit failure');};
  f.hooks.wait=async()=>{waited=true;throw new Error('Must not wait after admission failed');};
  try{
    const sum=await runWindows('执行甲；执行乙',f.hooks,{...f.options,maxAttempts:1});
    assert.equal(sum.success,false);assert.equal(waited,false);
    assert.equal(fs.existsSync(path.join(f.workspace,'count.json')),false);
    const entry=sum.results.B1;
    assert.equal(sameProcess(entry.launcher,processSnapshot().get(entry.launcher.ProcessId)),false);
  }finally{await pause(500);fs.rmSync(f.workspace,{recursive:true,force:true});}
});

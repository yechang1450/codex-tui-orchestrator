import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runWindows} from '../scripts/core/runner.mjs';
import {createHeadlessHooks} from '../scripts/core/headless-executor.mjs';
import {createStatusPublisher,readEvents,readRunStatus} from '../scripts/core/status-events.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const family=path.join(repo,'temp','execution-acceptance');
fs.mkdirSync(family,{recursive:true});
const controllerRoot=fs.mkdtempSync(path.join(family,'controller-'));
const oldControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{if(oldControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=oldControllerRoot;fs.rmSync(controllerRoot,{recursive:true,force:true});});

function doctor(mode,model,effort){
  const entry=path.join(repo,'scripts','core','orchestrate-sdk.mjs');
  const home=fs.mkdtempSync(path.join(family,'doctor-'));
  try{
    fs.writeFileSync(path.join(home,'config.toml'),`model = "${model}"\nmodel_reasoning_effort = "${effort}"\nservice_tier = "priority"\nsandbox_mode = "workspace-write"\napproval_policy = "never"\n`,'utf8');
    const env={...process.env,CODEX_HOME:home,ORCH_AGENT:'codex',ORCH_EXEC_MODE:mode,ORCH_MODEL:'wrong-model',ORCH_EFFORT:'low',ORCH_SERVICE_TIER:'flex'};
    delete env.CODEX_THREAD_ID;delete env.CODEX_SESSION_ID;
    const result=spawnSync(process.execPath,[entry,'--doctor'],{encoding:'utf8',windowsHide:true,env});
    assert.equal(result.status,0,result.stderr||result.stdout);
    return JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  }finally{fs.rmSync(home,{recursive:true,force:true});}
}

function optionPair(args){
  const modelAt=args.indexOf('-m'),effortAt=args.findIndex(value=>String(value).startsWith('model_reasoning_effort='));
  assert.ok(modelAt>=0&&args[modelAt+1],`model missing from argv: ${JSON.stringify(args)}`);
  assert.ok(effortAt>=0,`effort missing from argv: ${JSON.stringify(args)}`);
  return {model:args[modelAt+1],effort:String(args[effortAt]).slice('model_reasoning_effort='.length)};
}

test('exec and interactive TUI use the initiating model and effort exactly',()=>{
  const expected={model:'initiator-model-contract',effort:'high'};
  const headless=doctor('headless',expected.model,expected.effort);
  const visible=doctor('visible',expected.model,expected.effort);
  assert.equal(headless.args[0],'exec');
  assert.equal(headless.interactiveOutput,'jsonl');
  assert.deepEqual(optionPair(headless.args),expected);
  assert.ok(['wt','conhost'].includes(visible.terminal));
  assert.equal(visible.interactiveOutput,'inherited');
  assert.deepEqual(optionPair(visible.args),expected);
});

test('both doctors inherit thread model, effort and Fast without explicit ORCH overrides',()=>{
  const dir=fs.mkdtempSync(path.join(family,'initiator-')),id='11111111-2222-4333-8444-555555555555';
  try{
    const sessions=path.join(dir,'sessions','2026','09','24');fs.mkdirSync(sessions,{recursive:true});
    fs.writeFileSync(path.join(sessions,'rollout-example-'+id+'.jsonl'),JSON.stringify({type:'turn_context',payload:{model:'initiator-default-model',effort:'max',service_tier:'priority',sandbox_policy:{type:'workspace-write'},approval_policy:'on-request',cwd:repo}})+'\n','utf8');
    const env={...process.env,CODEX_HOME:dir,CODEX_THREAD_ID:id,ORCH_AGENT:'codex',WORKSPACE_DIR:repo};
    delete env.ORCH_MODEL;delete env.ORCH_EFFORT;delete env.ORCH_SERVICE_TIER;
    for(const mode of ['headless','visible']){
      const result=spawnSync(process.execPath,[path.join(repo,'scripts','core','orchestrate-sdk.mjs'),'--doctor'],{encoding:'utf8',windowsHide:true,env:{...env,ORCH_EXEC_MODE:mode}});
      assert.equal(result.status,0,result.stderr);
      const report=JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
      assert.equal(report.executionMode,'visible','approval-requiring initiators must use an interactive child');
      assert.ok(report.args,JSON.stringify(report));
      assert.deepEqual(optionPair(report.args),{model:'initiator-default-model',effort:'max'});
      assert.ok(report.args.includes('service_tier="priority"'));
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('interactive launcher keeps model and effort in one structured PowerShell argv list',()=>{
  const dir=fs.mkdtempSync(path.join(family,'visible-'));
  const workspace=path.join(dir,'project');fs.mkdirSync(workspace);
  const script=path.join(dir,'make-launcher.mjs');
  const module=new URL('../scripts/core/orchestrate-sdk.mjs',import.meta.url).href;
  fs.writeFileSync(path.join(dir,'config.toml'),'model = "initiator-visible-model"\nmodel_reasoning_effort = "medium"\nservice_tier = "priority"\nsandbox_mode = "workspace-write"\napproval_policy = "on-request"\n','utf8');
  fs.writeFileSync(script,`import {writeInteractiveLauncher} from ${JSON.stringify(module)};const f=writeInteractiveLauncher('acceptance','【本块唯一标识】acceptance-token','1');console.log(f.lp);`);
  try{
    const env={...process.env,CODEX_HOME:dir,WORKSPACE_DIR:workspace,ORCH_AGENT:'codex',ORCH_MODEL:'wrong-model',ORCH_EFFORT:'low',ORCH_SERVICE_TIER:'flex'};delete env.CODEX_THREAD_ID;delete env.CODEX_SESSION_ID;
    const result=spawnSync(process.execPath,[script],{cwd:workspace,encoding:'utf8',windowsHide:true,env});
    assert.equal(result.status,0,result.stderr);
    const launcher=fs.readFileSync(result.stdout.trim(),'utf8');
    assert.match(launcher,/initiator-visible-model/);
    assert.match(launcher,/model_reasoning_effort=medium/);
    assert.match(launcher,/\$agentArgs\s*=\s*@\(/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('headless runner sends the initiating model and effort to the worker and publishes both status views',async()=>{
  fs.mkdirSync(family,{recursive:true});
  const workspace=fs.mkdtempSync(path.join(family,'headless-'));
  const cli=path.join(workspace,'fake-codex.mjs'),capture=path.join(workspace,'capture.json'),checks=path.join(workspace,'checks.json');
  const checkpoint=new URL('../scripts/core/checkpoint.mjs',import.meta.url).href;
  fs.writeFileSync(cli,`import fs from 'node:fs';import {recordCheckpoint} from ${JSON.stringify(checkpoint)};let prompt='';for await(const c of process.stdin)prompt+=c;const m=/node "[^"]+" "([^"]+)" T001 started/.exec(prompt);if(!m)throw new Error('attempt command missing');fs.writeFileSync(process.env.CAPTURE_FILE,JSON.stringify({args:process.argv.slice(2),model:process.env.ORCH_MODEL||null,effort:process.env.ORCH_EFFORT||null}));console.log(JSON.stringify({type:'thread.started',thread_id:'acceptance-worker'}));recordCheckpoint(m[1],'T001','started');await new Promise(r=>setTimeout(r,400));recordCheckpoint(m[1],'T001','completed');console.log(JSON.stringify({type:'turn.completed'}));`);
  fs.writeFileSync(checks,JSON.stringify({T001:[{type:'json',path:'capture.json',equals:{args:['-m','initiator-worker-model','-c','model_reasoning_effort=high','-'],model:null,effort:null}}]}));
  const oldCapture=process.env.CAPTURE_FILE;process.env.CAPTURE_FILE=capture;
  const executor=createHeadlessHooks({workspace,cli:process.execPath,args:[cli,'-m','initiator-worker-model','-c','model_reasoning_effort=high'],timeoutMs:30000});
  const hooks={...executor,plan:async()=>[{title:'acceptance',tasks:[{prompt:'执行验收'}]}],compact:p=>p,infer:()=>[],prompt:p=>p,register:()=>{},commit:()=>{},unregister:()=>{}};
  const events=[];
  try{
    const sum=await runWindows('执行验收',hooks,{workspace,capacity:1,executionMode:'headless',runId:'acceptance',coordinator:path.join(controllerRoot,'coordinator'),acceptanceFile:checks,auth:'acceptance',timeoutMs:30000,onEvent:e=>events.push(e)});
    assert.equal(sum.success,true,JSON.stringify(sum.results));
    const captured=JSON.parse(fs.readFileSync(capture,'utf8'));
    assert.deepEqual(captured.args,['-m','initiator-worker-model','-c','model_reasoning_effort=high','-']);
    assert.deepEqual(sum.todoList.map(t=>t.status),['verified']);
    assert.equal(sum.executionStatus[0].mode,'headless');
    assert.ok(events.some(e=>e.todoList?.[0]?.status==='running'));
    assert.ok(events.some(e=>e.executionStatus?.[0]?.status==='running'));
    assert.ok(events.some(e=>e.todoList?.[0]?.status==='awaiting-verification'));
  }finally{if(oldCapture===undefined)delete process.env.CAPTURE_FILE;else process.env.CAPTURE_FILE=oldCapture;fs.rmSync(workspace,{recursive:true,force:true});}
});

test('spawn-group status is a monotonic host-consumable projection of every execution block',()=>{
  const workspace=fs.mkdtempSync(path.join(family,'status-')),dir=path.join(workspace,'temp','orchestrator','runs','group');fs.mkdirSync(dir,{recursive:true});
  const sum={runId:'group',workspace,generation:1,executionMode:'headless',tasks:[{id:'T001',prompt:'first'},{id:'T002',prompt:'second'}],blocks:[{key:'B1',title:'first',taskIds:['T001']},{key:'B2',title:'second',taskIds:['T002']}],results:{B1:{status:'running',attempts:[{number:1}],launcher:{ProcessId:101}},B2:{status:'waiting',attempts:[]}},taskResults:{T001:{status:'running'},T002:{status:'pending'}}};
  try{
    const publisher=createStatusPublisher(dir);publisher.publish(sum,'block.running');sum.taskResults.T001={status:'awaiting-verification'};sum.results.B1.status='awaiting-verification';publisher.publish(sum,'task.completed');
    const events=readEvents(dir);assert.deepEqual(events.map(e=>e.seq),[1,2]);
    for(const event of events){assert.equal(event.todoList.length,2);assert.equal(event.executionStatus.length,2);for(const block of event.executionStatus){assert.ok(block.block);assert.ok(Array.isArray(block.taskIds));assert.equal(block.mode,'headless');}}
    const state=readRunStatus(workspace,'group');assert.deepEqual(state.executionStatus.map(b=>b.block),['B1','B2']);assert.equal(state.todoList[1].status,'pending');
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('native Codex cards are never falsely claimed: host integration consumes the status contract explicitly',()=>{
  const readme=fs.readFileSync(path.join(repo,'README.md'),'utf8');
  assert.match(readme,/原生 TodoList\/spawn 卡片属于宿主界面/);
  assert.match(readme,/状态事件/);
  const source=fs.readFileSync(path.join(repo,'scripts','core','status-events.mjs'),'utf8');
  assert.match(source,/todoList:sum\.todoList/);
  assert.match(source,/executionStatus:sum\.executionStatus/);
  // No host tool is available to a plugin subprocess; the test requires the
  // durable interface to be present while rejecting a false native-card claim.
  assert.doesNotMatch(source,/update_plan\s*\(|spawn_agent\s*\(/);
});

test('optional real exec and visible TUI acceptance uses the same report contract',{skip:process.env.ORCH_REAL_CODEX_ACCEPTANCE!=='1'},async()=>{
  const harness=path.join(repo,'test','live-execution-mode.mjs');
  for(const mode of ['headless','visible']){
    const child=spawn(process.execPath,[harness],{cwd:process.cwd(),windowsHide:true,env:{...process.env,ORCH_LIVE_MODE:mode}});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    const code=await new Promise(resolve=>child.once('exit',resolve));assert.equal(code,0,output);
    const record=output.trim().split(/\r?\n/).reverse().map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(value=>value?.passed===true&&value.root);
    assert.ok(record,output);
    const report=JSON.parse(fs.readFileSync(path.join(record.root,'report.json'),'utf8'));assert.equal(report.mode,mode);assert.equal(report.summary.executionMode,mode);assert.equal(report.passed,true);
    assert.equal(report.receipts.length,2);
    for(const receipt of report.receipts){assert.equal(receipt.answer,42);assert.equal(receipt.cwd,process.cwd());}
  }
});

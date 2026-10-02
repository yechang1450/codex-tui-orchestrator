import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWindows,runDirectory,verifyRun} from '../scripts/core/runner.mjs';
import {createHeadlessHooks} from '../scripts/core/headless-executor.mjs';
import {canonicalDigest,buildTodoList} from '../scripts/core/contracts.mjs';
import {recordCheckpoint} from '../scripts/core/checkpoint.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const family=path.join(repo,'temp','acceptance-binding');
fs.mkdirSync(family,{recursive:true});
const originalCodexHome=process.env.CODEX_HOME;
const controllerHome=fs.mkdtempSync(path.join(family,'controller-home-'));
process.env.CODEX_HOME=controllerHome;
after(()=>{if(originalCodexHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=originalCodexHome;fs.rmSync(controllerHome,{recursive:true,force:true});});
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const contract=equals=>({T001:[{type:'json',path:'evidence.json',equals}]});
// 比原始契约宽松得多：只要文件存在就算通过，用来模拟有磁盘权限的执行窗自降验收条件。
const weakened={T001:[{type:'file',path:'evidence.json'}]};

function workerSource(evidence){
  return `import fs from 'node:fs';
import {recordCheckpoint} from ${JSON.stringify(new URL('../scripts/core/checkpoint.mjs',import.meta.url).href)};
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const started=/& '[^']+' '[^']+' '([^']+)' '(\\S+)' 'started'/.exec(prompt);if(!started)throw new Error('attempt command missing');
fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify({count:1}));
recordCheckpoint(started[1],started[2],'started');recordCheckpoint(started[1],started[2],'completed');
console.log(JSON.stringify({type:'thread.started',thread_id:'binding-worker'}));
console.log(JSON.stringify({type:'turn.completed'}));`;
}

/** 跑一轮最小 headless 执行：一个块、一个任务、一份显式验收契约。 */
async function runOnce(runId,checks){
  const workspace=fs.mkdtempSync(path.join(family,runId+'-'));
  const worker=path.join(workspace,'worker.mjs');
  fs.writeFileSync(worker,workerSource(path.join(workspace,'evidence.json')));
  const checksFile=path.join(workspace,'contract.json');
  fs.writeFileSync(checksFile,JSON.stringify(checks));
  const hooks={...createHeadlessHooks({workspace,cli:process.execPath,args:[worker]}),
    plan:async()=>[{title:'binding',tasks:[{prompt:'写证据'}]}],
    compact:value=>value,infer:()=>[],prompt:value=>value,register:()=>{},commit:()=>{},unregister:()=>{}};
  try{
    const sum=await runWindows('写证据',hooks,{workspace,capacity:1,executionMode:'headless',runId,
      coordinator:path.join(controllerHome,'coordinator'),acceptanceFile:checksFile,auth:'binding',timeoutMs:30000});
    return {workspace,checksFile,dir:runDirectory(workspace,runId),sum};
  }catch(error){
    // 失败路径同样不留工作区：调用方的 finally 只有在拿到返回值之后才会执行。
    fs.rmSync(workspace,{recursive:true,force:true});throw error;
  }
}

test('the canonical digest distinguishes JSON values that stringify identically',()=>{
  for(const [left,right] of [[{equals:null},JSON.parse('{"equals":1e400}')],[{equals:0},{equals:-0}],[{equals:1},{equals:'1'}]]){
    assert.notEqual(canonicalDigest(left),canonicalDigest(right),JSON.stringify(left)+' 与 '+JSON.stringify(right)+' 不能同摘要');
  }
  assert.equal(canonicalDigest({a:1,b:[{d:2,c:3}]}),canonicalDigest({b:[{c:3,d:2}],a:1}),'键顺序仍然不影响摘要');
});

test('a fresh run binds the acceptance contract into the ledger and the manifest',async()=>{
  const {workspace,checksFile,dir,sum}=await runOnce('bound',contract({count:1}));
  try{
    assert.equal(sum.success,true,JSON.stringify(sum.taskResults));
    const saved=readJson(path.join(dir,'summary.json')),manifest=readJson(path.join(dir,'manifest.json'));
    assert.equal(saved.acceptance?.algorithm,'sha256');
    assert.equal(saved.acceptance.sha256,canonicalDigest(contract({count:1})));
    assert.equal(manifest.acceptance?.sha256,saved.acceptance.sha256,'manifest 必须记录同一摘要');
    assert.equal(sum.acceptance.sha256,saved.acceptance.sha256,'内存账本与落盘账本一致');
    // 同一契约换个路径、换个排版（压缩 JSON）时摘要不变，历史与显式文件的用法继续可用。
    const copy=path.join(workspace,'contract-copy.json');
    fs.writeFileSync(copy,JSON.stringify(readJson(checksFile)));
    assert.equal(verifyRun(workspace,'bound',copy,{coordinator:path.join(controllerHome,'coordinator')}),true);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('workspace edits to the saved execution plan cannot be adopted by verification or resume',async()=>{
  const runId='plan-forgery';
  const {workspace,dir}=await runOnce(runId,contract({count:1}));
  try{
    const file=path.join(dir,'summary.json'),saved=readJson(file);
    saved.plan[0].b.tasks[0].prompt='forged child instruction';
    fs.writeFileSync(file,JSON.stringify(saved),'utf8');
    const options={coordinator:path.join(controllerHome,'coordinator')};
    assert.throws(()=>verifyRun(workspace,runId,undefined,options),/trusted run plan|plan binding/i);
    await assert.rejects(runWindows('',{}, {workspace,runId,resume:true,capacity:1,
      executionMode:'headless',...options}),/trusted run plan|plan binding/i);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('a verified headless run removes private launch artifacts after finalization',async()=>{
  const {workspace,sum}=await runOnce('completed-cleanup',contract({count:1}));
  try{
    assert.equal(sum.success,true);
    const files=Object.values(sum.results)[0].launcherFiles;
    for(const key of ['lp','pf','pidf','rf','stdout','stderr']){
      assert.equal(fs.existsSync(files[key]),false,key+' should be removed after final verification');
    }
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('verify rejects a weakened on-disk acceptance contract until the override is explicit',async()=>{
  const runId='weakened';
  const {workspace,dir}=await runOnce(runId,contract({count:1}));
  try{
    const trusted={coordinator:path.join(controllerHome,'coordinator')};
    const onDisk=path.join(dir,'acceptance.json');
    fs.writeFileSync(onDisk,JSON.stringify(weakened));
    assert.throws(()=>verifyRun(workspace,runId,undefined,trusted),/Acceptance contract changed/);
    assert.throws(()=>verifyRun(workspace,runId,onDisk,trusted),/Acceptance contract changed/);
    assert.equal(verifyRun(workspace,runId,onDisk,{...trusted,override:true}),true);
    const rebound=readJson(path.join(dir,'summary.json'));
    assert.equal(rebound.acceptance.sha256,canonicalDigest(weakened),'显式 override 必须把新摘要重新绑定');
    assert.ok(rebound.history.some(entry=>entry.acceptanceRebound?.to===canonicalDigest(weakened)),
      'override 必须留痕到账本 history');
    // 重新绑定后：磁盘副本、摘要、账本三者一致，后续 verify/resume 不再需要 override。
    assert.deepEqual(readJson(onDisk),weakened,'重新绑定必须把磁盘副本一起改写');
    assert.equal(verifyRun(workspace,runId,undefined,trusted),true,'重新绑定后同一契约不再触发拒绝');
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('verify rejects a contract forged together with both workspace digest records',async()=>{
  const runId='coordinated-forgery';
  const {workspace,dir}=await runOnce(runId,contract({count:1}));
  try{
    const marker=path.join(workspace,'forged-command-ran');
    const forged={T001:[{type:'command',command:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`]}]};
    fs.writeFileSync(path.join(dir,'acceptance.json'),JSON.stringify(forged),'utf8');
    const digest=canonicalDigest(forged);
    for(const name of ['summary.json','manifest.json']){
      const file=path.join(dir,name),record=readJson(file);
      record.acceptance.sha256=digest;
      fs.writeFileSync(file,JSON.stringify(record),'utf8');
    }
    assert.throws(()=>verifyRun(workspace,runId,undefined,{coordinator:path.join(controllerHome,'coordinator')}),/trusted acceptance|controller-owned|contract changed/i);
    assert.equal(fs.existsSync(marker),false);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('explicit adoption rebinds controller authority even when both workspace digests were rewritten',async()=>{
  const runId='adopt-forged-records';
  const {workspace,dir}=await runOnce(runId,contract({count:1}));
  try{
    const next=contract({count:1,approved:true});
    fs.writeFileSync(path.join(dir,'acceptance.json'),JSON.stringify(next),'utf8');
    const digest=canonicalDigest(next);
    for(const name of ['summary.json','manifest.json']){
      const file=path.join(dir,name),record=readJson(file);
      record.acceptance.sha256=digest;
      fs.writeFileSync(file,JSON.stringify(record),'utf8');
    }
    const trusted={coordinator:path.join(controllerHome,'coordinator')};
    assert.equal(verifyRun(workspace,runId,undefined,{...trusted,override:true}),false);
    const rebound=readJson(path.join(dir,'summary.json'));
    assert.equal(rebound.acceptance.sha256,digest);
    assert.ok(rebound.history.some(entry=>entry.acceptanceRebound?.to===digest));
    assert.equal(verifyRun(workspace,runId,undefined,trusted),false,'adopted contract no longer requires an override');
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('resume rejects a rewritten acceptance contract before any execution hook runs',async()=>{
  const runId='resume-guard';
  const {workspace,dir}=await runOnce(runId,contract({count:1}));
  try{
    fs.writeFileSync(path.join(dir,'acceptance.json'),JSON.stringify(weakened));
    let calls=0;
    const hooks=new Proxy({},{get(){calls++;throw new Error('Unexpected execution hook');}});
    await assert.rejects(()=>runWindows('',hooks,{workspace,capacity:8,runId,resume:true,coordinator:path.join(controllerHome,'coordinator')}),/Acceptance contract changed/);
    assert.equal(calls,0);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('unbound historical ledgers require explicit adoption and conflicting bindings are rejected',()=>{
  const workspace=fs.mkdtempSync(path.join(family,'legacy-'));
  try{
    const dir=path.join(workspace,'temp','orchestrator','runs','legacy');
    fs.mkdirSync(path.join(dir,'attempts','B1','1'),{recursive:true});
    const attemptFile=path.join(dir,'attempts','B1','1','attempt.json');
    const attempt={runId:'legacy',token:'token',taskIds:['T001']};
    fs.writeFileSync(attemptFile,JSON.stringify(attempt));
    recordCheckpoint(attemptFile,'T001','started');recordCheckpoint(attemptFile,'T001','completed');
    fs.writeFileSync(path.join(workspace,'evidence.json'),JSON.stringify({count:1}));
    const tasks=[{id:'T001',prompt:'first'}],blocks=[{key:'B1',taskIds:['T001']}];
    const summary={protocol:2,runId:'legacy',workspace,request:'first',capacity:8,generation:1,history:[],finishedAt:1,
      tasks,plan:[{key:'B1',title:'both',keys:[],dependsOn:[],b:{tasks:[{sourceIds:['T001']}]}}],blocks,
      results:{B1:{status:'awaiting-verification',endedAt:1,attempts:[{...attempt,file:attemptFile}]}},
      taskResults:{T001:{status:'awaiting-verification'}},
      todoList:buildTodoList(tasks,blocks,{T001:{status:'awaiting-verification'}}),
      coordinator:path.join(controllerHome,'coordinator')};
    const trusted={coordinator:summary.coordinator};
    const checks=path.join(dir,'acceptance.json');
    fs.writeFileSync(checks,JSON.stringify(contract({count:1})));
    fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(summary));
    assert.throws(()=>verifyRun(workspace,'legacy',undefined,trusted),/Trusted acceptance binding is missing/,'历史账本不能自动获得主控授权');
    assert.equal(verifyRun(workspace,'legacy',undefined,{...trusted,override:true}),true,'显式 override 可接管历史账本');
    // 重绑定要写两份账本；如果崩溃或篡改导致两份记录不一致，恢复必须拒绝选择任意一份。
    const digest=canonicalDigest(contract({count:1}));
    const bound={...summary,acceptance:{algorithm:'sha256',sha256:digest,boundAt:2}};
    fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(bound));
    fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({runId:'legacy',workspace,acceptance:{algorithm:'sha256',sha256:'0'.repeat(64),boundAt:1}}));
    assert.throws(()=>verifyRun(workspace,'legacy',undefined,trusted),/Acceptance binding records disagree or are incomplete/,'冲突绑定必须默认拒绝');
    assert.equal(verifyRun(workspace,'legacy',undefined,{...trusted,override:true}),true,'显式 override 才能修复冲突绑定');
    const healed=readJson(path.join(dir,'summary.json'));
    assert.equal(healed.acceptance.sha256,digest,'override 必须重新绑定 summary');
    assert.equal(readJson(path.join(dir,'manifest.json')).acceptance.sha256,digest,'override 必须重新绑定 manifest');
    const oneMissing=readJson(path.join(dir,'manifest.json'));
    delete oneMissing.acceptance;
    fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(oneMissing));
    assert.throws(()=>verifyRun(workspace,'legacy',undefined,trusted),/Acceptance binding records disagree or are incomplete/,'只剩一份绑定也必须拒绝');
    assert.equal(verifyRun(workspace,'legacy',undefined,{...trusted,override:true}),true,'显式 override 能修复缺失的一份绑定');
    // 绑定真正保护的是"磁盘契约必须与记录一致"：契约被改写就拒绝。
    fs.writeFileSync(checks,JSON.stringify(weakened));
    assert.throws(()=>verifyRun(workspace,'legacy',undefined,trusted),/Acceptance contract changed/);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

import {test} from 'node:test';
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
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const contract=equals=>({T001:[{type:'json',path:'evidence.json',equals}]});
// 比原始契约宽松得多：只要文件存在就算通过，用来模拟有磁盘权限的执行窗自降验收条件。
const weakened={T001:[{type:'file',path:'evidence.json'}]};

function workerSource(evidence){
  return `import fs from 'node:fs';
import {recordCheckpoint} from ${JSON.stringify(new URL('../scripts/core/checkpoint.mjs',import.meta.url).href)};
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const started=/node "([^"]+)" "([^"]+)" (\\S+) started/.exec(prompt);if(!started)throw new Error('attempt command missing');
fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify({count:1}));
recordCheckpoint(started[2],started[3],'started');recordCheckpoint(started[2],started[3],'completed');
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
      coordinator:path.join(workspace,'coordinator'),acceptanceFile:checksFile,auth:'binding',timeoutMs:30000});
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
    assert.equal(verifyRun(workspace,'bound',copy,{coordinator:path.join(workspace,'coordinator')}),true);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('verify rejects a weakened on-disk acceptance contract until the override is explicit',async()=>{
  const runId='weakened';
  const {workspace,dir}=await runOnce(runId,contract({count:1}));
  try{
    const trusted={coordinator:path.join(workspace,'coordinator')};
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

test('resume rejects a rewritten acceptance contract before any execution hook runs',async()=>{
  const runId='resume-guard';
  const {workspace,dir}=await runOnce(runId,contract({count:1}));
  try{
    fs.writeFileSync(path.join(dir,'acceptance.json'),JSON.stringify(weakened));
    let calls=0;
    const hooks=new Proxy({},{get(){calls++;throw new Error('Unexpected execution hook');}});
    await assert.rejects(()=>runWindows('',hooks,{workspace,capacity:8,runId,resume:true,coordinator:path.join(workspace,'coordinator')}),/Acceptance contract changed/);
    assert.equal(calls,0);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('unbound historical ledgers stay verifiable and conflicting bindings are rejected',()=>{
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
      coordinator:path.join(workspace,'temp/orchestrator/coordinator')};
    const trusted={coordinator:summary.coordinator};
    const checks=path.join(dir,'acceptance.json');
    fs.writeFileSync(checks,JSON.stringify(contract({count:1})));
    fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(summary));
    assert.equal(verifyRun(workspace,'legacy',undefined,trusted),true,'没有绑定的历史账本保持可验证');
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

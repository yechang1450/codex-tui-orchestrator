import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runWindows,runDirectory,verifyRun,identifyWithRetry,checkpointCommand} from '../scripts/core/runner.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
fs.mkdirSync(family,{recursive:true});
const controllerRoot=fs.mkdtempSync(path.join(family,'runner-controller-'));
const oldControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{if(oldControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=oldControllerRoot;fs.rmSync(controllerRoot,{recursive:true,force:true});});

test('checkpoint command preserves PowerShell-special paths and uses the current Node executable', t => {
  if (process.platform !== 'win32') return t.skip('PowerShell command contract is Windows-only');
  const root = fs.mkdtempSync(path.join(family, 'runner-checkpoint-command-'));
  const special = path.join(root, "literal $('value')-%ORCH_CHECKPOINT_TEST%! '");
  fs.mkdirSync(special, {recursive: true});
  const helper = path.join(special, 'capture.mjs');
  const capture = path.join(root, 'capture.json');
  const attemptFile = path.join(special, "attempt $('arg')-%ORCH_CHECKPOINT_TEST%! '.json");
  fs.writeFileSync(helper, "import fs from 'node:fs'; fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify(process.argv.slice(2)));\n", 'utf8');
  const command = checkpointCommand(helper, attemptFile, 'T001', 'started');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', command,
  ], {encoding: 'utf8', windowsHide: true, env: {...process.env, CAPTURE_FILE: capture}});
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${command}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), [attemptFile, 'T001', 'started']);
  assert.ok(command.startsWith(`& '${String(process.execPath).replaceAll("'", "''")}'`));
});
test('transient process-enumeration failures retry instead of failing the whole block',async()=>{
  let calls=0;
  const sleep=[];
  const identity=await identifyWithRetry(()=>{calls++;if(calls<3)throw new Error('Cannot verify process identities');return {ProcessId:42};},7,'exec-B1.pid',{pauseMs:ms=>{sleep.push(ms);return Promise.resolve();}});
  assert.equal(calls,3);
  assert.deepEqual(sleep,[300,600],'重试之间保持有界退避');
  assert.equal(identity.ProcessId,42);
  let attempts=0;
  await assert.rejects(()=>identifyWithRetry(()=>{attempts++;throw new Error('Cannot verify process identities');},7,'exec-B1.pid',{pauseMs:()=>Promise.resolve()}),/Cannot verify process identities/);
  assert.equal(attempts,3,'重试次数必须有上限，不能无限重试');
  let mismatched=0;
  assert.equal(await identifyWithRetry(()=>{mismatched++;return null;},7,'exec-B1.pid',{pauseMs:()=>Promise.resolve()}),null,'身份不匹配不是枚举故障，不重试');
  assert.equal(mismatched,1);
});
test('runWindows rejects malformed capacity before creating run state',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'runner-capacity-'));
 try {
  await assert.rejects(()=>runWindows('执行任务',{}, {workspace,runId:'invalid-capacity',capacity:0}),/capacity must be a positive integer/);
  assert.equal(fs.existsSync(path.join(workspace,'temp','orchestrator','runs','invalid-capacity')),false);
 } finally { fs.rmSync(workspace,{recursive:true,force:true}); }
});
test('failed prerequisite retains both original tasks and never starts its dependent',async()=>{
 fs.mkdirSync(family,{recursive:true});const workspace=fs.mkdtempSync(path.join(family,'runner-'));
 fs.mkdirSync(path.join(workspace,'temp'),{recursive:true});
 let launches=0;const prompts=[];
 const hooks={
  plan:async()=>[{title:'A',tasks:[{prompt:'执行甲'}]},{title:'B',dependsOn:['A'],tasks:[{prompt:'执行乙'}]}],
  compact:p=>p,infer:()=>[],prompt:p=>{prompts.push(p);return p;},
  launcher:(key,_prompt,suffix)=>{launches++;const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;return{lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};},
  register:()=>{},unregister:()=>{},cleanup:()=>{},spawn:async()=>false,readPid:()=>0,
 };
 try{
  const sum=await runWindows('执行甲；执行乙',hooks,{workspace,capacity:8,runId:'failure',auth:'test',coordinator:path.join(controllerRoot,'coordinator')});
  assert.equal(launches,2);assert.equal(sum.success,false);
  assert.match(prompts[0],/Global TodoList/);
  assert.match(prompts[0],/Current block TodoList/);
  assert.deepEqual(Object.keys(sum.taskResults),['T001','T002']);
  assert.equal(sum.taskResults.T001.status,'failed');assert.equal(sum.taskResults.T002.status,'blocked');
  const manifest=JSON.parse(fs.readFileSync(path.join(runDirectory(workspace,'failure'),'manifest.json'),'utf8'));
  assert.equal(manifest.tasks.length,2);
  assert.deepEqual(manifest.todoList.map(t=>t.id),['T001','T002']);
  const goal=JSON.parse(fs.readFileSync(path.join(runDirectory(workspace,'failure'),'goal.json'),'utf8'));
  assert.equal(goal.status,'failed');
  assert.deepEqual(goal.tasks.map(t=>t.id),['T001','T002']);
  await assert.rejects(()=>runWindows('执行甲',hooks,{workspace,capacity:8,runId:'failure'}),/already exists/);
  assert.throws(()=>verifyRun(workspace,'other-run'),/ENOENT/);
 }finally{await new Promise(r=>setTimeout(r,500));fs.rmSync(workspace,{recursive:true,force:true});}
});

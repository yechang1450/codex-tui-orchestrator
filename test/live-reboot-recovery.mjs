// Opt-in real reboot probe. This script never reboots Windows itself.
// prepare leaves one checked task complete and an idempotent second task waiting.
// collect resumes the same ledger only after a different OS boot is observed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyRelease} from '../scripts/release-integrity.mjs';
import {processSnapshot,sameProcess} from '../scripts/core/leases.mjs';
import {CORE_VERSION} from '../scripts/core/contracts.mjs';
// 与 scripts/core/orchestrate-sdk.mjs 的 decomposeHash 同式（sha1(CORE_VERSION|request|hintsKey)）。
// 这里刻意不复用 SDK 的导出：SDK 在 import 时就要解析 Codex CLI，会让本文件的离线测试也依赖真实 CLI。
const decomposeKey=(request,hints)=>crypto.createHash('sha1').update(CORE_VERSION+'|'+String(request||'')+'|'+JSON.stringify({moduleToProj:hints?.moduleToProj||{},foldRules:hints?.foldRules||{},tailKeywords:Array.isArray(hints?.tailKeywords)?hints.tailKeywords:[]})).digest('hex');

const repo=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const maybe=file=>{try{return read(file);}catch{return null;}};
const writeNew=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function validateRebootBaseline(pre,current){
  if(pre?.schema!==1||pre.ready!==true||!pre.id||pre.runId!=='reboot-'+pre.id)throw new Error('Invalid prepared reboot baseline');
  for(const key of ['id','runId','workspace','commit','releaseSha256'])if(!pre[key]||pre[key]!==current[key])throw new Error('Reboot baseline mismatch: '+key);
  const before=Date.parse(pre.bootBefore),after=Date.parse(current.bootAfter);
  if(!Number.isFinite(before)||!Number.isFinite(after)||after<=before)throw new Error('A real later OS boot is required');
}

export function assessRebootRecovery(pre,result){
  const sum=result.summary,ids=sum?.tasks?.map(task=>task.id).sort();
  const runWorkspace=pre.runWorkspace||pre.workspace;
  return result.exitCode===0&&result.closed===true&&result.firstReceiptUnchanged===true&&
    sum?.runId===pre.runId&&sum.executionMode==='headless'&&sum.generation>=2&&sum.success===true&&
    JSON.stringify(ids)===JSON.stringify(['T001','T002'])&&ids.every(id=>sum.taskResults?.[id]?.status==='verified')&&
    result.receipts?.length===2&&result.receipts.every((receipt,i)=>receipt?.id===['one','two'][i]&&receipt.nonce===pre.nonce&&receipt.cwd===runWorkspace&&receipt.count===1&&receipt.answer===42);
}

function environment(){
  verifyRelease(repo);
  const git=args=>{const r=spawnSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true});if(r.status!==0)throw new Error('Cannot inspect source commit');return r.stdout.trim();};
  if(git(['status','--porcelain','--untracked-files=no']))throw new Error('Commit tracked changes before preparing or collecting reboot evidence');
  const boot=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"],{encoding:'utf8',windowsHide:true,timeout:15000});
  if(boot.status!==0||!Number.isFinite(Date.parse(boot.stdout.trim())))throw new Error('Cannot independently inspect OS boot time');
  return {workspace:repo,commit:git(['rev-parse','HEAD']),releaseSha256:hash(path.join(repo,'release.json')),bootAfter:boot.stdout.trim()};
}

function locations(id){
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/.test(id))throw new Error('Invalid recovery Id');
  const runId='reboot-'+id,root=path.join(repo,'temp','reboot-recovery-'+id);
  // 执行工作区独立于编排器仓库：编排器拒绝"改自己"的请求（自引用守卫），
  // 而仓库路径出现在任务文本里会命中该守卫，所以这里用一个中立的 ws 目录承载这次运行。
  const runWorkspace=path.join(root,'ws');
  return {id,runId,root,runWorkspace,controllerRoot:path.join(root,'controller'),summaryFile:path.join(runWorkspace,'temp','orchestrator','runs',runId,'summary.json'),entry:path.join(repo,'scripts','orchestrate-sdk.mjs')};
}

function cancelOwned(state){
  const sum=maybe(state.summaryFile);
  for(const block of Object.values(sum?.results||{})){
    const configFile=block.launcherFiles?.lp;
    if(!configFile||!path.resolve(configFile).startsWith(path.dirname(state.summaryFile)+path.sep))continue;
    const config=maybe(configFile);
    if(config?.runId!==state.runId||config.token!==block.token||!config.cancel||!path.resolve(config.cancel).startsWith(path.dirname(configFile)+path.sep))continue;
    fs.writeFileSync(config.cancel,'cancel');
  }
}

async function prepare(id,{manualOnly=false}={}){
  const current=environment(),state=locations(id),nonce=crypto.randomUUID();
  if(fs.existsSync(state.root)||fs.existsSync(state.summaryFile))throw new Error('Recovery Id already exists');
  fs.mkdirSync(state.root,{recursive:true});fs.mkdirSync(state.runWorkspace,{recursive:true});
  const probes={one:path.join(state.root,'probe-one.mjs'),two:path.join(state.root,'probe-two.mjs')},acceptance=path.join(state.root,'acceptance.json');
  // 每个任务用各自的探针脚本：共享同一个脚本路径会被判成同一资源而合并成一块，
  // 那样"先完成一项"的顺序就只能靠模型自觉，实测会被打乱。
  const probeSource=id=>`import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const root=${JSON.stringify(state.root)},cwd=${JSON.stringify(state.runWorkspace)},nonce=${JSON.stringify(nonce)},id=${JSON.stringify(id)};
assert.equal(process.cwd(),cwd);
const receipt={nonce,cwd,id,count:1,answer:42},file=path.join(root,id+'.json');
${id==='one'
  ? 'fs.writeFileSync(file,JSON.stringify(receipt),{flag:"wx"});'
  : 'fs.writeFileSync(path.join(root,"waiting"),"idempotent wait");const deadline=Date.now()+1800000;\nwhile(!fs.existsSync(path.join(root,"release"))){if(Date.now()>deadline)throw new Error("Reboot barrier expired");await new Promise(r=>setTimeout(r,250));}\nif(fs.existsSync(file))assert.deepEqual(JSON.parse(fs.readFileSync(file,"utf8")),receipt);else fs.writeFileSync(file,JSON.stringify(receipt),{flag:"wx"});'}
assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),receipt);console.log(JSON.stringify(receipt));`;
  fs.writeFileSync(probes.one,probeSource('one'));fs.writeFileSync(probes.two,probeSource('two'));
  writeNew(acceptance,Object.fromEntries(['one','two'].map((task,i)=>['T00'+(i+1),{retrySafe:task==='two',checks:[{type:'json',path:path.join(state.root,task+'.json'),equals:{nonce,cwd:state.runWorkspace,id:task,count:1,answer:42}}]}])));
  const env={...process.env,ORCH_AGENT:'codex',WORKSPACE_DIR:state.runWorkspace,ORCH_CONTROLLER_ROOT:state.controllerRoot,ORCH_RUN_ID:state.runId,ORCH_ACCEPTANCE_FILE:acceptance,ORCH_MAX_POLL_MS:'1800000'};delete env.ORCH_STATE_DIR;
  for(const key of ['ORCH_TASK_HINTS','ORCH_TASK_FOLD','ORCH_TASK_TAIL'])delete env[key];
  // 提示词刻意不用"修改/更新"这类词：任务文本里出现仓库路径 + 修改意图会被自引用守卫判成"改编排器自己"。
  // 顺序由预置的拆块缓存保证（B1 完成后才允许开 B2），不指望模型自觉按序执行。
  const sentences={
    one:`项目 91：在工作目录 ${state.runWorkspace} 执行 node "${probes.one}"，等命令结束后读回 one.json，核验 nonce=${nonce}、cwd=${state.runWorkspace}、id=one、count=1、answer=42。先 started、成功读回后 completed。不要触碰测试脚本，不要读写记忆，不要另开窗口或提交`,
    two:`项目 92：在工作目录 ${state.runWorkspace} 执行 node "${probes.two}"，等命令结束后读回 two.json，核验 nonce=${nonce}、cwd=${state.runWorkspace}、id=two、count=1、answer=42。先 started、成功读回后 completed。不要触碰测试脚本，不要读写记忆，不要另开窗口或提交`,
  };
  const request=[sentences.one,sentences.two].join('；');
  const workspaceId=crypto.createHash('sha256').update(fs.realpathSync(state.runWorkspace).toLowerCase()).digest('hex');
  const stateDir=path.join(state.controllerRoot,'decompose',workspaceId);
  fs.mkdirSync(stateDir,{recursive:true});
  const hints={moduleToProj:{},foldRules:{},tailKeywords:['清爽','清理','保持干净','收尾','整理']};
  const blocks=[
    {type:'independent',title:'recovery-step-1',dependsOn:[],conflictKeys:['file:'+path.join(state.root,'one.json')],tasks:[{id:'t1',title:'one',prompt:sentences.one}]},
    {type:'independent',title:'recovery-step-2',dependsOn:['recovery-step-1'],conflictKeys:['file:'+path.join(state.root,'two.json')],tasks:[{id:'t2',title:'two',prompt:sentences.two}]},
  ];
  fs.writeFileSync(path.join(stateDir,'orchestrator-decompose-cache.json'),JSON.stringify({version:CORE_VERSION,entries:{[decomposeKey(request,hints)]:{createdAt:Date.now(),blocks}}},null,2)+'\n');
  const out=fs.openSync(path.join(state.root,'prepare.stdout.log'),'wx'),err=fs.openSync(path.join(state.root,'prepare.stderr.log'),'wx');
  const child=spawn(process.execPath,[state.entry,'--exec',request],{cwd:repo,env,detached:true,windowsHide:true,stdio:['ignore',out,err]});
  fs.closeSync(out);fs.closeSync(err);let launchError;child.on('error',error=>{launchError=error;});
  try{
    // 两个真实窗口各自要冷启动模型（实测每块 1-2 分钟），边界等待给足 10 分钟。
    const deadline=Date.now()+600000;let sum,attempt,waitingEntry;
    // 跨块收集每个任务的最新检查点状态：T001 与 T002 可能落在不同的块里。
    const checkpointStates=value=>{
      const states={};
      for(const entry of Object.values(value?.results||{}))for(const item of entry.attempts||[]){
        const dir=path.join(path.dirname(item.file),'checkpoints');
        for(const id of item.taskIds||[])if(!(id in states))states[id]=maybe(path.join(dir,id+'.json'))?.state||null;
      }
      return states;
    };
    while(Date.now()<deadline){
      if(launchError)throw launchError;if(child.exitCode!==null)throw new Error('Controller exited before the reboot boundary');
      sum=maybe(state.summaryFile);
      const states=checkpointStates(sum);
      if(states.T001==='completed'&&states.T002==='started'&&fs.existsSync(path.join(state.root,'waiting')))break;
      await pause(500);
    }
    // 等待中的那一块（含 T002）必须真的还活着，否则这不是"跨重启恢复"而是"重启前就跑挂了"。
    waitingEntry=Object.values(sum?.results||{}).find(entry=>(entry.attempts||[]).some(item=>(item.taskIds||[]).includes('T002')));
    attempt=waitingEntry?.attempts?.at(-1);
    const states=checkpointStates(sum);
    if(!attempt||!fs.existsSync(path.join(state.root,'waiting'))||states.T001!=='completed'||states.T002!=='started')throw new Error('Did not reach the real unfinished-task reboot boundary');
    const launcher=waitingEntry.launcher;if(!sameProcess(launcher,processSnapshot().get(launcher?.ProcessId)))throw new Error('Prepared worker is not alive');
    const pre={schema:1,id,runId:state.runId,workspace:repo,runWorkspace:state.runWorkspace,commit:current.commit,releaseSha256:current.releaseSha256,bootBefore:current.bootAfter,nonce,ready:true,firstReceiptSha256:hash(path.join(state.root,'one.json')),preparedAt:new Date().toISOString(),launcher,controllerPid:child.pid};
    writeNew(path.join(state.root,'pre-reboot.json'),pre);
    const bridge=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(repo,'test','reboot-validation.ps1'),'-Mode','prepare','-Id',id,'-RecoveryId',id,...(manualOnly?['-ManualOnly']:[])],{cwd:repo,encoding:'utf8',windowsHide:true,timeout:30000});
    if(bridge.status!==0)throw new Error('Reboot collector preparation failed: '+bridge.stderr);
    child.unref();return {prepared:true,id,runId:state.runId,root:state.root,boundary:'T001 completed; T002 started and waiting',collector:JSON.parse(bridge.stdout)};
  }catch(error){cancelOwned(state);child.kill();writeNew(path.join(state.root,'prepare-error.json'),{passed:false,error:String(error)});throw error;}
}

function collect(id){
  const state=locations(id),postFile=path.join(state.root,'post-reboot.json');
  if(fs.existsSync(postFile))throw new Error('Collection already exists; read the original receipt');
  if(fs.existsSync(path.join(state.root,'prepare-error.json')))throw new Error('Preparation failed; this baseline cannot certify a reboot');
  const pre=read(path.join(state.root,'pre-reboot.json'));let report={passed:false,id,runId:state.runId,automaticDispatchVerified:false};
  try{
    const current={...environment(),id:state.id,runId:state.runId};validateRebootBaseline(pre,current);
    if(sameProcess(pre.launcher,processSnapshot().get(pre.launcher.ProcessId)))throw new Error('Prepared pre-reboot process unexpectedly remains alive');
    if(hash(path.join(state.root,'one.json'))!==pre.firstReceiptSha256)throw new Error('First receipt changed before recovery');
    fs.writeFileSync(path.join(state.root,'release'),'continue');
    const out=fs.openSync(path.join(state.root,'resume.stdout.log'),'wx'),err=fs.openSync(path.join(state.root,'resume.stderr.log'),'wx');
    const env={...process.env,ORCH_AGENT:'codex',WORKSPACE_DIR:repo};for(const key of ['ORCH_RUN_ID','ORCH_ACCEPTANCE_FILE','ORCH_STATE_DIR'])delete env[key];
    let execution;try{execution=spawnSync(process.execPath,[state.entry,'--workspace',state.runWorkspace,'--resume-run',state.runId],{cwd:state.runWorkspace,env,windowsHide:true,stdio:['ignore',out,err],timeout:900000});}finally{fs.closeSync(out);fs.closeSync(err);}
    const sum=read(state.summaryFile),snapshot=processSnapshot(),blocks=Object.values(sum.results||{});
    const result={exitCode:execution.status,closed:blocks.length>0&&blocks.every(block=>block.launcher&&!sameProcess(block.launcher,snapshot.get(block.launcher.ProcessId))),summary:sum,receipts:['one','two'].map(task=>maybe(path.join(state.root,task+'.json'))),firstReceiptUnchanged:hash(path.join(state.root,'one.json'))===pre.firstReceiptSha256};
    report={...report,...result,bootBefore:pre.bootBefore,bootAfter:current.bootAfter,releaseSha256:current.releaseSha256,passed:assessRebootRecovery(pre,result),collectedAt:new Date().toISOString()};
    if(!report.passed)cancelOwned(state);
  }catch(error){report.error=String(error);cancelOwned(state);}
  writeNew(postFile,report);return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [mode,id,...extra]=process.argv.slice(2);
    if(mode==='--help'){console.log('node test/live-reboot-recovery.mjs prepare <unique-id> [--manual-only]\nnode test/live-reboot-recovery.mjs collect <same-id>');}
    else{
      if(!['prepare','collect'].includes(mode)||!id||extra.some(arg=>arg!=='--manual-only')||(mode==='collect'&&extra.length))throw new Error('Use --help for the explicit prepare/collect protocol');
      const result=mode==='prepare'?await prepare(id,{manualOnly:extra.includes('--manual-only')}):collect(id);
      console.log(JSON.stringify(result));if(result.passed===false)process.exitCode=1;
    }
  }catch(error){console.error(String(error));process.exitCode=1;}
}

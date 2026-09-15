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
  return result.exitCode===0&&result.closed===true&&result.firstReceiptUnchanged===true&&
    sum?.runId===pre.runId&&sum.executionMode==='headless'&&sum.generation>=2&&sum.success===true&&
    JSON.stringify(ids)===JSON.stringify(['T001','T002'])&&ids.every(id=>sum.taskResults?.[id]?.status==='verified')&&
    result.receipts?.length===2&&result.receipts.every((receipt,i)=>receipt?.id===['one','two'][i]&&receipt.nonce===pre.nonce&&receipt.cwd===pre.workspace&&receipt.count===1&&receipt.answer===42);
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
  return {id,runId,root,summaryFile:path.join(repo,'temp','orchestrator','runs',runId,'summary.json'),entry:path.join(repo,'scripts','orchestrate-sdk.mjs')};
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
  fs.mkdirSync(state.root,{recursive:true});
  const probe=path.join(state.root,'probe.mjs'),acceptance=path.join(state.root,'acceptance.json');
  fs.writeFileSync(probe,`import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const root=${JSON.stringify(state.root)},cwd=${JSON.stringify(repo)},nonce=${JSON.stringify(nonce)},id=process.argv[2];
assert.ok(['one','two'].includes(id));assert.equal(process.cwd(),cwd);
const receipt={nonce,cwd,id,count:1,answer:42},file=path.join(root,id+'.json');
if(id==='one'){fs.writeFileSync(file,JSON.stringify(receipt),{flag:'wx'});}else{
 fs.writeFileSync(path.join(root,'waiting'),'idempotent wait');const deadline=Date.now()+1800000;
 while(!fs.existsSync(path.join(root,'release'))){if(Date.now()>deadline)throw new Error('Reboot barrier expired');await new Promise(r=>setTimeout(r,250));}
 if(fs.existsSync(file))assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),receipt);else fs.writeFileSync(file,JSON.stringify(receipt),{flag:'wx'});
}assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),receipt);console.log(JSON.stringify(receipt));`);
  writeNew(acceptance,Object.fromEntries(['one','two'].map((task,i)=>['T00'+(i+1),{retrySafe:task==='two',checks:[{type:'json',path:path.join(state.root,task+'.json'),equals:{nonce,cwd:repo,id:task,count:1,answer:42}}]}])));
  const env={...process.env,ORCH_AGENT:'codex',WORKSPACE_DIR:repo,ORCH_RUN_ID:state.runId,ORCH_ACCEPTANCE_FILE:acceptance,ORCH_MAX_POLL_MS:'1800000'};delete env.ORCH_STATE_DIR;
  const request=['one','two'].map(task=>`同一项目 ${state.root}：在工作目录 ${repo} 执行 node "${probe}" ${task}，等命令结束后读回 ${task}.json，核验 nonce=${nonce}、cwd=${repo}、id=${task}、count=1、answer=42。先 started、成功回读后 completed。禁止修改测试脚本、读写记忆、另开窗口或提交`).join('；');
  const out=fs.openSync(path.join(state.root,'prepare.stdout.log'),'wx'),err=fs.openSync(path.join(state.root,'prepare.stderr.log'),'wx');
  const child=spawn(process.execPath,[state.entry,'--exec',request],{cwd:repo,env,detached:true,windowsHide:true,stdio:['ignore',out,err]});
  fs.closeSync(out);fs.closeSync(err);let launchError;child.on('error',error=>{launchError=error;});
  try{
    const deadline=Date.now()+300000;let sum,attempt;
    while(Date.now()<deadline){
      if(launchError)throw launchError;if(child.exitCode!==null)throw new Error('Controller exited before the reboot boundary');
      sum=maybe(state.summaryFile);attempt=sum?.results?.B1?.attempts?.at(-1);
      const checkpoints=attempt&&path.join(path.dirname(attempt.file),'checkpoints');
      if(sum?.blocks?.length===1&&maybe(path.join(checkpoints||state.root,'T001.json'))?.state==='completed'&&maybe(path.join(checkpoints||state.root,'T002.json'))?.state==='started'&&fs.existsSync(path.join(state.root,'waiting')))break;
      await pause(500);
    }
    if(!attempt||!fs.existsSync(path.join(state.root,'waiting'))||maybe(path.join(path.dirname(attempt.file),'checkpoints','T001.json'))?.state!=='completed'||maybe(path.join(path.dirname(attempt.file),'checkpoints','T002.json'))?.state!=='started')throw new Error('Did not reach the real unfinished-task reboot boundary');
    const launcher=sum.results.B1.launcher;if(!sameProcess(launcher,processSnapshot().get(launcher?.ProcessId)))throw new Error('Prepared worker is not alive');
    const pre={schema:1,id,runId:state.runId,workspace:repo,commit:current.commit,releaseSha256:current.releaseSha256,bootBefore:current.bootAfter,nonce,ready:true,firstReceiptSha256:hash(path.join(state.root,'one.json')),preparedAt:new Date().toISOString(),launcher,controllerPid:child.pid};
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
    let execution;try{execution=spawnSync(process.execPath,[state.entry,'--workspace',repo,'--resume-run',state.runId],{cwd:repo,env,windowsHide:true,stdio:['ignore',out,err],timeout:900000});}finally{fs.closeSync(out);fs.closeSync(err);}
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

// Opt-in real CLI smoke acceptance, including individual checkpoint verification.
// Run from the desired workspace with ORCH_LIVE_MODE=headless or visible.
// 两个独立任务：单任务请求按设计直接判 out-of-scope，两个任务还能验证"每项各自写检查点、
// 主控分别独立验收"，且默认动态内存预算下走的是真实规划路径。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {processSnapshot,sameProcess} from '../scripts/core/leases.mjs';
import {verifyRelease} from '../scripts/release-integrity.mjs';
import {liveTimeout} from './live-acceptance-utils.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url)),workspace=process.cwd();
const mode=process.env.ORCH_LIVE_MODE||'headless';
const entry=path.resolve(process.env.ORCH_LIVE_ENTRY||path.join(repo,'scripts','orchestrate-sdk.mjs'));
if(!['headless','visible'].includes(mode))throw new Error('Invalid ORCH_LIVE_MODE');
const runId='mode-'+mode+'-'+crypto.randomUUID(),root=path.join(workspace,'temp',runId);
const runDir=path.join(workspace,'temp','orchestrator','runs',runId);
const releaseFile=path.resolve(path.dirname(entry),'..','release.json');
verifyRelease(path.dirname(releaseFile));
const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(releaseFile)).digest('hex');
const releaseJsonSha256=hash();fs.mkdirSync(root,{recursive:true});
const tasks=[1,2].map(index=>{
  const nonce=crypto.randomUUID(),probe=path.join(root,'probe-'+index+'.mjs'),output=path.join(root,'receipt-'+index+'.json');
  fs.writeFileSync(probe,`import fs from 'node:fs';await new Promise(r=>setTimeout(r,1200));fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({nonce:${JSON.stringify(nonce)},cwd:process.cwd(),answer:6*7}));`);
  return {id:'T00'+index,nonce,probe,output};
});
const checks=path.join(root,'acceptance.json');
fs.writeFileSync(checks,JSON.stringify(Object.fromEntries(tasks.map(task=>[task.id,[{type:'json',path:task.output,equals:{nonce:task.nonce,cwd:workspace,answer:42}}]]))));
const request=tasks.map(task=>`执行 node "${task.probe}" 创建 "${task.output}"，等待完成并读回核验，按主持命令逐项记录检查点，禁止额外操作`).join('；');
// Real model-backed runs can spend several minutes in one turn at max effort.
// Keep the smoke test bounded by default, while allowing a caller to choose a
// longer explicit budget without changing the product's normal six-hour limit.
const liveTimeoutMs=liveTimeout();
const env={...process.env,WORKSPACE_DIR:workspace,ORCH_AGENT:'codex',ORCH_RUN_ID:runId,ORCH_ACCEPTANCE_FILE:checks,ORCH_MAX_POLL_MS:String(liveTimeoutMs)};
delete env.ORCH_STATE_DIR;
const startedAt=new Date().toISOString(),startedMs=Date.now();
const child=spawn(process.execPath,[entry,mode==='headless'?'--exec':'--run-windows',request],{cwd:workspace,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='';for(const pipe of [child.stdout,child.stderr])pipe.on('data',b=>{log+=b;process.stdout.write(b);});
const exitCode=await new Promise(resolve=>{child.once('error',e=>{log+=e.message;resolve(-1);});child.once('close',resolve);});
const summaryFile=path.join(runDir,'summary.json');
const summary=fs.existsSync(summaryFile)?JSON.parse(fs.readFileSync(summaryFile)):null;
const eventsFile=path.join(runDir,'events.jsonl');
const events=fs.existsSync(eventsFile)?fs.readFileSync(eventsFile,'utf8').trim().split('\n').map(JSON.parse):[];
const processes=processSnapshot();
const closed=!!summary&&Object.values(summary.results).every(r=>!sameProcess(r.launcher,processes.get(r.launcher?.ProcessId)));
const receipts=tasks.map(task=>fs.existsSync(task.output)?JSON.parse(fs.readFileSync(task.output)):null);
const receiptsValid=receipts.every((value,index)=>value?.nonce===tasks[index].nonce&&value?.cwd===workspace&&value?.answer===42);
const tasksCovered=Array.isArray(summary?.tasks)&&summary.tasks.length===tasks.length&&tasks.every(task=>task.id&&summary.tasks.some(saved=>saved.id===task.id));
let coreUnchanged=hash()===releaseJsonSha256;
try{verifyRelease(path.dirname(releaseFile));}catch{coreUnchanged=false;}
const report={mode,runId,root,workspace,entry,releaseJsonSha256,coreUnchanged,startedAt,elapsedMs:Date.now()-startedMs,exitCode,closed,
  passed:exitCode===0&&summary?.success===true&&closed&&coreUnchanged&&receiptsValid&&tasksCovered,
  receipts,tasks:tasks.map(task=>task.id),summary,events};
fs.writeFileSync(path.join(root,'engine.log'),log);fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,mode,runId,root,exitCode,closed}));process.exitCode=report.passed?0:1;

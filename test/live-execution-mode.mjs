// Opt-in real CLI smoke acceptance, including individual checkpoint verification.
// Run from the desired workspace with ORCH_LIVE_MODE=headless or visible.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {processSnapshot,sameProcess} from '../scripts/core/leases.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url)),workspace=process.cwd();
const mode=process.env.ORCH_LIVE_MODE||'headless';
const entry=path.resolve(process.env.ORCH_LIVE_ENTRY||path.join(repo,'scripts','orchestrate-sdk.mjs'));
if(!['headless','visible'].includes(mode))throw new Error('Invalid ORCH_LIVE_MODE');
const runId='mode-'+mode+'-'+crypto.randomUUID(),root=path.join(workspace,'temp',runId);
const runDir=path.join(workspace,'temp','orchestrator','runs',runId),nonce=crypto.randomUUID();
const releaseFile=path.resolve(path.dirname(entry),'..','release.json');
const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(releaseFile)).digest('hex');
const releaseJsonSha256=hash();fs.mkdirSync(root,{recursive:true});
const probe=path.join(root,'probe.mjs'),output=path.join(root,'receipt.json'),checks=path.join(root,'acceptance.json');
fs.writeFileSync(probe,`import fs from 'node:fs';await new Promise(r=>setTimeout(r,1200));fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({nonce:${JSON.stringify(nonce)},cwd:process.cwd(),answer:6*7}));`);
fs.writeFileSync(checks,JSON.stringify({T001:[{type:'json',path:output,equals:{nonce,cwd:workspace,answer:42}}]}));
const request=`执行 node "${probe}" 创建 "${output}"，等待完成并读回核验，按主持命令逐项记录检查点，禁止额外操作`;
const env={...process.env,WORKSPACE_DIR:workspace,ORCH_AGENT:'codex',ORCH_RUN_ID:runId,ORCH_ACCEPTANCE_FILE:checks,ORCH_MAX_POLL_MS:'180000'};
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
const receipt=fs.existsSync(output)?JSON.parse(fs.readFileSync(output)):null;
const coreUnchanged=hash()===releaseJsonSha256;
const report={mode,runId,root,workspace,entry,releaseJsonSha256,coreUnchanged,startedAt,elapsedMs:Date.now()-startedMs,exitCode,closed,
  passed:exitCode===0&&summary?.success===true&&closed&&coreUnchanged&&receipt?.nonce===nonce&&receipt?.cwd===workspace&&receipt?.answer===42,
  receipt,summary,events};
fs.writeFileSync(path.join(root,'engine.log'),log);fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,mode,runId,root,exitCode,closed}));process.exitCode=report.passed?0:1;

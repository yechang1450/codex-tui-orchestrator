// Opt-in real TUI test: kill only this test's Node controller, then adopt its surviving window.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {processSnapshot,sameProcess} from '../scripts/core/leases.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),workspace=process.cwd();
const agent=process.env.ORCH_LIVE_AGENT||'codex';
const entry=process.env.ORCH_LIVE_ENTRY||path.join(repo,'scripts','orchestrate-sdk.mjs');
const runId='recovery-'+crypto.randomUUID(),root=path.join(workspace,'temp',runId);
const summaryFile=path.join(workspace,'temp','orchestrator','runs',runId,'summary.json');
const coreHash=()=>crypto.createHash('sha256').update(fs.readdirSync(path.join(repo,'scripts','core')).filter(n=>/\.(mjs|ps1|txt)$/.test(n)).sort().map(n=>n+':'+crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,'scripts','core',n))).digest('hex')).join('\n')).digest('hex');
const hashBefore=coreHash();fs.mkdirSync(root,{recursive:true});
const probe=path.join(root,'probe.mjs'),acceptance=path.join(root,'acceptance.json');
fs.writeFileSync(probe,`import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const root=${JSON.stringify(root)},cwd=${JSON.stringify(workspace)},id=process.argv[2];assert.equal(process.cwd(),cwd);
if(id==='one'){const f=path.join(root,'one.json');const count=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)).count:0;fs.writeFileSync(f,JSON.stringify({count:count+1,cwd}));}
else {fs.writeFileSync(path.join(root,'waiting'),'waiting');const until=Date.now()+300000;while(!fs.existsSync(path.join(root,'release'))){if(Date.now()>until)throw new Error('Recovery barrier timeout');await new Promise(r=>setTimeout(r,200));}fs.writeFileSync(path.join(root,'two.json'),JSON.stringify({done:true,cwd}));}
console.log('verified '+id);`);
fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'json',path:path.join(root,'one.json'),equals:{count:1,cwd:workspace}}],T002:[{type:'json',path:path.join(root,'two.json'),equals:{done:true,cwd:workspace}}]}));
const request=['one','two'].map(id=>`同一项目 ${root}：执行 node "${probe}" ${id} 并等待命令结束，在发起目录 ${workspace} 执行，按主持命令记录检查点，禁止另开窗、禁止提交和写记忆`).join('；');
const env={...process.env,ORCH_AGENT:agent,ORCH_RUN_ID:runId,ORCH_ACCEPTANCE_FILE:acceptance,ORCH_MAX_POLL_MS:'600000'};
for(const key of ['WORKSPACE_DIR','ORCH_STATE_DIR','ORCH_TUI','ORCH_APPROVAL','ORCH_SANDBOX'])delete env[key];
const children=[];
function launch(args,label){
 const child=spawn(process.execPath,[entry,...args],{cwd:workspace,env,windowsHide:true});let output='';children.push(child);
 for(const pipe of [child.stdout,child.stderr])pipe.on('data',b=>{output+=b.toString();process.stdout.write('['+label+'] '+b);});
 const done=new Promise(resolve=>{child.on('exit',code=>resolve(code));child.on('error',e=>resolve(String(e)));});
 return {child,done,output:()=>output};
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=240000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await pause(500);}throw new Error('Timed out: '+label);}
const read=()=>{try{return JSON.parse(fs.readFileSync(summaryFile,'utf8'));}catch{return null;}};
let first,second,originalLauncher,report;
console.log(JSON.stringify({root,runId,entry}));
try {
 first=launch(['--run-windows',request],'first');
 await until(()=>{
  const s=read(),b=s?.results?.B1,a=b?.attempts?.[0];
  if(!a||!b.launcher||!fs.existsSync(path.join(root,'waiting')))return false;
  const cp=path.join(path.dirname(a.file),'checkpoints','T001.json');
  return fs.existsSync(cp)&&JSON.parse(fs.readFileSync(cp,'utf8')).state==='completed';
 },'first task completed and second task running');
 const before=read();assert.equal(before.blocks.length,1);originalLauncher=before.results.B1.launcher;
 assert.ok(sameProcess(originalLauncher,processSnapshot().get(originalLauncher.ProcessId)));
 first.child.kill();await first.done;
 second=launch(['--resume-run',runId],'resume');
 await until(()=>/adopting live B1/.test(second.output()),'adoption without relaunch',60000);
 assert.ok(sameProcess(originalLauncher,processSnapshot().get(originalLauncher.ProcessId)));
 fs.writeFileSync(path.join(root,'release'),'continue');
 await until(()=>second.child.exitCode!==null,'resumed completion');
 const exitCode=await second.done,after=read();
 assert.equal(exitCode,0,second.output());assert.equal(after.success,true);
 assert.equal(after.results.B1.attempts.length,1);assert.equal(after.generation,2);
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'one.json'),'utf8')).count,1);
 assert.ok(!sameProcess(originalLauncher,processSnapshot().get(originalLauncher.ProcessId)));
 assert.equal((first.output()+second.output()).match(new RegExp('spawned visible '+agent+' TUI','g'))?.length,1);
 assert.equal(coreHash(),hashBefore);
 report={passed:true,runId,entry,workspace,root,coreVersion:after.version,coreHash:hashBefore,coreUnchanged:true,generation:after.generation,windowLaunches:1,attempts:1,firstTaskExecutions:1,controllerCrashInjected:true,adoptedSameLauncher:true,closed:true,summary:after};
}catch(error){report={passed:false,runId,entry,workspace,root,error:String(error),summary:read()};process.exitCode=1;}
finally {
 fs.writeFileSync(path.join(root,'release'),'continue');
 fs.writeFileSync(path.join(root,'first.log'),first?.output()||'');fs.writeFileSync(path.join(root,'resume.log'),second?.output()||'');
 fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));
 console.log('[result] '+JSON.stringify({passed:report.passed,root,error:report.error}));
 // Never kill a shared terminal host. Failed tests leave identifiable evidence for the parent to reconcile.
}

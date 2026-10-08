import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {runWindows,collectVerification,verifyRun,waitForProcessExit} from '../scripts/core/runner.mjs';
import {recordCheckpoint,readCheckpoints} from '../scripts/core/checkpoint.mjs';
import {claimRun,releaseRun} from '../scripts/core/leases.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
fs.mkdirSync(family,{recursive:true});
const controllerRoot=fs.mkdtempSync(path.join(family,'runtime-controller-'));
const oldControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{if(oldControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=oldControllerRoot;fs.rmSync(controllerRoot,{recursive:true,force:true});});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('launcher exit verification tolerates a short process teardown race',async()=>{
 const expected={ProcessId:7,Name:'powershell.exe',Started:'s',CommandLine:'win-launch-test.ps1'};let calls=0;
 const gone=await waitForProcessExit(expected,{timeoutMs:200,intervalMs:10,snapshot:()=>calls++===0?new Map([[7,expected]]):new Map()});
 assert.equal(gone,true);
 const stuck=await waitForProcessExit(expected,{timeoutMs:20,intervalMs:10,snapshot:()=>new Map([[7,expected]])});
 assert.equal(stuck,false);
 let transientCalls=0;
 const transient=await waitForProcessExit(expected,{timeoutMs:200,intervalMs:10,snapshot:()=>{if(transientCalls++===0)throw new Error('snapshot unavailable');return new Map();}});
 assert.equal(transient,true,'retry a transient process snapshot failure within the existing deadline');
 const unreadable=await waitForProcessExit(expected,{timeoutMs:20,intervalMs:10,snapshot:()=>{throw new Error('snapshot unavailable');}});
 assert.equal(unreadable,false,'unavailable process evidence must never prove exit');
});
test('checkpoint refuses duplicate execution and completion without a start record',()=>{
 fs.mkdirSync(family,{recursive:true});const d=fs.mkdtempSync(path.join(family,'checkpoints-'));
 try{const f=path.join(d,'attempt.json');fs.writeFileSync(f,JSON.stringify({runId:'r',token:'t',taskIds:['T1']}));
  assert.throws(()=>recordCheckpoint(f,'T1','completed'),/started/);recordCheckpoint(f,'T1','started');
  assert.throws(()=>recordCheckpoint(f,'T1','started'),/already started/);recordCheckpoint(f,'T1','completed');
  assert.throws(()=>recordCheckpoint(f,'T1','started'),/already completed/);assert.throws(()=>recordCheckpoint(f,'other','started'),/Invalid/);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('checkpoint identity stays anchored to the controller ledger and rejects foreign previous records',()=>{
 fs.mkdirSync(family,{recursive:true});const d=fs.mkdtempSync(path.join(family,'checkpoint-identity-'));
 try{
  const f=path.join(d,'attempt.json'),expected={runId:'original',token:'original-token',taskIds:['T1']};
  fs.writeFileSync(f,JSON.stringify(expected));recordCheckpoint(f,'T1','started');
  const cp=path.join(d,'checkpoints','T1.json'),original=fs.readFileSync(cp,'utf8');
  for(const change of [{runId:'foreign'},{token:'foreign'},{id:'T2'},{state:'unexpected'}]){
   fs.writeFileSync(cp,JSON.stringify({...JSON.parse(original),...change}));
   const before=fs.readFileSync(cp,'utf8');
   assert.throws(()=>recordCheckpoint(f,'T1','completed'),/Invalid checkpoint identity or state/);
   assert.equal(fs.readFileSync(cp,'utf8'),before);
  }
  fs.writeFileSync(cp,original);
  assert.equal(readCheckpoints(f,expected).T1.state,'started');
  for(const change of [{runId:'foreign'},{token:'foreign'},{taskIds:[]},{taskIds:['T2']}]){
   fs.writeFileSync(f,JSON.stringify({...expected,...change}));
   assert.throws(()=>readCheckpoints(f,expected),/Attempt identity mismatch/);
   const sum={runId:expected.runId,blocks:[{key:'B1',taskIds:['T1']}],results:{B1:{endedAt:1,attempts:[{...expected,file:f}]}},taskResults:{}};
   collectVerification(sum,{},d);
   assert.equal(sum.taskResults.T1.status,'needs-reconciliation');
   assert.equal(sum.results.B1.status,'needs-reconciliation');
  }
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('missing checkpoint files cannot turn a damaged saved checkpoint into verified work',()=>{
 fs.mkdirSync(family,{recursive:true});const d=fs.mkdtempSync(path.join(family,'saved-checkpoint-identity-'));
 try{
  const file=path.join(d,'attempt.json'),attempt={runId:'original',token:'attempt-token',taskIds:['T1']};
  fs.writeFileSync(file,JSON.stringify(attempt));
  recordCheckpoint(file,'T1','started');const saved=recordCheckpoint(file,'T1','completed');
  fs.unlinkSync(path.join(d,'checkpoints','T1.json'));
  fs.writeFileSync(path.join(d,'evidence.json'),'{"count":1}');
  const checks={T1:[{type:'json',path:'evidence.json',equals:{count:1}}]};
  const summary=checkpoint=>({protocol:2,runId:'original',blocks:[{key:'B1',taskIds:['T1']}],
   results:{B1:{status:'failed',endedAt:1,attempts:[{...attempt,file}]}},taskResults:{T1:{status:'failed',checkpoint}}});
  const valid=summary(saved);collectVerification(valid,checks,d);
  assert.equal(valid.taskResults.T1.status,'verified');
  for(const change of [{id:'other'},{runId:'foreign'},{token:'foreign'},{state:'unexpected'},{id:undefined},{token:undefined}]){
   const damaged=summary({...saved,...change});collectVerification(damaged,checks,d);
   assert.equal(damaged.taskResults.T1.status,'needs-reconciliation',JSON.stringify(change));
   assert.equal(damaged.results.B1.status,'needs-reconciliation');
  }
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('two controllers cannot own the same run concurrently',async()=>{
 const d=fs.mkdtempSync(path.join(family,'run-claim-'));let claim;
 try{claim=claimRun(d,'run');assert.throws(()=>claimRun(d,'run'),/live controller/);releaseRun(d,'run',claim);claim=claimRun(d,'run');}
 finally{if(claim)releaseRun(d,'run',claim);await pause(500);fs.rmSync(d,{recursive:true,force:true});}
});
test('run owner release requires the claiming process identity, not only a readable token',async()=>{
 const d=fs.mkdtempSync(path.join(family,'run-claim-owner-'));let claim;
 try{
  claim=claimRun(d,'run');
  const helper=`import {releaseRun} from ${JSON.stringify(new URL('../scripts/core/leases.mjs',import.meta.url).href)};releaseRun(process.argv[1],process.argv[2],JSON.parse(process.argv[3]));`;
  const child=spawn(process.execPath,['--input-type=module','-e',helper,d,'run',JSON.stringify(claim)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const result=await new Promise((resolve,reject)=>{let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal,stdout,stderr}));});
  assert.equal(result.code,0,result.stderr);
  assert.throws(()=>claimRun(d,'run'),/live controller/,'a child with the token must not release the parent claim');
  releaseRun(d,'run',claim);claim=null;
 }finally{if(claim)releaseRun(d,'run',claim);await pause(500);fs.rmSync(d,{recursive:true,force:true});}
});
function pidReadRecoveryFixture(root,readPid,identity,{spawnResult=true,pidText='4321',writePid=true}={}){
 const artifacts={};let spawned=0,completed=0,cleanups=0,attemptFile='';
 const acceptance=path.join(root,'acceptance.json');
 fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'json',path:'completed.json',equals:{count:1}}]}));
 return {
  acceptance,coordinator:path.join(controllerRoot,'pid-'+path.basename(root)),artifacts,get spawned(){return spawned},get completed(){return completed},get cleanups(){return cleanups},
  hooks:{
   plan:async()=>[{title:'PID recovery',type:'single',tasks:[{prompt:'complete once'}]}],compact:p=>p,infer:()=>[],prompt:p=>p,
   launcher:(key,prompt,suffix)=>{
    attemptFile=/开始前：& '[^']+' '[^']+' '([^']+)'/.exec(prompt)[1];
    const launchDir=controllerWindowsDir(root);fs.mkdirSync(launchDir,{recursive:true});
    const stem=key+'-'+suffix;Object.assign(artifacts,{pidf:path.join(launchDir,'window-'+stem+'.pid'),lp:path.join(launchDir,'win-launch-'+stem+'.ps1'),pf:path.join(launchDir,'agent-win-'+stem+'.md'),rf:path.join(launchDir,'win-'+stem+'.result.json')});
    fs.writeFileSync(artifacts.lp,'# launcher');fs.writeFileSync(artifacts.pf,prompt);return artifacts;
   },
   spawn:async()=>{spawned++;if(writePid)fs.writeFileSync(artifacts.pidf,pidText);return spawnResult;},readPid,
   identity,session:async()=> 'controlled',
   wait:async()=>{completed++;recordCheckpoint(attemptFile,'T001','started');recordCheckpoint(attemptFile,'T001','completed');fs.writeFileSync(path.join(root,'completed.json'),JSON.stringify({count:completed}));return {done:true,exitCode:0};},
   exitCode:()=>0,register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{cleanups++;},close:async()=>{},waitForExit:async()=>true,
  },
 };
}
test('PID reader retries transient EBUSY before authenticating one launcher and executing once',async()=>{
 const d=fs.mkdtempSync(path.join(family,'pid-read-transient-'));let reads=0;
 try{
  const fixture=pidReadRecoveryFixture(d,()=>{reads++;if(reads<=2){const error=new Error('sharing lock');error.code='EBUSY';throw error;}return 4321;},pid=>pid===4321?{ProcessId:4321,Name:'powershell.exe',Started:'s',CommandLine:'win-launch-B1.ps1'}:null);
  const sum=await runWindows('complete once',fixture.hooks,{workspace:d,capacity:1,runId:'transient-pid',acceptanceFile:fixture.acceptance,coordinator:fixture.coordinator,auth:'test'});
  assert.equal(sum.success,true,JSON.stringify(sum.results));assert.equal(fixture.spawned,1);assert.equal(fixture.completed,1);assert.ok(reads>=3);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('permanent PID EBUSY retains recovery artifacts and never opens a replacement',async()=>{
 const d=fs.mkdtempSync(path.join(family,'pid-read-permanent-'));let reads=0;
 try{
  const fixture=pidReadRecoveryFixture(d,()=>{reads++;const error=new Error('sharing lock');error.code='EBUSY';throw error;},()=>{throw new Error('identity must not run without a PID');});
  const sum=await runWindows('complete once',fixture.hooks,{workspace:d,capacity:1,runId:'permanent-pid',acceptanceFile:fixture.acceptance,coordinator:fixture.coordinator,auth:'test'});
  assert.equal(sum.success,false);assert.equal(sum.results.B1.status,'needs-reconciliation');assert.equal(fixture.spawned,1);assert.equal(fixture.completed,0);assert.ok(reads>=3);for(const file of [fixture.artifacts.pidf,fixture.artifacts.lp,fixture.artifacts.pf])assert.ok(fs.existsSync(file),'retain '+file);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('no-process spawn result plus permanent PID EBUSY retains the lease and never replaces the launcher',async()=>{
 const d=fs.mkdtempSync(path.join(family,'pid-read-no-process-'));
 try{
  const fixture=pidReadRecoveryFixture(d,()=>{const error=new Error('sharing lock');error.code='EBUSY';throw error;},()=>{throw new Error('identity must not run without a PID');},{spawnResult:{noProcess:true}});
  const sum=await runWindows('complete once',fixture.hooks,{workspace:d,capacity:1,runId:'no-process-pid',acceptanceFile:fixture.acceptance,coordinator:fixture.coordinator,auth:'test'});
  assert.equal(sum.success,false);assert.equal(sum.results.B1.status,'needs-reconciliation');assert.equal(sum.results.B1.exitConfirmed,false);assert.equal(fixture.spawned,1);assert.equal(fixture.completed,0);assert.equal(sum.finalSweep.retained,1);for(const file of [fixture.artifacts.pidf,fixture.artifacts.lp,fixture.artifacts.pf])assert.ok(fs.existsSync(file),'retain '+file);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('no-process spawn result with an absent PID keeps the clean no-process cleanup path',async()=>{
 const d=fs.mkdtempSync(path.join(family,'pid-read-absent-'));
 try{
  const fixture=pidReadRecoveryFixture(d,()=>0,()=>{throw new Error('identity must not run without a PID');},{spawnResult:{noProcess:true},writePid:false});
  const sum=await runWindows('complete once',fixture.hooks,{workspace:d,capacity:1,runId:'absent-pid',acceptanceFile:fixture.acceptance,coordinator:fixture.coordinator,auth:'test',maxAttempts:1});
  assert.equal(sum.success,false);assert.equal(sum.results.B1.status,'failed');assert.equal(sum.results.B1.exitConfirmed,true);assert.equal(fixture.spawned,1);assert.equal(fixture.completed,0);assert.equal(fixture.cleanups,1);assert.equal(sum.finalSweep.retained,0);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('a malformed PID hidden as zero by the read hook fails closed without identity retry',async()=>{
 const d=fs.mkdtempSync(path.join(family,'pid-read-malformed-'));let identities=0;
 try{
  const fixture=pidReadRecoveryFixture(d,()=>0,()=>{identities++;return null;},{pidText:'not-a-pid'});
  const sum=await runWindows('complete once',fixture.hooks,{workspace:d,capacity:1,runId:'malformed-pid',acceptanceFile:fixture.acceptance,coordinator:fixture.coordinator,auth:'test'});
  assert.equal(sum.success,false);assert.equal(sum.results.B1.status,'needs-reconciliation');assert.match(sum.results.B1.reason,/invalid/i);assert.equal(fixture.spawned,1);assert.equal(fixture.completed,0);assert.equal(identities,0);for(const file of [fixture.artifacts.pidf,fixture.artifacts.lp,fixture.artifacts.pf])assert.ok(fs.existsSync(file),'retain '+file);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('an unauthenticated launcher PID remains needs-reconciliation without a replacement',async()=>{
 const d=fs.mkdtempSync(path.join(family,'pid-read-mismatch-'));
 try{
  const fixture=pidReadRecoveryFixture(d,()=>4321,()=>null);
  const sum=await runWindows('complete once',fixture.hooks,{workspace:d,capacity:1,runId:'mismatch-pid',acceptanceFile:fixture.acceptance,coordinator:fixture.coordinator,auth:'test'});
  assert.equal(sum.success,false);assert.equal(sum.results.B1.status,'needs-reconciliation');assert.match(sum.results.B1.reason,/identity unavailable|exit is unproven/i);assert.equal(fixture.spawned,1);assert.equal(fixture.completed,0);for(const file of [fixture.artifacts.pidf,fixture.artifacts.lp,fixture.artifacts.pf])assert.ok(fs.existsSync(file),'retain '+file);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
for(const fault of ['safe-retry','response-reset','response-timeout','started-only'])test('actual recovery without duplicate side effects: '+fault,async()=>{
 const d=fs.mkdtempSync(path.join(family,'recover-process-')),attempts=[],children=[];
 let requests=0,server,endpoint='';
 if(fault.startsWith('response-')){
  server=http.createServer((req,res)=>{requests++;fs.writeFileSync(path.join(d,'remote.json'),JSON.stringify({count:requests}));if(fault==='response-reset')res.destroy();});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  endpoint='http://127.0.0.1:'+server.address().port;
 }
 const lit=s=>"'"+s.replaceAll("'","''")+"'";
 const worker=path.join(d,'worker.mjs');
 fs.writeFileSync(worker,`import fs from 'node:fs';import path from 'node:path';import {recordCheckpoint} from ${JSON.stringify(new URL('../scripts/core/checkpoint.mjs',import.meta.url).href)};
 const [file,rf,root]=process.argv.slice(2),a=JSON.parse(fs.readFileSync(file));
 while(!fs.existsSync(rf+'.go'))await new Promise(r=>setTimeout(r,20));
 for(const id of a.taskIds){recordCheckpoint(file,id,'started');
 if(id==='T001'){const f=path.join(root,'count.json');const count=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)).count:0;fs.writeFileSync(f,JSON.stringify({count:count+1}));}
 if(id==='T002'&&${JSON.stringify(fault)}==='started-only'){
  fs.writeFileSync(path.join(root,'done.json'),JSON.stringify({done:true}));
  fs.writeFileSync(rf,JSON.stringify({exitCode:0}));process.exit(0);
 }
 if(id==='T002'&&${JSON.stringify(fault)}.startsWith('response-')){
  try{await fetch(${JSON.stringify(endpoint)},{method:'POST',signal:AbortSignal.timeout(500)});throw new Error('Expected transport failure');}
  catch(error){fs.writeFileSync(path.join(root,'transport-error.json'),JSON.stringify({name:error.name,message:error.message}));}
  fs.writeFileSync(rf,JSON.stringify({exitCode:23}));process.exit(23);
 }
 if(id==='T002'&&a.number===1){fs.writeFileSync(rf,JSON.stringify({exitCode:23}));process.exit(23);}
 if(id==='T002')fs.writeFileSync(path.join(root,'done.json'),JSON.stringify({done:true}));
 recordCheckpoint(file,id,'completed');}
 fs.writeFileSync(rf,JSON.stringify({exitCode:0}));`);
 const checks=path.join(d,'acceptance.json');fs.writeFileSync(checks,JSON.stringify({T001:[{type:'json',path:'count.json',equals:{count:1}}],T002:{retrySafe:fault==='safe-retry',checks:[{type:'json',path:'done.json',equals:{done:true}}]}}));
 const hooks={plan:async()=>[{title:'linked',type:'linked',tasks:[{prompt:'执行甲'},{prompt:'执行乙'}]}],compact:p=>p,infer:()=>[],prompt:p=>p,
  launcher:(key,prompt,suffix)=>{const file=/开始前：& '[^']+' '[^']+' '([^']+)'/.exec(prompt)[1];attempts.push(JSON.parse(fs.readFileSync(file)).taskIds);
   const launchDir=controllerWindowsDir(d);fs.mkdirSync(launchDir,{recursive:true});
   const stem=key+'-'+suffix,pidf=path.join(launchDir,'window-'+stem+'.pid'),lp=path.join(launchDir,'win-launch-'+stem+'.ps1'),pf=path.join(launchDir,'agent-win-'+stem+'.md'),rf=path.join(launchDir,'win-'+stem+'.result.json');
   // Start-Process -Wait 让夹具不依赖父进程类型：从 WSL 启动时，PowerShell 对 `& <控制台子进程>`
   // 会立即返回（实测 252ms），窗口身份校验就会因为启动器已退出而失败；-Wait 在两种父进程下都等待。
   const token=JSON.parse(fs.readFileSync(file,'utf8')).token;
   fs.writeFileSync(pf,prompt,'utf8');fs.writeFileSync(lp,'\ufeff'+`$token = ${lit(token)}\n$PID | Set-Content -LiteralPath ${lit(pidf)} -Encoding UTF8\nStart-Process -FilePath ${lit(process.execPath)} -ArgumentList ${lit(worker)},${lit(file)},${lit(rf)},${lit(d)} -NoNewWindow -Wait\nexit 0`);return{pidf,lp,pf,rf};},
  spawn:async(lp,_title,pidf)=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',lp],{windowsHide:true,stdio:'ignore'});children.push(child);const end=Date.now()+15000;while(!fs.existsSync(pidf)&&Date.now()<end)await pause(20);return fs.existsSync(pidf);},
  readPid:p=>fs.existsSync(p)?Number(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'')):0,
  session:async()=> 'controlled',wait:async(_session,_timeout,rf)=>{fs.writeFileSync(rf+'.go','go');const end=Date.now()+15000;while(!fs.existsSync(rf)&&Date.now()<end)await pause(20);return {done:fs.existsSync(rf),exitCode:JSON.parse(fs.readFileSync(rf)).exitCode};},
  exitCode:rf=>fs.existsSync(rf)?JSON.parse(fs.readFileSync(rf)).exitCode:null,
  register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},close:async()=>{await pause(300);},
 };
 try{const opts={workspace:d,capacity:8,runId:'partial',acceptanceFile:checks,coordinator:path.join(controllerRoot,'coordinator'),auth:'test'};
  const sum=await runWindows('执行甲；执行乙',hooks,opts);
  if(fault==='started-only'){
   assert.equal(sum.success,false);assert.equal(sum.taskResults.T002.status,'needs-reconciliation',JSON.stringify(sum));
   assert.equal(sum.taskResults.T002.checkpoint.state,'started');assert.deepEqual(attempts,[['T001','T002']]);
   const resumed=await runWindows('',hooks,{...opts,resume:true});
   assert.equal(resumed.success,false);assert.equal(resumed.taskResults.T002.status,'needs-reconciliation');assert.equal(attempts.length,1);
   assert.equal(verifyRun(d,'partial',checks,{coordinator:opts.coordinator}),true);
   const verified=await runWindows('',hooks,{...opts,resume:true});
   assert.equal(verified.success,true);assert.equal(verified.taskResults.T002.reconciled,true);
   assert.equal(attempts.length,1);assert.equal(JSON.parse(fs.readFileSync(path.join(d,'count.json'))).count,1);
   return;
  }
  if(fault!=='safe-retry'){
   assert.equal(sum.success,false);assert.equal(sum.taskResults.T002.status,'needs-reconciliation');
   assert.equal(requests,1);assert.deepEqual(attempts,[['T001','T002']]);
   const transport=JSON.parse(fs.readFileSync(path.join(d,'transport-error.json')));
   if(fault==='response-timeout')assert.equal(transport.name,'TimeoutError');
   else assert.ok(['TypeError','TimeoutError'].includes(transport.name),'reset transport failure must remain explicit: '+JSON.stringify(transport));
   const resumed=await runWindows('',hooks,{...opts,resume:true});
   assert.equal(resumed.taskResults.T002.status,'needs-reconciliation');assert.equal(requests,1);assert.equal(attempts.length,1);
  const reconciled=JSON.parse(fs.readFileSync(checks));reconciled.T002={checks:[{type:'json',path:'remote.json',equals:{count:1}}]};
   // 父代理在不确定结果后主动收紧契约属于"显式接管"：默认拒绝改写，必须打开 override 并留痕。
   fs.writeFileSync(checks,JSON.stringify(reconciled));assert.equal(verifyRun(d,'partial',checks,{override:true,coordinator:opts.coordinator}),true);
   const verified=await runWindows('',hooks,{...opts,resume:true,acceptanceOverride:true});assert.equal(verified.success,true);
   assert.equal(requests,1);assert.equal(attempts.length,1);assert.equal(JSON.parse(fs.readFileSync(path.join(d,'count.json'))).count,1);
   return;
  }
  assert.equal(sum.success,true,JSON.stringify(sum.results));assert.deepEqual(attempts,[['T001','T002'],['T002']]);assert.equal(JSON.parse(fs.readFileSync(path.join(d,'count.json'))).count,1);
  const recovered=await runWindows('',hooks,{...opts,resume:true});assert.equal(recovered.success,true);assert.equal(attempts.length,2,'verified resume must open no new window');
 }finally{for(const child of children)if(child.exitCode===null)child.kill();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await pause(500);fs.rmSync(d,{recursive:true,force:true});}
});

// Opt-in: real Codex, with a process-scoped CONNECT proxy interrupting TLS.
// No global proxy/firewall change and no TLS decryption or credential logging.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {processSnapshot,sameProcess} from '../scripts/core/leases.mjs';
import {verifyRelease} from '../scripts/release-integrity.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url)),workspace=process.cwd();
verifyRelease(repo);
const durationMs=Number(process.env.ORCH_OUTAGE_MS||300000);
if(!Number.isInteger(durationMs)||durationMs<1000||durationMs>1800000)throw new Error('Invalid ORCH_OUTAGE_MS');
const runId='outage-'+crypto.randomUUID(),root=path.join(workspace,'temp',runId);
const runDir=path.join(workspace,'temp','orchestrator','runs',runId),nonce=crypto.randomUUID();
fs.mkdirSync(root,{recursive:true});
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const summary=()=>read(path.join(runDir,'summary.json'));
const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,'release.json'))).digest('hex');
const releaseJsonSha256=hash(),transport=[],sockets=new Set(),children=[];
const upstreamProxy=process.env.ORCH_TEST_UPSTREAM_PROXY?new URL(process.env.ORCH_TEST_UPSTREAM_PROXY):null;
if(upstreamProxy&&(upstreamProxy.protocol!=='http:'||upstreamProxy.username||upstreamProxy.password))throw new Error('Use an existing unauthenticated HTTP CONNECT upstream proxy');
let offline=false,faultStartedAt=null,faultEndedAt=null,report;
const track=s=>{sockets.add(s);s.on('error',()=>{});s.once('close',()=>sockets.delete(s));return s;};
const proxy=http.createServer((_req,res)=>{res.writeHead(405);res.end();});
proxy.on('connect',(req,client,head)=>{
  track(client);
  let target;try{target=new URL('https://'+req.url);}catch{client.destroy();return;}
  const host=target.hostname.toLowerCase(),port=Number(target.port||443);
  transport.push({at:Date.now(),host,event:'connect-request'});
  const allowed=port===443&&(host==='chatgpt.com'||host.endsWith('.chatgpt.com')||host==='openai.com'||host.endsWith('.openai.com'));
  if(!allowed){transport.push({at:Date.now(),host,event:'target-rejected'});client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
  if(offline){transport.push({at:Date.now(),host,event:'blocked'});client.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return;}
  const ready=(upstream,upstreamHead=Buffer.alloc(0))=>{
    track(upstream);client.once('close',()=>upstream.destroy());upstream.once('close',()=>client.destroy());
    upstream.setTimeout(0);transport.push({at:Date.now(),host,event:'connected'});
    console.log('[transport] connected '+host);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if(upstreamHead.length)client.write(upstreamHead);
    if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);
  };
  if(upstreamProxy){
    const request=http.request({hostname:upstreamProxy.hostname,port:upstreamProxy.port||80,method:'CONNECT',path:host+':'+port,timeout:30000});
    request.on('connect',(response,socket,initial)=>{if(response.statusCode!==200){transport.push({at:Date.now(),host,event:'upstream-rejected',status:response.statusCode});socket.destroy();client.destroy();return;}ready(socket,initial);});
    request.on('timeout',()=>request.destroy());request.on('error',error=>{transport.push({at:Date.now(),host,event:'upstream-error',code:error.code});client.destroy();});
    client.once('close',()=>request.destroy());request.end();
  }else{
    const upstream=track(net.connect({host,port}));upstream.setTimeout(30000,()=>upstream.destroy());
    upstream.on('error',error=>{transport.push({at:Date.now(),host,event:'upstream-error',code:error.code});client.destroy();});
    upstream.once('connect',()=>ready(upstream));
  }
});
await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
const proxyURL='http://127.0.0.1:'+proxy.address().port;
const checks=path.join(root,'acceptance.json'),probe=path.join(root,'probe.mjs');
fs.writeFileSync(probe,`import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const root=${JSON.stringify(root)},nonce=${JSON.stringify(nonce)},cwd=${JSON.stringify(workspace)},id=process.argv[2];
assert.ok(['one','two'].includes(id));assert.equal(process.cwd(),cwd);
fs.writeFileSync(path.join(root,id+'.started'),String(Date.now()),{flag:'wx'});
if(id==='one'){const until=Date.now()+180000;while(!fs.existsSync(path.join(root,'release'))){if(Date.now()>until)throw new Error('Outage barrier timeout');await new Promise(r=>setTimeout(r,100));}}
const result={nonce,cwd,id,count:1,answer:42};fs.writeFileSync(path.join(root,id+'.json'),JSON.stringify(result),{flag:'wx'});
console.log(JSON.stringify(result));`);
fs.writeFileSync(checks,JSON.stringify(Object.fromEntries(['one','two'].map((id,i)=>['T00'+(i+1),[{type:'json',path:path.join(root,id+'.json'),equals:{nonce,cwd:workspace,id,count:1,answer:42}}]]))));
const env={...process.env,WORKSPACE_DIR:workspace,ORCH_AGENT:'codex',ORCH_RUN_ID:runId,ORCH_ACCEPTANCE_FILE:checks,ORCH_MAX_POLL_MS:String(durationMs+240000),
  HTTPS_PROXY:proxyURL,HTTP_PROXY:proxyURL,ALL_PROXY:proxyURL,https_proxy:proxyURL,http_proxy:proxyURL,all_proxy:proxyURL,NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'};
delete env.ORCH_STATE_DIR;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){if(check())return;await pause(250);}throw new Error('Timed out: '+label);}
function launch(args,label){
  const child=spawn(process.execPath,[path.join(repo,'scripts','orchestrate-sdk.mjs'),...args],{cwd:workspace,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',ended=false;
  for(const pipe of [child.stdout,child.stderr])pipe.on('data',b=>{output+=b;process.stdout.write('['+label+'] '+b);});
  const done=new Promise(resolve=>{child.once('error',error=>{ended=true;resolve({code:-1,error:error.message});});child.once('close',code=>{ended=true;resolve({code});});});
  const item={child,done,label,ended:()=>ended,output:()=>output};children.push(item);return item;
}
async function finish(item,timeout=180000){await until(item.ended,item.label+' completion',timeout);return item.done;}
console.log(JSON.stringify({root,runId,durationMs}));
try {
  const request=['one','two'].map(id=>`同一项目 outage-validation：执行 node "${probe}" ${id}，执行工具的 workdir 参数必须显式设为 "${workspace}"，不得切换到 probe 所在目录，等待完成后用独立工具调用读回 ${path.join(root,id+'.json')} 核验，按主持命令单独记录检查点，禁止把两个任务合并到一条工具命令，禁止另开窗口禁止提交或写记忆`).join('；');
  const first=launch(['--exec',request],'first');
  await until(()=>fs.existsSync(path.join(root,'one.started'))||first.ended(),'real task startup');
  if(first.ended()||!transport.some(e=>e.event==='connected'))throw new Error('Real provider task did not start through the scoped proxy');
  offline=true;faultStartedAt=Date.now();
  transport.push({at:faultStartedAt,event:'outage-start'});for(const socket of [...sockets])socket.destroy();
  fs.writeFileSync(path.join(root,'release'),'continue');
  console.log('[fault] real TLS tunnels closed; outage active');
  await pause(durationMs);
  faultEndedAt=Date.now();offline=false;transport.push({at:faultEndedAt,event:'outage-end'});
  console.log('[fault] connectivity restored');
  const firstResult=await finish(first,240000);
  const afterOutage=summary();let verifyResult=null,resumeResult=null;
  if(afterOutage&&!afterOutage.success){
    const verify=launch(['--verify-run',runId],'verify');verifyResult=await finish(verify,45000);
    const resume=launch(['--resume-run',runId],'resume');resumeResult=await finish(resume,240000);
  }
  const finalSummary=summary(),receipts=['one','two'].map(id=>read(path.join(root,id+'.json')));
  const snapshot=processSnapshot();
  const closed=!!finalSummary&&Object.values(finalSummary.results).every(r=>!sameProcess(r.launcher,snapshot.get(r.launcher?.ProcessId)));
  const receiptsValid=receipts.every((r,i)=>r?.nonce===nonce&&r.cwd===workspace&&r.id===['one','two'][i]&&r.count===1&&r.answer===42);
  const blockedConnections=transport.filter(e=>e.event==='blocked').length;
  const reconnected=transport.some(e=>e.event==='connected'&&e.at>=faultEndedAt);
  verifyRelease(repo);
  const coreUnchanged=hash()===releaseJsonSha256;
  const passed=durationMs>=300000&&faultEndedAt-faultStartedAt>=durationMs&&blockedConnections>0&&reconnected&&receiptsValid&&finalSummary?.success===true&&closed&&coreUnchanged;
  report={passed,runId,root,durationMs,faultStartedAt,faultEndedAt,blockedConnections,reconnected,receiptsValid,closed,coreUnchanged,releaseJsonSha256,firstResult,verifyResult,resumeResult,afterOutage,summary:finalSummary,receipts,transport};
} catch(error){report={passed:false,runId,root,durationMs,faultStartedAt,faultEndedAt,error:String(error),releaseJsonSha256,summary:summary(),transport};}
finally {
  offline=false;fs.writeFileSync(path.join(root,'release'),'continue');
  // Cancel only this run's owned headless workers through their durable protocol.
  for(const block of Object.values(summary()?.results||{})){
    const file=block.launcherFiles?.lp;
    if(!file||!path.resolve(file).startsWith(path.resolve(runDir)+path.sep))continue;
    const config=read(file);
    if(config?.runId===runId&&config.token===block.token&&config.cancel&&!fs.existsSync(config.files.rf))fs.writeFileSync(config.cancel,'cancel');
  }
  for(const item of children){if(!item.ended())item.child.kill();fs.writeFileSync(path.join(root,item.label+'.log'),item.output());}
  for(const socket of [...sockets])socket.destroy();await new Promise(resolve=>proxy.close(resolve));
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,root,error:report.error,blockedConnections:report.blockedConnections}));process.exitCode=report.passed?0:1;
}

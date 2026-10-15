import {makeTestDir,testTempFamily} from './test-temp-root.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {quoteWindowsArgument,spawnInactiveWindow,spawnInactiveWindowDetached} from '../scripts/core/inactive-window.mjs';
import {trustedWindowsHelper} from '../scripts/core/windows-system.mjs';

const priorControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
const testControllerRoot=fs.mkdtempSync(path.join(os.homedir(),'orch-inactive-window-controller-'));
process.env.ORCH_CONTROLLER_ROOT=testControllerRoot;
after(async()=>{
 if(priorControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=priorControllerRoot;
 await removeTreeWithRetry(testControllerRoot);
});

function withPoisonedPowerShellEnvironment(run) {
 const names=['PSModulePath','ORCH_INACTIVE_WINDOW_AMBIENT'];
 const previous=new Map(names.map(name=>[name,process.env[name]]));
 process.env.PSModulePath='C:\\untrusted\\PowerShell\\Modules';
 process.env.ORCH_INACTIVE_WINDOW_AMBIENT='must-not-reach-helper';
 try{return run();}
 finally {
  for(const name of names) {
   const value=previous.get(name);
   if(value===undefined)delete process.env[name];else process.env[name]=value;
  }
 }
}

function assertNarrowPowerShellEnvironment(options) {
 const env=options.env;
 assert.ok(env,'the helper must receive an explicit environment');
 const keys=Object.keys(env).map(name=>name.toUpperCase());
 const allowed=new Set(['SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','PATH']);
 // The narrow helper environment carries the caller's module analysis cache
 // location when one exists so PowerShell module auto-loading stays fast on
 // hosted images; machines without it keep the exact previous key set.
 if(process.env.PSModuleAnalysisCachePath)allowed.add('PSMODULEANALYSISCACHEPATH');
 assert.equal(keys.some(name=>!allowed.has(name)),false,`unexpected helper environment variables: ${keys.filter(name=>!allowed.has(name)).join(', ')}`);
 assert.equal(keys.includes('PSMODULEPATH'),false,'ambient PSModulePath must not reach the helper');
 assert.equal(keys.includes('ORCH_INACTIVE_WINDOW_AMBIENT'),false,'unrelated parent variables must not reach the helper');
 assert.equal(String(env.WINDIR).toLowerCase(),String(env.SystemRoot).toLowerCase());
 assert.equal(String(env.ComSpec).toLowerCase(),path.join(env.SystemRoot,'System32','cmd.exe').toLowerCase());
 assert.equal(String(env.Path).toLowerCase(),[path.join(env.SystemRoot,'System32'),env.SystemRoot].join(';').toLowerCase(),'the helper PATH must be derived from the trusted system root');
}

async function removeTreeWithRetry(root) {
 for(let attempt=0;;attempt++) {
  try { fs.rmSync(root,{recursive:true,force:true}); return; }
  catch(error) {
   if(!['EBUSY','EPERM','EACCES'].includes(error?.code)||attempt>=30)throw error;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
 }
}

function liveProbeRequest(root,{scriptBytes=Buffer.from('Write-Output "trusted live probe"\n','utf8'),...overrides}={}) {
 const bytes=Buffer.from(scriptBytes);
 return {
  version:3,
  launcher:'explicit-terminal',
  file:process.execPath,
  args:['-e','process.stdout.write("adapter fixture")','中文 空格','a"b'],
  scriptBase64:bytes.toString('base64'),
  scriptSha256:crypto.createHash('sha256').update(bytes).digest('hex'),
  cwd:root,
  ...overrides,
 };
}

test('inactive launch preserves arguments and hides only its short-lived helper',()=>{
 assert.equal(quoteWindowsArgument(''),'""');
 assert.equal(quoteWindowsArgument('a"b'),'"a\\"b"');
 assert.equal(quoteWindowsArgument('C:\\space dir\\'),'"C:\\space dir\\\\"');
 assert.throws(()=>quoteWindowsArgument('\0'),/NUL/);
 let called=0;
 spawnInactiveWindow(process.execPath,['中文 空格','a"b'],process.cwd(),{invoke:(file,args,options)=>{
  called++;assert.match(file,/powershell\.exe$/i);assert.equal(options.windowsHide,true);assert.equal(options.shell,false);
  assert.deepEqual(args.slice(0,5),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File']);
  const payload=JSON.parse(Buffer.from(args.at(-1),'base64').toString('utf8'));
  assert.equal(payload.cwd,process.cwd());assert.equal(payload.file,process.execPath);assert.equal(payload.parameters,'"中文 空格" "a\\"b"');
  return {status:0};
 }});assert.equal(called,1);
});

test('inactive helper passes the target session environment only through a protected controller file',t=>{
 if(process.platform!=='win32')return t.skip('Windows inactive-window contract');
 const secret='inactive-window-session-secret';
 const prior=process.env.ORCH_INACTIVE_TARGET_SECRET;
 process.env.ORCH_INACTIVE_TARGET_SECRET=secret;
 let args,options,environmentFile,sealed;
 try{
  spawnInactiveWindow(process.execPath,[],process.cwd(),{invoke:(_file,received,value)=>{
   args=received;options=value;
   const index=received.indexOf('-EnvironmentFile');
   if(index>=0){environmentFile=received[index+1];sealed=fs.readFileSync(environmentFile,'utf8');}
   return {status:0};
  }});
 }finally{if(prior===undefined)delete process.env.ORCH_INACTIVE_TARGET_SECRET;else process.env.ORCH_INACTIVE_TARGET_SECRET=prior;}
 assertNarrowPowerShellEnvironment(options);
 const fileIndex=args.indexOf('-EnvironmentFile'),tokenIndex=args.indexOf('-EnvironmentToken'),payloadIndex=args.indexOf('-Payload');
 assert.ok(fileIndex>=0,'the helper needs a controller-owned environment payload path');
 assert.ok(tokenIndex>=0,'the helper needs a one-time environment payload binding');
 assert.ok(payloadIndex>=0,'the existing launch payload remains present');
 const relativePayloadPath=path.relative(testControllerRoot,environmentFile);
 assert.equal(path.isAbsolute(relativePayloadPath)||relativePayloadPath==='..'||relativePayloadPath.startsWith('..'+path.sep),false,'the protected payload must stay under the controller root');
 assert.match(args[tokenIndex+1],/^[A-Za-z0-9_-]{43}$/,'the helper binding must be a nonsecret one-time token');
 assert.equal(JSON.stringify(args).includes(secret),false,'target session data must not appear in helper command-line arguments');
 assert.equal(JSON.stringify(JSON.parse(Buffer.from(args[payloadIndex+1],'base64').toString('utf8'))).includes(secret),false,'the existing payload must not carry target session data');
 assert.equal(sealed.includes(secret),false,'the controller payload must not retain target session data in plaintext');
 assert.equal(fs.existsSync(environmentFile),false,'the caller must clean up the protected payload after helper completion');
});

test('inactive helper removes the protected target environment after a synchronous failure',t=>{
 if(process.platform!=='win32')return t.skip('Windows inactive-window contract');
 const secret='inactive-window-failure-secret';
 const prior=process.env.ORCH_INACTIVE_FAILURE_SECRET;
 process.env.ORCH_INACTIVE_FAILURE_SECRET=secret;
 let environmentFile,error;
 try{
  spawnInactiveWindow(process.execPath,[],process.cwd(),{invoke:(_file,args)=>{
   environmentFile=args[args.indexOf('-EnvironmentFile')+1];
   return {status:1,stderr:secret};
  }});
 }catch(caught){error=caught;}
 finally{if(prior===undefined)delete process.env.ORCH_INACTIVE_FAILURE_SECRET;else process.env.ORCH_INACTIVE_FAILURE_SECRET=prior;}
 assert.match(error?.message||'',/INACTIVE_WINDOW_LAUNCH_FAILED/);
 assert.equal(error.message.includes(secret),false,'helper diagnostics must not expose target session values');
 assert.equal(fs.existsSync(environmentFile),false,'a synchronous helper failure must remove its protected payload');
});

test('inactive window helper excludes ambient PowerShell module paths',t=>{
 if(process.platform!=='win32')return t.skip('Windows inactive-window contract');
 let options;
 withPoisonedPowerShellEnvironment(()=>spawnInactiveWindow(process.execPath,[],process.cwd(),{invoke:(_file,_args,value)=>{
  options=value;return {status:0};
 }}));
 assertNarrowPowerShellEnvironment(options);
});

test('detached inactive window helper excludes ambient PowerShell module paths',t=>{
 if(process.platform!=='win32')return t.skip('Windows inactive-window contract');
 const child=Object.assign(new EventEmitter(),{unref(){}});
 let options;
 withPoisonedPowerShellEnvironment(()=>spawnInactiveWindowDetached(process.execPath,[],process.cwd(),{invoke:(_file,_args,value)=>{
  options=value;return child;
 }}));
 assertNarrowPowerShellEnvironment(options);
 child.emit('exit',0);
});
test('inactive launch fails explicitly instead of falling back to a focusing window',()=>{
 assert.throws(()=>spawnInactiveWindow('missing',[],'D:\\',{invoke:()=>({status:1,stderr:'failed'})}),/INACTIVE_WINDOW_LAUNCH_FAILED/);
});
test('focus guard keeps the initiating window while typing unless the user actually switched focus',()=>{
 const source=fs.readFileSync(new URL('../scripts/core/inactive-window.ps1',import.meta.url),'utf8');
 assert.match(source,/if\(now\.dwTime!=baselineInput&&GetForegroundWindow\(\)!=baseline\)break/,
  'typing alone must not cancel focus restoration while the initiating window remains foreground');
 assert.match(source,/\[Console\]::OutputEncoding\s*=\s*\[Text\.UTF8Encoding\]::new\(\$false\)/,
  'PowerShell diagnostics must use UTF-8 output');
  assert.match(source,/\$OutputEncoding\s*=\s*\[Text\.UTF8Encoding\]::new\(\$false\)/,
  'PowerShell pipeline output must use UTF-8');
  assert.match(source,/System32\\chcp\.com/,
  'the encoding helper must be resolved from the Windows system directory');
  assert.doesNotMatch(source,/(?<![$\\.\w])chcp\s+65001/,
  'workspace current-directory executables must not shadow chcp');
});

test('controlled focus probe exposes opt-in input diagnostics',()=>{
 const source=fs.readFileSync(new URL('./live-inactive-window.ps1',import.meta.url),'utf8');
 assert.match(source,/\[switch\]\$ContinuousInput/,
  'the live probe must expose an explicit opt-in continuous-input mode');
 assert.match(source,/inputDelivered/,
  'the live probe must report whether input reached the initiating window');
 assert.match(source,/inputLostFocus/,
  'the live probe must report whether the initiating window lost focus');
 assert.match(source,/\[Console\]::OutputEncoding\s*=\s*\[Text\.UTF8Encoding\]::new\(\$false\)/,
  'live probe output must use UTF-8');
 assert.match(source,/\$OutputEncoding\s*=\s*\[Text\.UTF8Encoding\]::new\(\$false\)/,
  'live probe pipeline output must use UTF-8');
});

test('live inactive-window probe sends its bounded launch request on stdin without a request-file protocol',()=>{
 const source=fs.readFileSync(new URL('./live-inactive-window.ps1',import.meta.url),'utf8');
 assert.match(source,/live-inactive-window-adapter\.mjs/,
  'the probe must call its dedicated Node adapter');
 assert.match(source,/RedirectStandardInput\s*=\s*\$true/,
  'the adapter request must cross the process boundary through stdin');
 assert.match(source,/StandardInputEncoding\s*=\s*\[Text\.UTF8Encoding\]::new\(\$false\)/,
  'the structured request must retain non-ASCII workspace and target values across stdin');
 assert.match(source,/\$helper\.StandardInput\.Write\(\$requestJson\)/,
  'the bounded request JSON must be written to the adapter stdin');
 assert.match(source,/Set-InactiveProbeArguments \$start @\(\$adapter\)/,
  'the adapter command line must carry only the adapter path');
 assert.doesNotMatch(source,/(?:launch-request\.json|--request-file|request-file)/i,
  'the workspace request-file protocol must be removed entirely');
 assert.doesNotMatch(source,/Get-Command\s+node\.exe/i,
  'the probe must not discover Node through PATH');
 assert.match(source,/\[string\]\$NodePath/,
  'the probe must expose an explicit Node executable override');
 assert.match(source,/SHGetKnownFolderPath/,
  'the default Codex runtime location must be derived from Windows known-folder APIs');
 assert.match(source,/\$start\.EnvironmentVariables\.Clear\(\)/,
  'the Node adapter process must start with a controlled environment');
 assert.match(source,/LOCALAPPDATA=\$localAppData/,
  'the controlled Node environment must pin LOCALAPPDATA from the known folder');
 assert.match(source,/USERPROFILE=\$profile/,
  'the controlled Node environment must pin Node\'s controller-home lookup to the Windows known profile folder');
 assert.doesNotMatch(source,/\$env:SystemRoot/i,
  'the probe must not build system helper paths from mutable environment variables');
 assert.doesNotMatch(source,/powershell\.exe/i,
  'the probe must delegate all PowerShell helper resolution to the Node trust boundary');
 assert.doesNotMatch(source,/scripts\\core\\inactive-window\.ps1/i,
  'the probe must not bypass the production Node API with the stale PowerShell helper interface');
 assert.doesNotMatch(source,/\$payload\b/i,
  'the probe must not put the target request into a base64 command-line payload');
 assert.doesNotMatch(source,/(?:\$probe\s*=|probe\.ps1)/i,
  'the probe script bytes must remain in the parent process until they enter the controlled adapter channel');
 assert.match(source,/\$receiptNonce=\[Guid\]::NewGuid\(\)\.ToString\('N'\)/,
  'the protected receipt must carry an unpredictable binding that is never written to a workspace script');
 assert.match(source,/\$receiptData\.nonce -ceq \$receiptNonce/,
  'the probe must reject a prewritten receipt that lacks the private binding');
 assert.match(source,/Get-InactiveProbeArtifacts/,
  'the adapter must allocate protected receipt and report paths before the probe reads or writes either artifact');
 assert.match(source,/Get-Content -LiteralPath \$receiptPath -Raw/,
  'the receipt must be read only from the adapter-provided protected path');
 assert.match(source,/\[IO\.File\]::WriteAllText\(\$reportPath,\$json/,
  'the authoritative report must be written only to the adapter-provided protected path');
 assert.doesNotMatch(source,/Join-Path \$Workspace \('temp\\inactive-window-/i,
  'the workspace must not host a live-probe artifact directory');
 assert.doesNotMatch(source,/Join-Path \$root '(?:receipt|report)\.json'/i,
  'workspace artifacts must never be used as receipt or report authority');
 assert.ok(source.indexOf('$ContinuousInput -and')<source.indexOf('$Workspace=Resolve-InactiveProbeLocalPath'),
  'the noninteractive skip path must exit before touching the workspace');
 assert.doesNotMatch(source,/(?:^|[^.\\\w])chcp(?:\s|$)/im,
  'the probe must not resolve an optional encoding executable from PATH before the no-TUI guard');
 const adapter=fs.readFileSync(new URL('./live-inactive-window-adapter.mjs',import.meta.url),'utf8');
 assert.match(adapter,/import\s+\{\s*spawnInactiveWindow\s*\}\s+from\s+'\.\.\/scripts\/core\/inactive-window\.mjs'/,
  'the adapter must use the production inactive-window API');
 assert.match(adapter,/import\s+\{\s*isWindowsTerminalAlias,\s*resolveWindowsTerminalExecutable\s*\}\s+from\s+'\.\.\/scripts\/core\/windows-terminal\.mjs'/,
  'the adapter must use the shared Windows Terminal resolver rather than reconstructing an alias path');
 assert.match(adapter,/trustedWindowsHelper/,
  'console modes must resolve PowerShell and conhost through the trusted production helper');
 assert.match(adapter,/readBoundedStdin\(process\.stdin\)/,
  'the command-line adapter must read its request only from bounded stdin');
 assert.doesNotMatch(adapter,/readFileSync\(0,\s*'utf8'\)/,
  'the command-line adapter must never buffer stdin until EOF without a size limit');
 assert.doesNotMatch(adapter,/(?:--request-file|requestFileFromArguments|request-file)/i,
  'the adapter must have no replacement-file command-line surface');
 assert.doesNotMatch(adapter,/WindowsApps/,
  'the adapter must not carry an independent WindowsApps alias fallback');
 assert.doesNotMatch(adapter,/node:child_process/,
  'the adapter must not create a separate launch path outside the production API');
});

test('live inactive-window adapter allocates receipt and report authority outside the workspace',async()=>{
 const workspace=makeTestDir('live-inactive-window-authority-workspace');
 const protectedArtifacts=makeTestDir('live-inactive-window-authority-controller');
 const request=liveProbeRequest(workspace);
 try{
  const adapter=await import(new URL('./live-inactive-window-adapter.mjs',import.meta.url));
  let received;
  const observed=adapter.launchLiveInactiveWindowRequest(JSON.stringify(request),{
   scriptDirectory:protectedArtifacts,artifactDirectory:protectedArtifacts,
   resolveSystemHelper:()=>process.execPath,
   launch:(file,args,cwd)=>{received={file,args,cwd};},
  });
  assert.equal(received.cwd,workspace);
  assert.equal(path.dirname(observed.script),protectedArtifacts);
  assert.equal(path.dirname(observed.receipt),protectedArtifacts,
   'the execution receipt must be allocated under the protected controller directory');
  assert.equal(path.dirname(observed.report),protectedArtifacts,
   'the authoritative report must be allocated under the protected controller directory');
  assert.notEqual(observed.receipt,observed.report);
  assert.equal(path.relative(workspace,observed.receipt).startsWith('..'+path.sep),true,
   'the workspace must not be able to supply the receipt path');
  assert.equal(path.relative(workspace,observed.report).startsWith('..'+path.sep),true,
   'the workspace must not be able to supply the report path');
  assert.equal(fs.statSync(observed.receipt).isFile(),true);
  assert.equal(fs.statSync(observed.report).isFile(),true);
  assert.equal(fs.readFileSync(observed.receipt).length,0,
   'the adapter must reserve the receipt before the target process starts');
  assert.equal(fs.readFileSync(observed.report).length,0,
   'the adapter must reserve the report before the parent probe writes it');
  const receiptFlag=received.args.indexOf('-ReceiptPath');
  assert.ok(receiptFlag>=0,'only the protected receipt path may reach the target script');
  assert.equal(received.args[receiptFlag+1],observed.receipt);
  assert.equal(received.args.includes(observed.report),false,
   'the target process must not choose or write the authoritative report');
  assert.equal(fs.existsSync(path.join(workspace,'receipt.json')),false);
  assert.equal(fs.existsSync(path.join(workspace,'report.json')),false);
  assert.equal(fs.existsSync(path.join(workspace,'temp')),false,
   'the workspace must have no probe-output directory');
 }finally{
  fs.rmSync(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  fs.rmSync(protectedArtifacts,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 }
});

test('live inactive-window adapter removes protected authority artifacts when launch admission fails',async()=>{
 const workspace=makeTestDir('live-inactive-window-authority-failure-workspace');
 const protectedArtifacts=makeTestDir('live-inactive-window-authority-failure-controller');
 try{
  const adapter=await import(new URL('./live-inactive-window-adapter.mjs',import.meta.url));
  assert.throws(()=>adapter.launchLiveInactiveWindowRequest(JSON.stringify(liveProbeRequest(workspace)),{
   scriptDirectory:protectedArtifacts,artifactDirectory:protectedArtifacts,
   resolveSystemHelper:()=>process.execPath,
   launch:()=>{throw new Error('fixture launch refusal');},
  }),/fixture launch refusal/);
  assert.deepEqual(fs.readdirSync(protectedArtifacts),[],
   'a rejected launch must not retain a protected script, receipt, or report');
 }finally{
  fs.rmSync(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  fs.rmSync(protectedArtifacts,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 }
});

test('live inactive-window adapter accepts a bounded stdin request and preserves the structured target vector without launching a TUI',async()=>{
 const root=makeTestDir('live-inactive-window-adapter');
 const protectedScripts=makeTestDir('live-inactive-window-adapter-controller');
 const request=liveProbeRequest(root);
 try{
  const adapter=await import(new URL('./live-inactive-window-adapter.mjs',import.meta.url));
  let calls=0,received;
  const observed=adapter.launchLiveInactiveWindowRequest(JSON.stringify(request),{launch:(file,args,cwd)=>{
   calls++;received={file,args,cwd};
  },resolveSystemHelper:()=>process.execPath,scriptDirectory:protectedScripts});
  assert.equal(calls,1,'the adapter must delegate exactly once through its injected production API boundary');
  assert.deepEqual(received,{file:request.file,args:[...request.args,process.execPath,'-NoProfile','-File',observed.script,'-ReceiptPath',observed.receipt],cwd:request.cwd});
  assert.equal(observed.launcher,request.launcher);
  assert.equal(observed.file,request.file);
  assert.equal(observed.cwd,request.cwd);
  assert.equal(path.dirname(observed.script),protectedScripts,'the executable probe script must be materialized outside the workspace');
  assert.deepEqual(fs.readFileSync(observed.script),Buffer.from(request.scriptBase64,'base64'));

  assert.throws(()=>adapter.readLiveInactiveWindowRequest(JSON.stringify({...request,unexpected:true})),/LIVE_INACTIVE_WINDOW_REQUEST_INVALID/,
   'extra schema keys must not enter the launch boundary');
  assert.throws(()=>adapter.readLiveInactiveWindowRequest('x'.repeat(128*1024+1)),/LIVE_INACTIVE_WINDOW_REQUEST_INVALID/,
   'stdin request size must be bounded before JSON parsing');

  const replacementFile=path.join(root,'replacement-request.json');
  fs.writeFileSync(replacementFile,'replacement data that must never be interpreted as a launch request','utf8');
  assert.throws(()=>adapter.launchLiveInactiveWindowRequest(replacementFile,{launch:()=>{calls++;}}),/LIVE_INACTIVE_WINDOW_REQUEST_INVALID/,
   'a replacement file name is data, not an adapter request protocol');
  assert.equal(calls,1,'a rejected replacement-file value must not reach launch');
  const adapterPath=fileURLToPath(new URL('./live-inactive-window-adapter.mjs',import.meta.url));
  const obsolete=spawnSync(process.execPath,[adapterPath,'--request-file',replacementFile],{input:JSON.stringify(request),encoding:'utf8',windowsHide:true,timeout:5000});
  assert.equal(obsolete.status,1,'obsolete request-file command-line arguments must be rejected before launch');
  assert.match(obsolete.stderr,/LIVE_INACTIVE_WINDOW_ADAPTER_FAILED/);
 }finally{
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  fs.rmSync(protectedScripts,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 }
});

test('live inactive-window adapter binds probe bytes outside a workspace before a replacement can forge the launch receipt',async()=>{
 const workspace=makeTestDir('live-inactive-window-script-race-workspace');
 const protectedScripts=makeTestDir('live-inactive-window-script-race-controller');
 const source=path.join(workspace,'temp','probe.ps1');fs.mkdirSync(path.dirname(source),{recursive:true});
 const original=Buffer.from("@{executed=$true;receipt='trusted'} | ConvertTo-Json\n",'utf8');
 fs.writeFileSync(source,original);
 const request=liveProbeRequest(workspace,{scriptBytes:original});
 try{
  const adapter=await import(new URL('./live-inactive-window-adapter.mjs',import.meta.url));
  let received;
  const observed=adapter.launchLiveInactiveWindowRequest(JSON.stringify(request),{
   scriptDirectory:protectedScripts,
   resolveSystemHelper:()=>process.execPath,
   launch:(file,args,cwd)=>{
    received={file,args,cwd};
    fs.writeFileSync(source,"@{executed=$true;receipt='forged'} | ConvertTo-Json\n",'utf8');
   },
  });
  const launchedScript=received.args[received.args.indexOf('-File')+1];
  assert.equal(received.cwd,workspace);
  assert.notEqual(path.resolve(launchedScript),path.resolve(source),'the launch boundary must never receive the workspace-writable script path');
  assert.equal(path.dirname(launchedScript),protectedScripts,'the launch boundary must receive only the controller-owned script copy');
  assert.equal(JSON.stringify(received.args).includes(source),false,'the workspace script path must never reach the target process arguments');
  assert.deepEqual(fs.readFileSync(launchedScript),original,'a replacement after validation must not change executable probe bytes');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(launchedScript)).digest('hex'),request.scriptSha256);
  assert.equal(observed.script,launchedScript);

  const tampered={...request,scriptBase64:Buffer.from("@{executed=$true;receipt='forged'}\n",'utf8').toString('base64')};
  assert.throws(()=>adapter.launchLiveInactiveWindowRequest(JSON.stringify(tampered),{
   scriptDirectory:protectedScripts,resolveSystemHelper:()=>process.execPath,launch:()=>{throw new Error('must not launch');},
  }),/LIVE_INACTIVE_WINDOW_REQUEST_INVALID/,'a digest mismatch must fail before any launch');
 }finally{
  fs.rmSync(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  fs.rmSync(protectedScripts,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 }
});

test('live inactive-window adapter defaults its executable probe copy to protected controller storage',async t=>{
 if(process.platform!=='win32')return t.skip('Windows controller storage contract');
 const workspace=makeTestDir('live-inactive-window-controller-workspace');
 const request=liveProbeRequest(workspace);
 let script,receipt,report;
 try{
  const adapter=await import(new URL('./live-inactive-window-adapter.mjs',import.meta.url));
  const observed=adapter.launchLiveInactiveWindowRequest(JSON.stringify(request),{
   resolveSystemHelper:()=>process.execPath,
  launch:(_file,args)=>{script=args[args.indexOf('-File')+1];},
  });
  const relative=path.relative(testControllerRoot,script);
  assert.equal(path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep),false,
   'the default materialized script must stay below the private controller root');
  assert.equal(path.relative(workspace,script).startsWith('..'+path.sep),true,
   'the executable script must not be stored inside the writable workspace');
  assert.equal(observed.script,script);
  assert.deepEqual(fs.readFileSync(script),Buffer.from(request.scriptBase64,'base64'));
   receipt=observed.receipt;report=observed.report;
   for(const [label,file] of [['receipt',receipt],['report',report]]){
    const artifactRelative=path.relative(testControllerRoot,file);
    assert.equal(path.isAbsolute(artifactRelative)||artifactRelative==='..'||artifactRelative.startsWith('..'+path.sep),false,
     `the default ${label} must stay below the private controller root`);
    assert.equal(path.relative(workspace,file).startsWith('..'+path.sep),true,
     `the default ${label} must not be stored inside the writable workspace`);
    assert.equal(fs.statSync(file).size,0,`the adapter must reserve the default ${label} before launch`);
   }
 }finally{
  for(const file of [script,receipt,report])if(file)fs.rmSync(file,{force:true});
  fs.rmSync(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 }
});

test('live inactive-window adapter rejects oversized stdin before EOF without launching a TUI',async()=>{
 const adapterPath=fileURLToPath(new URL('./live-inactive-window-adapter.mjs',import.meta.url));
 const child=spawn(process.execPath,[adapterPath],{stdio:['pipe','ignore','pipe'],windowsHide:true});
 const stderr=[];let endedByTest=false;
 child.stderr.on('data',chunk=>stderr.push(Buffer.from(chunk)));
 child.stdin.on('error',()=>{});
 try{
  const exited=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('adapter waited for stdin EOF after its byte limit was exceeded')),3000);
   child.once('error',error=>{clearTimeout(timer);reject(error);});
   child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
  });
  child.stdin.write(Buffer.alloc(128*1024+1,0x78));
  const result=await exited;
  assert.equal(endedByTest,false,'the test must keep stdin open until the adapter exits');
  assert.equal(result.code,1,'an oversized request must fail before it can reach the launch boundary');
  assert.match(Buffer.concat(stderr).toString('utf8'),/LIVE_INACTIVE_WINDOW_ADAPTER_FAILED/);
 }finally{
  endedByTest=true;
  try{child.stdin.destroy();}catch{}
  if(child.exitCode===null)child.kill();
 }
});

test('live inactive-window adapter resolves trusted terminal and console helpers while rejecting unsafe Windows path forms',async()=>{
 const root=makeTestDir('live-inactive-window-terminal-resolver');
 const protectedScripts=makeTestDir('live-inactive-window-terminal-resolver-controller');
 const request=liveProbeRequest(root,{launcher:'windows-terminal',file:null,args:['-w','adapter-fixture']});
 try{
  const adapter=await import(new URL('./live-inactive-window-adapter.mjs',import.meta.url));
  let resolveCalls=0,launchCalls=0,received;
  const observed=adapter.launchLiveInactiveWindowRequest(JSON.stringify(request),{
   resolveTerminal:()=>{resolveCalls++;return process.execPath;},
   resolveSystemHelper:()=>process.execPath,
   scriptDirectory:protectedScripts,
   launch:(file,args,cwd)=>{launchCalls++;received={file,args,cwd};},
  });
  assert.equal(resolveCalls,1,'the default Windows Terminal path must come from the shared resolver');
  assert.equal(launchCalls,1);
  assert.deepEqual(received,{file:process.execPath,args:[...request.args,process.execPath,'-NoProfile','-File',observed.script,'-ReceiptPath',observed.receipt],cwd:request.cwd});
  assert.equal(observed.file,process.execPath);

  const helperNames=[];
  const systemConsole={...request,launcher:'system-console',file:null,args:[]};
  const observedSystem=adapter.launchLiveInactiveWindowRequest(JSON.stringify(systemConsole),{
   resolveSystemHelper:name=>{helperNames.push(name);return process.execPath;},
   scriptDirectory:protectedScripts,
   launch:(file,args,cwd)=>{received={file,args,cwd};},
  });
  assert.deepEqual(helperNames,['powershell'],'the system console mode must ask the trusted helper boundary for PowerShell');
  assert.deepEqual(received,{file:process.execPath,args:['-NoProfile','-File',observedSystem.script,'-ReceiptPath',observedSystem.receipt],cwd:request.cwd});

  helperNames.length=0;
  const legacyConsole={...request,launcher:'legacy-console',file:null,args:[]};
  const observedLegacy=adapter.launchLiveInactiveWindowRequest(JSON.stringify(legacyConsole),{
   resolveSystemHelper:name=>{helperNames.push(name);return process.execPath;},
   scriptDirectory:protectedScripts,
   launch:(file,args,cwd)=>{received={file,args,cwd};},
  });
  assert.deepEqual(helperNames,['powershell','conhost'],'the legacy console mode must use the same trusted helper boundary for PowerShell and conhost');
  assert.deepEqual(received,{file:process.execPath,args:[process.execPath,'-NoProfile','-File',observedLegacy.script,'-ReceiptPath',observedLegacy.receipt],cwd:request.cwd});

  const alias=path.join(process.env.LOCALAPPDATA||'C:\\Users\\fixture\\AppData\\Local','Microsoft','WindowsApps','wt.exe');
  let aliasLaunches=0;
  assert.throws(()=>adapter.launchLiveInactiveWindowRequest(JSON.stringify(request),{
   resolveTerminal:()=>alias,
   resolveSystemHelper:()=>process.execPath,
   isTerminalAlias:value=>value===alias,
   scriptDirectory:protectedScripts,
   launch:()=>{aliasLaunches++;},
  }),/LIVE_INACTIVE_WINDOW_REQUEST_INVALID/);
  assert.equal(aliasLaunches,0,'an App Execution Alias must not reach the production launch boundary');

  for(const unsafe of ['\\\\server\\share\\probe','\\Windows\\System32\\cmd.exe','\\\\?\\C:\\Windows\\System32\\cmd.exe','C:\\Windows\\System32\\cmd.exe:stream']){
   assert.throws(()=>adapter.launchLiveInactiveWindowRequest(JSON.stringify({...request,launcher:'explicit-terminal',file:unsafe}),{
    resolveSystemHelper:()=>process.execPath,
    scriptDirectory:protectedScripts,
    launch:()=>{aliasLaunches++;},
   }),/LIVE_INACTIVE_WINDOW_REQUEST_INVALID/,`unsafe explicit target must be rejected: ${unsafe}`);
   assert.throws(()=>adapter.launchLiveInactiveWindowRequest(JSON.stringify({...request,cwd:unsafe}),{
    resolveSystemHelper:()=>process.execPath,
    scriptDirectory:protectedScripts,
    launch:()=>{aliasLaunches++;},
   }),/LIVE_INACTIVE_WINDOW_REQUEST_INVALID/,`unsafe cwd must be rejected: ${unsafe}`);
  }
  assert.throws(()=>adapter.launchLiveInactiveWindowRequest(JSON.stringify({...request,launcher:'explicit-terminal',file:root}),{
   resolveSystemHelper:()=>process.execPath,
   scriptDirectory:protectedScripts,
   launch:()=>{aliasLaunches++;},
  }),/LIVE_INACTIVE_WINDOW_REQUEST_INVALID/,'an explicit target must be a regular file');
  assert.equal(aliasLaunches,0,'rejected Windows path forms must never reach launch');
 }finally{
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  fs.rmSync(protectedScripts,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 }
});

test('live inactive-window probe resolves the Codex primary runtime without a poisoned PATH node candidate',{skip:process.platform!=='win32'},()=>{
 const root=makeTestDir('live-inactive-window-poisoned-path');
 const poison=path.join(root,'poison');fs.mkdirSync(poison);
 fs.writeFileSync(path.join(poison,'node.exe'),'not a Node executable','utf8');
 const chcpMarker=path.join(root,'poisoned-chcp-ran.txt');
 fs.writeFileSync(path.join(poison,'chcp.cmd'),`@echo poisoned> "${chcpMarker}"\r\n`,'ascii');
 const script=fileURLToPath(new URL('./live-inactive-window.ps1',import.meta.url));
 try{
  const result=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-MTA','-ExecutionPolicy','Bypass','-File',script,'-ContinuousInput'],{
   cwd:root,encoding:'utf8',windowsHide:true,timeout:15000,
   env:{SystemRoot:process.env.SystemRoot||process.env.WINDIR,WINDIR:process.env.SystemRoot||process.env.WINDIR,ComSpec:path.join(process.env.SystemRoot||process.env.WINDIR,'System32','cmd.exe'),PATHEXT:'.COM;.EXE;.BAT;.CMD',Path:poison,PATH:poison,LOCALAPPDATA:process.env.LOCALAPPDATA||'',...(process.env.PSModuleAnalysisCachePath?{PSModuleAnalysisCachePath:process.env.PSModuleAnalysisCachePath}:{})},
  });
  assert.equal(result.status,0,`the noninteractive MTA guard must exit before any TUI launch: ${result.stderr}`);
  const report=JSON.parse(String(result.stdout).trim());
  assert.equal(report.skipped,true);
  assert.equal(path.basename(report.nodePath).toLowerCase(),'node.exe');
  assert.notEqual(path.normalize(report.nodePath).toLowerCase(),path.join(poison,'node.exe').toLowerCase(),
   'the deterministic Codex runtime path must win even when PATH is poisoned');
  assert.equal(fs.existsSync(chcpMarker),false,'the no-TUI guard must not execute a PATH-resolved chcp.cmd before it reports its skip');
  assert.equal(fs.existsSync(path.join(root,'temp')),false,
   'the noninteractive skip path must report only on stdout and must not create workspace probe artifacts');

  const rejected=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-MTA','-ExecutionPolicy','Bypass','-File',script,'-NodePath','\\\\server\\share\\node.exe','-ContinuousInput'],{
   cwd:root,encoding:'utf8',windowsHide:true,timeout:15000,
   env:{SystemRoot:process.env.SystemRoot||process.env.WINDIR,WINDIR:process.env.SystemRoot||process.env.WINDIR,ComSpec:path.join(process.env.SystemRoot||process.env.WINDIR,'System32','cmd.exe'),PATHEXT:'.COM;.EXE;.BAT;.CMD',Path:poison,PATH:poison,LOCALAPPDATA:process.env.LOCALAPPDATA||'',...(process.env.PSModuleAnalysisCachePath?{PSModuleAnalysisCachePath:process.env.PSModuleAnalysisCachePath}:{})},
  });
  assert.notEqual(rejected.status,0,'an unsafe NodePath must fail before the no-TUI MTA guard can complete');
  assert.match(String(rejected.stderr),/local drive-qualified path/i);
 }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});

test('asynchronous inactive launch preserves a hidden console for PowerShell',async()=>{
 let called=0,unref=0;
 const child=Object.assign(new EventEmitter(),{unref(){unref++;}});
 const result=spawnInactiveWindowDetached(process.execPath,['-w','win-x'],process.cwd(),{invoke:(file,args,options)=>{
  called++;assert.match(file,/powershell\.exe$/i);assert.notEqual(options.detached,true);assert.equal(options.windowsHide,true);assert.equal(options.stdio,'ignore');
  const payload=JSON.parse(Buffer.from(args.at(-1),'base64').toString('utf8'));
  assert.equal(payload.file,process.execPath);assert.equal(payload.cwd,process.cwd());assert.equal(payload.parameters,'"-w" "win-x"');
  return child;
 }});
 assert.equal(result,child);assert.equal(called,1);assert.equal(unref,0);
 child.emit('exit',0);
 assert.deepEqual(await result.launchResult,{ok:true});
});

test('a fresh controller stays alive until asynchronous helper startup settles',{skip:process.platform!=='win32'},()=>{
 const module=new URL('../scripts/core/inactive-window.mjs',import.meta.url).href;
 const source=`import {spawnInactiveWindowDetached} from ${JSON.stringify(module)};const helper=spawnInactiveWindowDetached(process.execPath,['-e',''],process.cwd());if(!(await helper.launchResult).ok)throw new Error('launch failed');console.log('launch settled');`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:process.cwd(),windowsHide:true,encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/launch settled/);
});

test('real asynchronous helper executes its payload before reporting success',{skip:process.platform!=='win32'},async()=>{
 const family=testTempFamily('inactive-window');fs.mkdirSync(family,{recursive:true});
 const root=fs.mkdtempSync(path.join(family,'launch-helper-')),receipt=path.join(root,'receipt.json');
 const environmentName='ORCH_INACTIVE_TARGET_SESSION',environmentValue='visible-session-survives';
 const prior=process.env[environmentName];process.env[environmentName]=environmentValue;
 let child;
 try {
  child=spawnInactiveWindowDetached(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify({nonce:'owned-probe',cwd:process.cwd(),session:process.env[${JSON.stringify(environmentName)}]}))`],root);
  child.ref();
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('helper exit '+code)));});
  const end=Date.now()+3000;while(!fs.existsSync(receipt)&&Date.now()<end)await new Promise(r=>setTimeout(r,25));
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt,'utf8')),{nonce:'owned-probe',cwd:root,session:environmentValue});
  const environmentDirectory=path.join(testControllerRoot,'inactive-window-environments');
  assert.deepEqual(fs.existsSync(environmentDirectory)?fs.readdirSync(environmentDirectory):[],[],'a successful helper must remove its protected payload');
 }finally{
  if(child&&child.exitCode===null)child.kill();await removeTreeWithRetry(root);
  if(prior===undefined)delete process.env[environmentName];else process.env[environmentName]=prior;
 }
});

test('asynchronous helper reports spawn and native launch errors',async()=>{
 const missing=spawnInactiveWindowDetached(process.execPath,[],process.cwd(),{invoke:(_f,_a,options)=>spawn('orchestrator-intentionally-missing-executable',[],options)});
 missing.ref();assert.match((await missing.launchResult).error,/ENOENT/);
 const environmentDirectory=path.join(testControllerRoot,'inactive-window-environments');
 assert.deepEqual(fs.existsSync(environmentDirectory)?fs.readdirSync(environmentDirectory):[],[],'a failed helper spawn must remove its protected payload');
 const failed=Object.assign(new EventEmitter(),{unref(){}});
 const result=spawnInactiveWindowDetached(process.execPath,[],process.cwd(),{invoke:()=>failed});
 failed.emit('exit',1);assert.deepEqual(await result.launchResult,{ok:false,error:'helper exited with code 1'});
 assert.deepEqual(fs.existsSync(environmentDirectory)?fs.readdirSync(environmentDirectory):[],[],'a failed helper exit must remove its protected payload');
});

test('a synchronous detached helper-start failure removes its protected target environment',t=>{
 if(process.platform!=='win32')return t.skip('Windows inactive-window contract');
 const secret='inactive-window-detached-start-secret';
 const prior=process.env.ORCH_INACTIVE_DETACHED_START_SECRET;
 process.env.ORCH_INACTIVE_DETACHED_START_SECRET=secret;
 let environmentFile,error;
 try{
  spawnInactiveWindowDetached(process.execPath,[],process.cwd(),{invoke:(_file,args)=>{
   environmentFile=args[args.indexOf('-EnvironmentFile')+1];
   const failure=Object.assign(new Error(secret),{code:'ENOENT'});
   throw failure;
  }});
 }catch(caught){error=caught;}
 finally{if(prior===undefined)delete process.env.ORCH_INACTIVE_DETACHED_START_SECRET;else process.env.ORCH_INACTIVE_DETACHED_START_SECRET=prior;}
 assert.match(error?.message||'',/INACTIVE_WINDOW_LAUNCH_FAILED: helper could not start ENOENT/);
 assert.equal(error.message.includes(secret),false,'a helper-start error must not expose target session values');
 assert.equal(fs.existsSync(environmentFile),false,'a synchronous helper-start failure must remove its protected payload');
});

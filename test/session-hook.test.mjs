import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const windows=process.platform==='win32';
const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const event={session_id:'fixture-session',transcript_path:null,cwd:'C:\\workspace',hook_event_name:'SessionStart',source:'startup',model:'fixture',permission_mode:'default'};
// This is a fixture deadline, separate from the production hook's 110-second
// preparation limit.  A cold Windows PowerShell can spend almost three seconds
// starting its module infrastructure before this deliberately small bootstrap
// fixture runs.
const fixturePrepareTimeoutSeconds=10;
const sessionHookOuterTimeoutMs=45000;
// The one-second child deadline is verified separately below.  This outer
// wall-clock bound also includes a fresh Windows PowerShell startup.
const timeoutCaseCompletionBoundMs=30000;
const timeoutCaseOwnedProcessDeadlineSeconds=1;
const success="param([string]$Action,[switch]$Json,[int]$TimeoutSeconds)\n[Console]::OutputEncoding=[Text.Encoding]::UTF8\n[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'called.json'),(@{Action=$Action;Json=[bool]$Json;TimeoutSeconds=$TimeoutSeconds}|ConvertTo-Json),[Text.Encoding]::UTF8)\n@{ok=$true;stage='ready';nodeVersion='22.0.0';sdkVersion='0.149.0';cliPath='fixture';agent='codex'}|ConvertTo-Json -Compress\n";
function fixture(t,bootstrap=success,{observeOwnedPid=false}={}){
  assert.ok(fs.existsSync(path.join(root,'hooks','session-start.ps1')),'SessionStart preparation hook must exist');
  const base=path.join(process.env.USERPROFILE||os.homedir(),'workspace','temp');fs.mkdirSync(base,{recursive:true});
  const dir=fs.mkdtempSync(path.join(base,"orch-hook 中文 '& "));
  for(const folder of ['scripts','hooks'])fs.mkdirSync(path.join(dir,folder));
  for(const name of ['session-start.ps1','hooks.json'])fs.copyFileSync(path.join(root,'hooks',name),path.join(dir,'hooks',name));
  const runtimePath=path.join(root,'scripts','runtime-bootstrap.ps1'),fixtureRuntime=path.join(dir,'scripts','runtime-bootstrap.ps1');
  if(observeOwnedPid){
    // Production only exposes the child PID inside Invoke-OrchProcess.  Copy
    // its real implementation and add a fixture-only observation immediately
    // after Process.Start(), before the one-second deadline can race PowerShell
    // script initialization.  The timeout and taskkill paths remain unchanged.
    const runtime=fs.readFileSync(runtimePath,'utf8');
    const observed=runtime.replace(
      /(\s+\[void\]\$process\.Start\(\)\r?\n)(\s+\$stdout = \$process\.StandardOutput\.ReadToEndAsync\(\))/,
      '$1        if ($env:ORCH_TEST_CHILD_PID_FILE) { [IO.File]::WriteAllText($env:ORCH_TEST_CHILD_PID_FILE,[string]$process.Id,[Text.Encoding]::UTF8) }\n$2'
    );
    assert.notEqual(observed,runtime,'fixture must observe the real owned process after it starts');
    fs.writeFileSync(fixtureRuntime,observed,'utf8');
  }else fs.copyFileSync(runtimePath,fixtureRuntime);
  fs.writeFileSync(path.join(dir,'scripts','bootstrap.ps1'),'\uFEFF'+bootstrap,'utf8');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return {dir,data:path.join(dir,'plugin data'),called:path.join(dir,'scripts','called.json')};
}
function cleanEnv(extra={}){
  const env={...process.env};
  for(const key of Object.keys(env))if(key.startsWith('ORCH_'))delete env[key];
  return {...env,...extra};
}
function run(f,{input=JSON.stringify(event),memory=8000,timeout=fixturePrepareTimeoutSeconds,env={},prelude=''}={}){
  const script=`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; . ${quote(path.join(f.dir,'hooks','session-start.ps1'))}; function Get-OrchSessionAvailableMemoryMB { ${memory===null?"throw 'unavailable'":`return ${memory}`} }; ${prelude}; Invoke-OrchSessionStart -InputJson ${quote(input)} -PluginRoot ${quote(f.dir)} -DataRoot ${quote(f.data)} -PrepareTimeoutSeconds ${timeout} | ConvertTo-Json -Depth 6 -Compress`;
  const r=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:sessionHookOuterTimeoutMs,windowsHide:true,env:cleanEnv(env),maxBuffer:1024*1024});
  assert.equal(r.status,0,`${r.error||''}\n${r.stdout}\n${r.stderr}`);
  const json=JSON.parse(r.stdout.trim());
  assert.equal(json.continue,true);
  assert.deepEqual(Object.keys(json).sort(),['continue','hookSpecificOutput']);
  assert.equal(json.hookSpecificOutput.hookEventName,'SessionStart');
  assert.equal(typeof json.hookSpecificOutput.additionalContext,'string');
  assert.ok(json.hookSpecificOutput.additionalContext.length<1200);
  return {json,text:json.hookSpecificOutput.additionalContext,stdout:r.stdout,stderr:r.stderr};
}
const winTest=(name,fn)=>test(name,{skip:!windows},fn);

winTest('session hook prepares via a quoted Unicode path with fixed prepare-only arguments',t=>{
  const f=fixture(t),r=run(f);
  assert.match(r.text,/READY/,r.stderr);
  const called=JSON.parse(fs.readFileSync(f.called,'utf8').replace(/^\uFEFF/,''));
  assert.deepEqual(called,{TimeoutSeconds:fixturePrepareTimeoutSeconds,Json:true,Action:'prepare'});
});
winTest('explicit plugin data is forwarded to preparation and healthy sessions are freshly probed',t=>{
  const f=fixture(t,"param([string]$Action,[switch]$Json,[int]$TimeoutSeconds)\n[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'data.txt'),($env:PLUGIN_DATA+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))\nWrite-Output '{\"ok\":true,\"stage\":\"ready\"}'\n");
  assert.match(run(f).text,/READY/);assert.match(run(f).text,/READY/);
  assert.deepEqual(fs.readFileSync(path.join(f.dir,'scripts','data.txt'),'utf8').trim().split(/\r?\n/),[f.data,f.data]);
});
winTest('malformed, unrelated and sessionless input never starts preparation',t=>{
  const f=fixture(t);
  for(const input of ['not-json','[]','null','{}',JSON.stringify({...event,hook_event_name:'Stop'}),JSON.stringify({...event,session_id:''})]){
    const r=run(f,{input});assert.match(r.text,/INVALID_INPUT|NO_SESSION|UNRELATED_EVENT/);assert.equal(fs.existsSync(f.called),false);
  }
});
winTest('child execution and compaction do not recursively prepare or launch workers',t=>{
  const f=fixture(t);
  for(const env of [{ORCH_RUN_ID:'a'},{ORCH_WINDOW:'1'},{ORCH_EXECUTION:'1'},{ORCH_BLOCK_ID:'b'}]){
    assert.match(run(f,{env}).text,/CHILD_SESSION/);assert.equal(fs.existsSync(f.called),false);
  }
  assert.match(run(f,{input:JSON.stringify({...event,source:'compact'})}).text,/COMPACTION/);
  assert.equal(fs.existsSync(f.called),false);
});
winTest('1000 MB reserve boundary skips preparation and explains inline execution',t=>{
  const f=fixture(t);
  for(const memory of [999,1000]){
    assert.match(run(f,{memory}).text,/LOW_MEMORY.*inline/);assert.equal(fs.existsSync(f.called),false);
  }
  assert.match(run(f,{memory:1001}).text,/READY/);assert.equal(fs.existsSync(f.called),true);
});
winTest('session hook honors a higher reserve override and clamps a lower one',t=>{
  const f=fixture(t);
  assert.match(run(f,{memory:1500,env:{ORCH_MIN_AVAILABLE_MB:'2000'}}).text,/LOW_MEMORY.*2000 MB/);
  assert.equal(fs.existsSync(f.called),false);
  assert.match(run(f,{memory:1000,env:{ORCH_MIN_AVAILABLE_MB:'512'}}).text,/LOW_MEMORY.*1000 MB/);
  assert.match(run(f,{memory:1001,env:{ORCH_MIN_AVAILABLE_MB:'512'}}).text,/READY/);
});
winTest('unavailable or invalid memory readings conservatively keep work inline',t=>{
  const f=fixture(t);
  for(const memory of [null,-1,0])assert.match(run(f,{memory}).text,/MEMORY_UNAVAILABLE.*inline/);
  assert.equal(fs.existsSync(f.called),false);
});
winTest('failed preparation is nonblocking and sanitized, and does not retry during cooldown',t=>{
  const f=fixture(t,"param([string]$Action,[switch]$Json,[int]$TimeoutSeconds)\n[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'calls.txt'),'x',[Text.Encoding]::UTF8)\n[Console]::Error.WriteLine('secret=fixture_token_DO_NOT_PRINT')\nWrite-Output '{\"ok\":false,\"message\":\"password=fixture_DO_NOT_PRINT\"}'\nexit 7\n");
  const first=run(f);assert.match(first.text,/PREPARE_FAILED/);assert.doesNotMatch(first.stdout+first.stderr,/DO_NOT_PRINT|password|secret/);
  const second=run(f);assert.match(second.text,/COOLDOWN/);
  assert.match(second.text,/powershell\.exe -NoProfile -ExecutionPolicy Bypass -File ".+scripts\\bootstrap\.ps1" -Action prepare -Json/);
  assert.equal(fs.readFileSync(path.join(f.dir,'scripts','calls.txt'),'utf8').replace(/^\uFEFF/,''),'x');
  const state=fs.readFileSync(path.join(f.data,'session-start','state.json'),'utf8');assert.doesNotMatch(state,/DO_NOT_PRINT|password|secret/);
});
winTest('preparation timeout ends the owned process and returns inline without blocking the session',t=>{
  const f=fixture(t,"param([string]$Action,[switch]$Json,[int]$TimeoutSeconds)\n[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'pid.txt'),[string]$PID,[Text.Encoding]::UTF8)\nStart-Sleep -Seconds 12\n",{observeOwnedPid:true});
  const ownedPidFile=path.join(f.dir,'scripts','owned-process-pid.txt');
  const started=Date.now(),r=run(f,{timeout:timeoutCaseOwnedProcessDeadlineSeconds,env:{ORCH_TEST_CHILD_PID_FILE:ownedPidFile}});assert.match(r.text,/PREPARE_TIMEOUT.*inline/);assert.ok(Date.now()-started<timeoutCaseCompletionBoundMs);
  const pid=Number(fs.readFileSync(ownedPidFile,'utf8').replace(/^\uFEFF/,''));
  assert.ok(Number.isInteger(pid)&&pid>0,'fixture must observe the owned process before its one-second timeout');
  assert.throws(()=>process.kill(pid,0));
});
winTest('a held preparation lock skips concurrent preparation instead of waiting on the host',t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.data,'session-start'),{recursive:true});
  const r=run(f,{prelude:`$held=[IO.File]::Open(${quote(path.join(f.data,'session-start','prepare.lock'))},'OpenOrCreate','ReadWrite','None')`});
  assert.match(r.text,/PREPARE_BUSY/);assert.equal(fs.existsSync(f.called),false);
});
winTest('plugin data junction cannot redirect hook state writes',t=>{
  const f=fixture(t),outside=path.join(f.dir,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,f.data,'junction');
  assert.match(run(f).text,/STATE_UNAVAILABLE/);assert.deepEqual(fs.readdirSync(outside),[]);assert.equal(fs.existsSync(f.called),false);
});
winTest('hook does not accept apparent success with malformed or incomplete bootstrap output',t=>{
  for(const output of ['not-json','{}','{"ok":true}','{"ok":false,"stage":"ready"}','{"ok":1,"stage":"ready"}','{"ok":"true","stage":"ready"}']){
    const f=fixture(t,`param([string]$Action,[switch]$Json,[int]$TimeoutSeconds)\nWrite-Output ${quote(output)}\n`);
    assert.match(run(f).text,/PREPARE_FAILED/);
  }
});
winTest('registered Windows hook command consumes UTF-8 stdin and handles shell metacharacters in plugin root',t=>{
  const f=fixture(t),config=JSON.parse(fs.readFileSync(path.join(f.dir,'hooks','hooks.json'),'utf8'));
  const handler=config.hooks.SessionStart[0].hooks[0];
  assert.equal(handler.type,'command');assert.ok(handler.timeout>0&&handler.timeout<=180);
  // Codex's Windows command runner uses /C and one raw outer quote pair.
  // An executable in the untrusted session cwd must not shadow PowerShell.
  fs.copyFileSync(process.env.ComSpec||path.join(process.env.SystemRoot,'System32','cmd.exe'),path.join(f.dir,'powershell.exe'));
  const r=spawnSync(process.env.ComSpec||'cmd.exe',['/c',`"${handler.commandWindows}"`],{cwd:f.dir,windowsVerbatimArguments:true,env:cleanEnv({PLUGIN_ROOT:f.dir,PLUGIN_DATA:f.data,ORCH_WINDOW:'1'}),input:JSON.stringify({...event,cwd:f.dir}),encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(r.status,0,`${r.stdout}\n${r.stderr}`);
  assert.match(JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext,/CHILD_SESSION/);
  assert.equal(r.stderr,'');
  assert.equal(fs.existsSync(f.called),false);
});
winTest('native Windows memory measurement returns a finite available physical-memory value',()=>{
  const script=`$ErrorActionPreference='Stop'; . ${quote(path.join(root,'hooks','session-start.ps1'))}; Get-OrchSessionAvailableMemoryMB`;
  const r=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(r.status,0,r.stderr);assert.ok(Number.isFinite(Number(r.stdout.trim())));assert.ok(Number(r.stdout.trim())>0);
});

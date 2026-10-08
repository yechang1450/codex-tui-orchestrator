import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const windows=process.platform==='win32';
const q=s=>`'${String(s).replaceAll("'","''")}'`;
// Signed portable Node installations can take over 30 seconds to hash their
// bundled npm tree on a cold Windows filesystem.
const bootstrapProbeTimeoutMs=180000;
function fixture(t){
  const base=path.join(process.env.USERPROFILE||os.homedir(),'workspace','temp');
  fs.mkdirSync(base,{recursive:true});
  const dir=fs.mkdtempSync(path.join(base,'orch-bootstrap-entry-中文 '));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'scripts'));
  for(const file of ['bootstrap.ps1','runtime-bootstrap.ps1']) fs.copyFileSync(path.join(root,'scripts',file),path.join(dir,'scripts',file));
  fs.writeFileSync(path.join(dir,'scripts','runtime-prepare.mjs'),'console.log(JSON.stringify({ok:true,stage:"ready",nodeVersion:process.versions.node,sdkVersion:"fixture",cliPath:process.execPath,agent:"codex"}));','utf8');
  for(const file of ['install-plugin.mjs','orchestrate-sdk.mjs']) fs.writeFileSync(path.join(dir,'scripts',file),'console.log(JSON.stringify({args:process.argv.slice(2),path:process.env.PATH,npm:process.env.npm_execpath,prefix:process.env.npm_config_prefix,cli:process.env.CODEX_CLI_PATH}));','utf8');
  const node=testNodePath(dir),npm=testNpmPath(dir);
  fs.mkdirSync(path.dirname(node),{recursive:true});
  try { fs.linkSync(process.execPath,node); } catch { fs.copyFileSync(process.execPath,node); }
  fs.mkdirSync(path.dirname(npm),{recursive:true});
  fs.writeFileSync(npm,"process.stdout.write('10.0.0\\n');",'utf8');
  return dir;
}
function testNodePath(dir){ return path.join(dir,'paired-node-runtime','bin','node.exe'); }
function testNpmPath(dir){ return path.join(dir,'paired-node-runtime','node_modules','npm','bin','npm-cli.js'); }
function run(dir,args=[],env={}){
  // These entrypoint fixtures exercise argument forwarding and environment
  // restoration. Their paired Node/npm runtime is created by the fixture and
  // deliberately accepted only by the explicit test override below. CLI
  // identity remains independently covered by runtime-prepare and host-cli tests.
  return spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(dir,'scripts','bootstrap.ps1'),...args],{env:{...process.env,ORCH_ALLOW_UNVERIFIED_NODE:'1',ORCH_ALLOW_UNVERIFIED_NPM:'1',...env},encoding:'utf8',windowsHide:true,timeout:bootstrapProbeTimeoutMs});
}
function nativeCliFixture(file){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const code=`public class CodexVersionFixture { public static int Main(string[] args) { if(args.Length != 1 || args[0] != "--version") return 42; System.Console.WriteLine("codex-cli 0.160.0"); return 0; } }`;
  const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ${q(code)} -OutputAssembly ${q(file)} -OutputType ConsoleApplication`;
  const r=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(r.status,0,r.stderr);
}
test('bootstrap prepares without Node on PATH and passes structured runtime report',{skip:!windows},t=>{
  const dir=fixture(t),data=path.join(dir,'plugin data');
  const r=run(dir,['-Action','prepare','-Json','-NoDownload','-NodePath',testNodePath(dir)],{PATH:path.join(process.env.SystemRoot,'System32'),PLUGIN_DATA:data});
  assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).stage,'ready');
  assert.equal(fs.existsSync(path.join(data,'runtime','.bootstrap.lock')),true);
  assert.equal(fs.readdirSync(path.join(data,'runtime')).some(n=>n.startsWith('.npm-cache-')),false);
});
test('an explicit unverified npm override does not hash the npm tree',{skip:!windows},t=>{
  const dir=fixture(t),data=path.join(dir,'plugin data');
  // If Test-OrchNode still digests npm before honoring the explicit override,
  // this throw is caught as a missing runtime and bootstrap fails.  A trusted
  // production path does not set this override.
  fs.appendFileSync(path.join(dir,'scripts','runtime-bootstrap.ps1'),`
function Test-OrchTrustedNpm {
  param([Parameter(Mandatory)][string]$NpmPath, [string[]]$AllowedDigests)
  throw 'npm digest must be skipped under explicit test override'
}
`,'utf8');
  const r=run(dir,['-Action','prepare','-Json','-NoDownload','-NodePath',testNodePath(dir)],{PATH:path.join(process.env.SystemRoot,'System32'),PLUGIN_DATA:data});
  assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).stage,'ready');
});
test('bootstrap dispatches an explicit distribution install literally and uses private CLI prefix',{skip:!windows},t=>{
  const dir=fixture(t),data=path.join(dir,'plugin data'),value='中文 x & echo BAD | more';
  const r=run(dir,['-Action','install','-NoDownload','-NodePath',testNodePath(dir),'--source','dist','--dist-root',value],{PLUGIN_DATA:data});
  assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout);
  assert.deepEqual(result.args,['--source','dist','--dist-root',value]);
  assert.equal(result.prefix,path.join(data,'runtime','cli'));
  assert.equal(result.cli,testNodePath(dir));
});
test('bootstrap marks its default checkout installation as an explicit local-development install',{skip:!windows},t=>{
  const dir=fixture(t),data=path.join(dir,'plugin data');
  const r=run(dir,['-Action','install','-NoDownload','-NodePath',testNodePath(dir)],{PLUGIN_DATA:data});
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).args,['--local-development']);
});
test('bootstrap doctor forwards doctor flag and run keeps the original argument list',{skip:!windows},t=>{
  const dir=fixture(t);
  for(const [action,args,want] of [['doctor',[],['--doctor']],['run',['--plan','任务 spaces'],['--plan','任务 spaces']]]){
    const r=run(dir,['-Action',action,'-NoDownload','-NodePath',testNodePath(dir),...args]);
    assert.equal(r.status,0,r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).args,want);
  }
});
test('bootstrap restores parent process PATH and npm environment after completion',{skip:!windows},t=>{
  const dir=fixture(t);
  // The nested PowerShell process is also a fixture-only runtime probe.  Make
  // any attempt to hash the harness npm tree fail deterministically, so this
  // test keeps exercising environment restoration rather than cold-cache I/O.
  fs.appendFileSync(path.join(dir,'scripts','runtime-bootstrap.ps1'),`
function Test-OrchTrustedNpm {
  param([Parameter(Mandatory)][string]$NpmPath, [string[]]$AllowedDigests)
  throw 'fixture npm digest must be skipped by the explicit test override'
}
`,'utf8');
  const code=`$before=$env:PATH; $npm=$env:npm_execpath; $prefix=$env:npm_config_prefix; & ${q(path.join(dir,'scripts','bootstrap.ps1'))} -Action prepare -NoDownload -NodePath ${q(testNodePath(dir))} -Json; if($env:PATH -ne $before -or $env:npm_execpath -ne $npm -or $env:npm_config_prefix -ne $prefix){throw 'leaked environment'}`;
  const r=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{env:{...process.env,ORCH_ALLOW_UNVERIFIED_NODE:'1',ORCH_ALLOW_UNVERIFIED_NPM:'1'},encoding:'utf8',windowsHide:true,timeout:bootstrapProbeTimeoutMs});
  assert.equal(r.status,0,r.stderr);
});
test('run streams progress immediately and is not killed by the preparation budget',{skip:!windows},async t=>{
  const dir=fixture(t);
  // This case isolates streaming from the separately tested native runtime
  // verification cost, so the run can outlast a short preparation budget.
  fs.appendFileSync(path.join(dir,'scripts','runtime-bootstrap.ps1'),`
function Resolve-OrchNode {
  param([string[]]$Candidates,[string]$RuntimeHome,[switch]$NoDownload,[switch]$AllowUnverified,[switch]$AllowUnverifiedNpm,[int]$TimeoutSeconds)
  return [pscustomobject]@{NodePath=${q(testNodePath(dir))};NpmPath=${q(testNpmPath(dir))};Version='fixture';NpmTrusted=$true}
}
`,'utf8');
  fs.writeFileSync(path.join(dir,'scripts','orchestrate-sdk.mjs'),'console.log("START"); setTimeout(()=>console.log("END"),11500);','utf8');
  const child=spawn(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(dir,'scripts','bootstrap.ps1'),'-Action','run','-NoDownload','-NodePath',testNodePath(dir),'-TimeoutSeconds','10'],{windowsHide:true});
  let firstAt=0,stdout='',stderr='';
  child.stdout.on('data',b=>{if(!firstAt)firstAt=Date.now();stdout+=b;});
  child.stderr.on('data',b=>stderr+=b);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,0,stderr);
  assert.match(stdout,/START[\s\S]*END/);
  assert.ok(Date.now()-firstAt>11000,'progress was buffered until exit');
});
test('runtime prepare resolves an explicitly approved test CLI without invoking a model',{skip:!windows},t=>{
  const dir=fixture(t),cli=path.join(dir,'codex.exe');
  nativeCliFixture(cli);
  const r=spawnSync(process.execPath,[path.join(root,'scripts','runtime-prepare.mjs')],{env:{...process.env,ORCH_CLI:cli,ORCH_ALLOW_UNVERIFIED_CLI:'1',ORCH_AUTO_INSTALL_CLI:'0',ORCH_AUTO_INSTALL_DEPS:'0'},encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout);
  assert.equal(result.ok,true);assert.equal(result.stage,'ready');assert.equal(result.agent,'codex');
  assert.equal(result.sdkVersion,'0.149.0');assert.match(result.cliPath,/codex\.exe$/i);
});
test('runtime prepare rejects an unsigned CLI in npm prefix when desktop candidates are unavailable',{skip:!windows},t=>{
  const dir=fixture(t),prefix=path.join(dir,'private-cli');
  const cli=path.join(prefix,'node_modules','@openai','codex','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
  nativeCliFixture(cli);
  const r=spawnSync(process.execPath,[path.join(root,'scripts','runtime-prepare.mjs')],{env:{...process.env,PATH:'',LOCALAPPDATA:path.join(dir,'no-desktop'),ORCH_CLI:'',CODEX_EXE:'',npm_config_prefix:prefix,ORCH_AUTO_INSTALL_CLI:'0',ORCH_AUTO_INSTALL_DEPS:'0'},encoding:'utf8',windowsHide:true,timeout:30000});
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/CLI_UNTRUSTED|CLI_MISSING/);
});

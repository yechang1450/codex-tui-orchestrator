import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync,spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const windows=process.platform==='win32';
const q=s=>`'${String(s).replaceAll("'","''")}'`;
// Signed portable Node installations can take over 30 seconds to hash their
// bundled npm tree on a cold Windows filesystem.
const bootstrapProbeTimeoutMs=180000;
function fixture(t){
  // Runtime archives and their paired executable are deliberately checked
  // against every ancestor. Keep this fixture below the user-private Codex
  // root instead of a shared system temp tree.
  const base=path.join(os.homedir(),'.codex','test-fixtures','bootstrap-entry');
  fs.mkdirSync(base,{recursive:true});
  const dir=fs.mkdtempSync(path.join(base,'orch-bootstrap-entry-中文 '));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'scripts'));
  for(const file of ['bootstrap.ps1','runtime-bootstrap.ps1','git-for-windows-trust.json']) fs.copyFileSync(path.join(root,'scripts',file),path.join(dir,'scripts',file));
  fs.writeFileSync(path.join(dir,'scripts','runtime-prepare.mjs'),'console.log(JSON.stringify({ok:true,stage:"ready",nodeVersion:process.versions.node,sdkVersion:"fixture",cliPath:process.execPath,agent:"codex"}));','utf8');
  for(const file of ['install-plugin.mjs','orchestrate-sdk.mjs']) fs.writeFileSync(path.join(dir,'scripts',file),'console.log(JSON.stringify({args:process.argv.slice(2),path:process.env.PATH,npm:process.env.npm_execpath,prefix:process.env.npm_config_prefix,cli:process.env.CODEX_CLI_PATH,proxy:process.env.HTTPS_PROXY||process.env.https_proxy||null,systemRoot:process.env.SystemRoot,windir:process.env.WINDIR,comspec:process.env.ComSpec}));','utf8');
  const node=testNodePath(dir),npm=testNpmPath(dir);
  fs.mkdirSync(path.dirname(node),{recursive:true});
  try { fs.linkSync(process.execPath,node); } catch { fs.copyFileSync(process.execPath,node); }
  fs.mkdirSync(path.dirname(npm),{recursive:true});
  fs.writeFileSync(npm,"process.stdout.write('10.0.0\\n');",'utf8');
  return dir;
}
function testNodePath(dir){ return path.join(dir,'paired-node-runtime','bin','node.exe'); }
function testNpmPath(dir){ return path.join(dir,'paired-node-runtime','node_modules','npm','bin','npm-cli.js'); }
function run(dir,args=[],env={},options={}){
  // These entrypoint fixtures exercise argument forwarding and environment
  // restoration. Their paired Node/npm runtime is created by the fixture and
  // deliberately accepted only by the explicit test override below. CLI
  // identity remains independently covered by runtime-prepare and host-cli tests.
  return spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(dir,'scripts','bootstrap.ps1'),...args],{cwd:options.cwd,env:{...process.env,ORCH_ALLOW_UNVERIFIED_NODE:'1',ORCH_ALLOW_UNVERIFIED_NPM:'1',...env},encoding:'utf8',windowsHide:true,timeout:bootstrapProbeTimeoutMs});
}
function nativeCliFixture(file){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const code=`public class CodexVersionFixture { public static int Main(string[] args) { if(args.Length != 1 || args[0] != "--version") return 42; System.Console.WriteLine("codex-cli 0.162.1"); return 0; } }`;
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
test('bootstrap repairs dependencies with a verified Node/npm runtime without preparing the CLI',{skip:!windows},t=>{
  const dir=fixture(t),data=path.join(dir,'plugin data');
  // `repair-deps` must be narrow: a missing/unavailable host CLI cannot turn
  // an SDK repair into a different bootstrap failure.
  fs.writeFileSync(path.join(dir,'scripts','runtime-prepare.mjs'),'process.stderr.write("must not prepare CLI\\n"); process.exit(72);','utf8');
  const r=run(dir,['-Action','repair-deps','-NoDownload','-NodePath',testNodePath(dir),'-Json'],{PLUGIN_DATA:data});
  assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout);
  assert.deepEqual(result.args,['--install-deps']);
});
test('bootstrap repair isolates npm configuration from ambient user and environment state',{skip:!windows},t=>{
  const dir=fixture(t),data=path.join(dir,'plugin data');
  const hostileHome=path.join(dir,'hostile-user-home');
  const hostileConfig=path.join(dir,'hostile.npmrc');
  fs.mkdirSync(hostileHome,{recursive:true});
  fs.writeFileSync(path.join(hostileHome,'.npmrc'),'registry=https://hostile.example.invalid/\n//hostile.example.invalid/:_authToken=not-a-real-token\n','utf8');
  fs.writeFileSync(hostileConfig,'registry=https://other-hostile.example.invalid/\n','utf8');
  fs.writeFileSync(path.join(dir,'scripts','orchestrate-sdk.mjs'),`
import fs from 'node:fs';
const get=name=>{const key=Object.keys(process.env).find(item=>item.toLowerCase()===name.toLowerCase());return key?process.env[key]:null;};
const configEntries=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^npm_config_/i.test(key)));
const userconfig=get('npm_config_userconfig');
const globalconfig=get('npm_config_globalconfig');
const ambient=Object.fromEntries(['NODE_OPTIONS','NODE_PATH','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NPM_TOKEN','NODE_AUTH_TOKEN'].map(name=>[name,get(name)]));
console.log(JSON.stringify({args:process.argv.slice(2),userconfig,globalconfig,registry:get('npm_config_registry'),configEntries,configText:userconfig?fs.readFileSync(userconfig,'utf8'):null,globalConfigText:globalconfig?fs.readFileSync(globalconfig,'utf8'):null,userprofile:get('USERPROFILE'),ambient,path:get('Path'),systemRoot:get('SystemRoot')}));
`,'utf8');
  const r=run(dir,['-Action','repair-deps','-NoDownload','-NodePath',testNodePath(dir),'-Json'],{
    PLUGIN_DATA:data,
    USERPROFILE:hostileHome,
    NPM_CONFIG_USERCONFIG:hostileConfig,
    NPM_CONFIG_GLOBALCONFIG:hostileConfig,
    NPM_CONFIG_REGISTRY:'https://hostile.example.invalid/',
    NPM_CONFIG_PROXY:'http://proxy.example.invalid:8080',
    NPM_CONFIG_HTTPS_PROXY:'http://proxy.example.invalid:8080',
    NODE_OPTIONS:'--no-warnings',
    NODE_PATH:path.join(dir,'hostile-node-path'),
    HTTP_PROXY:'http://proxy.example.invalid:8080',
    HTTPS_PROXY:'http://proxy.example.invalid:8080',
    ALL_PROXY:'socks5://proxy.example.invalid:1080',
    NPM_TOKEN:'not-a-real-token',
    NODE_AUTH_TOKEN:'not-a-real-token',
  });
  assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout);
  const privateRuntime=path.join(data,'runtime');
  assert.notEqual(path.resolve(result.userconfig),path.resolve(result.globalconfig),'npm must receive distinct user and global config files');
  assert.equal(path.relative(privateRuntime,result.userconfig).startsWith('..'),false,'npm config must stay in the private runtime');
  assert.equal(path.relative(privateRuntime,result.globalconfig).startsWith('..'),false,'global npm config must stay in the private runtime');
  assert.notEqual(path.resolve(result.userconfig),path.resolve(hostileConfig));
  assert.match(path.relative(privateRuntime,result.userconfig).replaceAll('\\','/'),/^\.npm-cache-[a-f0-9]{32}\/isolated-user\.npmrc$/i);
  assert.match(path.relative(privateRuntime,result.globalconfig).replaceAll('\\','/'),/^\.npm-cache-[a-f0-9]{32}\/isolated-global\.npmrc$/i);
  assert.equal(result.registry,'https://registry.npmjs.org/');
  assert.equal(result.configEntries.NPM_CONFIG_PROXY,'false');
  assert.equal(result.configEntries.NPM_CONFIG_REPLACE_REGISTRY_HOST,'never');
  assert.equal(result.configText,'');
  assert.equal(result.globalConfigText,'');
  assert.equal(result.userprofile,null);
  assert.deepEqual(result.ambient,{NODE_OPTIONS:null,NODE_PATH:null,HTTP_PROXY:null,HTTPS_PROXY:null,ALL_PROXY:null,NPM_TOKEN:null,NODE_AUTH_TOKEN:null});
  assert.deepEqual(String(result.path).split(';').map(value=>value.toLowerCase()),[path.dirname(testNodePath(dir)).toLowerCase(),path.join(result.systemRoot,'System32').toLowerCase()]);
  assert.equal(Object.keys(result.configEntries).some(key=>/https_proxy/i.test(key)),false);
  assert.equal(Object.values(result.configEntries).some(value=>String(value).includes('hostile.example.invalid')),false);
  assert.equal(fs.readdirSync(privateRuntime).some(name=>name.startsWith('.npm-cache-')),false,'repair cache and isolated npmrc must be cleaned');
});
test('bootstrap preparation isolates npm configuration while retaining plugin and Codex roots',{skip:!windows},t=>{
  const dir=fixture(t),data=path.join(dir,'plugin data'),codexHome=path.join(dir,'isolated-codex-home');
  const hostileHome=path.join(dir,'hostile-user-home'),hostileCwd=path.join(dir,'hostile-working-directory'),hostileLocalAppData=path.join(dir,'hostile-local-appdata');
  const hostileConfig=path.join(dir,'hostile.npmrc'),preload=path.join(dir,'hostile-preload.cjs'),marker=path.join(dir,'hostile-preload-ran');
  fs.mkdirSync(hostileHome,{recursive:true});fs.mkdirSync(hostileCwd,{recursive:true});
  fs.writeFileSync(path.join(hostileHome,'.npmrc'),'registry=https://hostile.example.invalid/\n//hostile.example.invalid/:_authToken=not-a-real-token\n','utf8');
  fs.writeFileSync(path.join(hostileCwd,'.npmrc'),'registry=https://cwd-hostile.example.invalid/\n','utf8');
  fs.writeFileSync(hostileConfig,'registry=https://other-hostile.example.invalid/\n','utf8');
  fs.writeFileSync(preload,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');`,'utf8');
  fs.writeFileSync(path.join(dir,'scripts','runtime-prepare.mjs'),`
import fs from 'node:fs';
const get=name=>{const key=Object.keys(process.env).find(item=>item.toLowerCase()===name.toLowerCase());return key?process.env[key]:null;};
const userconfig=get('npm_config_userconfig'),globalconfig=get('npm_config_globalconfig');
const configEntries=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^npm_config_/i.test(key)));
const ambient=Object.fromEntries(['USERPROFILE','HOME','APPDATA','NODE_OPTIONS','NODE_PATH','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','NPM_TOKEN','NODE_AUTH_TOKEN'].map(name=>[name,get(name)]));
console.log(JSON.stringify({ok:true,stage:'ready',nodeVersion:process.versions.node,sdkVersion:'fixture',cliPath:process.execPath,agent:'codex',userconfig,globalconfig,registry:get('npm_config_registry'),configEntries,configText:userconfig?fs.readFileSync(userconfig,'utf8'):null,globalConfigText:globalconfig?fs.readFileSync(globalconfig,'utf8'):null,ambient,pluginData:get('PLUGIN_DATA'),codexHome:get('CODEX_HOME'),localAppData:get('LOCALAPPDATA'),autoInstallDeps:get('ORCH_AUTO_INSTALL_DEPS'),autoInstallCli:get('ORCH_AUTO_INSTALL_CLI'),installTimeout:get('ORCH_CLI_INSTALL_TIMEOUT_MS'),path:get('Path'),systemRoot:get('SystemRoot'),cwd:process.cwd()}));
`,'utf8');
  const r=run(dir,['-Action','prepare','-NoDownload','-NodePath',testNodePath(dir),'-Json'],{
    PLUGIN_DATA:data,CODEX_HOME:codexHome,ORCH_AUTO_INSTALL_DEPS:'0',ORCH_AUTO_INSTALL_CLI:'0',ORCH_CLI_INSTALL_TIMEOUT_MS:'12345',USERPROFILE:hostileHome,HOMEDRIVE:'C:',HOMEPATH:'\\hostile',APPDATA:path.join(dir,'hostile-appdata'),LOCALAPPDATA:hostileLocalAppData,
    NPM_CONFIG_USERCONFIG:hostileConfig,NPM_CONFIG_GLOBALCONFIG:hostileConfig,NPM_CONFIG_REGISTRY:'https://hostile.example.invalid/',NPM_CONFIG_PROXY:'http://proxy.example.invalid:8080',NPM_CONFIG_HTTPS_PROXY:'http://proxy.example.invalid:8080',
    NODE_OPTIONS:`--require=${JSON.stringify(preload)}`,NODE_PATH:path.join(dir,'hostile-node-path'),HTTP_PROXY:'http://proxy.example.invalid:8080',HTTPS_PROXY:'http://proxy.example.invalid:8080',ALL_PROXY:'socks5://proxy.example.invalid:1080',NO_PROXY:'localhost',NPM_TOKEN:'not-a-real-token',NODE_AUTH_TOKEN:'not-a-real-token',
  },{cwd:hostileCwd});
  assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout),privateRuntime=path.join(data,'runtime');
  assert.equal(fs.existsSync(marker),false,'NODE_OPTIONS preload must not reach runtime preparation');
  assert.equal(path.resolve(result.pluginData),path.resolve(data));
  assert.equal(path.resolve(result.codexHome),path.resolve(codexHome));
  assert.equal(path.resolve(result.localAppData),path.resolve(process.env.LOCALAPPDATA),'desktop CLI verification must use the OS-derived local app-data path');
  assert.notEqual(path.resolve(result.localAppData),path.resolve(hostileLocalAppData));
  assert.equal(result.autoInstallDeps,'0');assert.equal(result.autoInstallCli,'0');assert.equal(result.installTimeout,'12345');
  assert.notEqual(path.resolve(result.userconfig),path.resolve(result.globalconfig));
  assert.match(path.relative(privateRuntime,result.userconfig).replaceAll('\\','/'),/^\.npm-cache-[a-f0-9]{32}\/isolated-user\.npmrc$/i);
  assert.match(path.relative(privateRuntime,result.globalconfig).replaceAll('\\','/'),/^\.npm-cache-[a-f0-9]{32}\/isolated-global\.npmrc$/i);
  assert.equal(result.registry,'https://registry.npmjs.org/');assert.equal(result.configEntries.NPM_CONFIG_PROXY,'false');
  assert.equal(result.configText,'');assert.equal(result.globalConfigText,'');assert.equal(result.configEntries.NPM_CONFIG_OMIT,undefined);
  assert.deepEqual(result.ambient,{USERPROFILE:null,HOME:null,APPDATA:null,NODE_OPTIONS:null,NODE_PATH:null,HTTP_PROXY:null,HTTPS_PROXY:null,ALL_PROXY:null,NO_PROXY:null,NPM_TOKEN:null,NODE_AUTH_TOKEN:null});
  assert.deepEqual(String(result.path).split(';').map(value=>value.toLowerCase()),[path.dirname(testNodePath(dir)).toLowerCase(),path.join(result.systemRoot,'System32').toLowerCase()]);
  assert.equal(path.resolve(result.cwd),path.resolve(path.join(result.systemRoot,'System32')));
  assert.equal(Object.keys(result.configEntries).some(key=>/https_proxy|token/i.test(key)),false);
  assert.equal(Object.values(result.configEntries).some(value=>String(value).includes('hostile.example.invalid')),false);
  assert.equal(fs.readdirSync(privateRuntime).some(name=>name.startsWith('.npm-cache-')),false,'prepare cache and isolated npmrc must be cleaned');
});
test('bootstrap removes isolated repair state after a failed dependency command',{skip:!windows},t=>{
  const dir=fixture(t),data=path.join(dir,'plugin data');
  fs.writeFileSync(path.join(dir,'scripts','orchestrate-sdk.mjs'),'process.stderr.write("fixture repair failure\\n"); process.exit(67);','utf8');
  const r=run(dir,['-Action','repair-deps','-NoDownload','-NodePath',testNodePath(dir),'-Json'],{PLUGIN_DATA:data});
  assert.equal(r.status,67,r.stderr);
  const privateRuntime=path.join(data,'runtime');
  assert.equal(fs.readdirSync(privateRuntime).some(name=>name.startsWith('.npm-cache-')),false,'failed repair must not retain npm cache or isolated config');
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
  fs.writeFileSync(path.join(dir,'scripts','runtime-prepare.mjs'),`
import {assertTrustedNpm} from ${JSON.stringify(pathToFileURL(path.join(root,'scripts','npm-cli.mjs')).href)};
assertTrustedNpm();
console.log(JSON.stringify({ok:true,stage:'ready',nodeVersion:process.versions.node,sdkVersion:'fixture',cliPath:process.execPath,agent:'codex',allowUnverifiedNpm:process.env.ORCH_ALLOW_UNVERIFIED_NPM||null}));
`,'utf8');
  const r=run(dir,['-Action','prepare','-Json','-NoDownload','-NodePath',testNodePath(dir)],{PATH:path.join(process.env.SystemRoot,'System32'),PLUGIN_DATA:data});
  assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout);
  assert.equal(result.stage,'ready');
  assert.equal(result.allowUnverifiedNpm,'1','the existing explicit NodePath-only override must reach the actual npm trust gate');
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
test('bootstrap forwards multiple installer flags after its known parameters',{skip:!windows},t=>{
  const dir=fixture(t),data=path.join(dir,'plugin data');
  const r=run(dir,['-Action','install','-NoDownload','-NodePath',testNodePath(dir),'--verify-skills','--strict-skills'],{PLUGIN_DATA:data});
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).args,['--verify-skills','--strict-skills','--local-development']);
});
test('bootstrap keeps GNU-style installer flags when a PowerShell script invokes it',{skip:!windows},t=>{
  const dir=fixture(t),data=path.join(dir,'plugin data');
  // PowerShell's default positional binding treats the first --flag as the
  // next positional parameter when this script is invoked from another .ps1.
  // Stub runtime selection so this test isolates the argument boundary.
  fs.appendFileSync(path.join(dir,'scripts','runtime-bootstrap.ps1'),`
function Resolve-OrchNode {
  param([AllowEmptyCollection()][string[]]$Candidates = @(), [Parameter(Mandatory)][string]$RuntimeHome, [switch]$NoDownload, [switch]$AllowUnverified, [switch]$AllowUnverifiedNpm, [ValidateRange(1,1800)][int]$TimeoutSeconds = 900)
  return [pscustomobject]@{NodePath=${q(testNodePath(dir))};NpmPath=${q(testNpmPath(dir))};Version='fixture';NpmTrusted=$true}
}
`,'utf8');
  const command=`& ${q(path.join(dir,'scripts','bootstrap.ps1'))} -Action install --verify-skills --strict-skills`;
  const r=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command],{cwd:dir,env:{...process.env,PLUGIN_DATA:data},encoding:'utf8',windowsHide:true,timeout:bootstrapProbeTimeoutMs});
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).args,['--verify-skills','--strict-skills','--local-development']);
});
test('bootstrap consumes --pull itself and never forwards that privileged action to Node',{skip:!windows},t=>{
  const dir=fixture(t),data=path.join(dir,'plugin data');
  const pullMarker=path.join(dir,'bootstrap-pull.json');
  fs.appendFileSync(path.join(dir,'scripts','runtime-bootstrap.ps1'),`
function Invoke-OrchTrustedCheckoutPull {
  param([Parameter(Mandatory)][string]$Checkout, [ValidateRange(1,1800)][int]$TimeoutSeconds = 15)
  [IO.File]::WriteAllText(${q(pullMarker)}, (ConvertTo-Json ([ordered]@{ checkout = $Checkout; gitDir = $env:GIT_DIR; gitConfigCount = $env:GIT_CONFIG_COUNT; sshAskpass = $env:SSH_ASKPASS }) -Compress))
}
`,'utf8');
  const r=run(dir,['-Action','install','-NoDownload','-NodePath',testNodePath(dir),'--pull'],{PLUGIN_DATA:data});
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).args,['--local-development']);
  assert.equal(fs.existsSync(pullMarker),true,'bootstrap must perform the pull before it dispatches Node');
});
test('bootstrap rejects obsolete skip-dist before every action initializes state',{skip:!windows},t=>{
  const actions=['install','prepare','doctor','run','repair-deps'];
  const spellings=['--skip-dist','--skip-dist=legacy'];
  for(const action of actions){
    for(const unsupported of spellings){
      // A fresh fixture makes every assertion independent: a previous action
      // cannot leave a marker or private runtime that masks work by this one.
      const dir=fixture(t),data=path.join(dir,'plugin data');
      const prepareMarker=path.join(dir,'prepare-ran');
      const pullMarker=path.join(dir,'pull-ran');
      const childActionMarker=path.join(dir,`child-${action}-ran`);
      fs.writeFileSync(path.join(dir,'scripts','runtime-prepare.mjs'),`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(prepareMarker)},'ran'); console.log(JSON.stringify({ok:true,stage:'ready',nodeVersion:process.versions.node,sdkVersion:'fixture',cliPath:process.execPath,agent:'codex'}));`,'utf8');
      const child=`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(childActionMarker)},process.argv.slice(2).join(' '));`;
      fs.writeFileSync(path.join(dir,'scripts','install-plugin.mjs'),child,'utf8');
      fs.writeFileSync(path.join(dir,'scripts','orchestrate-sdk.mjs'),child,'utf8');
      fs.appendFileSync(path.join(dir,'scripts','runtime-bootstrap.ps1'),`
function Invoke-OrchTrustedCheckoutPull {
  param([Parameter(Mandatory)][string]$Checkout,[Parameter(Mandatory)][int]$TimeoutSeconds)
  [IO.File]::WriteAllText(${q(pullMarker)},'ran')
}
`,'utf8');
      const actionArguments=action==='install'
        ? ['--pull',unsupported]
        : [unsupported,...(action==='run'?['--plan','must not run']:[])];
      const r=run(dir,['-Action',action,'-NoDownload','-NodePath',testNodePath(dir),...actionArguments],{PLUGIN_DATA:data});
      assert.equal(r.status,1,`${action} ${unsupported} must fail at bootstrap input validation`);
      assert.match(r.stderr,/SKIP_DIST_UNSUPPORTED/,`${action} ${unsupported} must preserve the canonical public rejection code`);
      assert.equal(fs.existsSync(path.join(data,'runtime')),false,`${action} ${unsupported} must not create private runtime state`);
      assert.equal(fs.existsSync(prepareMarker),false,`${action} ${unsupported} must not prepare a CLI runtime`);
      assert.equal(fs.existsSync(pullMarker),false,`${action} ${unsupported} must not update the checkout`);
      assert.equal(fs.existsSync(childActionMarker),false,`${action} ${unsupported} must not launch its child action`);
    }
  }
});
test('bootstrap doctor forwards doctor flag and run keeps the original argument list',{skip:!windows},t=>{
  const dir=fixture(t);
  for(const [action,args,want] of [['doctor',[],['--doctor']],['run',['--plan','任务 spaces'],['--plan','任务 spaces']]]){
    const proxy='http://caller-proxy.example.invalid:8080';
    const r=run(dir,['-Action',action,'-NoDownload','-NodePath',testNodePath(dir),...args],{HTTPS_PROXY:proxy});
    assert.equal(r.status,0,r.stderr);
    const result=JSON.parse(r.stdout);
    assert.deepEqual(result.args,want);
    assert.equal(result.proxy,proxy,'ordinary bootstrap actions must regain the caller proxy after npm setup');
  }
});
test('bootstrap strips caller Node loaders from install, doctor, and run children',{skip:!windows},t=>{
  for(const [action,args,want] of [
    ['install',[],['--local-development']],
    ['doctor',[],['--doctor']],
    ['run',['--plan','任务 spaces'],['--plan','任务 spaces']],
  ]){
    const dir=fixture(t),data=path.join(dir,`plugin data ${action}`),preload=path.join(dir,'hostile-preload.cjs'),marker=path.join(dir,`hostile-preload-${action}.ran`),hostileNodePath=path.join(dir,'hostile-node-path');
    const terminal=`const get=name=>{const key=Object.keys(process.env).find(item=>item.toLowerCase()===name.toLowerCase());return key?process.env[key]:null;};console.log(JSON.stringify({args:process.argv.slice(2),nodeOptions:get('NODE_OPTIONS'),nodePath:get('NODE_PATH')}));`;
    fs.writeFileSync(preload,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');`,'utf8');
    for(const file of ['install-plugin.mjs','orchestrate-sdk.mjs'])fs.writeFileSync(path.join(dir,'scripts',file),terminal,'utf8');
    const r=run(dir,['-Action',action,'-NoDownload','-NodePath',testNodePath(dir),...args],{
      PLUGIN_DATA:data,
      NODE_OPTIONS:`--require=${JSON.stringify(preload)}`,
      NODE_PATH:hostileNodePath,
    });
    assert.equal(r.status,0,r.stderr);
    const result=JSON.parse(r.stdout);
    assert.deepEqual(result.args,want,`${action} must preserve its public argument contract`);
    assert.equal(fs.existsSync(marker),false,`${action} must not execute a caller-supplied NODE_OPTIONS preload`);
    assert.equal(result.nodeOptions,null,`${action} must not expose NODE_OPTIONS to the terminal Node child`);
    assert.equal(result.nodePath,null,`${action} must not expose NODE_PATH to the terminal Node child`);
  }
});
test('bootstrap pins normal install and run children to the OS-derived Windows root',{skip:!windows},t=>{
  const dir=fixture(t),data=path.join(dir,'plugin data'),capture=path.join(dir,'execution-environment.json');
  fs.appendFileSync(path.join(dir,'scripts','runtime-bootstrap.ps1'),`
function Resolve-OrchNode {
  param([AllowEmptyCollection()][string[]]$Candidates = @(), [Parameter(Mandatory)][string]$RuntimeHome, [switch]$NoDownload, [switch]$AllowUnverified, [switch]$AllowUnverifiedNpm, [ValidateRange(1,1800)][int]$TimeoutSeconds = 900)
  return [pscustomobject]@{NodePath=${q(testNodePath(dir))};NpmPath=${q(testNpmPath(dir))};Version='fixture';NpmTrusted=$true}
}
function Invoke-OrchProcess {
  param([Parameter(Mandatory)][string]$FilePath, [AllowEmptyCollection()][string[]]$ArgumentList = @(), [ValidateRange(1,1800)][int]$TimeoutSeconds = 15, [System.Collections.IDictionary]$Environment = $null, [AllowNull()][string]$WorkingDirectory = $null)
  if ($ArgumentList -contains ${q(path.join(dir,'scripts','runtime-prepare.mjs'))}) { return [pscustomobject]@{ExitCode=0;Stdout=${q(JSON.stringify({ok:true,stage:'ready',nodeVersion:'fixture',sdkVersion:'fixture',cliPath:testNodePath(dir),agent:'codex'}))};Stderr=''} }
  [IO.File]::WriteAllText(${q(capture)},($Environment | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  return [pscustomobject]@{ExitCode=0;Stdout='';Stderr=''}
}
function Invoke-OrchAttachedProcess {
  param([Parameter(Mandatory)][string]$FilePath, [AllowEmptyCollection()][string[]]$ArgumentList = @(), [System.Collections.IDictionary]$Environment = $null)
  [IO.File]::WriteAllText(${q(capture)},($Environment | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  return 0
}
`,'utf8');
  const actualRoot=path.resolve(process.env.SystemRoot);
  const actualComSpec=path.join(actualRoot,'System32','cmd.exe');
  for(const [action,args] of [['install',[]],['run',['--plan','ordinary task']]]){
    try{fs.rmSync(capture,{force:true});}catch{}
    const r=run(dir,['-Action',action,'-NoDownload','-NodePath',testNodePath(dir),...args],{PLUGIN_DATA:data});
    assert.equal(r.status,0,r.stderr);
    const result=JSON.parse(fs.readFileSync(capture,'utf8'));
    assert.equal(path.resolve(result.SystemRoot).toLowerCase(),actualRoot.toLowerCase(),`${action} must not inherit a caller-selected SystemRoot`);
    assert.equal(path.resolve(result.WINDIR).toLowerCase(),actualRoot.toLowerCase(),`${action} must not inherit a caller-selected WINDIR`);
    assert.equal(path.resolve(result.ComSpec).toLowerCase(),actualComSpec.toLowerCase(),`${action} must use the OS command processor`);
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
  const code=`$before=$env:PATH; $npm=$env:npm_execpath; $prefix=$env:npm_config_prefix; $registry='https://before.example.invalid/'; $proxy='http://before.example.invalid:8080'; $nodeOptions='--no-warnings'; $env:npm_config_registry=$registry; $env:HTTPS_PROXY=$proxy; $env:NODE_OPTIONS=$nodeOptions; & ${q(path.join(dir,'scripts','bootstrap.ps1'))} -Action prepare -NoDownload -NodePath ${q(testNodePath(dir))} -Json; if($env:PATH -ne $before -or $env:npm_execpath -ne $npm -or $env:npm_config_prefix -ne $prefix -or $env:npm_config_registry -ne $registry -or $env:HTTPS_PROXY -ne $proxy -or $env:NODE_OPTIONS -ne $nodeOptions){throw 'leaked environment'}`;
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
  assert.equal(result.sdkVersion,'0.162.1');assert.match(result.cliPath,/codex\.exe$/i);
});
test('runtime prepare rejects an unsigned CLI in npm prefix when desktop candidates are unavailable',{skip:!windows},t=>{
  const dir=fixture(t),prefix=path.join(dir,'private-cli');
  const cli=path.join(prefix,'node_modules','@openai','codex','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
  nativeCliFixture(cli);
  const r=spawnSync(process.execPath,[path.join(root,'scripts','runtime-prepare.mjs')],{env:{...process.env,PATH:'',LOCALAPPDATA:path.join(dir,'no-desktop'),PLUGIN_DATA:path.join(dir,'plugin-data'),ORCH_CLI:'',CODEX_EXE:'',npm_config_prefix:prefix,ORCH_AUTO_INSTALL_CLI:'0',ORCH_AUTO_INSTALL_DEPS:'0'},encoding:'utf8',windowsHide:true,timeout:30000});
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/CLI_UNTRUSTED|CLI_MISSING/);
});

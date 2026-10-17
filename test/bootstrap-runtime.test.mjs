import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const lib=path.join(root,'scripts','runtime-bootstrap.ps1');
const windows=process.platform==='win32';
const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const quote=s=>`'${String(s).replaceAll("'","''")}'`;
// Deep archive fixtures exercise PowerShell 5.1 extended-path enumeration.
// Leave room for a cold, contended Windows filesystem without changing the
// production extraction budget.
const longPathFixtureTimeoutMs=120000;
const hashArchive=archive=>`$sha=[Security.Cryptography.SHA256]::Create(); try { $hash=[BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes(${quote(archive)}))).Replace('-','') } finally { $sha.Dispose() }`;
function run(code,{timeout=30000,env={}}={}){
  const script=`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; . ${quote(lib)}; ${code}`;
  const r=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,...env},encoding:'utf8',timeout,windowsHide:true,maxBuffer:1024*1024});
  assert.equal(r.status,0,`${r.error||''}\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}
function fixture(t){
  const base=testTempFamily('bootstrap-runtime');
  fs.mkdirSync(base,{recursive:true});
  const dir=fs.mkdtempSync(path.join(base,'orch-bootstrap-test-中文 '));
  // A probe child can still hold the copied node.exe for a moment after the
  // probe returns; keep teardown retrying instead of failing the test with
  // Windows EBUSY on a loaded machine.
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:30,retryDelay:200}));
  return dir;
}
function pairedNodeRuntime(dir){
  const runtime=path.join(dir,'paired-node-runtime');
  const node=path.join(runtime,'bin','node.exe');
  const npm=path.join(runtime,'node_modules','npm','bin','npm-cli.js');
  fs.mkdirSync(path.dirname(node),{recursive:true});
  try { fs.linkSync(process.execPath,node); } catch { fs.copyFileSync(process.execPath,node); }
  fs.mkdirSync(path.dirname(npm),{recursive:true});
  fs.writeFileSync(npm,"process.stdout.write('10.0.0\\n');",'utf8');
  return {node,npm};
}
function trustedRuntimeOverrides(runtime){
  return `
function Test-OrchTrustedSignature {
  param([Parameter(Mandatory)][string]$Path, [string[]]$AllowedThumbprints)
  return [string]::Equals([IO.Path]::GetFullPath($Path), [IO.Path]::GetFullPath(${quote(runtime.node)}), [StringComparison]::OrdinalIgnoreCase)
}
function Test-OrchTrustedNpm {
  param([Parameter(Mandatory)][string]$NpmPath, [string[]]$AllowedDigests)
  return [string]::Equals([IO.Path]::GetFullPath($NpmPath), [IO.Path]::GetFullPath(${quote(runtime.npm)}), [StringComparison]::OrdinalIgnoreCase)
}
`;
}
const winTest=(name,fn)=>test(name,{skip:!windows},fn);

winTest('trusted tree digest follows extended-length paths under Windows PowerShell 5.1',t=>{
  // Regression: a deep install path pushes npm-tree files past the classic
  // 260-character limit. Get-FileHash / [IO.File]::GetAttributes without an
  // extended prefix fail there and used to make first installs report
  // NODE_RUNTIME_INVALID even though the downloaded runtime was healthy.
  const base=fixture(t);
  let deep=path.join(base,'segment-'+'x'.repeat(40));
  while(deep.length<250)deep=path.join(deep,'deeper-'+'y'.repeat(40));
  const leaf=path.join(deep,'node_modules');
  fs.mkdirSync(leaf,{recursive:true});
  const target=path.join(leaf,'payload-with-a-long-name.js');
  fs.writeFileSync(target,'payload','utf8');
  assert.ok(target.length>259,`fixture path must exceed MAX_PATH (got ${target.length})`);
  const digest=run(`(Get-OrchTreeDigest -Root ${quote(leaf)})`,{timeout:longPathFixtureTimeoutMs});
  assert.match(digest,/^[a-f0-9]{64}$/,'extended-length tree digest must return a hash instead of null');
});

winTest('runtime home stays with plugin data or plugin temp, never global installs',t=>{
  const dir=fixture(t);
  const data=path.join(dir,'plugin data');
  const result=JSON.parse(run(`@((Get-OrchRuntimeHome -PluginRoot ${quote(dir)} -DataRoot ${quote(data)}),(Get-OrchRuntimeHome -PluginRoot ${quote(dir)} -DataRoot '')) | ConvertTo-Json -Compress`));
  assert.deepEqual(result,[path.join(data,'runtime'),path.join(dir,'temp','runtime')]);
});
winTest('runtime authority refuses a root writable by Authenticated Users before setup begins',t=>{
  const dir=fixture(t),home=path.join(dir,'shared-runtime');
  fs.mkdirSync(home,{recursive:true});
  const out=run(`$acl=[IO.Directory]::GetAccessControl(${quote(home)}); $acl.SetAccessRuleProtection($true,$false); $current=[Security.Principal.WindowsIdentity]::GetCurrent().User; $full=New-Object Security.AccessControl.FileSystemAccessRule($current,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow); $acl.SetAccessRule($full); $sharedSid=New-Object Security.Principal.SecurityIdentifier('S-1-5-11'); $shared=New-Object Security.AccessControl.FileSystemAccessRule($sharedSid,[Security.AccessControl.FileSystemRights]::Modify,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($shared); [IO.Directory]::SetAccessControl(${quote(home)},$acl); try { Assert-OrchPrivateRuntimeHome ${quote(home)}; throw 'unexpected success' } catch { $_.Exception.Message }`);
  assert.match(out,/RUNTIME_ROOT_UNSAFE_ACL/);
  assert.equal(fs.existsSync(path.join(home,'.bootstrap.lock')),false);
});
winTest('an explicitly trusted paired Node/npm runtime is verified without downloading or creating runtime state',t=>{
  const dir=fixture(t),runtime=pairedNodeRuntime(dir);
  const result=JSON.parse(run(`${trustedRuntimeOverrides(runtime)}; Resolve-OrchNode -Candidates @(${quote(runtime.node)}) -RuntimeHome ${quote(path.join(dir,'runtime'))} -NoDownload | ConvertTo-Json -Compress`));
  assert.equal(path.resolve(result.NodePath).toLowerCase(),path.resolve(runtime.node).toLowerCase());
  assert.equal(path.resolve(result.NpmPath).toLowerCase(),path.resolve(runtime.npm).toLowerCase());
  assert.ok(result.NpmPath.endsWith('npm-cli.js'));
  assert.ok(Number(result.Version.split('.')[0])>=22);
  assert.equal(result.NpmTrusted,true);
  assert.equal(fs.existsSync(path.join(dir,'runtime')),false);
});
winTest('Node and npm runtime probes ignore ambient loaders, npm config, proxy, and caller working directory',t=>{
  const dir=fixture(t),runtime=pairedNodeRuntime(dir),marker=path.join(dir,'ambient-loader-ran.txt'),report=path.join(dir,'npm-probe-observation.json');
  const preload=path.join(dir,'ambient-loader.cjs'),hostileConfig=path.join(dir,'hostile.npmrc'),hostileHome=path.join(dir,'hostile-home');
  fs.mkdirSync(hostileHome,{recursive:true});
  fs.writeFileSync(preload,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'loaded');`,'utf8');
  fs.writeFileSync(path.join(hostileHome,'.npmrc'),'registry=https://hostile-user.example.invalid/\n//hostile-user.example.invalid/:_authToken=not-a-real-token\n','utf8');
  fs.writeFileSync(hostileConfig,'registry=https://hostile.example.invalid/\n','utf8');
  fs.writeFileSync(runtime.npm,`const fs=require('node:fs'); const get=name=>{const key=Object.keys(process.env).find(key=>key.toLowerCase()===name.toLowerCase());return key?process.env[key]:null}; fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({cwd:process.cwd(),userprofile:get('USERPROFILE'),appdata:get('APPDATA'),nodeOptions:get('NODE_OPTIONS'),nodePath:get('NODE_PATH'),httpProxy:get('HTTP_PROXY'),httpsProxy:get('HTTPS_PROXY'),allProxy:get('ALL_PROXY'),userconfig:get('NPM_CONFIG_USERCONFIG'),globalconfig:get('NPM_CONFIG_GLOBALCONFIG'),offline:get('NPM_CONFIG_OFFLINE'),ignoreScripts:get('NPM_CONFIG_IGNORE_SCRIPTS'),registry:get('NPM_CONFIG_REGISTRY'),proxy:get('NPM_CONFIG_PROXY')})); process.stdout.write('10.0.0\\n');`,'utf8');
  const observation=JSON.parse(run(`${trustedRuntimeOverrides(runtime)}; $before=@{user=$env:USERPROFILE; config=$env:NPM_CONFIG_USERCONFIG; proxy=$env:HTTPS_PROXY; nodeOptions=$env:NODE_OPTIONS}; $result=Resolve-OrchNode -Candidates @(${quote(runtime.node)}) -RuntimeHome ${quote(path.join(dir,'runtime'))} -NoDownload; $after=@{user=$env:USERPROFILE; config=$env:NPM_CONFIG_USERCONFIG; proxy=$env:HTTPS_PROXY; nodeOptions=$env:NODE_OPTIONS}; [pscustomobject]@{result=$result;before=$before;after=$after}|ConvertTo-Json -Compress`,{env:{
    USERPROFILE:hostileHome,APPDATA:path.join(dir,'hostile-appdata'),NODE_PATH:path.join(dir,'hostile-node-path'),NODE_OPTIONS:`--require ${JSON.stringify(preload)}`,
    HTTP_PROXY:'http://proxy.example.invalid:8080',HTTPS_PROXY:'http://proxy.example.invalid:8080',ALL_PROXY:'socks5://proxy.example.invalid:1080',
    NPM_CONFIG_USERCONFIG:hostileConfig,NPM_CONFIG_GLOBALCONFIG:hostileConfig,NPM_CONFIG_REGISTRY:'https://hostile.example.invalid/',
  }}));
  assert.equal(observation.result.NpmTrusted,true);
  assert.deepEqual(observation.after,observation.before,'probe isolation must not mutate the caller environment');
  assert.equal(fs.existsSync(marker),false,'ambient NODE_OPTIONS must not execute during runtime verification');
  const npmObservation=JSON.parse(fs.readFileSync(report,'utf8'));
  const system32=path.join(process.env.SystemRoot,'System32');
  assert.equal(path.resolve(npmObservation.cwd).toLowerCase(),path.resolve(system32).toLowerCase());
  assert.equal(npmObservation.userprofile,null);
  assert.equal(npmObservation.appdata,null);
  assert.equal(npmObservation.nodeOptions,null);
  assert.equal(npmObservation.nodePath,null);
  assert.equal(npmObservation.httpProxy,null);
  assert.equal(npmObservation.httpsProxy,null);
  assert.equal(npmObservation.allProxy,null);
  assert.equal(path.dirname(npmObservation.userconfig).toLowerCase(),path.resolve(system32).toLowerCase());
  assert.equal(path.dirname(npmObservation.globalconfig).toLowerCase(),path.resolve(system32).toLowerCase());
  assert.notEqual(npmObservation.userconfig,npmObservation.globalconfig,'npm 11 rejects one config path loaded as both user and global');
  assert.equal(fs.existsSync(npmObservation.userconfig),false,'probe config path is never materialized');
  assert.equal(fs.existsSync(npmObservation.globalconfig),false,'probe config path is never materialized');
  assert.equal(npmObservation.offline,'true');
  assert.equal(npmObservation.ignoreScripts,'true');
  assert.equal(npmObservation.registry,'https://registry.npmjs.org/');
  assert.equal(npmObservation.proxy,'false');
});
winTest('preparation environment forwards an explicit npm override and derives the desktop CLI root',t=>{
  const dir=fixture(t),runtime=pairedNodeRuntime(dir),home=path.join(dir,'runtime'),cache=path.join(home,'cache'),userConfig=path.join(cache,'user.npmrc'),globalConfig=path.join(cache,'global.npmrc'),hostileLocalAppData=path.join(dir,'hostile-local-appdata');
  fs.mkdirSync(cache,{recursive:true});fs.writeFileSync(userConfig,'');fs.writeFileSync(globalConfig,'');
  const output=run(`$allowed=Get-OrchTrustedNpmPreparationEnvironment -NodePath ${quote(runtime.node)} -NpmPath ${quote(runtime.npm)} -RuntimeHome ${quote(home)} -NpmCache ${quote(cache)} -UserConfigPath ${quote(userConfig)} -GlobalConfigPath ${quote(globalConfig)} -NpmTrusted $false -AllowUnverifiedNpm -PluginData ${quote(path.join(dir,'plugin-data'))}; $blocked=Get-OrchTrustedNpmPreparationEnvironment -NodePath ${quote(runtime.node)} -NpmPath ${quote(runtime.npm)} -RuntimeHome ${quote(home)} -NpmCache ${quote(cache)} -UserConfigPath ${quote(userConfig)} -GlobalConfigPath ${quote(globalConfig)} -NpmTrusted $false -PluginData ${quote(path.join(dir,'plugin-data'))}; [pscustomobject]@{allowed=$allowed;blocked=$blocked}|ConvertTo-Json -Compress`,{env:{ORCH_ALLOW_UNVERIFIED_NPM:'1',LOCALAPPDATA:hostileLocalAppData,USERPROFILE:path.join(dir,'hostile-user-profile')}});
  const result=JSON.parse(output);
  assert.equal(result.allowed.ORCH_ALLOW_UNVERIFIED_NPM,'1');
  assert.equal(result.blocked.ORCH_ALLOW_UNVERIFIED_NPM,undefined,'ambient override must not cross the boundary without the bootstrap gate');
  assert.equal(path.resolve(result.allowed.LOCALAPPDATA),path.resolve(process.env.LOCALAPPDATA));
  assert.notEqual(path.resolve(result.allowed.LOCALAPPDATA),path.resolve(hostileLocalAppData));
});
winTest('missing runtime produces actionable refusal when network installation is disabled',t=>{
  const dir=fixture(t);
  const out=run(`try { Resolve-OrchNode -Candidates @(${quote(path.join(dir,'missing.exe'))}) -RuntimeHome ${quote(path.join(dir,'runtime'))} -NoDownload; throw 'unexpected success' } catch { $_.Exception.Message }`);
  assert.match(out,/NODE_RUNTIME_MISSING/);
  assert.equal(fs.existsSync(path.join(dir,'runtime')),false);
});
winTest('a Node executable without npm cannot be accepted as a ready runtime',t=>{
  const dir=fixture(t),node=path.join(dir,'node.exe');
  fs.copyFileSync(process.execPath,node);
  const out=run(`try { Resolve-OrchNode -Candidates @(${quote(node)}) -RuntimeHome ${quote(path.join(dir,'runtime'))} -NoDownload; throw 'unexpected success' } catch { $_.Exception.Message }`);
  assert.match(out,/NODE_RUNTIME_MISSING/);
});
winTest('unsafe executable candidates are rejected before selecting a working runtime',t=>{
  const dir=fixture(t),runtime=pairedNodeRuntime(dir);
  const result=JSON.parse(run(`${trustedRuntimeOverrides(runtime)}; Resolve-OrchNode -Candidates @(${quote(ps)},${quote(runtime.node)}) -RuntimeHome ${quote(path.join(dir,'runtime'))} -NoDownload | ConvertTo-Json -Compress`));
  assert.equal(path.resolve(result.NodePath).toLowerCase(),path.resolve(runtime.node).toLowerCase());
});
winTest('failed automatic download removes every partial download directory',t=>{
  const dir=fixture(t),home=path.join(dir,'runtime');
  const out=run(`function Get-OrchDownloadSources { param($Release,$TimeoutSeconds); [pscustomobject]@{Uri='https://nodejs.org/fixture.zip';Milliseconds=1} }; function Save-OrchNodeArchive { param($Uri,$Destination,$TimeoutSeconds); [IO.File]::WriteAllText($Destination,'invalid archive',[Text.Encoding]::UTF8) }; try { Resolve-OrchNode -Candidates @() -RuntimeHome ${quote(home)}; throw 'unexpected success' } catch { $_.Exception.Message }`);
  assert.match(out,/NODE_CHECKSUM_MISMATCH/);
  assert.deepEqual(fs.readdirSync(home),[]);
});
winTest('native argument forwarding preserves empty strings, Unicode, quotes and shell metacharacters',t=>{
  const dir=fixture(t), marker=path.join(dir,'MUST_NOT_EXIST');
  const args=['','a b','中文','x"y','tail\\','; New-Item '+marker,'$(Get-Process)','& echo nope','a\\"b'];
  const out=run(`$r=Invoke-OrchProcess -FilePath ${quote(process.execPath)} -ArgumentList @('-e','process.stdout.write(JSON.stringify(process.argv.slice(1)))','--',${args.map(quote).join(',')}) -TimeoutSeconds 5; if($r.ExitCode -ne 0){throw $r.Stderr}; $r.Stdout`);
  assert.deepEqual(JSON.parse(out),args);
  assert.equal(fs.existsSync(marker),false);
});
winTest('native runtime probes are bounded and terminate their owned process on timeout',()=>{
  const before=Date.now();
  const out=run(`try { Invoke-OrchProcess -FilePath ${quote(process.execPath)} -ArgumentList @('-e','setInterval(()=>{},1000)') -TimeoutSeconds 1; throw 'unexpected success' } catch { $_.Exception.Message }`);
  assert.match(out,/PROCESS_TIMEOUT/);
  assert.ok(Date.now()-before<10000);
});
winTest('concurrent runtime install cannot enter a held lock',t=>{
  const dir=fixture(t),home=path.join(dir,'runtime');
  const out=run(`$lock=Enter-OrchRuntimeLock -RuntimeHome ${quote(home)} -TimeoutSeconds 1; try { try { $other=Enter-OrchRuntimeLock -RuntimeHome ${quote(home)} -TimeoutSeconds 1; $other.Dispose(); throw 'unexpected success' } catch { $_.Exception.Message } } finally { $lock.Dispose() }`);
  assert.match(out,/RUNTIME_INSTALL_BUSY/);
});
winTest('bad checksum cannot extract or execute an archive',t=>{
  const dir=fixture(t),archive=path.join(dir,'bad.zip'),home=path.join(dir,'runtime');
  fs.writeFileSync(archive,'untrusted bytes','utf8');
  const out=run(`try { Install-OrchNodeArchive -Archive ${quote(archive)} -ExpectedHash '${'0'.repeat(64)}' -RuntimeHome ${quote(home)} -DirectoryName 'node-v22.23.3-win-x64'; throw 'unexpected success' } catch { $_.Exception.Message }`);
  assert.match(out,/NODE_CHECKSUM_MISMATCH/);
  assert.equal(fs.existsSync(path.join(home,'node-v22.23.3-win-x64')),false);
  if(fs.existsSync(home)) assert.equal(fs.readdirSync(home).some(n=>n.startsWith('.stage-')),false);
});
winTest('verified archive installs atomically under Unicode paths and removes extraction staging',t=>{
  const dir=fixture(t),archive=path.join(dir,'good.zip'),home=path.join(dir,'runtime'),top='node-v22.23.3-win-x64';
  const out=run(`Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::Open(${quote(archive)},'Create'); try { $entry=$zip.CreateEntry('${top}/node.exe'); $writer=[IO.StreamWriter]::new($entry.Open()); $writer.Write('fixture'); $writer.Dispose() } finally { $zip.Dispose() }; ${hashArchive(archive)}; Install-OrchNodeArchive -Archive ${quote(archive)} -ExpectedHash $hash -RuntimeHome ${quote(home)} -DirectoryName '${top}'`);
  assert.equal(path.resolve(out),path.join(home,top));
  assert.equal(fs.readFileSync(path.join(home,top,'node.exe'),'utf8'),'fixture');
  assert.equal(fs.readdirSync(home).some(n=>n.startsWith('.stage-')),false);
});
winTest('verified archive extracts deep npm paths from a realistic isolated runtime root and removes staging',t=>{
  const dir=fixture(t),archive=path.join(dir,'legacy-long.zip'),top='node-v22.23.3-win-x64';
  const homePrefix=path.join(dir,'runtime-');
  const home=homePrefix+'x'.repeat(Math.max(1,105-homePrefix.length));
  const deepDirectory=`${top}/node_modules/npm/node_modules/@npmcli/metavuln-calculator/node_modules/pacote/bin/`;
  const deepFile=`${top}/node_modules/npm/node_modules/@npmcli/metavuln-calculator/node_modules/pacote/lib/util/tar-create-options.js`;
  const stagedDirectory=path.join(home,'.stage-'+'0'.repeat(32),deepDirectory);
  const stagedFile=path.join(home,'.stage-'+'0'.repeat(32),deepFile);
  assert.ok(home.length>=105,`fixture must retain the observed runtime-root depth, got ${home.length}`);
  assert.ok(stagedDirectory.length>=248,`fixture must exercise the legacy directory limit, got ${stagedDirectory.length}`);
  assert.ok(stagedFile.length>=260,`fixture must exercise the legacy file limit, got ${stagedFile.length}`);
  const out=run(`Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::Open(${quote(archive)},'Create'); try { $entry=$zip.CreateEntry('${top}/node.exe'); $writer=[IO.StreamWriter]::new($entry.Open()); $writer.Write('fixture'); $writer.Dispose(); $null=$zip.CreateEntry('${deepDirectory}'); $entry=$zip.CreateEntry('${deepFile}'); $writer=[IO.StreamWriter]::new($entry.Open()); $writer.Write('deep'); $writer.Dispose() } finally { $zip.Dispose() }; ${hashArchive(archive)}; Install-OrchNodeArchive -Archive ${quote(archive)} -ExpectedHash $hash -RuntimeHome ${quote(home)} -DirectoryName '${top}'`,{timeout:longPathFixtureTimeoutMs});
  assert.equal(path.resolve(out),path.join(home,top));
  assert.equal(fs.readFileSync(path.join(home,top,'node.exe'),'utf8'),'fixture');
  assert.equal(fs.readFileSync(path.join(home,...deepFile.split('/')),'utf8'),'deep');
  assert.equal(fs.readdirSync(home).some(n=>n.startsWith('.stage-')),false);
});
winTest('deep staging cleanup survives a later archive rejection',t=>{
  const dir=fixture(t),archive=path.join(dir,'legacy-long-reject.zip'),top='node-v22.23.3-win-x64';
  const homePrefix=path.join(dir,'runtime-');
  const home=homePrefix+'x'.repeat(Math.max(1,105-homePrefix.length));
  const deepDirectory=`${top}/node_modules/npm/node_modules/@npmcli/metavuln-calculator/node_modules/pacote/bin/`;
  const stagedDirectory=path.join(home,'.stage-'+'0'.repeat(32),deepDirectory);
  assert.ok(stagedDirectory.length>=248,`fixture must exercise the legacy directory limit, got ${stagedDirectory.length}`);
  const out=run(`Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::Open(${quote(archive)},'Create'); try { $null=$zip.CreateEntry('${deepDirectory}'); $null=$zip.CreateEntry('${top}/../../escaped.txt') } finally { $zip.Dispose() }; ${hashArchive(archive)}; try { Install-OrchNodeArchive -Archive ${quote(archive)} -ExpectedHash $hash -RuntimeHome ${quote(home)} -DirectoryName '${top}'; throw 'unexpected success' } catch { $_.Exception.Message }`,{timeout:longPathFixtureTimeoutMs});
  assert.match(out,/NODE_ARCHIVE_PATH/);
  assert.equal(fs.readdirSync(home).some(n=>n.startsWith('.stage-')),false);
});
winTest('archive path traversal is rejected even when its checksum matches',t=>{
  const dir=fixture(t),archive=path.join(dir,'traversal.zip'),home=path.join(dir,'runtime');
  const out=run(`Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::Open(${quote(archive)},'Create'); try { $null=$zip.CreateEntry('node-v22.23.3-win-x64/../../escaped.txt') } finally { $zip.Dispose() }; ${hashArchive(archive)}; try { Install-OrchNodeArchive -Archive ${quote(archive)} -ExpectedHash $hash -RuntimeHome ${quote(home)} -DirectoryName 'node-v22.23.3-win-x64'; throw 'unexpected success' } catch { $_.Exception.Message }`);
  assert.match(out,/NODE_ARCHIVE_PATH/);
  assert.equal(fs.existsSync(path.join(dir,'escaped.txt')),false);
  assert.equal(fs.existsSync(path.join(home,'node-v22.23.3-win-x64')),false);
  assert.equal(fs.readdirSync(home).some(n=>n.startsWith('.stage-')),false);
});
winTest('runtime junctions cannot redirect installation or cleanup outside runtime home',t=>{
  const dir=fixture(t),outside=path.join(dir,'outside'),home=path.join(dir,'runtime');
  fs.mkdirSync(outside);fs.symlinkSync(outside,home,'junction');
  const out=run(`try { Enter-OrchRuntimeLock -RuntimeHome ${quote(home)}; throw 'unexpected success' } catch { $_.Exception.Message }`);
  assert.match(out,/RUNTIME_REPARSE_PATH/);
  assert.deepEqual(fs.readdirSync(outside),[]);
});
winTest('owned cleanup removes readonly npm cache content beyond the Windows legacy path limit',t=>{
  const dir=fixture(t),home=path.join(dir,'runtime');
  const cache=path.join(home,'.npm-cache-'+('a'.repeat(32)));
  const leaf=path.join(cache,'_cacache','content-v2','sha512','8b','87','f'.repeat(128));
  fs.mkdirSync(path.dirname(leaf),{recursive:true});
  fs.writeFileSync(leaf,'x');
  fs.chmodSync(leaf,0o444);
  assert.ok(leaf.length>260,`fixture must exercise a legacy-long path, got ${leaf.length}`);
  const out=run(`Remove-OrchOwnedDirectory -Path ${quote(cache)} -RuntimeHome ${quote(home)}; [bool](Test-Path -LiteralPath ${quote(cache)}) | ConvertTo-Json -Compress`);
  assert.equal(JSON.parse(out),false);
});
winTest('extended cleanup path conversion preserves local and UNC roots',()=>{
  const local='C:\\runtime\\cache',unc='\\\\server\\share\\cache',alreadyExtended='\\\\?\\C:\\runtime\\cache';
  const out=run(`@(
    ConvertTo-OrchExtendedPath -Path ${quote(local)}
    ConvertTo-OrchExtendedPath -Path ${quote(unc)}
    ConvertTo-OrchExtendedPath -Path ${quote(alreadyExtended)}
  ) | ConvertTo-Json -Compress`);
  assert.deepEqual(JSON.parse(out),['\\\\?\\C:\\runtime\\cache','\\\\?\\UNC\\server\\share\\cache','\\\\?\\C:\\runtime\\cache']);
});
winTest('owned cleanup refuses reparse descendants and paths outside its runtime home',t=>{
  const dir=fixture(t),home=path.join(dir,'runtime'),outside=path.join(dir,'outside'),cache=path.join(home,'.npm-cache-owned'),escape=path.join(dir,'not-owned');
  fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'sentinel.txt'),'outside');
  fs.mkdirSync(cache,{recursive:true});fs.symlinkSync(outside,path.join(cache,'linked'),'junction');
  fs.mkdirSync(escape);fs.writeFileSync(path.join(escape,'sentinel.txt'),'escape');
  const reparse=run(`try { Remove-OrchOwnedDirectory -Path ${quote(cache)} -RuntimeHome ${quote(home)}; 'unexpected success' } catch { $_.Exception.Message }`);
  assert.match(reparse,/RUNTIME_REPARSE_PATH/);
  assert.equal(fs.readFileSync(path.join(outside,'sentinel.txt'),'utf8'),'outside');
  assert.equal(fs.existsSync(cache),true);
  const outsideMessage=run(`try { Remove-OrchOwnedDirectory -Path ${quote(escape)} -RuntimeHome ${quote(home)}; 'unexpected success' } catch { $_.Exception.Message }`);
  assert.match(outsideMessage,/RUNTIME_CLEANUP_PATH/);
  assert.equal(fs.readFileSync(path.join(escape,'sentinel.txt'),'utf8'),'escape');
});
winTest('owned cleanup detects a reparse descendant beyond the legacy directory limit',t=>{
  const dir=fixture(t),homePrefix=path.join(dir,'runtime-');
  const home=homePrefix+'x'.repeat(Math.max(1,105-homePrefix.length));
  const cache=path.join(home,'.npm-cache-owned'),outside=path.join(dir,'outside'),parent=path.join(cache,'a'.repeat(80),'b'.repeat(80)),link=path.join(parent,'link');
  assert.ok(link.length>=248,`fixture must exercise a legacy-long reparse path, got ${link.length}`);
  const out=run(`$outside=${quote(outside)}; $parent=${quote(parent)}; $link=${quote(link)}; [IO.Directory]::CreateDirectory((ConvertTo-OrchExtendedPath -Path $parent)) | Out-Null; [IO.Directory]::CreateDirectory((ConvertTo-OrchExtendedPath -Path $outside)) | Out-Null; [IO.File]::WriteAllText((Join-Path $outside 'sentinel.txt'),'outside'); & "$env:SystemRoot\\System32\\cmd.exe" /d /c ('mklink /J "' + (ConvertTo-OrchExtendedPath -Path $link) + '" "' + $outside + '"') | Out-Null; if($LASTEXITCODE -ne 0){throw 'junction creation failed'}; try { Remove-OrchOwnedDirectory -Path ${quote(cache)} -RuntimeHome ${quote(home)}; 'unexpected success' } catch { $_.Exception.Message }`,{timeout:longPathFixtureTimeoutMs});
  assert.match(out,/RUNTIME_REPARSE_PATH/);
  assert.equal(fs.readFileSync(path.join(outside,'sentinel.txt'),'utf8'),'outside');
  assert.equal(fs.existsSync(cache),true);
});

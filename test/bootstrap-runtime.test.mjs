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
// A trusted portable Node probe hashes the complete bundled npm tree.  Keep
// this test-only process deadline bounded while allowing cold Windows I/O.
const trustedNpmProbeTimeoutMs=180000;
const hashArchive=archive=>`$sha=[Security.Cryptography.SHA256]::Create(); try { $hash=[BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes(${quote(archive)}))).Replace('-','') } finally { $sha.Dispose() }`;
function run(code,{timeout=30000}={}){
  const script=`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; . ${quote(lib)}; ${code}`;
  const r=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout,windowsHide:true,maxBuffer:1024*1024});
  assert.equal(r.status,0,`${r.error||''}\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}
function fixture(t){
  const base=path.join(process.env.USERPROFILE||os.homedir(),'workspace','temp');
  fs.mkdirSync(base,{recursive:true});
  const dir=fs.mkdtempSync(path.join(base,'orch-bootstrap-test-中文 '));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return dir;
}
const winTest=(name,fn)=>test(name,{skip:!windows},fn);

winTest('runtime home stays with plugin data or plugin temp, never global installs',t=>{
  const dir=fixture(t);
  const data=path.join(dir,'plugin data');
  const result=JSON.parse(run(`@((Get-OrchRuntimeHome -PluginRoot ${quote(dir)} -DataRoot ${quote(data)}),(Get-OrchRuntimeHome -PluginRoot ${quote(dir)} -DataRoot '')) | ConvertTo-Json -Compress`));
  assert.deepEqual(result,[path.join(data,'runtime'),path.join(dir,'temp','runtime')]);
});
winTest('existing node and npm are verified without downloading or creating runtime state',t=>{
  const dir=fixture(t);
  const result=JSON.parse(run(`Resolve-OrchNode -Candidates @(${quote(process.execPath)}) -RuntimeHome ${quote(path.join(dir,'runtime'))} -NoDownload | ConvertTo-Json -Compress`,{timeout:trustedNpmProbeTimeoutMs}));
  assert.equal(path.resolve(result.NodePath).toLowerCase(),path.resolve(process.execPath).toLowerCase());
  assert.ok(result.NpmPath.endsWith('npm-cli.js'));
  assert.ok(Number(result.Version.split('.')[0])>=22);
  assert.equal(fs.existsSync(path.join(dir,'runtime')),false);
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
  const dir=fixture(t);
  const result=JSON.parse(run(`Resolve-OrchNode -Candidates @(${quote(ps)},${quote(process.execPath)}) -RuntimeHome ${quote(path.join(dir,'runtime'))} -NoDownload | ConvertTo-Json -Compress`,{timeout:trustedNpmProbeTimeoutMs}));
  assert.equal(path.resolve(result.NodePath).toLowerCase(),path.resolve(process.execPath).toLowerCase());
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

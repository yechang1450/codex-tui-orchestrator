import fs from 'node:fs';
import { networkArgs } from './network-policy.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {createHash} from 'node:crypto';
import { assertTrustedNpm, pickNpmCli } from '../npm-cli.mjs';
import {assertNoReparsePoints} from './runtime-context.mjs';
import {trustedWindowsHelper,trustedWindowsRoot,controllerEnvironment} from './windows-system.mjs';
import {runtimeCliPrefix} from './runtime-cli-prefix.mjs';
import {assertPrivateWindowsRoot} from './private-root.mjs';
import {constrainWorkerPolicy} from './worker-authorization.mjs';

const WIN_TARGETS = Object.freeze([
  ['x86_64-pc-windows-msvc', 'codex.exe'],
  ['aarch64-pc-windows-msvc', 'codex.exe'],
]);

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path;
}

function vendorCandidates(root, platform) {
  const p = pathApi(platform);
  const candidates = [];
  for (const [triple, executable] of WIN_TARGETS) {
    candidates.push(p.join(root, 'vendor', triple, 'bin', executable));
    candidates.push(p.join(root, 'vendor', triple, 'codex', 'bin', executable));
    candidates.push(p.join(root, 'vendor', triple, 'codex', executable));
  }
  return candidates;
}

function packageNativeCandidates(modulesRoot, platform) {
  const p = pathApi(platform);
  const roots = [
    p.join(modulesRoot, '@openai', 'codex'),
    p.join(modulesRoot, '@openai', 'codex-win32-x64'),
    p.join(modulesRoot, '@openai', 'codex-win32-arm64'),
  ];
  const candidates = [];
  for (const root of roots) candidates.push(...vendorCandidates(root, platform));
  // npm may keep optional platform packages nested under the main package.
  for (const packageName of ['codex-win32-x64', 'codex-win32-arm64']) {
    candidates.push(...vendorCandidates(p.join(modulesRoot, '@openai', 'codex', 'node_modules', '@openai', packageName), platform));
  }
  return candidates;
}

function defaultLocalModuleRoots(platform) {
  if (platform !== process.platform) return [];
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.resolve(here, '..', 'node_modules')];
}

function localNativeCandidates(platform, localRoots = defaultLocalModuleRoots(platform)) {
  if (platform !== 'win32') return [];
  return localRoots.flatMap(root => packageNativeCandidates(root, platform));
}

function nativeProbe(file, env = process.env) {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    const result = spawnSync(file, ['--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 8000, shell: false, env,
    });
    return result.status === 0 && /^codex-cli\s/m.test(result.stdout || '');
  } catch { return false; }
}

function fileIdentity(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch { return null; }
}

// Desktop Codex and the pinned @openai/codex@0.162.1 Windows package use
// different valid OpenAI signing certificates. The latter can be external to
// an installed cache even when bootstrap authenticated its package tree.
const TRUSTED_CLI_CERTIFICATES = Object.freeze([
  'DB9831002B26D78F14E07806F595C6A429E9B6E9',
  '41977145C93B7A096405E230DDCC8FED1AB82AC3',
  // OpenAI's current Windows desktop CLI signing certificate. The Authenticode
  // API validates its timestamp and trust chain; pinning prevents accepting an
  // unrelated publisher with a locally trusted certificate.
  'AAB04F57830B69182775AB3CEB6CE37981FE71C5',
  // OpenAI desktop CLI certificate observed on the 0.160.1 Windows build.
  'CDBF18EB36CF54344875E8F92C87FA732EF42F52',
]);
// Microsoft-issued desktop certificates rotate more frequently than the
// product identity.  A rotated signer is accepted only from the official
// desktop install root and only when the full validated publisher identity
// matches OpenAI's current desktop signer.  Other external executables still
// require a release-pinned leaf certificate.
const TRUSTED_DESKTOP_CLI_SUBJECTS = Object.freeze([
  'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US',
]);
const AUTHENTICODE_SCRIPT = 'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; $s=Get-AuthenticodeSignature -LiteralPath $env:ORCH_AUTHENTICODE_TARGET -ErrorAction Stop; if ([string]$s.Status -ne "Valid" -or $null -eq $s.SignerCertificate) { exit 2 }; [Console]::Out.WriteLine(([PSCustomObject]@{thumbprint=$s.SignerCertificate.Thumbprint;subject=$s.SignerCertificate.Subject;issuer=$s.SignerCertificate.Issuer}|ConvertTo-Json -Compress))';

export function readAuthenticodeSigner(file, env = process.env, spawn = spawnSync) {
  if (process.platform !== 'win32') return {thumbprint: null, subject: null, issuer: null};
  try {
    if (!fs.statSync(file).isFile()) return null;
    // The verifier itself is security-sensitive.  Never let a caller-supplied
    // child environment select a different PowerShell or module tree: the
    // parent process' host environment is the only trusted system-root source.
    const trustedRoot = trustedWindowsRoot();
    const suppliedRoot = env.SystemRoot || env.WINDIR;
    if (suppliedRoot && path.win32.normalize(suppliedRoot).toLowerCase() !== path.win32.normalize(trustedRoot).toLowerCase()) return null;
    const systemRoot = trustedRoot;
    const powershell = trustedWindowsHelper('powershell');
    const systemModules = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
    const result = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', AUTHENTICODE_SCRIPT], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000,
      env: controllerEnvironment({PSModulePath: systemModules, ORCH_AUTHENTICODE_TARGET: path.resolve(file)}),
    });
    if (result?.status !== 0) return null;
    const output = String(result.stdout || '').trim();
    let parsed;
    try { parsed = JSON.parse(output); }
    catch { parsed = {thumbprint: output, subject: null, issuer: null}; }
    const thumbprint = String(parsed?.thumbprint || '').replace(/\s+/g, '').toUpperCase();
    if (!/^[A-F0-9]{40}$/.test(thumbprint)) return null;
    return {
      thumbprint,
      subject: typeof parsed?.subject === 'string' ? parsed.subject : null,
      issuer: typeof parsed?.issuer === 'string' ? parsed.issuer : null,
    };
  } catch {
    return null;
  }
}

function isOfficialDesktopCliPath(file, env = process.env) {
  if (process.platform !== 'win32' || !env.LOCALAPPDATA) return false;
  try {
    const root = path.win32.resolve(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    const target = path.win32.resolve(file);
    const relative = path.win32.relative(root, target);
    if (!relative || path.win32.isAbsolute(relative) || relative === '..' || relative.startsWith('..\\')) return false;
    if (path.win32.basename(target).toLowerCase() !== 'codex.exe') return false;
    assertNoReparsePoints(root, 'Codex desktop install root');
    assertNoReparsePoints(target, 'Codex desktop executable');
    return true;
  } catch {
    return false;
  }
}

export function verifyAuthenticodePublisher(file, env = process.env, spawn = spawnSync, allowedThumbprints = TRUSTED_CLI_CERTIFICATES) {
  if (process.platform !== 'win32') return true;
  const signer = readAuthenticodeSigner(file, env, spawn);
  return !!signer && allowedThumbprints.includes(signer.thumbprint);
}

/** Verify a Codex CLI without turning ordinary third-party signed binaries into candidates. */
export function verifyCodexCliPublisher(file, env = process.env, spawn = spawnSync) {
  if (process.platform !== 'win32') return true;
  const signer = readAuthenticodeSigner(file, env, spawn);
  if (!signer) return false;
  if (TRUSTED_CLI_CERTIFICATES.includes(signer.thumbprint)) return true;
  return isOfficialDesktopCliPath(file, env) && TRUSTED_DESKTOP_CLI_SUBJECTS.includes(signer.subject);
}

// Codex contract: resolve a verified Codex CLI before any planner or window
// starts. A CLI name alone is not proof of compatibility.
export const adapters = Object.freeze({
  codex: Object.freeze({ id: 'codex', label: 'Codex CLI', native: true,
    modelEnv: 'ORCH_MODEL', effortEnv: 'ORCH_EFFORT',
    completionMarker: '__ORCH_DONE__', verified: false }),
});

export function detectHostAgent(env = process.env) {
  const explicit = String(env.ORCH_AGENT || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return 'codex';
  throw new Error('HOST_UNKNOWN: set ORCH_AGENT=codex or invoke from a Codex host context.');
}

function desktopNativeCandidates(env,platform){
  if(platform!=='win32'||!env.LOCALAPPDATA)return [];
  const root=path.win32.join(env.LOCALAPPDATA,'OpenAI','Codex','bin');
  try{return fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>{
    const bin=path.win32.join(root,e.name,'codex.exe');
    try{return {bin,time:fs.statSync(bin).mtimeMs};}catch{return null;}
  }).filter(Boolean).sort((a,b)=>b.time-a.time).map(e=>e.bin);}catch{return [];}
}

export function cliCandidates(env = process.env, platform = process.platform, options = {}) {
  const {where = spawnSync, localRoots = defaultLocalModuleRoots(platform), includeAmbient = true} = options;
  const desktopBins = options.desktopBins === undefined
    ? (includeAmbient ? desktopNativeCandidates(env,platform) : [])
    : options.desktopBins;
  const p = pathApi(platform);
  const explicit = env.ORCH_CLI || env.CODEX_EXE;
  if (explicit) return [p.resolve(explicit)];
  const found = [];
  if (includeAmbient) {
    for (const dir of String(env.PATH || env.Path || '').split(p.delimiter).filter(Boolean)) {
      found.push(p.join(dir, platform === 'win32' ? 'codex.exe' : 'codex'));
      // npm shims are not native executables; the SDK must receive the packaged binary.
      found.push(...packageNativeCandidates(p.join(dir, 'node_modules'), platform));
    }
    found.push(...desktopBins);
    // Some desktop hosts expose neither PATH nor Path to a child process even
    // though the native Codex installation is registered. Ask the Windows
    // resolver for codex.exe in that case; this never installs or selects a shim.
    if (platform === 'win32' && !found.some(file => { try { return fs.existsSync(file); } catch { return false; } })) {
      try {
        const runningWindows = process.platform === 'win32' && platform === 'win32';
        const whereExe = runningWindows
          ? trustedWindowsHelper('where')
          : p.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'where.exe');
        const result = where(whereExe, ['codex.exe'], {
          encoding:'utf8', windowsHide:true, shell:false, timeout:8000,
          ...(runningWindows ? {cwd: trustedWindowsRoot(), env: controllerEnvironment()} : {env}),
        });
        if (result?.status === 0) for (const line of String(result.stdout || '').split(/\r?\n/)) {
          const candidate = line.trim();
          if (candidate) found.push(candidate);
        }
      } catch { /* resolveHost reports CLI_MISSING if the native resolver is unavailable */ }
    }
  }
  found.push(...localNativeCandidates(platform, localRoots));
  return [...new Set(found)];
}

function installerError(code) {
  const suffix = code ? ` (${String(code)})` : '';
  return new Error('CLI_AUTO_INSTALL_FAILED' + suffix);
}

function npmRoot({npm, env, platform, spawn}) {
  try {
    const result = spawn(npm.command, [...npm.args, 'root', '--global'], {
      encoding: 'utf8', windowsHide: true, shell: npm.shell, timeout: 15000, env,
    });
    if (result?.status === 0) {
      const lines = String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      return lines.at(-1) || '';
    }
  } catch { /* installation already succeeded; probing below gives the final error */ }
  return '';
}

export const DEFAULT_CLI_INSTALL_SPEC = '@openai/codex@0.162.1';
// SHA-256 of the native executables in the official 0.162.1 platform tarballs.
// Their archive SHA-512 values were cross-checked against npmjs and npmmirror
// before sealing this release. Never execute npm-fetched bytes without this pin.
const PINNED_CLI_SHA256=Object.freeze({
  x64:'dd13bdb162a184fa04039488b234a8258ef9b76f84e926c505d5742b19249a6a',
  arm64:'3afc6a5195ce3fc08ee69b99521773b1542f129ee5b68dd4f0bb10cf7930c6ef',
});
// SHA-256 of a canonical manifest of every regular file in the official
// platform tarball. Checking the complete tree rejects DLL side-loading and
// secondary executable substitution beside an otherwise genuine codex.exe.
const PINNED_PLATFORM_TREE_SHA256=Object.freeze({
  x64:'49d12f52a017c8dcbeeb80afe1ecc889b565813f052eaeaaa48fb87adc480515',
  arm64:'107096b12a70cbe46496f47f31b99257a72d80b4d42a76d49c7257ff4387e84f',
});

function pinnedBinaryHash(file,expected) {
  let fd;
  try {
    if(!fs.statSync(file).isFile())return false;
    fd=fs.openSync(file,'r');
    const hash=createHash('sha256'),chunk=Buffer.allocUnsafe(1024*1024);
    for(let bytes;(bytes=fs.readSync(fd,chunk,0,chunk.length,null))>0;)hash.update(chunk.subarray(0,bytes));
    return hash.digest('hex')===expected;
  } catch {return false;}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
function platformTreeDigest(root,expected) {
  try {
    const rows=[];
    const walk=(dir,relative='')=>{
      for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
        const name=relative?relative+'/'+entry.name:entry.name;
        const file=path.join(dir,entry.name);
        assertNoReparsePoints(file,'Codex platform package');
        if(entry.isSymbolicLink())throw new Error('Symlink in Codex platform package');
        if(entry.isDirectory())walk(file,name);
        else if(entry.isFile()){
          const stat=fs.lstatSync(file);
          const hash=createHash('sha256');
          const fd=fs.openSync(file,'r'),chunk=Buffer.allocUnsafe(1024*1024);
          try{for(let n;(n=fs.readSync(fd,chunk,0,chunk.length,null))>0;)hash.update(chunk.subarray(0,n));}
          finally{fs.closeSync(fd);}
          rows.push({name,size:stat.size,hash:hash.digest('hex')});
        }else throw new Error('Non-file entry in Codex platform package');
      }
    };
    walk(root);
    rows.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
    const manifest=rows.map(row=>`${row.name}\0${row.size}\0${row.hash}\n`).join('');
    return createHash('sha256').update(manifest,'utf8').digest('hex')===expected;
  }catch{return false;}
}

function privateCliPath(env) {
  return runtimeCliPrefix(env);
}
function privateCliPrefix(env) {
  const prefix=privateCliPath(env);
  try{assertPrivateWindowsRoot(path.dirname(prefix),{powershell:trustedWindowsHelper('powershell')});}
  catch{throw new Error('RUNTIME_ROOT_UNSAFE_ACL: runtime storage must be a local directory writable only by the current Windows user, SYSTEM, and Administrators');}
  return assertNoReparsePoints(prefix,'Codex CLI runtime');
}
function isPrivateCliCandidate(file,env) {
  const prefix=privateCliPath(env),relative=path.relative(prefix,path.resolve(file));
  return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);
}
function verifiedPrivateCodexCandidate(file,env,{verifyBinary=pinnedBinaryHash,verifyTree=platformTreeDigest}={}) {
  if(process.platform!=='win32'||!PINNED_CLI_SHA256[process.arch])return false;
  try{
    const modules=path.join(privateCliPrefix(env),'node_modules');
    const architecture=process.arch==='x64'?'x64':'arm64';
    const packageName='codex-win32-'+architecture;
    const triple=architecture==='x64'?'x86_64-pc-windows-msvc':'aarch64-pc-windows-msvc';
    const roots=[path.join(modules,'@openai',packageName),
      path.join(modules,'@openai','codex','node_modules','@openai',packageName)];
    for(const root of roots){
      const expected=path.join(root,'vendor',triple,'bin','codex.exe');
      if(path.resolve(file).toLowerCase()!==path.resolve(expected).toLowerCase())continue;
      assertNoReparsePoints(file,'Codex CLI candidate');
      return verifyBinary(file,PINNED_CLI_SHA256[process.arch])&&verifyTree(root,PINNED_PLATFORM_TREE_SHA256[process.arch]);
    }
  }catch{return false;}
  return false;
}

// Revalidate the exact selected executable at the controller-to-child launch
// boundary.  Resolution returns a path string, so this check closes the
// verification-to-use gap as tightly as the platform API permits and fails
// closed if the file or its authenticated package changed meanwhile.
export function revalidateHostExecutable(config, env = process.env, {allowExplicitUnverified=true} = {}) {
  const file = config?.bin;
  if (!file || !fileIdentity(file)) throw new Error('CLI_UNTRUSTED: selected executable is missing or changed');
  const explicit=String(env.ORCH_CLI || env.CODEX_EXE || '').trim();
  if(allowExplicitUnverified&&explicit && env.ORCH_ALLOW_UNVERIFIED_CLI==='1' && path.resolve(file).toLowerCase()===path.resolve(explicit).toLowerCase()){
    assertNoReparsePoints(file,'explicit Codex CLI');
    if(!fs.statSync(file).isFile())throw new Error('CLI_UNTRUSTED: explicit executable is not a regular file');
    return file;
  }
  if (isPrivateCliCandidate(file, env)) {
    if (!verifiedPrivateCodexCandidate(file, env)) throw new Error('CLI_UNTRUSTED: private executable failed final integrity verification');
    return file;
  }
  if (!verifyCodexCliPublisher(file, env)) throw new Error('CLI_UNTRUSTED: executable failed final publisher verification');
  return file;
}

/** Install a native Codex package without logging npm output or credentials. */
export function installCodexCli({env = process.env, platform = process.platform, spawn = spawnSync, probe = file => nativeProbe(file, env), verifyBinary=pinnedBinaryHash,verifyTree=platformTreeDigest} = {}) {
  const spec = String(env.ORCH_CLI_INSTALL_SPEC || DEFAULT_CLI_INSTALL_SPEC).trim();
  if (!/^@openai\/codex@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec)) throw installerError('invalid_spec');
  if(spec!==DEFAULT_CLI_INSTALL_SPEC||platform!=='win32'||!PINNED_CLI_SHA256[process.arch])throw installerError('unpinned_package');
  // Native Codex packages can take more than two minutes on a cold but healthy
  // connection. Keep a finite default while allowing the documented override
  // to reduce it or extend it up to the existing ten-minute ceiling.
  const timeout = Number(env.ORCH_CLI_INSTALL_TIMEOUT_MS || 300000);
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>600000)throw installerError('invalid_timeout');
  try { assertTrustedNpm(env); }
  catch { throw installerError('npm_untrusted'); }
  const prefix=privateCliPrefix(env);
  const installEnv={...env};
  for(const key of Object.keys(installEnv))if(key.toLowerCase()==='npm_config_prefix')delete installEnv[key];
  installEnv.npm_config_prefix=prefix;
  const npm=pickNpmCli({env:installEnv});
  let result;
  try {
    result = spawn(npm.command, [...npm.args, 'install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', '--include=optional', spec], {
      cwd: process.cwd(), encoding: 'utf8', windowsHide: true, shell: npm.shell, timeout, env:installEnv,
    });
  } catch (error) {
    throw installerError(error?.code || 'spawn');
  }
  if (result?.error || result?.status !== 0) throw installerError(result?.error?.code || `exit_${result?.status ?? 'unknown'}`);
  const root=npmRoot({npm,env:installEnv,platform,spawn});
  if(path.resolve(root).toLowerCase()!==path.resolve(prefix,'node_modules').toLowerCase())throw installerError('private_root_mismatch');
  const candidates=packageNativeCandidates(root,platform);
  const bin=[...new Set(candidates)].find(file=>verifiedPrivateCodexCandidate(file,installEnv,{verifyBinary,verifyTree}));
  if(!bin)throw installerError('integrity_mismatch');
  if(!probe(bin))throw installerError('native_binary_not_found');
  return bin;
}

export function resolveHost({ env = process.env, agent, candidates = cliCandidates,
  probe = (file) => nativeProbe(file, env), verifyPrivate=file=>verifiedPrivateCodexCandidate(file,env),
  verifyExternal=file=>verifyCodexCliPublisher(file,env), install, autoInstall } = {}) {
  const id = agent || detectHostAgent(env);
  const adapter = adapters[id];
  if (!adapter) throw new Error(`ADAPTER_UNSUPPORTED: ${id}; no CLI adapter implemented; no fallback or automatic install.`);
  // An explicit executable is an operator decision. If it is stale or invalid,
  // fail closed instead of silently installing a different CLI and hiding the
  // configuration error.
  const explicit = String(env.ORCH_CLI || env.CODEX_EXE || '').trim();
  const allowExplicitUnverified = Boolean(explicit && String(env.ORCH_ALLOW_UNVERIFIED_CLI || '') === '1');
  const explicitlyAllowed = file => allowExplicitUnverified
    && path.resolve(file).toLowerCase() === path.resolve(explicit).toLowerCase();
  let untrustedCandidate = false;
  let selectedIdentity = null;
  const verifiedProbe=file=>{
    if (!fileIdentity(file)) return false;
    const allowUnverified = explicitlyAllowed(file);
    if(isPrivateCliCandidate(file,env)){
      try{
        if(!verifyPrivate(file))return false;
      }catch{return false;}
    } else if (!allowUnverified && !verifyExternal(file)) {
      untrustedCandidate = true;
      return false;
    } else if (!allowUnverified) {
      const beforeProbe = fileIdentity(file);
      if (!beforeProbe) { untrustedCandidate = true; return false; }
      if (fileIdentity(file) !== beforeProbe) { untrustedCandidate = true; return false; }
      const accepted = probe(file);
      if (fileIdentity(file) !== beforeProbe || !verifyExternal(file)) {
        untrustedCandidate = true;
        return false;
      }
      if (accepted) selectedIdentity = beforeProbe;
      return accepted;
    }
    return probe(file);
  };
  let bin = candidates(env).find(verifiedProbe);
  const shouldAutoInstall = !explicit && !untrustedCandidate && (autoInstall ?? (candidates === cliCandidates && env.ORCH_AUTO_INSTALL_CLI !== '0'));
  if (!bin && id === 'codex' && shouldAutoInstall) {
    try {
       const installed = (install || (() => installCodexCli({env, probe})))();
      const installedCandidates = Array.isArray(installed) ? installed : [installed];
       bin = [...installedCandidates, ...candidates(env)].find(verifiedProbe);
    } catch (error) {
      if (String(error?.message || '').startsWith('CLI_AUTO_INSTALL_FAILED')) throw error;
      throw installerError(error?.code || 'installer');
    }
  }
  if (bin && !explicitlyAllowed(bin) && !isPrivateCliCandidate(bin, env)
      && (fileIdentity(bin) !== selectedIdentity || !verifyExternal(bin))) {
    throw new Error(`CLI_UNTRUSTED: ${id}; the candidate changed after verification. Retry after restoring the signed executable.`);
  }
  if (!bin && untrustedCandidate) {
    throw new Error(`CLI_UNTRUSTED: ${id}; the candidate is not signed by a trusted publisher. Set ORCH_ALLOW_UNVERIFIED_CLI=1 only for an explicitly selected custom executable.`);
  }
  if (!bin) throw new Error(`CLI_MISSING: ${id}; install its CLI yourself or set ORCH_CLI to its native executable. Automatic installation was disabled or did not produce a verified native binary.`);
  return { agent: id, config: { ...adapter, bin, available: true } };
}

export function launchArgs(config, options = {}) {
  if (!adapters[config?.id]) throw new Error('ADAPTER_UNSUPPORTED: refusing a non-Codex adapter.');
  const cwd = options.cwd || process.cwd();
  const requestedSandbox = options.sandbox || 'read-only';
  const requestedApproval = options.approval || 'on-request';
  const {sandbox,approval}=constrainWorkerPolicy(requestedSandbox,requestedApproval);
  if(sandbox!==requestedSandbox||approval!==requestedApproval)
    throw new Error('CHILD_AUTHORIZATION_UNAVAILABLE: privileged child policy requires a host-authenticated capability');
  const args = ['--cd', cwd];
  args.push('-a', approval, '--sandbox', sandbox);
  // Codex retains configured workspace-write extra roots even when a CLI
  // sandbox flag selects workspace-write.  Clear them explicitly so a child
  // can write only its initiating workspace and asks before any write.
  args.push('-c','sandbox_workspace_write.writable_roots=[]');
  args.push(...networkArgs());
  // A worker starts after the host has already prepared the environment.
  // Fresh plugin SessionStart hooks trigger an interactive trust review in the
  // TUI before the task begins. Keep that decision with the initiating host;
  // worker windows run without hooks and never bypass hook trust.
  args.push('--disable','hooks');
  return args;
}

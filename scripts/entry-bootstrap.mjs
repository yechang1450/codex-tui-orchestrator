import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertTrustedNpm, pickNpmCli, quoteShellArg} from './npm-cli.mjs';
import {verifyLockedSdk} from './sdk-dependency-verify.mjs';
import {verifyRelease} from './release-integrity.mjs';
import {trustedWindowsHelper,trustedWindowsRoot,controllerEnvironment} from './core/leases.mjs';

// 引擎加载**之前**就要能跑完的命令。
//
// 为什么单独一层：引擎（scripts/core/orchestrate-sdk.mjs）静态依赖锁定的 SDK，
// 而 `--install-deps` 的用途恰恰是"依赖缺失/损坏时把它修回来"，`--help` / `--version`
// 是排障时最该先能用的只读命令。放在引擎里 = 一旦依赖坏了，连修法和版本都问不出来。
//
// 输出一律走 writeSync(1)：这些命令会在写完后立刻 exit(0)，而管道的 console.log 是
// 异步的，Windows 上可能被截断。
const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');

export const USAGE = [
  'Usage:',
  '  node orchestrate-sdk.mjs --version                  (read-only: plugin + core version)',
  '  node orchestrate-sdk.mjs --install-deps             (idempotent: restore the locked SDK)',
  '  node orchestrate-sdk.mjs --doctor                   (check host/CLI/workspace/mode; first use may prepare dependencies)',
  '  node orchestrate-sdk.mjs --tasks [--run-id <id>]    (TodoList + execution status; first use may prepare dependencies)',
  '  node orchestrate-sdk.mjs --plan "<request>"',
  '  node orchestrate-sdk.mjs --plan-file <path>         (same as --plan, request read from a file)',
  '  node orchestrate-sdk.mjs --run  "<request>"',
  '  node orchestrate-sdk.mjs --exec "<request>"         (read-only, noninteractive only)',
  '  node orchestrate-sdk.mjs --run-windows "<request>"',
  '  node orchestrate-sdk.mjs --resume-run <id>',
  '  node orchestrate-sdk.mjs --verify-run <id> [--allow-acceptance-change]',
  '  node orchestrate-sdk.mjs --status [--run-id <id>] [--watch] [--json]',
  '  node orchestrate-sdk.mjs --clear-cache',
  '  node orchestrate-sdk.mjs --selftest-close',
  '  node orchestrate-sdk.mjs --spawn <title> "<prompt or .md>"',
].join('\n');

const BOOTSTRAP_COMMANDS = new Set(['--help', '-h', '--version', '--install-deps']);

// First-use SDK setup is automatic; ORCH_AUTO_INSTALL_DEPS=0 opts out.
// Reuse the bounded locked installer and keep all diagnostics off JSON stdout.
export async function ensureRuntimeDependencies({env=process.env,verify=verifyLockedSdk,install=installLockedDependencies}={}) {
  const before=await verify();
  if(before.ok)return before;
  if(env.ORCH_AUTO_INSTALL_DEPS==='0'||before.code!=='RELEASE_DEPENDENCY_MISSING')throw new Error(before.message);
  assertTrustedNpm(env);
  console.error('[orchestrator] installing missing locked SDK dependency');
  await install({env});
  const after=await verify();
  if(!after.ok)throw new Error(after.message);
  return after;
}

function emit(text) {
  fs.writeSync(1, text.endsWith('\n') ? text : text + '\n');
}

/** 版本从"权威文件"直读，不加载引擎：损坏的树也要能问出版本号。 */
export function versionReport() {
  const report = {name: 'codex-tui-orchestrator', version: null, coreVersion: null, schema: null};
  try {
    report.version = JSON.parse(fs.readFileSync(path.join(repoRoot, '.codex-plugin', 'plugin.json'), 'utf8')).version || null;
  } catch { /* 版本是只读诊断，读不到就留 null */ }
  try {
    const release = JSON.parse(fs.readFileSync(path.join(repoRoot, 'release.json'), 'utf8'));
    report.coreVersion = release.coreVersion || null;
    report.schema = release.schema ?? null;
  } catch { /* 同上 */ }
  if (!report.coreVersion) {
    // release.json 缺失/损坏时回退到源头常量（与 release-integrity 用同一处定义）。
    try {
      report.coreVersion = /CORE_VERSION\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(scriptsDir, 'core', 'contracts.mjs'), 'utf8'))?.[1] || null;
    } catch { /* 同上 */ }
  }
  return report;
}

/**
 * 幂等恢复锁定依赖：已经满足就报 already-present，绝不做多余安装。
 * 判据 test/entry-surface-audit.test.mjs（二次调用必须是 already-present）。
 */
export async function installLockedDependencies({timeoutMs = 15 * 60 * 1000, env = process.env, verify = verifyLockedSdk, spawn = spawnSync, pickNpm = pickNpmCli} = {}) {
  const before = await verify();
  if (before.ok) {
    return {ok: true, status: 'already-present', dependency: '@openai/codex-sdk', version: before.version,
      expected: before.expected, scriptsDir, reason: 'locked SDK dependency already satisfies scripts/package.json'};
  }
  assertTrustedNpm(env);
  const invocation = resolveInvocation(['ci', '--prefix', scriptsDir, '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], env, pickNpm);
  const started = Date.now();
  const result = spawn(invocation.command, invocation.args, {
    cwd: scriptsDir, encoding: 'utf8', windowsHide: true, shell: invocation.shell, timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024, env,
  });
  if (result.error) throw new Error('npm ci could not start: ' + (result.error.code || result.error.message));
  if (result.status !== 0) {
    const tail = String(result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 400);
    throw new Error(`npm ci failed (exit ${result.status}): ${tail}`);
  }
  const after = await verify();
  if (!after.ok) throw new Error('dependencies were restored but the lock check still fails: ' + after.message);
  return {ok: true, status: 'installed', dependency: '@openai/codex-sdk', version: after.version,
    expected: after.expected, scriptsDir, ms: Date.now() - started};
}

function bootstrapFailureCode(result) {
  const text=String(result?.stderr||result?.stdout||'');
  return /\b([A-Z][A-Z0-9_]{2,}):/.exec(text)?.[1] || 'BOOTSTRAP_FAILED';
}

// The Desktop's bundled Node intentionally has no npm binary.  An explicit
// repair may bridge into the already-audited PowerShell bootstrap, but only
// after the release itself is sealed.  Normal runtime startup must keep its
// stricter npm-attestation behaviour and never gain this network-capable path.
export function bootstrapExplicitDependencyRepair({timeoutMs=15*60*1000,env=process.env,spawn=spawnSync,
  releaseVerify=verifyRelease,powershell=trustedWindowsHelper,windowsRoot=trustedWindowsRoot,
  safeEnvironment=controllerEnvironment}={}) {
  if(process.platform!=='win32')throw new Error('NPM_UNTRUSTED: a verified npm runtime is unavailable');
  releaseVerify(repoRoot);
  const seconds=Math.max(1,Math.min(1800,Math.ceil((Number(timeoutMs)||0)/1000)));
  const childEnv=safeEnvironment({
    ...(typeof env.PLUGIN_DATA==='string'&&env.PLUGIN_DATA?{PLUGIN_DATA:env.PLUGIN_DATA}:{}),
    ORCH_DEP_REPAIR_BOOTSTRAP:'1',
  });
  const result=spawn(powershell(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    path.join(scriptsDir,'bootstrap.ps1'),'-Action','repair-deps','-Json','-TimeoutSeconds',String(seconds)],{
    cwd:windowsRoot(),encoding:'utf8',windowsHide:true,shell:false,timeout:timeoutMs+15000,maxBuffer:64*1024,env:childEnv,
  });
  if(result?.error||result?.status!==0)throw new Error('NPM_RUNTIME_BOOTSTRAP_FAILED: '+bootstrapFailureCode(result));
  const output=String(result.stdout||'');
  if(Buffer.byteLength(output,'utf8')>64*1024)throw new Error('NPM_RUNTIME_BOOTSTRAP_FAILED: invalid_output');
  let parsed;
  try{parsed=JSON.parse(output);}catch{throw new Error('NPM_RUNTIME_BOOTSTRAP_FAILED: invalid_output');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||parsed.ok!==true)throw new Error('NPM_RUNTIME_BOOTSTRAP_FAILED: invalid_output');
  return parsed;
}

export async function repairExplicitDependencyInstall({timeoutMs=15*60*1000,env=process.env,verify=verifyLockedSdk,
  install=installLockedDependencies,bridge=bootstrapExplicitDependencyRepair,platform=process.platform}={}) {
  let before;
  try{before=await verify();}catch(error){throw error;}
  try{return await install({timeoutMs,env,verify});}
  catch(error){
    const marker=String(env.ORCH_DEP_REPAIR_BOOTSTRAP||'');
    const canBridge=platform==='win32'&&before?.code==='RELEASE_DEPENDENCY_MISSING'&&
      marker!=='1'&&String(error?.message||'').startsWith('NPM_UNTRUSTED:');
    if(!canBridge)throw error;
    const repaired=await bridge({timeoutMs,env});
    const after=await verify();
    if(!after?.ok)throw new Error('NPM_RUNTIME_BOOTSTRAP_FAILED: dependency_verification');
    return repaired;
  }
}

function resolveInvocation(args, env = process.env, pickNpm = pickNpmCli) {
  const npm = pickNpm({env});
  if (!npm || npm.source === 'fallback' || typeof npm.command !== 'string' || !Array.isArray(npm.args) || typeof npm.shell !== 'boolean') {
    throw new Error('NPM_UNTRUSTED: a verified npm runtime is unavailable');
  }
  const argv = [...npm.args, ...args];
  // 走 shell 时参数要自己加引号，否则含空格的工作路径会被拆开。
  return {command: npm.command, args: npm.shell ? argv.map(quoteShellArg) : argv, shell: npm.shell, source: npm.source};
}

/**
 * 处理只读/自举命令。命中就同步写完 stdout 并返回 true（调用方随即 exit(0)）。
 * 未命中返回 false，交给引擎正常解析——这样 `--mode bogus` 之类仍然按未知参数 fail-closed。
 */
export async function runBootstrapCommand(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!BOOTSTRAP_COMMANDS.has(command)) return false;
  if (command === '--help' || command === '-h') {
    emit(USAGE);
    return true;
  }
  if (command === '--version') {
    emit(JSON.stringify(versionReport(), null, 2));
    return true;
  }
  emit(JSON.stringify(await repairExplicitDependencyInstall(), null, 2));
  return true;
}

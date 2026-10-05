import { test } from 'node:test';
import { networkArgs } from '../scripts/network-policy.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import { detectHostAgent, installCodexCli, resolveHost, launchArgs, cliCandidates, verifyAuthenticodePublisher } from '../scripts/host-cli.mjs';
function fakeCli(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-cli-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'codex.exe');
  fs.writeFileSync(file,'test-only native CLI fixture');
  return file;
}
test('unknown and explicitly unsupported hosts never become codex', () => {
  assert.throws(() => detectHostAgent({}), /HOST_UNKNOWN/);
  assert.equal(detectHostAgent({ ORCH_AGENT: 'unknown', CODEX_THREAD_ID: 'x' }), 'unknown');
  assert.throws(() => resolveHost({env:{ ORCH_AGENT: 'unknown' }}), /ADAPTER_UNSUPPORTED/);
});
test('missing CLI cannot start or install anything', () => {
  assert.throws(() => resolveHost({env:{ ORCH_AGENT:'codex' }, candidates:()=>[], probe:()=>false, autoInstall:false}), /CLI_MISSING/);
});
test('missing native CLI invokes one bounded automatic installer and re-probes the result', t => {
  let installs = 0;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-cli-private-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const installed=path.join(dir,'runtime','cli','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
  fs.mkdirSync(path.dirname(installed),{recursive:true});
  fs.writeFileSync(installed,'test-only private CLI fixture');
  const host = resolveHost({
    env: { ORCH_AGENT:'codex', PLUGIN_DATA:dir },
    candidates: () => [],
    probe: file => file === installed,
    verifyPrivate:()=>true,
    install: () => { installs += 1; return installed; },
    autoInstall: true,
  });
  assert.equal(installs, 1);
  assert.equal(host.config.bin, installed);
});
test('explicit native CLI remains authoritative and suppresses automatic installation', t => {
  let installs = 0;
  const bin=fakeCli(t);
  const host = resolveHost({
    env: { ORCH_AGENT:'codex', ORCH_CLI:bin, ORCH_ALLOW_UNVERIFIED_CLI:'1' },
    candidates: () => [bin],
    probe: file => file === bin,
    install: () => { installs += 1; return 'other-native-codex'; },
    autoInstall: true,
  });
  assert.equal(installs, 0);
  assert.equal(host.config.bin, bin);
});
test('an invalid explicit native CLI fails closed without installing a replacement', () => {
  let installs = 0;
  assert.throws(() => resolveHost({
    env: { ORCH_AGENT:'codex', ORCH_CLI:'C:\\tools\\missing-codex.exe' },
    candidates: () => ['C:\\tools\\missing-codex.exe'],
    probe: () => false,
    install: () => { installs += 1; return 'replacement-native-codex'; },
    autoInstall: undefined,
  }), /CLI_MISSING/);
  assert.equal(installs, 0);
});
test('unsigned external CLI is rejected before its version probe', t => {
  const bin = fakeCli(t);
  let probed = 0;
  assert.throws(() => resolveHost({
    env: {ORCH_AGENT:'codex', ORCH_CLI:bin}, candidates:()=>[bin],
    verifyExternal:()=>false, probe:()=>{probed++; return true;}, autoInstall:false,
  }), /CLI_UNTRUSTED/);
  assert.equal(probed, 0);
});

test('an untrusted existing CLI does not invoke the automatic installer', t => {
  const bin = fakeCli(t);
  let installs = 0;
  assert.throws(() => resolveHost({
    env: {ORCH_AGENT:'codex'}, candidates:()=>[bin],
    verifyExternal:()=>false, probe:()=>true, autoInstall:true,
    install:()=>{installs++; return bin;},
  }), /CLI_UNTRUSTED/);
  assert.equal(installs,0);
});

test('Authenticode verification allows a bounded slow Windows trust check', t => {
  if (process.platform !== 'win32') return t.skip('Windows Authenticode contract');
  const bin = fakeCli(t);
  const sign = (_command, _args, options) => {
    assert.ok(options.timeout >= 30000);
    return {status:0, stdout:'41977145C93B7A096405E230DDCC8FED1AB82AC3\n'};
  };
  assert.equal(verifyAuthenticodePublisher(bin, process.env, sign), true);
});
test('pinned npm-distributed native CLI signer remains trusted when a cache sees it as external', t => {
  if (process.platform !== 'win32') return t.skip('Windows Authenticode contract');
  const bin = fakeCli(t);
  const sign = (_command, _args, _options) => ({status:0, stdout:'41977145C93B7A096405E230DDCC8FED1AB82AC3\n'});
  assert.equal(verifyAuthenticodePublisher(bin, process.env, sign), true);
});
test('current OpenAI desktop CLI signer is trusted after Authenticode validation', t => {
  if (process.platform !== 'win32') return t.skip('Windows Authenticode contract');
  const bin = fakeCli(t);
  const sign = (_command, _args, _options) => ({status:0, stdout:'AAB04F57830B69182775AB3CEB6CE37981FE71C5\n'});
  assert.equal(verifyAuthenticodePublisher(bin, process.env, sign), true);
});
test('a tampered plugin-private CLI is rejected before its version probe',()=>{
  const home=path.join(os.tmpdir(),'orch-cli-private-candidate');
  const bin=path.join(home,'runtime','cli','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
  let probed=0;
  assert.throws(()=>resolveHost({env:{ORCH_AGENT:'codex',PLUGIN_DATA:home},candidates:()=>[bin],
    verifyPrivate:()=>false,probe:()=>{probed++;return true;},autoInstall:false}),/CLI_MISSING/);
  assert.equal(probed,0);
});
test('automatic installer replaces uppercase npm prefix before spawning npm',()=>{
  const home=path.join(os.tmpdir(),'orch-cli-private-prefix');
  const expected=path.join(home,'runtime','cli','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
  const spawn=(_command,args,options)=>{
    const child=spawnSync(process.execPath,['-e','process.stdout.write(process.env.npm_config_prefix||"")'],{env:options.env,encoding:'utf8'});
    assert.equal(child.stdout,path.join(home,'runtime','cli'));
    return args.at(-2)==='root'?{status:0,stdout:path.join(home,'runtime','cli','node_modules')}:{status:0};
  };
  assert.equal(installCodexCli({env:{PATH:process.env.PATH,NPM_CONFIG_PREFIX:'C:\\outside',PLUGIN_DATA:home,ORCH_ALLOW_UNVERIFIED_NPM:'1'},platform:'win32',spawn,verifyBinary:()=>true,verifyTree:()=>true,probe:()=>true}),expected);
});
test('automatic CLI installation refuses ambient npm before spawning it',()=>{
  let spawned=false;
  assert.throws(()=>installCodexCli({
    env:{PATH:process.env.PATH,PLUGIN_DATA:path.join(os.tmpdir(),'orch-cli-untrusted-npm')},
    platform:'win32',
    spawn:()=>{spawned=true;return {status:0};},
  }),/CLI_AUTO_INSTALL_FAILED.*npm_untrusted/i);
  assert.equal(spawned,false);
});
test('automatic installation errors are reported without leaking installer output', () => {
  assert.throws(() => resolveHost({
    env: { ORCH_AGENT:'codex' },
    candidates: () => [],
    probe: () => false,
    install: () => { throw new Error('npm exited with status 1; secret-token-must-not-appear'); },
    autoInstall: true,
  }), error => {
    assert.match(String(error.message), /CLI_AUTO_INSTALL_FAILED/);
    assert.doesNotMatch(String(error.message), /secret-token/);
    return true;
  });
});
test('automatic installer uses a bounded global npm install and verifies the installed native package', () => {
  const calls = [];
  let integrityChecked=false;
  const home=path.join(os.tmpdir(),'orch-cli-happy-fixture');
  const root=path.join(home,'runtime','cli','node_modules');
  const expected=path.join(root,'@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
  const spawn = (command, args, options) => {
    calls.push({command, args, options});
    if (args.at(-2) === 'root' && args.at(-1) === '--global') return {status: 0, stdout: root + String.fromCharCode(13, 10)};
    return {status: 0, stdout: 'npm installed\n', stderr: 'diagnostic\n'};
  };
  const bin = installCodexCli({
    env: {PATH: '', PLUGIN_DATA:home, ORCH_CLI_INSTALL_SPEC: '@openai/codex@0.160.0', ORCH_ALLOW_UNVERIFIED_NPM:'1'},
    platform: 'win32',
    spawn,
    verifyBinary:()=>{integrityChecked=true;return true;},
    verifyTree:()=>true,
    probe: file => file === expected,
  });
  assert.equal(bin, expected);
  assert.equal(integrityChecked,true,'native executable must be authenticated before the version probe');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('install'));
  assert.ok(calls[0].args.includes('--global'));
  assert.ok(calls[0].args.includes('--ignore-scripts'));
  assert.ok(calls[0].args.includes('--no-audit'));
  assert.ok(calls[0].args.includes('--no-fund'));
  assert.ok(calls[0].args.includes('@openai/codex@0.160.0'));
  assert.equal(calls[0].options.timeout, 120000);
});
test('automatic installer rejects an altered platform package tree before probing the CLI',()=>{
  const home=path.join(os.tmpdir(),'orch-cli-tree-fixture');
  const root=path.join(home,'runtime','cli','node_modules');
  let probed=0;
  const spawn=(_command,args)=>args.at(-2)==='root'?{status:0,stdout:root}:{status:0};
  assert.throws(()=>installCodexCli({env:{PATH:process.env.PATH,PLUGIN_DATA:home,ORCH_ALLOW_UNVERIFIED_NPM:'1'},platform:'win32',spawn,
    verifyBinary:()=>true,verifyTree:()=>false,probe:()=>{probed++;return true;}}),/integrity_mismatch/);
  assert.equal(probed,0);
});

test('automatic CLI installer rejects substituted native bytes before executing them',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'orch-cli-integrity-'));
  const root=path.join(home,'runtime','cli','node_modules');
  const bin=path.join(root,'@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
  fs.mkdirSync(path.dirname(bin),{recursive:true});fs.writeFileSync(bin,'substituted executable','utf8');
  let probed=false;
  try {
    assert.throws(()=>installCodexCli({env:{...process.env,PLUGIN_DATA:home,ORCH_CLI_INSTALL_SPEC:'@openai/codex@0.160.0',ORCH_ALLOW_UNVERIFIED_NPM:'1'},platform:'win32',localRoots:[],
      spawn:(_command,args)=>args.at(-2)==='root'?{status:0,stdout:root+'\n'}:{status:0},
      probe:()=>{probed=true;return true;}}),/CLI_AUTO_INSTALL_FAILED.*integrity/i);
    assert.equal(probed,false);
  } finally {fs.rmSync(home,{recursive:true,force:true});}
});

test('automatic CLI installer never fetches a version without a release-controlled digest',()=>{
  let spawned=false;
  assert.throws(()=>installCodexCli({env:{...process.env,ORCH_CLI_INSTALL_SPEC:'@openai/codex@0.149.0'},spawn:()=>{spawned=true;return {status:1};}}),/CLI_AUTO_INSTALL_FAILED.*unpinned/i);
  assert.equal(spawned,false);
});

test('direct automatic CLI installation overrides ambient npm global prefix with plugin-private runtime',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'orch-cli-prefix-'));
  let usedPrefix='';
  try {
    assert.throws(()=>installCodexCli({env:{...process.env,PLUGIN_DATA:home,npm_config_prefix:path.join(home,'outside'),ORCH_ALLOW_UNVERIFIED_NPM:'1'},spawn:(_command,_args,options)=>{usedPrefix=options.env.npm_config_prefix;return {status:1};}}),/CLI_AUTO_INSTALL_FAILED/);
    assert.equal(path.resolve(usedPrefix),path.join(home,'runtime','cli'));
  } finally {fs.rmSync(home,{recursive:true,force:true});}
});
test('automatic installer converts npm failure to a bounded diagnostic without npm output', () => {
  assert.throws(() => installCodexCli({
    env: {PATH: '', ORCH_CLI_INSTALL_SPEC: '@openai/codex@0.149.0'},
    platform: 'win32',
    localRoots: [],
    spawn: () => ({status: 1, stdout: 'private-token-from-npm', stderr: 'registry details'}),
  }), error => {
    assert.match(String(error.message), /CLI_AUTO_INSTALL_FAILED/);
    assert.doesNotMatch(String(error.message), /private-token|registry details/);
    return true;
  });
});

test('automatic CLI installation requires an exact official Codex package version',()=>{
  for(const spec of ['@openai/codex','@evil/codex@1.2.3','@openai/codex@latest','@openai/codex@1.2.3 --ignore-scripts']){
    assert.throws(()=>installCodexCli({env:{PATH:'',ORCH_CLI_INSTALL_SPEC:spec},spawn:()=>{throw new Error('must not spawn');}}),/CLI_AUTO_INSTALL_FAILED/);
  }
});
test('Windows CLI discovery consults the native where.exe result when PATH is empty', () => {
  const candidates = cliCandidates({PATH:'',Path:'',SystemRoot:'C:\\Windows'}, 'win32', {
    localRoots: [], desktopBins: [],
    where: () => ({status:0, stdout:'C:\\Program Files\\Codex\\codex.exe\r\n'})
  });
  assert.ok(candidates.includes('C:\\Program Files\\Codex\\codex.exe'));
});
test('Windows CLI discovery covers current npm vendor bin layout', () => {
  const candidates = cliCandidates({ PATH:'C:\\tools', Path:'', SystemRoot:'C:\\Windows' }, 'win32', {
    where: () => ({ status:1, stdout:'' })
  });
  assert.ok(candidates.includes('C:\\tools\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe'));
});
test('Windows CLI discovery checks the installed plugin dependency tree', () => {
  const candidates = cliCandidates({ PATH:'', Path:'', SystemRoot:'C:\\Windows' }, 'win32', {
    where: () => ({ status:1, stdout:'' }),
    localRoots: ['C:\\plugin\\scripts\\node_modules'],
  });
  assert.ok(candidates.includes('C:\\plugin\\scripts\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe'));
});
test('host identity and resolved executable are preserved', t => {
  assert.equal(detectHostAgent({ CODEX_THREAD_ID:'x' }), 'codex');
  const bin=fakeCli(t);
  const host = resolveHost({env:{ORCH_AGENT:'codex',ORCH_CLI:bin,ORCH_ALLOW_UNVERIFIED_CLI:'1'}, candidates:()=>['missing',bin], probe:p=>p===bin});
  assert.equal(host.config.bin,bin);
  assert.deepEqual(launchArgs(host.config,{cwd:'a b',sandbox:'read-only',approval:'never'}), ['--cd','a b','-a','never','--sandbox','read-only',...networkArgs(),'--disable','hooks']);
  const authorized = launchArgs(host.config,{cwd:'a b',sandbox:'danger-full-access',approval:'never'});
  assert.ok(authorized.includes('--dangerously-bypass-approvals-and-sandbox'));
  // Codex rejects the approval flag together with the dangerous bypass flag;
  // the bypass itself is the no-prompt authorization envelope for this mode.
  assert.equal(authorized.includes('-a'), false);
  assert.equal(authorized.includes('never'), false);
  assert.throws(()=>launchArgs({id:'unknown'}),/ADAPTER_UNSUPPORTED/);
});

test('restricted child argv preserves on-request approval and does not bypass sandbox or project trust',()=>{
  const args=launchArgs({id:'codex'},{cwd:'C:\\work',sandbox:'workspace-write',approval:'on-request'});
  assert.deepEqual(args.slice(0,6),['--cd','C:\\work','-a','on-request','--sandbox','workspace-write']);
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'),false);
  assert.equal(args.some(arg=>arg.includes('trust_level="trusted"')),false);
});

test('Codex child windows disable session hooks so first-run hook review cannot block tasks',()=>{
  const args=launchArgs({id:'codex'},{cwd:'C:\\work',sandbox:'workspace-write',approval:'on-request'});
  const at=args.indexOf('--disable');
  assert.ok(at>=0,'the worker must disable host session hooks');
  assert.equal(args[at+1],'hooks');
  assert.equal(args.includes('--dangerously-bypass-hook-trust'),false);
});

test('danger-full-access with on-request approval never receives no-approval bypass',()=>{
  const args=launchArgs({id:'codex'},{cwd:'C:\\work',sandbox:'danger-full-access',approval:'on-request'});
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'),false);
  assert.deepEqual(args.slice(0,6),['--cd','C:\\work','-a','on-request','--sandbox','danger-full-access']);
});

test('desktop CLI precedes the SDK bundled fallback and invalid explicit paths never install',()=>{
  const desktop='C:\\AppData\\Local\\OpenAI\\Codex\\bin\\current\\codex.exe';
  const list=cliCandidates({PATH:''},'win32',{desktopBins:[desktop],localRoots:['C:\\plugin\\node_modules'],where:()=>({status:1})});
  assert.equal(list[0],desktop);
  let installed=false;
  assert.throws(()=>resolveHost({env:{ORCH_AGENT:'codex',ORCH_CLI:'missing'},candidates:()=>[],probe:()=>false,autoInstall:true,install:()=>{installed=true;}}),/CLI_MISSING/);
  assert.equal(installed,false);
});

test('automatic CLI install rejects unbounded timeouts before starting npm',()=>{
  for(const value of ['0','-1','NaN','Infinity','600001']){
    let spawned=false;
    assert.throws(()=>installCodexCli({env:{ORCH_CLI_INSTALL_TIMEOUT_MS:value},spawn:()=>{spawned=true;return {status:1};}}),/invalid_timeout/);
    assert.equal(spawned,false);
  }
});

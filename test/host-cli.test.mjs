import { test } from 'node:test';
import { networkArgs } from '../scripts/network-policy.mjs';
import assert from 'node:assert/strict';
import { detectHostAgent, installCodexCli, resolveHost, launchArgs, cliCandidates } from '../scripts/host-cli.mjs';
test('unknown and explicitly unsupported hosts never become codex', () => {
  assert.throws(() => detectHostAgent({}), /HOST_UNKNOWN/);
  assert.equal(detectHostAgent({ ORCH_AGENT: 'unknown', CODEX_THREAD_ID: 'x' }), 'unknown');
  assert.throws(() => resolveHost({env:{ ORCH_AGENT: 'unknown' }}), /ADAPTER_UNSUPPORTED/);
});
test('missing CLI cannot start or install anything', () => {
  assert.throws(() => resolveHost({env:{ ORCH_AGENT:'codex' }, candidates:()=>[], probe:()=>false, autoInstall:false}), /CLI_MISSING/);
});
test('missing native CLI invokes one bounded automatic installer and re-probes the result', () => {
  let installs = 0;
  const host = resolveHost({
    env: { ORCH_AGENT:'codex' },
    candidates: () => [],
    probe: file => file === 'installed-native-codex',
    install: () => { installs += 1; return 'installed-native-codex'; },
    autoInstall: true,
  });
  assert.equal(installs, 1);
  assert.equal(host.config.bin, 'installed-native-codex');
});
test('explicit native CLI remains authoritative and suppresses automatic installation', () => {
  let installs = 0;
  const host = resolveHost({
    env: { ORCH_AGENT:'codex', ORCH_CLI:'C:\\tools\\codex.exe' },
    candidates: () => ['C:\\tools\\codex.exe'],
    probe: file => file === 'C:\\tools\\codex.exe',
    install: () => { installs += 1; return 'other-native-codex'; },
    autoInstall: true,
  });
  assert.equal(installs, 0);
  assert.equal(host.config.bin, 'C:\\tools\\codex.exe');
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
  const expected = 'C:\\npm-root\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
  const spawn = (command, args, options) => {
    calls.push({command, args, options});
    if (args.at(-2) === 'root' && args.at(-1) === '--global') return {status: 0, stdout: 'C:\\npm-root' + String.fromCharCode(13, 10)};
    return {status: 0, stdout: 'npm installed\n', stderr: 'diagnostic\n'};
  };
  const bin = installCodexCli({
    env: {PATH: '', ORCH_CLI_INSTALL_SPEC: '@openai/codex@0.149.0'},
    platform: 'win32',
    localRoots: [],
    spawn,
    probe: file => file === expected,
  });
  assert.equal(bin, expected);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('install'));
  assert.ok(calls[0].args.includes('--global'));
  assert.ok(calls[0].args.includes('--ignore-scripts'));
  assert.ok(calls[0].args.includes('--no-audit'));
  assert.ok(calls[0].args.includes('--no-fund'));
  assert.ok(calls[0].args.includes('@openai/codex@0.149.0'));
  assert.equal(calls[0].options.timeout, 120000);
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
test('host identity and resolved executable are preserved', () => {
  assert.equal(detectHostAgent({ CODEX_THREAD_ID:'x' }), 'codex');
  const host = resolveHost({env:{ORCH_AGENT:'codex'}, candidates:()=>['missing','native cli'], probe:p=>p==='native cli'});
  assert.equal(host.config.bin,'native cli');
  assert.deepEqual(launchArgs(host.config,{cwd:'a b',sandbox:'read-only',approval:'never'}), ['--cd','a b','-a','never','--sandbox','read-only','-c','projects."a b".trust_level="trusted"',...networkArgs()]);
  const authorized = launchArgs(host.config,{cwd:'a b',sandbox:'danger-full-access',approval:'never'});
  assert.ok(authorized.includes('--dangerously-bypass-approvals-and-sandbox'));
  // Codex rejects the approval flag together with the dangerous bypass flag;
  // the bypass itself is the no-prompt authorization envelope for this mode.
  assert.equal(authorized.includes('-a'), false);
  assert.equal(authorized.includes('never'), false);
  assert.throws(()=>launchArgs({id:'unknown'}),/ADAPTER_UNSUPPORTED/);
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

import { test } from 'node:test';
import { networkArgs } from '../scripts/network-policy.mjs';
import assert from 'node:assert/strict';
import { detectHostAgent, resolveHost, launchArgs, cliCandidates } from '../scripts/host-cli.mjs';
test('unknown and explicitly unsupported hosts never become codex', () => {
  assert.throws(() => detectHostAgent({}), /HOST_UNKNOWN/);
  assert.equal(detectHostAgent({ ORCH_AGENT: 'unknown', CODEX_THREAD_ID: 'x' }), 'unknown');
  assert.throws(() => resolveHost({env:{ ORCH_AGENT: 'unknown' }}), /ADAPTER_UNSUPPORTED/);
});
test('missing CLI cannot start or install anything', () => {
  assert.throws(() => resolveHost({env:{ ORCH_AGENT:'codex' }, candidates:()=>[], probe:()=>false}), /CLI_MISSING/);
});
test('Windows CLI discovery consults the native where.exe result when PATH is empty', () => {
  const candidates = cliCandidates({PATH:'',Path:'',SystemRoot:'C:\\Windows'}, 'win32', {
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

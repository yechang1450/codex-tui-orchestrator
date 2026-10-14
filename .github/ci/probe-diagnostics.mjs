// Temporary CI diagnostics: compare spawn option combinations against the
// production PowerShell ACL probe shape to find the ETIMEDOUT source.
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {trustedWindowsHelper} from '../../scripts/core/windows-system.mjs';
import {trustedPowerShellEnvironment} from '../../scripts/core/private-root.mjs';

const ps = trustedWindowsHelper('powershell');
const target = process.argv[2];
const phase = process.argv[3] || 'phase1';
console.log('DIAG_PHASE', phase);
const source = readFileSync(new URL('../../scripts/core/private-root.mjs', import.meta.url), 'utf8');
const scriptMatch = /const ACL_PROBE_SCRIPT=\[([\s\S]*?)\]\.join\(';'\);/.exec(source);
const fullScript = scriptMatch ? eval('[' + scriptMatch[1] + ']').join(';') : '';
console.log('DIAG_FULL_SCRIPT_CHARS', fullScript.length);
const prelude = "$ErrorActionPreference='Stop';$target=[Console]::In.ReadToEnd().Trim();if([string]::IsNullOrWhiteSpace($target)){throw 'missing root'};$acl=[IO.Directory]::GetAccessControl($target);";
const stepAcl = prelude + "'STEP1_DONE'";
const stepOwner = prelude + "$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;'STEP2_DONE '+$owner";
const stepRules = prelude + "$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));'STEP3_DONE '+$rules.Count";
const stepRuleIds = prelude + "$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value });'STEP4_DONE '+$rules.Count";
const w1 = prelude + "$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;'W1_DONE '+$current";
const w2 = prelude + "$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;'W2_DONE '+$owner";
const w3 = prelude + "$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));'W3_DONE '+$rules.Count";
const w4 = prelude + "$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));$objs=@($rules | ForEach-Object { [PSCustomObject]@{ sid=$_.IdentityReference.Value; type=$_.AccessControlType.ToString(); rights=[string](([int64][int]$_.FileSystemRights) -band [int64]4294967295); propagation=$_.PropagationFlags.ToString() } });'W4_DONE '+$objs.Count";
const probeScript = "$ErrorActionPreference='Stop';$target=[Console]::In.ReadToEnd().Trim();if([string]::IsNullOrWhiteSpace($target)){throw 'missing root'};$acl=[IO.Directory]::GetAccessControl($target);$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;'PROBE_DONE ' + $owner";
const base = {encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000, maxBuffer: 64 * 1024};
const cases = [
  ['V1_full_short_noinput', {...base, cwd: path.dirname(ps), env: process.env}, 'exit 0', null],
  ['V2_full_short_input', {...base, cwd: path.dirname(ps), env: process.env}, 'exit 0', 'x'],
  ['V3_full_probe_input', {...base, cwd: path.dirname(ps), env: process.env}, probeScript, target],
  ['V4_min_probe_input', {encoding: 'utf8', timeout: 30000}, probeScript, target],
  ['V5_full_probe_noinput', {...base, cwd: path.dirname(ps), env: process.env}, probeScript, null],
  ['V6_full_probe_input_defaultenv', {...base, cwd: path.dirname(ps)}, probeScript, target],
  ['V7_product_script_fullopts', {...base, cwd: path.dirname(ps), env: process.env, timeout: 20000}, fullScript, target],
  ['V8_rule_ids', {...base, cwd: path.dirname(ps), env: process.env, timeout: 20000}, stepRuleIds, target],
  ['V8b_rule_ids_plain', {...base, cwd: path.dirname(ps), env: process.env, timeout: 20000}, stepRules, target],
  ['V9_owner_only', {...base, cwd: path.dirname(ps), env: process.env, timeout: 20000}, stepOwner, target],
  ['V10_acl_only', {...base, cwd: path.dirname(ps), env: process.env, timeout: 20000}, stepAcl, target],
  ['V12_full_trustedenv', {...base, cwd: path.dirname(ps), env: trustedPowerShellEnvironment(), timeout: 20000}, fullScript, target],
  ['V13_short_trustedenv', {...base, cwd: path.dirname(ps), env: trustedPowerShellEnvironment(), timeout: 20000}, probeScript, target],
  ['V14_full_trustedenv_restored', {...base, cwd: path.dirname(ps), env: {...trustedPowerShellEnvironment(), USERPROFILE: process.env.USERPROFILE, HOMEDRIVE: process.env.HOMEDRIVE, HOMEPATH: process.env.HOMEPATH, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERNAME: process.env.USERNAME, PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE}, timeout: 20000}, fullScript, target],
  ['W1_getcurrent', {...base, cwd: path.dirname(ps), env: trustedPowerShellEnvironment(), timeout: 20000}, w1, target],
  ['W2_owner', {...base, cwd: path.dirname(ps), env: trustedPowerShellEnvironment(), timeout: 20000}, w2, target],
  ['W3_rules', {...base, cwd: path.dirname(ps), env: trustedPowerShellEnvironment(), timeout: 20000}, w3, target],
  ['W4_objects', {...base, cwd: path.dirname(ps), env: trustedPowerShellEnvironment(), timeout: 20000}, w4, target],
  ['V15_full_trustedenv_bigrestore', {...base, cwd: path.dirname(ps), env: {...trustedPowerShellEnvironment(), USERDOMAIN: process.env.USERDOMAIN, USERDNSDOMAIN: process.env.USERDNSDOMAIN, LOGONSERVER: process.env.LOGONSERVER, COMPUTERNAME: process.env.COMPUTERNAME, USERPROFILE: process.env.USERPROFILE, USERNAME: process.env.USERNAME, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, HOMEDRIVE: process.env.HOMEDRIVE, HOMEPATH: process.env.HOMEPATH, SystemDrive: process.env.SystemDrive, PUBLIC: process.env.PUBLIC, ALLUSERSPROFILE: process.env.ALLUSERSPROFILE, PROGRAMDATA: process.env.PROGRAMDATA, OS: process.env.OS, NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS}, timeout: 20000}, fullScript, target],
];
for (const [name, opts, script, input] of cases) {
  const started = Date.now();
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], input == null ? opts : {...opts, input});
  console.log(name, 'ms=' + (Date.now() - started), 'status=' + r.status, 'err=' + ((r.error && r.error.code) || 'none'), 'out=' + String(r.stdout || '').slice(0, 80).replace(/\n/g, ' '), 'stderr=' + String(r.stderr || '').slice(0, 120).replace(/\n/g, ' '));
}

// Importing the production prepare module mirrors the product process state
// (its transitive module top-level effects) without running its entry point.
try {
  const started = Date.now();
  await import('../../scripts/runtime-prepare.mjs');
  console.log('PREPARE_IMPORT_MS', Date.now() - started);
} catch (error) {
  console.log('PREPARE_IMPORT_FAIL', String(error && error.message).slice(0, 200));
}
{
  const started = Date.now();
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', probeScript], {...base, cwd: path.dirname(ps), env: process.env, input: target});
  console.log('V3_after_prepare_import ms=' + (Date.now() - started), 'status=' + r.status, 'err=' + ((r.error && r.error.code) || 'none'), 'out=' + String(r.stdout || '').slice(0, 80).replace(/\n/g, ' '));
}

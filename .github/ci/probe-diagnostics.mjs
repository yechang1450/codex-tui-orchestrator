// Temporary CI diagnostics: compare spawn option combinations against the
// production PowerShell ACL probe shape to find the ETIMEDOUT source.
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {trustedWindowsHelper} from '../../scripts/core/windows-system.mjs';

const ps = trustedWindowsHelper('powershell');
const target = process.argv[2];
const probeScript = "$ErrorActionPreference='Stop';$target=[Console]::In.ReadToEnd().Trim();if([string]::IsNullOrWhiteSpace($target)){throw 'missing root'};$acl=[IO.Directory]::GetAccessControl($target);$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;'PROBE_DONE ' + $owner";
const base = {encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000, maxBuffer: 64 * 1024};
const cases = [
  ['V1_full_short_noinput', {...base, cwd: path.dirname(ps), env: process.env}, 'exit 0', null],
  ['V2_full_short_input', {...base, cwd: path.dirname(ps), env: process.env}, 'exit 0', 'x'],
  ['V3_full_probe_input', {...base, cwd: path.dirname(ps), env: process.env}, probeScript, target],
  ['V4_min_probe_input', {encoding: 'utf8', timeout: 30000}, probeScript, target],
  ['V5_full_probe_noinput', {...base, cwd: path.dirname(ps), env: process.env}, probeScript, null],
  ['V6_full_probe_input_defaultenv', {...base, cwd: path.dirname(ps)}, probeScript, target],
];
for (const [name, opts, script, input] of cases) {
  const started = Date.now();
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], input == null ? opts : {...opts, input});
  console.log(name, 'ms=' + (Date.now() - started), 'status=' + r.status, 'err=' + ((r.error && r.error.code) || 'none'), 'out=' + String(r.stdout || '').slice(0, 80).replace(/\n/g, ' '), 'stderr=' + String(r.stderr || '').slice(0, 120).replace(/\n/g, ' '));
}

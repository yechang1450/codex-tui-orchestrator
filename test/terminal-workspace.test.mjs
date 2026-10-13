import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWindowsTerminalArguments} from '../scripts/core/orchestrate-sdk.mjs';
import {resolveWindowsTerminalExecutable} from '../scripts/core/windows-terminal.mjs';
import {trustedWindowsHelper} from '../scripts/core/windows-system.mjs';

const windowsFixtureWorkspace = 'C:\\orchestrator-fixtures\\workspace';
const windowsFixtureLauncher = `${windowsFixtureWorkspace}\\temp\\launcher.ps1`;

test('visible Windows Terminal launcher pins the initiating workspace', () => {
  const args = buildWindowsTerminalArguments(
    windowsFixtureWorkspace,
    'win-abc',
    windowsFixtureLauncher
  );
  const expectedPowerShell = process.platform === 'win32'
    ? trustedWindowsHelper('powershell')
    : 'powershell.exe';
  assert.deepEqual(args, [
    '-w', 'win-abc',
    '-d', windowsFixtureWorkspace,
    expectedPowerShell, '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', windowsFixtureLauncher
  ]);
});

test('visible Windows Terminal resolves the packaged executable instead of the alias', {skip: process.platform !== 'win32'}, () => {
  const resolved = resolveWindowsTerminalExecutable();
  if (!resolved) return;
  assert.match(resolved, /[\\/]WindowsApps[\\/]Microsoft\.WindowsTerminal_[^\\/]+[\\/]wt\.exe$/i);
  assert.notEqual(resolved.toLowerCase(), `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\wt.exe`.toLowerCase());
});

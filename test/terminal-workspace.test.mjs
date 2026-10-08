import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {buildWindowsTerminalArguments,resolveWindowsTerminalExecutable} from '../scripts/core/orchestrate-sdk.mjs';

const windowsFixtureWorkspace = 'C:\\orchestrator-fixtures\\workspace';
const windowsFixtureLauncher = `${windowsFixtureWorkspace}\\temp\\launcher.ps1`;

test('visible Windows Terminal launcher pins the initiating workspace', () => {
  const args = buildWindowsTerminalArguments(
    windowsFixtureWorkspace,
    'win-abc',
    windowsFixtureLauncher
  );
  const expectedPowerShell = process.platform === 'win32'
    ? path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWindowsTerminalArguments,resolveWindowsTerminalExecutable} from '../scripts/core/orchestrate-sdk.mjs';

test('visible Windows Terminal launcher pins the initiating workspace', () => {
  const args = buildWindowsTerminalArguments(
    'C:\\Users\\fixture-user\\workspace',
    'win-abc',
    'C:\\Users\\fixture-user\\workspace\\temp\\launcher.ps1'
  );
  assert.deepEqual(args, [
    '-w', 'win-abc',
    '-d', 'C:\\Users\\fixture-user\\workspace',
    'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', 'C:\\Users\\fixture-user\\workspace\\temp\\launcher.ps1'
  ]);
});

test('visible Windows Terminal resolves the packaged executable instead of the alias', {skip: process.platform !== 'win32'}, () => {
  const resolved = resolveWindowsTerminalExecutable();
  if (!resolved) return;
  assert.match(resolved, /[\\/]WindowsApps[\\/]Microsoft\.WindowsTerminal_[^\\/]+[\\/]wt\.exe$/i);
  assert.notEqual(resolved.toLowerCase(), `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\wt.exe`.toLowerCase());
});

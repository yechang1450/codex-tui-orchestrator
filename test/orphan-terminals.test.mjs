import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isPluginOwnedTerminalCommand, closeOrphanTerminals} from '../scripts/orchestrate-sdk.mjs';

const TMP = 'C:\\Users\\me\\.codex\\plugins\\codex-tui-orchestrator\\temp';
const own = (extra = '') => `wt.exe -w win-B1-a1 "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -File "${TMP}\\win-launch-B1-a1.ps1"${extra}`;

test('only panes started from this workspace launcher count as plugin-owned', () => {
  assert.equal(isPluginOwnedTerminalCommand(own(), TMP), true);
  assert.equal(isPluginOwnedTerminalCommand(own().toUpperCase(), TMP), true, 'case-insensitive');
  assert.equal(isPluginOwnedTerminalCommand(own(), TMP + '\\'), true, 'trailing separator tolerated');
  // 别人的工作区/别的插件：绝不认领
  assert.equal(isPluginOwnedTerminalCommand('wt.exe -w x D:\\temp\\codex-batt\\ws\\temp\\win-launch-B1.ps1', TMP), false);
  // 没有 launcher 的普通终端窗
  assert.equal(isPluginOwnedTerminalCommand('wt.exe -w x powershell.exe', TMP), false);
  assert.equal(isPluginOwnedTerminalCommand('', TMP), false);
});

test('the orphan sweep is safe to call and never throws on a clean host', async () => {
  const closed = await closeOrphanTerminals();
  assert.equal(typeof closed, 'number');
  assert.ok(closed >= 0);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isPluginOwnedTerminalCommand, closeOrphanTerminals} from '../scripts/orchestrate-sdk.mjs';

const TMP = 'C:\\Users\\me\\.codex\\plugins\\codex-tui-orchestrator\\temp';
const own = (extra = '') => `wt.exe -w win-B1-a1 "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -File "${TMP}\\win-launch-B1-a1.ps1"${extra}`;

test('only panes started from this workspace launcher count as plugin-owned', () => {
  assert.equal(isPluginOwnedTerminalCommand(own(), TMP), true);
  assert.equal(isPluginOwnedTerminalCommand(own().toUpperCase(), TMP), true, 'case-insensitive');
  assert.equal(isPluginOwnedTerminalCommand(own(), TMP + '\\'), true, 'trailing separator tolerated');
  // 编排器在任意工作区都会用同一启动器命名：换了工作区（例如 D:\temp\xxx\ws\temp）也要认领，
  // 否则别的磁盘/目录留下的错误窗会被漏掉——实测踩过这条。
  assert.equal(isPluginOwnedTerminalCommand('wt.exe -w x D:\\temp\\codex-batt\\ws\\temp\\win-launch-B1.ps1', TMP), true);
  // 没有 launcher 的普通终端窗
  assert.equal(isPluginOwnedTerminalCommand('wt.exe -w x powershell.exe', TMP), false);
  assert.equal(isPluginOwnedTerminalCommand('', TMP), false);
  // 名字像但不是编排器启动器的路径（不在 temp 下）不认领
  assert.equal(isPluginOwnedTerminalCommand('wt.exe -w x C:\\proj\\bin\\win-launch-B1.ps1', TMP), false);
});

test('the orphan sweep is safe to call and never throws on a clean host', async () => {
  const closed = await closeOrphanTerminals();
  assert.equal(typeof closed, 'number');
  assert.ok(closed >= 0);
});

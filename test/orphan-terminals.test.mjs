import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isPluginOwnedTerminalCommand, closeOrphanTerminals} from '../scripts/orchestrate-sdk.mjs';

const TMP = 'C:\\Users\\me\\.codex\\plugins\\codex-tui-orchestrator\\temp';
const own = (extra = '') => `wt.exe -w win-B1-a1 "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -File "${TMP}\\win-launch-B1-a1.ps1"${extra}`;

test('only panes started from this workspace launcher count as plugin-owned', () => {
  assert.equal(isPluginOwnedTerminalCommand(own(), TMP), true);
  assert.equal(isPluginOwnedTerminalCommand(own().toUpperCase(), TMP), true, 'case-insensitive');
  assert.equal(isPluginOwnedTerminalCommand(own(), TMP + '\\'), true, 'trailing separator tolerated');
  // 另一个工作区的同名脚本不能冒充当前工作区的 launcher。
  assert.equal(isPluginOwnedTerminalCommand('wt.exe -w x D:\\temp\\codex-batt\\ws\\temp\\win-launch-B1.ps1', TMP), false);
  assert.equal(isPluginOwnedTerminalCommand('wt.exe -w x ' + TMP + '\\other\\win-launch-B1.ps1', TMP), false);
  assert.equal(isPluginOwnedTerminalCommand('wt.exe prefix' + TMP + '\\win-launch-B1.ps1', TMP), false, 'a substring of a foreign path is not ownership');
  assert.equal(isPluginOwnedTerminalCommand(own(), ''), false, 'unknown workspace is not ownership');
  // 没有 launcher 的普通终端窗
  assert.equal(isPluginOwnedTerminalCommand('wt.exe -w x powershell.exe', TMP), false);
  assert.equal(isPluginOwnedTerminalCommand('', TMP), false);
  // 名字像但不是编排器启动器的路径（不在 temp 下）不认领
  assert.equal(isPluginOwnedTerminalCommand('wt.exe -w x C:\\proj\\bin\\win-launch-B1.ps1', TMP), false);
});

test('orphan cleanup never force-kills the shared Windows Terminal host', async () => {
  const proc={Name:'WindowsTerminal.exe',ProcessId:123,CommandLine:own()};
  for (const value of [undefined,'','0','-1','NaN','1.5','999999999','\uFEFF456']) {
    const killed=[];
    const closed=await closeOrphanTerminals({
      tempDir:TMP,snapshot:()=>new Map([[123,proc]]),
      readPidText:()=>{if(value===undefined)throw new Error('unreadable');return value;},
      isAlive:()=>false,kill:pid=>{killed.push(pid);return {status:0};},
    });
    assert.equal(closed,0,JSON.stringify(value));
    assert.equal(killed.length,0,JSON.stringify(value));
  }
  let called=0;
  const defaults={tempDir:TMP,snapshot:()=>new Map([[123,proc]]),readPidText:()=> '456',isAlive:()=>false};
  assert.equal(await closeOrphanTerminals({...defaults,kill:()=>{called++;return {status:1};}}),0);
  assert.equal(called,0,'the shared Windows Terminal host is never sent to taskkill');
  for(const change of [
    {isAlive:()=>true},
    {snapshot:()=>new Map([[123,proc],[456,{ProcessId:456,ParentProcessId:123}]])},
    {snapshot:()=>new Map([[123,{...proc,CommandLine:'wt.exe D:\\other\\temp\\win-launch-B1.ps1'}]])},
  ]){
    let attempts=0;
    await closeOrphanTerminals({...defaults,...change,kill:()=>{attempts++;return {status:0};}});
    assert.equal(attempts,0,'live, shared and foreign terminals must remain untouched');
  }
});

test('the orphan sweep is safe to call and never throws on a clean host', async () => {
  const closed = await closeOrphanTerminals();
  assert.equal(typeof closed, 'number');
  assert.ok(closed >= 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// 公开入口的失败契约（CHANGELOG 记录、deps 前的入口必须自行兜住）：
// 失败时 stderr 只允许出现一行 `[orchestrator] FATAL: <原因>`，不得泄漏 Node 栈帧或
// ESM 载入器前言，stdout 必须保持空（失败不产出数据）。此前公开包装层用
// `console.error(e.stack||e.message)` 收尾，导致 `--nope` 之类的拒绝把 2–5 层栈帧和
// "Node.js v…" 横幅打到用户面前，与内核入口的一行 FATAL 行为不一致。
const repo = fileURLToPath(new URL('../', import.meta.url));

function invoke(script, args, extra = {}) {
  const env = {...process.env, ...extra};
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  delete env.WORKSPACE_DIR;
  delete env.ORCH_STATE_DIR;
  delete env.ORCH_RUN_ID;
  return spawnSync(process.execPath, [path.join(repo, 'scripts', script), ...args], {
    cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
}

const CASES = [
  ['orchestrate-sdk.mjs', ['--nope'], {}, 'unsupported mode'],
  ['orchestrate-sdk.mjs', ['--agent'], {}, 'option without a value'],
  ['orchestrate-sdk.mjs', ['--workspace', 'a', '--workspace', 'b', '--doctor'], {}, 'duplicate option'],
  ['orchestrate-sdk.mjs', ['--run-id', 'bad id!', '--doctor'], {}, 'invalid run ID'],
  ['orchestrate-sdk.mjs', ['--doctor'], {ORCH_AGENT: 'pi'}, 'foreign agent adapter'],
  ['poll-windows.mjs', ['--nope'], {}, 'invalid polling argument'],
  ['status.mjs', ['--bogus'], {}, 'invalid status argument'],
  ['supervise.mjs', ['--run-id'], {}, 'incomplete supervisor argument'],
];

test('every public entry rejects with one FATAL line, no stack frames and no stdout', () => {
  for (const [script, args, extra, label] of CASES) {
    const where = `${label} (${script} ${args.join(' ')})`;
    const result = invoke(script, args, extra);
    const stderr = String(result.stderr || '');
    assert.notEqual(result.status, 0, `${where}: must fail closed`);
    assert.equal(String(result.stdout || ''), '', `${where}: a rejected invocation must not write stdout`);
    const lines = stderr.split(/\r?\n/);
    const fatal = lines.filter((line) => line.startsWith('[orchestrator] FATAL: '));
    assert.equal(fatal.length, 1, `${where}: expected exactly one FATAL line, got ${JSON.stringify(stderr)}`);
    assert.ok(fatal[0].trim().length > 24, `${where}: the FATAL line must carry the reason, got ${JSON.stringify(fatal[0])}`);
    assert.deepEqual(lines.filter((line) => /^\s+at\s/.test(line)), [], `${where}: must not leak Node stack frames`);
    assert.doesNotMatch(stderr, /Node\.js v\d/, `${where}: must not print the Node banner`);
  }
});

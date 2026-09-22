import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {transaction} from '../scripts/core/leases.mjs';

// 回归（2026-09-22 并发探针实测抓到）：leases.json 里只要有一条**没有 owner 的畸形条目**，
// transaction() 就会在过滤阶段解引用 l.owner.ProcessId 抛裸 TypeError —— 该工作区的协调器
// 从此每一次事务都崩（160 次事务实测 159 次死在这里），而且违反"公开入口只回一行
// FATAL、无 Node 栈帧"的契约。判据：畸形条目必须被安全跳过（新鲜的按 90s 兜底保留、
// 过期的直接剪掉），事务必须照常跑完。
test('a lease entry without an owner can never poison the coordinator transaction', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-poison-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'leases.json'),
      JSON.stringify([
        {id: 'junk-no-owner', keys: ['dir:x'], reservedAt: Date.now()},
        null,
        'not-an-object',
        {id: 'junk-stale', keys: ['dir:y'], reservedAt: 1},
        {id: 'live-owner', keys: ['dir:z'], owner: {ProcessId: process.pid}, reservedAt: Date.now()}
      ]),
      'utf8'
    );

    let ran = false;
    transaction(dir, (leases) => {
      ran = true;
      leases.push({id: 'probe', keys: ['dir:p'], owner: {ProcessId: process.pid}, reservedAt: Date.now()});
    });

    assert.equal(ran, true, '事务体必须被执行（畸形条目不得让事务整体抛错）');
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'leases.json'), 'utf8'));
    const ids = after.map((l) => l && l.id);
    assert.ok(ids.includes('probe'), '本次事务写入的条目必须落盘');
    assert.ok(ids.includes('live-owner'), 'owner 仍然活着的租约必须保留');
    assert.ok(!ids.includes('junk-stale'), '过期的畸形条目必须被剪掉（自愈）');
    assert.ok(!ids.includes(null), '非对象垃圾必须被剪掉');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

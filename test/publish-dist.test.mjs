import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectRegistration} from '../scripts/repair-plugin-registration.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('publish-dist builds a clean distribution that registration accepts as install source', () => {
  // repair.mjs 拒绝把分发目标建在源码树内部，所以这里用系统临时目录，测试结束即清理。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-publish-dist-'));
  try {
    const target = path.join(root, 'dist');
    const output = execFileSync(process.execPath, [path.join(repo, 'scripts', 'publish-dist.mjs'), '--target', target], {encoding: 'utf8', cwd: repo});
    assert.match(output, /codex plugin add codex-tui-orchestrator@personal/);
    const dist = path.join(target, 'codex-tui-orchestrator');
    assert.ok(fs.existsSync(path.join(dist, '.codex-plugin', 'plugin.json')), '分发必须带插件清单');
    assert.equal(fs.existsSync(path.join(dist, 'temp')), false, '分发不带本地运行状态');
    assert.equal(fs.existsSync(path.join(dist, '.git')), false, '分发不带 git 元数据');
    assert.equal(fs.existsSync(path.join(dist, 'scripts', 'node_modules')), false, '分发不带依赖目录');
    const verify = JSON.parse(execFileSync(process.execPath, [path.join(dist, 'scripts', 'release-integrity.mjs')], {encoding: 'utf8', cwd: dist}));
    assert.equal(verify.schema, 2);

    // 注册校验必须认识这个分发源（否则重启健康检查会误报 source_mismatch）
    const marketRoot = path.join(root, 'home');
    const marketplace = path.join(marketRoot, '.agents', 'plugins', 'marketplace.json');
    fs.mkdirSync(path.dirname(marketplace), {recursive: true});
    const relative = './' + path.relative(marketRoot, dist).replaceAll('\\', '/');
    fs.writeFileSync(marketplace, JSON.stringify({
      name: 'personal',
      interface: {displayName: 'Personal'},
      plugins: [{name: 'codex-tui-orchestrator', source: {source: 'local', path: relative}, policy: {installation: 'AVAILABLE', authentication: 'ON_INSTALL'}, category: 'Developer Tools'}],
    }, null, 2) + '\n');
    const result = inspectRegistration({pluginPath: repo, marketplacePath: marketplace, marketplaceRoot: marketRoot, distRoot: target});
    assert.equal(result.status, 'matched', JSON.stringify(result));
    assert.equal(result.sourceKind, 'dist');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

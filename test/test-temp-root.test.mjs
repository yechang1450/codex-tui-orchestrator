import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {makeTestDir, testTempFamily, testTempRoot} from './test-temp-root.mjs';

test('test scratch root defaults outside the checkout and honors an explicit external root', () => {
  const defaultRoot = testTempRoot({});
  assert.equal(defaultRoot, path.join(os.tmpdir(), 'codex-tui-orchestrator-tests'));

  const configured = path.join(os.tmpdir(), '编排器 临时 root');
  assert.equal(testTempRoot({ORCH_TEST_TEMP_ROOT: configured}), path.resolve(configured));
});

test('test scratch families reject path traversal and create unique fixture directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctui-test-root-'));
  try {
    const env = {ORCH_TEST_TEMP_ROOT: root};
    assert.throws(() => testTempFamily('../escape', env), /safe test temp family/);
    assert.throws(() => testTempFamily('nested/name', env), /safe test temp family/);
    const family = testTempFamily('runner', env);
    const first = makeTestDir('runner', 'fixture-', env);
    const second = makeTestDir('runner', 'fixture-', env);
    assert.equal(family, path.join(root, 'runner'));
    assert.ok(first.startsWith(family + path.sep));
    assert.ok(second.startsWith(family + path.sep));
    assert.notEqual(first, second);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

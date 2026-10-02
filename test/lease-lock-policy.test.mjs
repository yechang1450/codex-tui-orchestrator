import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {transaction} from '../scripts/core/leases.mjs';

test('coordinator lease lock works under RemoteSigned without a signed script', {skip: process.platform !== 'win32'}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tui-lease-policy-'));
  try {
    assert.equal(transaction(dir, leases => ({count: leases.length})).count, 0);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('1.3.1 compatibility matrix has explicit environment and result for every row', () => {
  const matrix = JSON.parse(fs.readFileSync(path.join(repo, 'test', 'compatibility-matrix-1.3.1.json'), 'utf8'));
  assert.equal(matrix.schema, 1);
  assert.equal(matrix.coreVersion, '1.3.1'); // Historical matrix; RC results are recorded separately.
  assert.ok(Array.isArray(matrix.rows) && matrix.rows.length >= 3);
  const ids = new Set();
  for (const row of matrix.rows) {
    assert.ok(row.id && !ids.has(row.id), `duplicate matrix row: ${row.id}`);
    ids.add(row.id);
    for (const key of ['cliVersion', 'nodeVersion', 'terminal', 'codeHome', 'pathMode', 'result']) {
      assert.equal(typeof row[key], 'string');
      assert.ok(row[key].length > 0, `${row.id} is missing ${key}`);
    }
    assert.ok(['pass', 'fail', 'unverified'].includes(row.result));
    if (row.result !== 'pass') assert.ok(typeof row.reason === 'string' && row.reason.length > 10, `${row.id} needs a limitation reason`);
    if (row.result === 'pass') assert.ok(Array.isArray(row.checks) && row.checks.length > 0, `${row.id} needs check evidence`);
  }
  const current = matrix.rows.find(row => row.id === 'native-current-user');
  assert.equal(current.result, 'pass');
  assert.match(current.terminal, /^wt /);
  assert.match(current.cliVersion, /^0\.153\.4$/);
  assert.ok(matrix.rows.some(row => row.id === 'native-isolated-no-developer-path' && row.result === 'pass'));
  assert.ok(matrix.rows.some(row => row.cliVersion.startsWith('0.149.0') && row.result === 'unverified'));
});

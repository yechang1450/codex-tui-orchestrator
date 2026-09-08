import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {coreInventory} from '../scripts/release-integrity.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('1.3.1 network and reboot evidence separates controlled recovery from unrun gates', () => {
  const evidence = JSON.parse(fs.readFileSync(path.join(repo, 'test', 'network-reboot-validation-1.3.1.json'), 'utf8'));
  assert.equal(evidence.schema, 1);
  assert.equal(evidence.coreVersion, '1.3.1');
  const files = coreInventory(repo);
  const coreHash = crypto.createHash('sha256').update(Object.keys(files).sort().map(name => `${name}:${files[name]}`).join('\n')).digest('hex');
  assert.match(evidence.coreHash,/^[a-f0-9]{64}$/);
  assert.notEqual(evidence.coreHash, coreHash,'Historical evidence must not certify the changed RC core');
  assert.equal(evidence.controlledScenarios.length, 3);
  for (const scenario of evidence.controlledScenarios) {
    assert.equal(scenario.result, 'pass');
    assert.equal(scenario.testFile, 'test/recovery-runtime.test.mjs');
    assert.equal(scenario.blindRetry ?? false, false);
  }
  assert.ok(evidence.unverifiedScenarios.some(s => s.id === 'windows-restart'));
  assert.ok(evidence.unverifiedScenarios.some(s => s.id === 'prolonged-provider-outage'));
  assert.ok(evidence.unverifiedScenarios.every(s => s.reason && s.reason.length > 20));
  for (const suite of evidence.suiteRuns) {
    assert.equal(suite.failed, 0);
    assert.equal(suite.tests, suite.passed);
  }
});

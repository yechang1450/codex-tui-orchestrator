import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {coreInventory} from '../scripts/release-integrity.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function coreHash(root) {
  const files = coreInventory(root);
  return crypto.createHash('sha256')
    .update(Object.keys(files).sort().map((name) => `${name}:${files[name]}`).join('\n'))
    .digest('hex');
}

test('historical security evidence retains hashes and limits without requiring another checkout', () => {
  const evidence = JSON.parse(fs.readFileSync(path.join(repo, 'test', 'security-validation-1.3.1.json'), 'utf8'));
  assert.equal(evidence.schema, 1);
  assert.equal(evidence.scans.length, 2);
  for (const scan of evidence.scans) {
    assert.equal(scan.status, 'complete');
    assert.equal(scan.findings, 0);
    assert.equal(scan.coverage, 'partial');
    assert.equal(scan.reportAvailable, true);
    assert.ok(scan.scanId && scan.targetRevision && scan.reportPath);
    assert.match(scan.independentBaseline, /unavailable/i);
    assert.ok(['codex-tui-orchestrator','open-tui-orchestrator'].includes(scan.implementation));
    assert.match(scan.coreHashAtEvidence,/^[a-f0-9]{64}$/);
    if(scan.implementation==='codex-tui-orchestrator')assert.notEqual(scan.coreHashAtEvidence,coreHash(repo));
    // Do not turn archived scans or machine-specific report paths into current certification.
  }
  assert.equal(evidence.localRegression.dedicatedFocused.failed, 0);
  assert.equal(evidence.localRegression.genericFocused.failed, 0);
  assert.equal(evidence.localRegression.dedicatedFocused.tests, evidence.localRegression.dedicatedFocused.passed);
  assert.equal(evidence.localRegression.genericFocused.tests, evidence.localRegression.genericFocused.passed);
  assert.ok(evidence.limitations.length >= 3);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('historical 1.3.1 package evidence preserves its original scope and manager limits', () => {
  const evidence = JSON.parse(fs.readFileSync(path.join(repo, 'test', 'current-package-validation.json'), 'utf8'));
  assert.equal(evidence.schema, 1);
  assert.ok(typeof evidence.source==='string');
  assert.equal(evidence.coreVersion, '1.3.1');
  assert.equal(evidence.allSourceHashesMatch, true);
  assert.equal(evidence.allPublishedHashesMatch, true);
  assert.equal(evidence.npmCi.exitCode, 0);
  assert.equal(evidence.npmCi.omitOptional, true);
  assert.equal(evidence.npmCi.ignoreScripts, true);
  assert.equal(evidence.releaseVerify.exitCode, 0);
  assert.equal(evidence.doctor.exitCode, 0);
  assert.equal(evidence.status.exitCode, 0);
  assert.equal(evidence.status.aliveWindows, 0);
  assert.equal(evidence.status.pendingReservations, 0);
  assert.equal(evidence.status.pendingLocks, 0);
  assert.equal(evidence.repair.exitCode, 0);
  assert.equal(evidence.repair.noRuntimeDebris, true);
  assert.equal(evidence.quickValidate.exitCode, 0);
  assert.equal(evidence.upgradeRollback.status, 'unverified');
  assert.match(evidence.upgradeRollback.reason, /plugin-manager/i);

  assert.ok(typeof evidence.target==='string');
  // The current clean-package tests recreate and verify a package on every host.
  // Historical machine paths are provenance, not dependencies of this suite.
});

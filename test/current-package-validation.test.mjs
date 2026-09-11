import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('historical 1.3.4 package evidence retains its original validation scope', () => {
  const evidence = JSON.parse(fs.readFileSync(path.join(repo, 'test', 'package-validation-1.3.4-rc.1-historical.json'), 'utf8'));
  assert.equal(evidence.schema, 2);
  assert.ok(typeof evidence.source==='string');
  assert.equal(evidence.coreVersion, '1.3.4-rc.1');
  assert.equal(evidence.manifestVersion, '0.4.43-rc.1');
  assert.equal(evidence.coreFiles, 20);
  assert.equal(evidence.runtimeFiles, 43);
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
  assert.equal(evidence.regression.tests, 180);
  assert.equal(evidence.regression.pass, 180);
  assert.equal(evidence.regression.fail, 0);
  assert.equal(evidence.cleanup.cleaned, true);
  assert.equal(evidence.upgradeRollback.status, 'unverified');
  assert.match(evidence.upgradeRollback.reason, /plugin-manager/i);

  assert.ok(typeof evidence.target==='string');
  assert.match(evidence.releaseJsonSha256,/^[a-f0-9]{64}$/);
  assert.match(evidence.lockfileSha256,/^[a-f0-9]{64}$/);
});

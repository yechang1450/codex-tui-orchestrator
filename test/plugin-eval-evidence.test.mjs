import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const audit = JSON.parse(fs.readFileSync(path.join(root, 'test', 'full-audit-current.json'), 'utf8'));
const auditDate = String(audit.generatedAt).slice(0, 10);
const auditCommit = String(audit.commit).slice(0, 7);

// The two Plugin Eval reports are audit artifacts of the same 2026-09-14 audit as
// test/full-audit-current.json. They quote a score that was true at that commit and is
// not the current one, so they must be labeled the way this repository labels every
// other piece of historical evidence.
const snapshots = [
  { file: 'test/plugin-eval-current.md', target: 'plugin root' },
  { file: 'test/plugin-eval-skill-current.md', target: 'skills/codex-tui-orchestrator' },
];

test('plugin-eval snapshots record the audit they belong to', () => {
  assert.match(auditDate, /^\d{4}-\d{2}-\d{2}$/, 'the audit snapshot must carry a date');
  assert.match(auditCommit, /^[0-9a-f]{7}$/, 'the audit snapshot must carry a commit');
  for (const { file, target } of snapshots) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(text, new RegExp('Generated: ' + auditDate), file + ' must record the audit date');
    assert.match(text, new RegExp('Commit: ' + auditCommit), file + ' must record the audited commit');
    assert.match(text, new RegExp('Target: ' + target.replace(/[/\\]/g, '\\$&')), file + ' must record what was evaluated');
    assert.match(text, /plugin-eval analyze/, file + ' must record how to regenerate it');
  }
});

test('plugin-eval snapshots are labeled historical evidence instead of the current score', () => {
  for (const { file } of snapshots) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(text, /historical evidence/i, file + ' must be labeled historical evidence');
    assert.match(text, /not the current|does not certify|不认证|不代表当前/i, file + ' must deny certifying the current release');
  }
});

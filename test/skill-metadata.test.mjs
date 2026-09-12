import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const skill = fs.readFileSync(path.join(root, 'skills', 'codex-tui-orchestrator', 'SKILL.md'), 'utf8');
const description = /^description:\s*(.+)$/m.exec(skill)?.[1] || '';
const name = /^name:\s*(.+)$/m.exec(skill)?.[1]?.trim() || '';

test('skill metadata uses a canonical identifier and preserves the legacy invocation name', () => {
  assert.match(description, /Use when/i);
  assert.equal(name, 'codex-tui-orchestrator');
  assert.match(description, /codex-tui-orchestrator/);
  assert.match(description, /codex-TUI-orchestrator/);
  assert.match(description, /只读|read-only/i);
});

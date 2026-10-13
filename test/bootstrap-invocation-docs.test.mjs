import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('published bootstrap commands use a process-scoped execution-policy override', () => {
  const publicCommandSources = [
    'README.md',
    'README-zh.md',
    'docs/clean-machine-validation.md',
    'docs/environment-setup.md',
    'skills/codex-tui-orchestrator/SKILL.md',
    'scripts/bootstrap.ps1',
    'scripts/install-plugin.mjs',
  ];
  const commandPrefix = /powershell(?:\.exe)?\s+-NoProfile\s+-ExecutionPolicy\s+Bypass\s+-File\s+/i;

  for (const source of publicCommandSources) {
    const commands = read(source)
      .split(/\r?\n/)
      .filter((line) => /(?:powershell(?:\.exe)?\b|&)\s+.*bootstrap\.ps1/i.test(line));
    assert.ok(commands.length > 0, `${source} must retain a runnable bootstrap example`);
    for (const command of commands) {
      assert.match(command, commandPrefix, `${source} must use a child-process execution-policy override: ${command}`);
    }
  }

  const publicText = publicCommandSources.map(read).join('\n');
  assert.doesNotMatch(publicText, /Set-ExecutionPolicy\b/i, 'bootstrap guidance must not persistently modify an execution policy');
  assert.doesNotMatch(
    read('skills/codex-tui-orchestrator/SKILL.md'),
    /-Arguments\s+@\(/i,
    'PowerShell -File guidance must forward runner flags directly instead of using an array expression',
  );
});

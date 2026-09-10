import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('current documentation points at the sealed core and labels older evidence historical', () => {
  const release = JSON.parse(read('release.json'));
  const version = String(release.coreVersion);
  const versionRe = new RegExp(`\\b${version.replaceAll('.', '\\.') }\\b`);
  const readme = read('README.md');
  const readmeZh = read('README-zh.md');
  const policy = read('docs/release-policy.md');
  const compatibility = read('docs/compatibility.md');
  const manifest = JSON.parse(read('.codex-plugin/plugin.json'));

  assert.match(readme, versionRe);
  assert.match(readmeZh, versionRe);
  assert.match(compatibility, versionRe);
  assert.equal(manifest.homepage, 'https://github.com/yechang1450/agent-tui-orchestrator');
  assert.equal(manifest.interface.websiteURL, manifest.homepage);
  assert.equal(manifest.interface.privacyPolicyURL, 'https://github.com/yechang1450/agent-tui-orchestrator/blob/master/docs/privacy.md');
  assert.equal(manifest.interface.termsOfServiceURL, 'https://github.com/yechang1450/agent-tui-orchestrator/blob/master/docs/terms.md');
  assert.doesNotMatch(JSON.stringify(manifest), /github\.com\/"/i);
  const current = policy.split(/^## Earlier validation/m)[0];
  assert.match(current, new RegExp(`Current candidate: core ${version.replaceAll('.', '\\.')}`));

  for (const line of [...readme.split(/\r?\n/), ...readmeZh.split(/\r?\n/)]) {
    if (/(当前|current)\s*(?:core|核心)/i.test(line)) assert.match(line, versionRe);
  }
  assert.match(read('docs/live-validation-1.2.1.md'), /历史|historical/i);
  assert.match(read('docs/live-validation-1.2.3.md'), /历史|historical/i);
  assert.doesNotMatch(readme + readmeZh + policy + compatibility, new RegExp(['blocked', 'by', 'policy'].join('\\s+'), 'i'));
});

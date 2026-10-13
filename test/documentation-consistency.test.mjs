import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('public source omits retired audit snapshots and historical validation notes', () => {
  for (const rel of [
    'docs/rc-validation.md',
    'test/historical-audit-index.json',
    'test/plugin-eval-current.md',
    'test/plugin-eval-skill-current.md',
  ]) assert.equal(fs.existsSync(path.join(root, rel)), false, `${rel} must not ship as current public evidence`);
});

test('current documentation points at the sealed core and labels older evidence historical', () => {
  const release = JSON.parse(read('release.json'));
  const version = String(release.coreVersion);
  const versionRe = new RegExp(`\\b${version.replaceAll('.', '\\.') }\\b`);
  const readme = read('README.md');
  const readmeZh = read('README-zh.md');
  const skill = read('skills/codex-tui-orchestrator/SKILL.md');
  const contract = read('docs/execution-contract.md');
  const policy = read('docs/release-policy.md');
  const compatibility = read('docs/compatibility.md');
  const manifest = JSON.parse(read('.codex-plugin/plugin.json'));

  assert.match(compatibility, versionRe);
  assert.equal(manifest.homepage, 'https://github.com/yechang1450/codex-tui-orchestrator');
  assert.equal(manifest.repository, manifest.homepage);
  assert.equal(manifest.interface.websiteURL, manifest.homepage);
  assert.equal(manifest.interface.privacyPolicyURL, 'https://github.com/yechang1450/codex-tui-orchestrator/blob/master/docs/privacy.md');
  assert.equal(manifest.interface.termsOfServiceURL, 'https://github.com/yechang1450/codex-tui-orchestrator/blob/master/docs/terms.md');
  assert.equal(manifest.interface.supportURL, 'https://github.com/yechang1450/codex-tui-orchestrator/issues');
  assert.doesNotMatch(JSON.stringify(manifest), /github\.com\/"/i);
  const current = policy.split(/^## Earlier validation/m)[0];
  assert.match(current, new RegExp(`Current candidate: core ${version.replaceAll('.', '\\.')}`));
  const pluginVersion = String(manifest.version).replaceAll('.', '\\.')
  assert.match(current, new RegExp(`Current candidate: core ${version.replaceAll('.', '\\.')}, plugin ${pluginVersion}\\.`));

  assert.doesNotMatch(readme + readmeZh + policy + compatibility, new RegExp(['blocked', 'by', 'policy'].join('\\s+'), 'i'));

  // The active release uses current available memory and a 1000 MB reserve.
  // Historical implementation plans intentionally retain the formula that was
  // in effect when they were written and are excluded from this assertion.
  const activeDocs = [readme, readmeZh, skill, contract, policy].join('\n');
  assert.doesNotMatch(activeDocs, /reported\s*GiB|1024\s*\/\s*1000|3\s*\/\s*4/i);
  const capacitySources = [
    read('scripts/core/contracts.mjs'),
    read('scripts/core/orchestrate-sdk.mjs'),
    read('scripts/core/memory-budget.mjs'),
    read('scripts/core/recovery.mjs'),
    read('test/live-codex.mjs'),
  ].join('\n');
  assert.match(capacitySources, /os\.freemem\s*\(/, 'admission must use current available memory');
  assert.match(capacitySources, /DEFAULT_MIN_AVAILABLE_MB\s*=\s*1000/, 'admission must keep the 1000 MB reserve');
});

test('public overview is concise while retaining the conservative execution contract', () => {
  const readme = read('README.md');
  const readmeZh = read('README-zh.md');
  const manifest = JSON.parse(read('.codex-plugin/plugin.json'));
  const summary = `${readme}\n${readmeZh}`;

  assert.doesNotMatch(summary, /Declared execution core|本源码树声明的执行核心/i,
    'the public overview must not present an implementation-core label as a second release version');
  assert.match(readme, /parent-defined acceptance conditions/i);
  assert.match(readmeZh, /父任务定义的验收条件/);
  assert.deepEqual(manifest.keywords, [
    'codex',
    'codex-plugin',
    'task-orchestration',
    'parallel-execution',
    'windows',
    'powershell',
  ]);
  assert.equal(Object.hasOwn(manifest.interface, 'screenshots'), false,
    'omit an empty screenshots field from public plugin metadata');
  assert.doesNotMatch(manifest.interface.longDescription, /SessionStart|bootstrap|CLI/i,
    'plugin catalog metadata should describe user value instead of setup mechanics');
  assert.doesNotMatch(manifest.interface.defaultPrompt.join('\n'), /1000MB|headless|prepare.*CLI/i,
    'plugin catalog metadata should leave tuning and setup mechanics to the documentation');
});

test('public documentation distinguishes checkout installation, the GitHub marketplace catalog, and the official directory boundary', () => {
  const readme = read('README.md');
  const readmeZh = read('README-zh.md');
  const policy = read('docs/release-policy.md');
  const cleanMachine = read('docs/clean-machine-validation.md');
  const hooks = JSON.parse(read('hooks/hooks.json'));
  const publicDocs = [readme, readmeZh, policy, cleanMachine].join('\n');
  assert.match(readme, /Codex-only plugin/i);
  assert.match(readmeZh, /仅面向 Codex 的插件/);
  assert.match(readme, /Author's statement/i);
  assert.match(readmeZh, /作者声明/);
  assert.match(readme + readmeZh, /open-tui-orchestrator/i, 'the author statement records the related project without changing this plugin\'s Codex-only support boundary');
  const readmeDistributionText=[readme,readmeZh].map(text=>text.slice(text.indexOf('# codex-tui-orchestrator'))).join('\n');
  assert.doesNotMatch(readmeDistributionText, /\bnpm\s+publish\b|npmjs\.com/i, 'the plugin README must not advertise an npm publishing route');
  assert.match(policy, /--set-source[\s\S]*does not replace a host-global marketplace/i);

  assert.match(publicDocs, /https:\/\/github\.com\/yechang1450\/codex-tui-orchestrator(?:\.git)?/i);
  assert.match(publicDocs, /codex plugin marketplace add yechang1450\/codex-tui-orchestrator --ref (?:\$ref|<(?:final-commit|tag-or-commit)>)/i);
  assert.match(publicDocs, /codex plugin add codex-tui-orchestrator@yechang1450-codex-tui-orchestrator/i);
  assert.match(publicDocs, /checkout install/i);
  assert.match(publicDocs, /GitHub marketplace catalog/i);
  assert.match(policy, /remote GitHub marketplace acceptance remains an open gate/i);
  assert.match(policy, /lifecycle hooks[\s\S]*not eligible for.*public plugin directory/i);
  assert.match(policy, /`ORCH_PROVIDER=inherit`[\s\S]*`ORCH_PROVIDER=openai-https`/i);
  assert.match(policy, /`native` and `relay` are legacy aliases/i);
  assert.ok(Array.isArray(hooks.hooks?.SessionStart) && hooks.hooks.SessionStart.length > 0, 'the public-directory boundary must remain tied to the shipped lifecycle hook');
  assert.doesNotMatch(cleanMachine, /<owner>\/<repository>/i);
  assert.match(cleanMachine, /\$repositoryUrl\s*=\s*'https:\/\/github\.com\/yechang1450\/codex-tui-orchestrator\.git'/i);
  assert.match(cleanMachine, /原始.*不得提交|生成证据.*不得提交/i, 'clean-machine instructions must forbid committing raw generated evidence');
  assert.match(cleanMachine, /路径.*用户名.*run ID.*token/i, 'public evidence summaries must exclude machine and run identities');

  for (const readmeVariant of [readme, readmeZh]) {
    assert.match(readmeVariant, /codex plugin marketplace add yechang1450\/codex-tui-orchestrator --ref \$ref/i);
    assert.match(readmeVariant, /codex plugin add codex-tui-orchestrator@yechang1450-codex-tui-orchestrator/i);
  }
  assert.match(readme, /git clone --branch \$ref --depth 1 https:\/\/github\.com\/yechang1450\/codex-tui-orchestrator\.git/i);
  assert.match(readmeZh, /git clone --branch \$ref --depth 1 https:\/\/github\.com\/yechang1450\/codex-tui-orchestrator\.git/i);

  const oldCatalogMentions = [...publicDocs.matchAll(/codex-tui-orchestrator-local/gi)];
  assert.ok(oldCatalogMentions.length > 0, 'the legacy catalog removal must remain documented');
  for (const oldCatalog of oldCatalogMentions) {
    const start = Math.max(0, oldCatalog.index - 180);
    const end = Math.min(publicDocs.length, oldCatalog.index + 180);
    assert.match(publicDocs.slice(start, end), /legacy|迁移|remove|移除/i, 'old catalog name must appear only in an explicit migration/removal instruction');
  }
  assert.match(policy, /codex plugin marketplace remove codex-tui-orchestrator-local/i);
});

test('current host and live-acceptance documentation keeps the Codex-only source-harness boundary', () => {
  const privacy = read('docs/privacy.md');
  const terms = read('docs/terms.md');
  const contract = read('docs/execution-contract.md');
  const skillMetadata = read('skills/codex-tui-orchestrator/agents/openai.yaml');

  assert.match(privacy, /The Codex CLI may contact its configured provider/i);
  assert.match(skillMetadata, /^\s*products:\s*\[CODEX\]\s*$/m, 'skill metadata must declare the Codex-only product boundary');
  assert.doesNotMatch(privacy, /another supported host/i);
  assert.match(terms, /or Codex CLI to perform/i);
  assert.match(terms, /preserves Codex's execution policy/i);
  assert.doesNotMatch(terms, /selected host CLI|host CLIs and Windows Terminal/i);
  assert.match(contract, /explicitly set `ORCH_LIVE_MODE=headless` or `ORCH_LIVE_MODE=visible`/i);
  assert.match(contract, /rejects an `ORCH_LIVE_ENTRY` override/i);
  assert.doesNotMatch(contract, /ORCH_LIVE_ENTRY can select/i);

});

test('the changelog begins with the version advertised by the plugin manifest', () => {
  const manifest = JSON.parse(read('.codex-plugin/plugin.json'));
  const version = String(manifest.version);
  const changelog = read('CHANGELOG.md');
  assert.match(changelog, new RegExp(`^## ${version.replaceAll('.', '\\.')}$`, 'm'));
});

test('public security documentation states the isolated-acceptance boundary without claiming same-user containment', () => {
  const policy = read('SECURITY.md');
  const boundary = read('docs/security-boundaries.md');

  assert.match(policy, /docs\/security-boundaries\.md/i);
  assert.match(boundary, /workspace[- ]controlled task/i);
  assert.match(boundary, /cannot forge an HMAC-authenticated terminal (?:record|state)/i);
  assert.match(boundary, /same Windows user/i);
  assert.match(boundary, /full-access/i);
  assert.match(boundary, /parent command line/i);
  assert.match(boundary, /delete or lock controller files/i);
  assert.match(boundary, /denial of service/i);
  assert.match(boundary, /does not create an operating-system security boundary/i);
  assert.match(boundary, /does not by itself enable.*forge.*HMAC/i);
  assert.match(boundary, /Lease nonces bind freshness and attempt, not authentication/i);
  assert.match(boundary, /forge a matching release marker.*coordination integrity/i);
  assert.match(boundary, /controller directory is not a trust boundary/i);
  assert.match(policy, /nonce.*新鲜度.*尝试.*认证/i);
});

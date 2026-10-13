import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CLI_INSTALL_SPEC } from '../scripts/core/host-cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const release = '0.162.1';
const nativeWindowsPackages = {
  x64: {
    integrity: 'sha512-dfl4MhHuEi0ARKyNmrTxk+RQmsWNCQAoVLUtrYq+yrW1C8P2sg5ziwgHUUACHjYLKuACV7ARH5Nq5pnCz3GlaQ==',
  },
  arm64: {
    integrity: 'sha512-teVVACnEcupkR6XSmUQKwlGg/oA15d1DQDPVSoAfilHgctPEpTi5y11jYS6JhJO+AFnYM84gyo5SOS5vlnCQSg==',
  },
};

function releaseMetadataFixture(architecture) {
  const packageName = `@openai/codex-win32-${architecture}`;
  const version = `${release}-win32-${architecture}`;
  return {
    packages: {
      'node_modules/@openai/codex': {
        optionalDependencies: {
          [packageName]: `npm:@openai/codex@${version}`,
        },
      },
      [`node_modules/${packageName}`]: {
        name: '@openai/codex',
        version,
        resolved: `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz`,
        integrity: nativeWindowsPackages[architecture].integrity,
        os: ['win32'],
        cpu: [architecture],
        optional: true,
      },
    },
  };
}

function assertWindowsNativeCodexMetadata(packageLock, auditedRelease, architecture) {
  const pinned = nativeWindowsPackages[architecture];
  assert.ok(pinned, `the test must pin an SRI value for ${architecture}`);

  const packageName = `@openai/codex-win32-${architecture}`;
  const version = `${auditedRelease}-win32-${architecture}`;
  const packages = packageLock?.packages;
  const cli = packages?.['node_modules/@openai/codex'];
  const native = packages?.[`node_modules/${packageName}`];

  assert.equal(
    cli?.optionalDependencies?.[packageName],
    `npm:@openai/codex@${version}`,
    `${packageName} must remain an optional alias of the audited CLI release`,
  );
  assert.ok(native, `${packageName} must remain pinned in package-lock.json`);
  assert.equal(native.name, '@openai/codex', `${packageName} must preserve the Codex package identity`);
  assert.equal(native.version, version, `${packageName} must preserve the audited native version`);
  assert.equal(
    native.resolved,
    `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz`,
    `${packageName} must preserve its audited tarball URL`,
  );
  assert.equal(native.integrity, pinned.integrity, `${packageName} must preserve its audited SRI`);
  assert.deepEqual(native.os, ['win32'], `${packageName} must remain restricted to Windows`);
  assert.deepEqual(native.cpu, [architecture], `${packageName} must remain restricted to ${architecture}`);
  assert.equal(native.optional, true, `${packageName} must remain optional`);
}

test('release metadata gate rejects malformed Windows native aliases and package metadata', () => {
  assertWindowsNativeCodexMetadata(releaseMetadataFixture('x64'), release, 'x64');

  const mutations = [
    ['missing optional alias', lock => delete lock.packages['node_modules/@openai/codex'].optionalDependencies['@openai/codex-win32-x64']],
    ['mismatched optional alias', lock => { lock.packages['node_modules/@openai/codex'].optionalDependencies['@openai/codex-win32-x64'] = 'npm:@openai/codex@0.0.0-win32-x64'; }],
    ['missing tarball URL', lock => delete lock.packages['node_modules/@openai/codex-win32-x64'].resolved],
    ['mismatched tarball URL', lock => { lock.packages['node_modules/@openai/codex-win32-x64'].resolved = 'https://registry.npmjs.org/@openai/codex/-/codex-0.0.0-win32-x64.tgz'; }],
    ['missing SRI', lock => delete lock.packages['node_modules/@openai/codex-win32-x64'].integrity],
    ['mismatched SRI', lock => { lock.packages['node_modules/@openai/codex-win32-x64'].integrity = 'sha512-tampered'; }],
    ['missing OS restriction', lock => delete lock.packages['node_modules/@openai/codex-win32-x64'].os],
    ['mismatched OS restriction', lock => { lock.packages['node_modules/@openai/codex-win32-x64'].os = ['linux']; }],
    ['missing CPU restriction', lock => delete lock.packages['node_modules/@openai/codex-win32-x64'].cpu],
    ['mismatched CPU restriction', lock => { lock.packages['node_modules/@openai/codex-win32-x64'].cpu = ['arm64']; }],
    ['missing optional flag', lock => delete lock.packages['node_modules/@openai/codex-win32-x64'].optional],
    ['mismatched optional flag', lock => { lock.packages['node_modules/@openai/codex-win32-x64'].optional = false; }],
  ];

  for (const [label, mutate] of mutations) {
    const fixture = JSON.parse(JSON.stringify(releaseMetadataFixture('x64')));
    mutate(fixture);
    assert.throws(
      () => assertWindowsNativeCodexMetadata(fixture, release, 'x64'),
      undefined,
      `the release gate must reject ${label}`,
    );
  }
});

test('the bundled SDK and automatic native CLI use the same audited Codex release', () => {
  const packageJson = readJson('scripts/package.json');
  const packageLock = readJson('scripts/package-lock.json');

  assert.equal(DEFAULT_CLI_INSTALL_SPEC, `@openai/codex@${release}`);
  assert.equal(packageJson.dependencies['@openai/codex-sdk'], release);
  assert.equal(packageLock.packages[''].dependencies['@openai/codex-sdk'], release);
  assert.equal(packageLock.packages['node_modules/@openai/codex-sdk'].version, release);
  assert.equal(packageLock.packages['node_modules/@openai/codex'].version, release);
  for (const architecture of Object.keys(nativeWindowsPackages)) {
    assertWindowsNativeCodexMetadata(packageLock, release, architecture);
  }
});

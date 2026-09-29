import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILES = [
  '.codex-plugin/plugin.json',
  'scripts/package.json',
  'scripts/package-lock.json'
];
const RC_VERSION = /^(\d+)\.(\d+)\.(\d+)-rc\.(\d+)(?:\+[^+]+)?$/;

function jsonPath(root, relativePath) {
  return path.join(root, relativePath);
}

function readJson(root, relativePath) {
  const file = jsonPath(root, relativePath);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${relativePath}: ${error.message}`);
  }
}

function quoteForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseRcVersion(value) {
  if (typeof value !== 'string') throw new Error(`version must be a string, got ${typeof value}`);
  const match = RC_VERSION.exec(value);
  if (!match) throw new Error(`expected <major>.<minor>.<patch>-rc.<number>, got ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rc: Number(match[4])
  };
}

export function normalizeRcVersion(value) {
  const parsed = parseRcVersion(value);
  return `${parsed.major}.${parsed.minor}.${parsed.patch}-rc.${parsed.rc}`;
}

export function nextRcVersion(value) {
  const parsed = parseRcVersion(value);
  return `${parsed.major}.${parsed.minor}.${parsed.patch}-rc.${parsed.rc + 1}`;
}

export function readPluginVersion(root = REPO_ROOT) {
  const manifest = readJson(root, '.codex-plugin/plugin.json');
  const packageJson = readJson(root, 'scripts/package.json');
  const lockfile = readJson(root, 'scripts/package-lock.json');
  const versions = [
    manifest.version,
    packageJson.version,
    lockfile.version,
    lockfile.packages?.['']?.version
  ];
  if (versions.some(version => typeof version !== 'string')) {
    throw new Error('all release manifests must contain a string version');
  }
  if (new Set(versions).size !== 1) {
    throw new Error(`release manifest versions disagree: ${versions.join(', ')}`);
  }
  return versions[0];
}

export function writePluginVersion(root = REPO_ROOT, requestedVersion) {
  const current = readPluginVersion(root);
  const version = normalizeRcVersion(requestedVersion);
  if (current === version) return {previous: current, version, changed: false};

  const updates = [];
  for (const relativePath of VERSION_FILES) {
    const file = jsonPath(root, relativePath);
    const source = fs.readFileSync(file, 'utf8');
    const quotedCurrent = JSON.stringify(current);
    const pattern = new RegExp(`("version"\\s*:\\s*)${quoteForRegExp(quotedCurrent)}`, 'g');
    let replacements = 0;
    const updated = source.replace(pattern, (_match, prefix) => {
      replacements += 1;
      return `${prefix}${JSON.stringify(version)}`;
    });
    const expected = relativePath.endsWith('package-lock.json') ? 2 : 1;
    if (replacements !== expected) {
      throw new Error(`expected ${expected} version fields in ${relativePath}, found ${replacements}`);
    }
    JSON.parse(updated);
    updates.push({file, updated});
  }

  for (const {file, updated} of updates) fs.writeFileSync(file, updated, 'utf8');

  if (readPluginVersion(root) !== version) {
    throw new Error('release manifest versions did not converge after update');
  }
  return {previous: current, version, changed: true};
}

function parseArguments(argv) {
  let mode = 'next';
  let requested;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--next-rc') {
      if (requested) throw new Error('--next-rc cannot be combined with an explicit version');
      mode = 'next';
    } else if (argument === '--set' || argument === '--version') {
      if (requested) throw new Error('only one explicit version is allowed');
      requested = argv[++index];
      if (!requested) throw new Error(`${argument} requires a version`);
      mode = 'set';
    } else if (argument === '--help' || argument === '-h') {
      return {help: true};
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  return {mode, requested};
}

function printHelp() {
  console.log([
    'Usage: node scripts/bump-version.mjs [--next-rc | --set <version>]',
    '',
    '  --next-rc       increment the current rc number (the default)',
    '  --set <version> set an explicit <major>.<minor>.<patch>-rc.<number>'
  ].join('\n'));
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.help) {
    printHelp();
    return;
  }
  const current = readPluginVersion(REPO_ROOT);
  const target = args.mode === 'set' ? normalizeRcVersion(args.requested) : nextRcVersion(current);
  const result = writePluginVersion(REPO_ROOT, target);
  console.log(JSON.stringify({ok: true, ...result}));
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath && import.meta.url === invokedPath) {
  main().catch(error => {
    console.error(`VERSION_BUMP_FAILED: ${error.message}`);
    process.exitCode = 2;
  });
}

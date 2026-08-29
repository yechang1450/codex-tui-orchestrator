#!/usr/bin/env node
/**
 * repair.mjs - per-skill publish / integrity entry.
 *
 * A skill folder is self-contained & publishable when it carries:
 *   SKILL.md + README.md + LICENSE                (must exist)
 *   plus optional docs (README-zh.md, CHANGELOG.md)
 *   plus source dirs (scripts/, automations/, references/, data/)
 *   - all free of runtime debris.
 *
 * Runtime debris (use-and-discard, never bundled, safe to remove):
 *   node_modules/  __pycache__/  state/  temp/
 *   .pytest_cache/  .cache/
 *   *.part  *.tmp  *.pyc  *.pyo  *.crdownload  *.partial  *.swp
 *   .enforce-state.json  .DS_Store  Thumbs.db
 *
 * Usage:
 *   node repair.mjs                 # integrity check (read-only)
 *   node repair.mjs --clean         # remove runtime debris (use-and-discard only)
 *   node repair.mjs --target <root> # publish: byte-copy the skill folder to <root>/<skill>
 *
 * No third-party deps; Node 22+; all reads/writes UTF-8 (no BOM) for text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.basename(__dirname);

const REQUIRED_FILES = ['SKILL.md', 'README.md', 'LICENSE'];
const OPTIONAL_FILES = ['README-zh.md', 'CHANGELOG.md'];

const DEBRIS_DIRS = new Set([
  'node_modules',
  '__pycache__',
  'state',
  'temp',
  '.pytest_cache',
  '.cache',
]);

const DEBRIS_EXACT = new Set(['.enforce-state.json', '.DS_Store', 'Thumbs.db']);
const DEBRIS_RE = /\.(part|tmp|pyc|pyo|crdownload|partial|swp)$/i;

function listFiles(dir, base = '', out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue; // 跳过符号链接：不跟随内容复制/删除（防越权/防逃逸）
    const abs = path.join(dir, e.name);
    const rel = path.join(base, e.name);
    if (e.isDirectory()) listFiles(abs, rel, out);
    else out.push(rel);
  }
  return out;
}

function isDebrisRel(rel) {
  const parts = rel.split(path.sep);
  if (parts.some((p) => DEBRIS_DIRS.has(p))) return true;
  const base = path.basename(rel);
  if (DEBRIS_EXACT.has(base)) return true;
  if (DEBRIS_RE.test(base)) return true;
  return false;
}

function hasAny(relRoot) {
  const files = listFiles(path.join(__dirname, relRoot));
  return files.some((f) => !isDebrisRel(f));
}

function check() {
  let problems = 0;

  console.log(`[${SKILL}] repair.mjs - self-contained publish / integrity check`);
  console.log(`[${SKILL}] skill root = ${__dirname}`);

  for (const name of REQUIRED_FILES) {
    const ok = fs.existsSync(path.join(__dirname, name));
    console.log(`  ${ok ? 'OK ' : 'MISSING'} required  ${name}`);
    if (!ok) problems++;
  }
  for (const name of OPTIONAL_FILES) {
    if (fs.existsSync(path.join(__dirname, name))) {
      console.log(`  OK  optional  ${name}`);
    }
  }
  for (const dir of ['scripts', 'automations', 'references', 'data']) {
    const full = path.join(__dirname, dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory() && hasAny(dir)) {
      console.log(`  OK  source dir  ${dir}/`);
    }
  }

  const debris = [];
  for (const rel of listFiles(__dirname)) {
    if (isDebrisRel(rel)) debris.push(rel);
  }
  if (debris.length) {
    console.log(`  FOUND ${debris.length} runtime debri item(s) (use-and-discard):`);
    for (const d of debris) console.log(`      ${d}`);
  } else {
    console.log('  OK  no runtime debris');
  }

  console.log('---');
  if (problems) {
    console.log(`[${SKILL}] RESULT: not publishable (${problems} required file(s) missing). Run with --target <root> to publish a clean copy.`);
    process.exit(1);
  }
  console.log(`[${SKILL}] RESULT: publishable${debris.length ? ' (debris present; use --clean to remove)' : ''}.`);
  process.exit(0);
}

function clean() {
  try {
    console.log(`[${SKILL}] --clean: removing runtime debris (use-and-discard only; source is untouched)`);
    const removed = [];
    for (const rel of listFiles(__dirname)) {
      if (!isDebrisRel(rel)) continue;
      const abs = path.join(__dirname, rel);
      // Never follow out of the skill root（realpath 兜底，防符号链接逃逸）。
      let real = abs;
      try { real = fs.realpathSync(abs); } catch { /* path may be gone */ }
      const rootReal = fs.realpathSync(__dirname);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) continue;
      fs.rmSync(abs, { force: true });
      removed.push(rel);
      console.log(`  removed ${rel}`);
    }
    // Also drop now-empty debris dirs (e.g. empty state/, temp/, __pycache__/).
    for (const dir of DEBRIS_DIRS) {
      const full = path.join(__dirname, dir);
      if (fs.existsSync(full)) {
        const empty = fs.readdirSync(full).length === 0;
        if (empty) {
          fs.rmdirSync(full);
          removed.push(dir + '/');
          console.log(`  removed empty dir ${dir}/`);
        }
      }
    }
    console.log(`[${SKILL}] removed ${removed.length} debris item(s).`);
    process.exit(0);
  } catch (e) {
    console.error(`[${SKILL}] clean failed: ${e.message}`);
    process.exit(2);
  }
}

function publish(targetRoot) {
  try {
    if (!path.isAbsolute(targetRoot)) {
      console.error(`[${SKILL}] --target expects an absolute root, got: ${targetRoot}`);
      process.exit(2);
    }
    // publish 前必须验证必需文件
    const missing = REQUIRED_FILES.filter((nf) => !fs.existsSync(path.join(__dirname, nf)));
    if (missing.length) { console.error("[" + SKILL + "] publish aborted: missing " + missing.join(", ")); process.exit(2); }
    const dest = path.join(path.resolve(targetRoot), SKILL);
    console.log(`[${SKILL}] --target: publishing skill folder to ${dest}`);
    let copied = 0;
    for (const rel of listFiles(__dirname)) {
      if (isDebrisRel(rel)) continue;
      const srcAbs = path.join(__dirname, rel);
      const dstAbs = path.join(dest, rel);
      fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
      // Byte-copy: preserves UTF-8 no-BOM text and any binary data byte-exact.
      fs.copyFileSync(srcAbs, dstAbs);
      copied++;
    }
    console.log(`[${SKILL}] published ${copied} file(s) to ${dest}.`);
    process.exit(0);
  } catch (e) {
    console.error(`[${SKILL}] publish failed: ${e.message}`);
    process.exit(2);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--clean')) return clean();
  const ti = args.indexOf('--target');
  if (ti >= 0 && args[ti + 1]) return publish(args[ti + 1]);
  return check();
}

main();

#!/usr/bin/env node
/**
 * repair.mjs - per-skill publish / integrity entry.
 *
 * A skill folder is self-contained & publishable when it carries:
 *   SKILL.md + README.md + LICENSE                (must exist)
 *   plus optional docs (README-zh.md, CHANGELOG.md)
 *   manifest-advertised privacy/terms pages are required when their URLs are present
 *   plus source dirs (scripts/, automations/, references/, data/)
 *   - all free of runtime debris.
 *
 * Runtime debris (use-and-discard, never bundled, safe to remove):
 *   node_modules/  __pycache__/
 *   .pytest_cache/  .cache/
 *   *.part  *.tmp  *.pyc  *.pyo  *.crdownload  *.partial  *.swp
 *   .enforce-state.json  .DS_Store  Thumbs.db
 *
 * Usage:
 *   node repair.mjs                 # integrity check (read-only)
 *   node repair.mjs --clean         # remove runtime debris (use-and-discard only)
 *   node repair.mjs --target <root> [--name <safe-directory-name>] # publish: byte-copy to <root>/<name>
 *
 * No third-party deps; Node 22+; all reads/writes UTF-8 (no BOM) for text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {isSourceOnlyRuntimePath,verifyRelease} from './scripts/release-integrity.mjs';
import {assertNoReparsePoints} from './scripts/core/runtime-context.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.basename(__dirname);

const REQUIRED_FILES = ['README.md', 'LICENSE'];
const OPTIONAL_FILES = ['README-zh.md', 'CHANGELOG.md'];

// If the plugin manifest advertises repository-hosted privacy/terms pages,
// those pages are part of the publish contract.  Keep the generic repair
// workflow compatible with older skill roots whose manifest has no such URLs.
function requiredPublishedFiles(root = __dirname) {
  const required = [...REQUIRED_FILES];
  const manifest = path.join(root, '.codex-plugin', 'plugin.json');
  if (!isRegularFile(manifest)) return required;
  try {
    const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const urls = [metadata?.interface?.privacyPolicyURL, metadata?.interface?.termsOfServiceURL]
      .filter(value => typeof value === 'string');
    if (urls.some(url => /\/docs\/privacy\.md(?:$|[#?])/i.test(url))) required.push('docs/privacy.md');
    if (urls.some(url => /\/docs\/terms\.md(?:$|[#?])/i.test(url))) required.push('docs/terms.md');
  } catch {
    // Manifest validity is handled by the release-integrity snapshot; avoid
    // making this compatibility helper reject legacy fixture roots.
  }
  return required;
}

const DEBRIS_DIRS = new Set([
  'node_modules',
  'temp',
  '__pycache__',
  '.pytest_cache',
  '.cache',
]);

const DEBRIS_EXACT = new Set(['.enforce-state.json', '.agent-cache.json', '.DS_Store', 'Thumbs.db']);
const DEBRIS_RE = /\.(part|tmp|pyc|pyo|crdownload|partial|swp)$/i;
// Publication is a sealed, reviewed inventory.  Ignore rules alone are not a
// publication boundary: an untracked .env or receipt can still be copied.
const SENSITIVE_PUBLIC_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|id_[a-z0-9_-]+|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|log))$/i;
const SENSITIVE_PUBLIC_DIR = /^(?:\.?secrets?|\.?credentials?|\.?private[-_]?keys?)$/i;
// Public documentation is allowed here.  Only machine-readable receipts and
// explicitly private artifacts are barred; a broad filename rule would make
// legitimate documentation impossible to publish.
const PRIVATE_EVIDENCE_NAME = /^(?:.*(?:receipt|report|evidence|full-audit|readiness)[^/]*\.(?:json|jsonl|log|txt)|(?:private[-_].*)\.(?:json|jsonl|log|txt))$/i;

// Development-only suites and CI metadata stay in the source checkout. They
// are not runtime plugin content and must not be copied into an installed
// cache (they also contain large historical fixtures and live evidence).
const PROTECTED_DIRS=new Set(['.git','node_modules','temp','.plugin-eval','test','.github']);
function listFiles(dir, base = '', out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if(PROTECTED_DIRS.has(e.name))continue;
    if (e.isSymbolicLink()) continue; // 跳过符号链接：不跟随内容复制/删除（防越权/防逃逸）
    const abs = path.join(dir, e.name);
    const rel = path.join(base, e.name);
    if (e.isDirectory()) listFiles(abs, rel, out);
    else out.push(rel);
  }
  return out;
}

// republish 只复制常规文件，不跟随符号链接；校验也保持一致（lstat，不 follow symlink）。
function isRegularFile(p) { try { return fs.lstatSync(p).isFile(); } catch { return false; } }

function renamePublishedStaging(staging,dest) {
  const deadline=Date.now()+2000;
  while(true){
    try { fs.renameSync(staging,dest); return; }
    catch(error){
      if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||Date.now()>=deadline)throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
    }
  }
}

// 可发布 skill 标志：优先 skills/*/SKILL.md（插件规范），兼容旧式根目录 SKILL.md。
function findSkillFile(root = __dirname) {
  const sk = path.join(root, 'skills');
  if (fs.existsSync(sk)) {
    for (const e of fs.readdirSync(sk, { withFileTypes: true })) {
      if (e.isDirectory() && isRegularFile(path.join(sk, e.name, 'SKILL.md'))) return path.join(sk, e.name, 'SKILL.md');
    }
  }
  if (isRegularFile(path.join(root, 'SKILL.md'))) return path.join(root, 'SKILL.md');
  return null;
}

function isDebrisRel(rel) {
  const parts = rel.split(path.sep);
  if (parts.some((p) => DEBRIS_DIRS.has(p))) return true;
  const base = path.basename(rel);
  if (DEBRIS_EXACT.has(base)) return true;
  if (DEBRIS_RE.test(base)) return true;
  return false;
}

function publicationManifest(root = __dirname) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
    if (value?.schema !== 2 || !value.runtimeFiles || typeof value.runtimeFiles !== 'object') {
      throw new Error('RELEASE_SCHEMA_UNSUPPORTED: publication requires a schema 2 runtime inventory');
    }
    return new Set(['release.json', ...Object.keys(value.runtimeFiles).map(String)]);
  } catch (error) {
    throw new Error(`PUBLICATION_MANIFEST_INVALID: ${error?.message || error}`);
  }
}

function assertPublicPath(rel) {
  const parts = String(rel).split(/[\\/]/);
  const base = parts.at(-1);
  if (parts.slice(0, -1).some(part => SENSITIVE_PUBLIC_DIR.test(part))
    || SENSITIVE_PUBLIC_NAME.test(base) || PRIVATE_EVIDENCE_NAME.test(base)) {
    throw new Error(`PUBLICATION_SENSITIVE_FILE: refusing to publish ${rel}`);
  }
}

function publicationFiles(root = __dirname) {
  const expected = publicationManifest(root);
  // Keep the publisher's traversal aligned with the sealed runtime inventory:
  // source-only release tooling lives in a checkout but is deliberately absent
  // from release.json and therefore must neither trigger an unlisted-file
  // failure nor be copied into an installed artifact.
  const files = listFiles(root).filter(rel => !isDebrisRel(rel) && !isSourceOnlyRuntimePath(rel));
  for (const rel of files) assertPublicPath(rel);
  const unexpected = files.filter(rel => !expected.has(rel.replaceAll(path.sep, '/')) && !expected.has(rel));
  if (unexpected.length) {
    throw new Error(`PUBLICATION_UNLISTED_FILE: release manifest does not authorize ${unexpected.slice(0, 12).join(', ')}${unexpected.length > 12 ? ` (+${unexpected.length - 12} more)` : ''}`);
  }
  return files;
}

function hasAny(relRoot) {
  const files = listFiles(path.join(__dirname, relRoot));
  return files.some((f) => !isDebrisRel(f));
}

function check() {
  let problems = 0;
  try{verifyRelease(__dirname);}catch(e){console.error(e.message);problems++;}

  console.log(`[${SKILL}] repair.mjs - self-contained publish / integrity check`);
  console.log(`[${SKILL}] skill root = ${__dirname}`);

  const skillFile = findSkillFile();
  if (skillFile) {
    console.log(`  OK  skill  ${path.relative(__dirname, skillFile)}`);
  } else {
    console.log('  MISSING skill  SKILL.md (expected under skills/<name>/SKILL.md)');
    problems++;
  }
  for (const name of requiredPublishedFiles()) {
    const full = path.join(__dirname, name);
    const ok = isRegularFile(full);
    const isLink = fs.existsSync(full) && !ok; // 存在但非常规（如符号链接）→ 一致性校验失败
    console.log(`  ${ok ? 'OK ' : 'MISSING'} required  ${name}${isLink ? ' (symlink/not-regular; will not be published)' : ''}`);
    if (!ok) problems++;
  }
  for (const name of OPTIONAL_FILES) {
    if (isRegularFile(path.join(__dirname, name))) {
      console.log(`  OK  optional  ${name}`);
    }
  }
  for (const dir of ['scripts', 'automations', 'references', 'data']) {
    const full = path.join(__dirname, dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory() && hasAny(dir)) {
      console.log(`  OK  source dir  ${dir}/`);
    }
  }

  const core=path.join(__dirname,'scripts','core','contracts.mjs');
  if(!fs.existsSync(core)){console.log('  MISSING shared execution core');problems++;}
  else console.log('  OK  shared core '+fs.realpathSync(path.dirname(core)));
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
    process.exit(2);
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
      try { real = fs.realpathSync(abs); } catch { continue; } // realpath 失败则无法确认越界，跳过不删
      const rootReal = fs.realpathSync(__dirname);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) continue;
      fs.rmSync(abs, { force: true });
      removed.push(rel);
      console.log(`  removed ${rel}`);
    }
    // Also drop now-empty debris dirs (e.g. empty state/, temp/, __pycache__/).
    for (const dir of DEBRIS_DIRS) {
      if(PROTECTED_DIRS.has(dir))continue;
      const full = path.join(__dirname, dir);
      if (fs.existsSync(full) && !fs.lstatSync(full).isSymbolicLink()) {
        let real = null;
        try { real = fs.realpathSync(full); } catch { continue; }
        const rootReal = fs.realpathSync(__dirname);
        if (real !== rootReal && !real.startsWith(rootReal + path.sep)) continue;
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

function publishedDirectoryName(name = SKILL) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..'
    || path.basename(name) !== name || /[\\/\0]/.test(name)) {
    throw new Error(`Publish destination name must be one safe path segment, got: ${JSON.stringify(name)}`);
  }
  return name;
}

function publish(targetRoot, destinationName = SKILL) {
  let staging;
  try {
    verifyRelease(__dirname);
    if (!path.isAbsolute(targetRoot)) {
      console.error(`[${SKILL}] --target expects an absolute root, got: ${targetRoot}`);
      process.exit(2);
    }
    // publish 前必须验证必需文件
    const missing = requiredPublishedFiles().filter((nf) => !isRegularFile(path.join(__dirname, nf)));
    if (missing.length || !findSkillFile()) { console.error("[" + SKILL + "] publish aborted: missing " + (missing.length ? missing.join(", ") : "skill SKILL.md (under skills/<name>/)")); process.exit(2); }
    const name = publishedDirectoryName(destinationName);
    const dest = path.join(path.resolve(targetRoot), name);
    assertNoReparsePoints(path.resolve(targetRoot), 'publish target root');
    assertNoReparsePoints(dest, 'publish target');
    if(fs.existsSync(dest))throw new Error('Publish target already exists; choose a fresh version directory');
    const relative=path.relative(__dirname,dest);
    if(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw new Error('Publish target must be outside the source tree');
    // Resolve existing ancestors before creating anything; junction aliases must
    // not disguise a destination inside the source tree.
    let ancestor=path.dirname(dest),tail=[path.basename(dest)];
    while(!fs.existsSync(ancestor)){tail.unshift(path.basename(ancestor));ancestor=path.dirname(ancestor);}
    const physical=path.join(fs.realpathSync(ancestor),...tail);
    const physicalRelative=path.relative(fs.realpathSync(__dirname),physical);
    if(physicalRelative!=='..'&&!physicalRelative.startsWith('..'+path.sep)&&!path.isAbsolute(physicalRelative))throw new Error('Publish target must be outside the source tree');
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    staging=fs.mkdtempSync(path.join(path.dirname(dest),'.'+name+'-staging-'));
    console.log(`[${SKILL}] --target: publishing skill folder to ${dest}`);
    let copied = 0;
    const inventory = publicationFiles(__dirname);
    for (const rel of inventory) {
      const srcAbs = path.join(__dirname, rel);
      const dstAbs = path.join(staging, rel);
      fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
      // Byte-copy: preserves UTF-8 no-BOM text and any binary data byte-exact.
      fs.copyFileSync(srcAbs, dstAbs);
      copied++;
    }
    const missingStaged = requiredPublishedFiles(staging).filter(name => !isRegularFile(path.join(staging, name)));
    if(missingStaged.length || !findSkillFile(staging))throw new Error('Staged package missing required: '+(missingStaged.length?missingStaged.join(', '):'skill SKILL.md'));
    verifyRelease(staging);
    if(fs.existsSync(dest))throw new Error('Publish target appeared during publication');
    renamePublishedStaging(staging,dest);staging=undefined;
    console.log(`[${SKILL}] published ${copied} file(s) to ${dest}.`);
    process.exit(0);
  } catch (e) {
    if(staging)fs.rmSync(staging,{recursive:true,force:true});
    console.error(`[${SKILL}] publish failed: ${e.message}`);
    process.exit(2);
  }
}

function main() {
  const args = process.argv.slice(2);
  const options = {clean: false, target: null, name: null};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--clean') options.clean = true;
    else if (arg === '--target' || arg === '--name') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
      if (arg === '--target') options.target = value;
      else options.name = value;
    } else throw new Error(`unknown option: ${arg}`);
  }
  if (options.clean) {
    if (options.target || options.name) throw new Error('--clean cannot be combined with --target or --name');
    return clean();
  }
  if (options.name && !options.target) throw new Error('--name requires --target');
  if (options.target) return publish(options.target, options.name || SKILL);
  return check();
}

main();

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function fixture(t) {
  fs.mkdirSync(path.join(repo, 'temp'), {recursive: true});
  const root = fs.mkdtempSync(path.join(repo, 'temp', 'reboot bridge '));
  const id = 'unit-' + randomUUID().slice(0, 8);
  const name = 'CodexTuiOrchestrator-RebootValidation-' + id;
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const registryRead = `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'); if($key){$key.GetValue(${quote(name)});$key.Dispose()}`;
  const registryValue = () => spawnSync(ps, ['-NoProfile', '-Command', registryRead], {encoding:'utf8', windowsHide:true}).stdout.trim();
  t.after(() => {
    const cleanup = `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',$true); if($key){$value=$key.GetValue(${quote(name)}); if($value -and $value.Contains(${quote(root)})){$key.DeleteValue(${quote(name)})};$key.Dispose()}`;
    spawnSync(ps, ['-NoProfile', '-Command', cleanup], {encoding:'utf8', windowsHide:true});
    fs.rmSync(root, {recursive: true, force: true});
  });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.copyFileSync(path.join(repo, 'test/reboot-validation.ps1'), path.join(root, 'test/reboot-validation.ps1'));
  fs.writeFileSync(path.join(root, 'scripts/release-integrity.mjs'), 'console.log(JSON.stringify({schema:2,coreVersion:"test",files:24,runtimeFiles:50}));');
  fs.writeFileSync(path.join(root, 'scripts/orchestrate-sdk.mjs'), 'console.log(JSON.stringify({agent:"codex",workspace:process.cwd(),cli:process.execPath}));');
  fs.writeFileSync(path.join(root, 'scripts/repair-plugin-registration.mjs'), 'console.log(JSON.stringify({ok:true,status:"matched",pluginReal:process.argv[2]}));');
  fs.writeFileSync(path.join(root, 'release.json'), '{"schema":2}');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Reboot Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']]) {
    const r = spawnSync('git', args, {cwd: root, encoding: 'utf8', windowsHide: true});
    assert.equal(r.status, 0, r.stderr);
  }
  const state = path.join(root, 'temp', 'reboot-validation-' + id);
  const prePath = path.join(state, 'pre-reboot.json');
  const postPath = path.join(state, 'post-reboot.json');
  const run = (mode, extra = [], cwd = repo) => spawnSync(ps, ['-NoProfile', '-File', path.join(root, 'test/reboot-validation.ps1'), '-Mode', mode, '-Workspace', root, '-Id', id, ...extra], {cwd, encoding: 'utf8', windowsHide: true, timeout: 30000});
  const prepare = () => { const r = run('prepare', ['-ManualOnly']); assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(fs.readFileSync(prePath, 'utf8')); };
  const earlierBoot = () => { const pre = JSON.parse(fs.readFileSync(prePath, 'utf8')); pre.bootBefore = '2000-01-01T00:00:00.0000000Z'; fs.writeFileSync(prePath, JSON.stringify(pre)); };
  const post = () => JSON.parse(fs.readFileSync(postPath, 'utf8'));
  return {root, state, prePath, postPath, run, prepare, earlierBoot, post, registryValue};
}

test('reboot collector distinguishes manual fallback and runs checks in the prepared workspace', {skip: !windows}, t => {
  const f = fixture(t); const pre = f.prepare(); f.earlierBoot();
  assert.equal(pre.nodePath.toLowerCase(), fs.realpathSync.native(pre.nodePath).toLowerCase(), 'Pin the installed executable, not a temporary shell alias');
  const r = f.run('collect');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const post = f.post();
  assert.equal(post.passed, true);
  assert.equal(post.collectionTrigger, 'Manual');
  assert.equal(post.automaticCollectionPassed, false);
  assert.equal(post.scope, 'post-reboot-health');
  assert.equal(post.commitBefore, post.commitAfter);
  assert.equal(JSON.parse(post.checks.find(c => c.label === 'doctor').output).workspace.toLowerCase(), f.root.toLowerCase());
});

test('no reboot is not a pass and prepare cannot replace its original baseline', {skip: !windows}, t => {
  const f = fixture(t); f.prepare();
  const before = fs.readFileSync(f.prePath);
  assert.equal(f.run('prepare', ['-ManualOnly']).status, 1);
  assert.deepEqual(fs.readFileSync(f.prePath), before);
  assert.equal(f.run('collect').status, 1);
  assert.equal(f.post().bootChanged, false);
  assert.equal(f.post().passed, false);
});

test('zero exit with invalid receipt still fails while later checks and failure evidence survive', {skip: !windows}, t => {
  const f = fixture(t); f.prepare(); f.earlierBoot();
  fs.writeFileSync(path.join(f.root, 'scripts/release-integrity.mjs'), 'console.error("unexpected diagnostic"); console.log("not-json");');
  assert.equal(f.run('collect').status, 1);
  const post = f.post();
  assert.equal(post.passed, false);
  assert.equal(post.checks.length, 3);
  assert.equal(post.checks[0].valid, false);
  assert.equal(post.checks[2].valid, true);
});

test('missing pinned runtime writes a failure receipt rather than silently losing collection', {skip: !windows}, t => {
  const f = fixture(t); const pre = f.prepare();
  pre.nodePath = path.join(f.root, 'missing-node.exe');
  fs.writeFileSync(f.prePath, JSON.stringify(pre));
  assert.equal(f.run('collect').status, 1);
  assert.equal(f.post().passed, false);
  assert.match(f.post().error, /runtime/i);
});

test('changed commit cannot certify the old baseline and collection never overwrites an existing receipt', {skip: !windows}, t => {
  const f = fixture(t); f.prepare(); f.earlierBoot();
  const r = spawnSync('git', ['-c', 'user.name=Reboot Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'changed'], {cwd:f.root, encoding:'utf8', windowsHide:true});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.run('collect').status, 1);
  assert.equal(f.post().commitMatches, false);
  assert.equal(f.post().passed, false);
  const before = fs.readFileSync(f.postPath);
  assert.equal(f.run('collect').status, 1);
  assert.deepEqual(fs.readFileSync(f.postPath), before);
});

test('registered command runs from a foreign working directory and cleans only its one-shot entry', {skip: !windows}, t => {
  const f = fixture(t);
  const prepare = f.run('prepare');
  assert.equal(prepare.status, 0, prepare.stdout + prepare.stderr);
  const pre = JSON.parse(fs.readFileSync(f.prePath, 'utf8'));
  assert.equal(pre.registration.status, 'registered-unverified');
  const command = f.registryValue();
  assert.ok(command.length > 0 && command.length <= 260);
  const collect = spawnSync(ps, ['-NoProfile', '-Command', command], {cwd:repo, encoding:'utf8', windowsHide:true, timeout:30000});
  assert.equal(collect.status, 1, collect.stdout + collect.stderr);
  assert.ok(fs.existsSync(f.postPath), collect.stdout + collect.stderr);
  const post = f.post();
  assert.equal(post.collectionTrigger, 'RunOnce');
  assert.equal(post.automaticCollectionPassed, false, 'Invoking a registered command is not a Windows logon test');
  assert.equal(post.bootChanged, false);
  assert.equal(post.checks.length, 3);
  assert.ok(post.checks.every(c => c.valid));
  assert.equal(f.registryValue(), '');
});

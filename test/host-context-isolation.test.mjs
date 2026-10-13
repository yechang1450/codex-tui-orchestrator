import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const preload = path.join(root, 'test', 'host-context-isolation.mjs');
const contextModule = pathToFileURL(path.join(root, 'scripts', 'core', 'initiator-context.mjs')).href;
const sdkModule = pathToFileURL(path.join(root, 'scripts', 'core', 'orchestrate-sdk.mjs')).href;

test('test preload removes inherited desktop authority before initiator context loads', () => {
  const program = `import { PROCESS_INITIATOR_CONTEXT } from ${JSON.stringify(contextModule)}; process.stdout.write(JSON.stringify({ context: PROCESS_INITIATOR_CONTEXT, workspace: process.env.WORKSPACE_DIR, home: process.env.CODEX_HOME }));`;
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '--eval', program], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_THREAD_ID: '11111111-1111-1111-1111-111111111111',
      CODEX_SESSION_ID: '22222222-2222-2222-2222-222222222222',
      CODEX_PERMISSION_PROFILE: 'danger-full-access',
      CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY: 'desktop-binding',
      WORKSPACE_DIR: 'C:\\fixture-host-workspace',
      CODEX_HOME: 'C:\\fixture-codex-home',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.context, {threadId: '', workspace: 'C:\\fixture-host-workspace'});
  assert.equal(observed.workspace, 'C:\\fixture-host-workspace');
  assert.equal(observed.home, 'C:\\fixture-codex-home');
});

test('pure SDK exports import without desktop authority or a selected host agent', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-host-neutral-import-'));
  t.after(() => fs.rmSync(fixture, {recursive: true, force: true}));
  const workspace = path.join(fixture, 'workspace');
  fs.mkdirSync(workspace);
  const program = `import {publicOutputText, genericProjectSplit} from ${JSON.stringify(sdkModule)};
    process.stdout.write(JSON.stringify({
      publicText: publicOutputText('OPENAI_API_KEY=host-neutral-secret'),
      split: genericProjectSplit('explain the current workspace only')
    }));`;
  const env = {
    ...process.env,
    WORKSPACE_DIR: workspace,
    ORCH_CONTROLLER_ROOT: path.join(fixture, 'controller'),
    CODEX_HOME: path.join(fixture, 'home'),
    ORCH_AUTO_INSTALL_CLI: '0',
    ORCH_AUTO_INSTALL_DEPS: '0',
  };
  for (const key of [
    'ORCH_AGENT', 'ORCH_CLI', 'CODEX_EXE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID',
    'CODEX_PERMISSION_PROFILE', 'CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY',
  ]) delete env[key];
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(preload).href,
    '--input-type=module', '--eval', program,
  ], {cwd: workspace, env, encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    publicText: 'OPENAI_API_KEY=[REDACTED]',
    split: null,
  });
});

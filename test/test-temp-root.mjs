import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const checkoutRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrChild(candidate, parent) {
  const child = comparable(candidate);
  const root = comparable(parent);
  return child === root || child.startsWith(root + path.sep);
}

function safeSegment(value, label) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) {
    throw new TypeError(`${label} must be a safe test temp family name`);
  }
  return text;
}

export function testTempRoot(env = process.env) {
  const configured = String(env.ORCH_TEST_TEMP_ROOT || '').trim();
  const root = path.resolve(configured || path.join(os.tmpdir(), 'codex-tui-orchestrator-tests'));
  if (isSameOrChild(root, checkoutRoot)) {
    throw new Error(`ORCH_TEST_TEMP_ROOT must be outside the checkout: ${checkoutRoot}`);
  }
  return root;
}

export function testTempFamily(family, env = process.env) {
  const root = testTempRoot(env);
  const target = path.join(root, safeSegment(family, 'test temp family'));
  fs.mkdirSync(target, {recursive: true});
  return target;
}

export function makeTestDir(family, prefix = 'fixture-', env = process.env) {
  const target = testTempFamily(family, env);
  return fs.mkdtempSync(path.join(target, safeSegment(prefix, 'test temp prefix')));
}

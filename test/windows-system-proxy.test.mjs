import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as network from '../scripts/network-policy.mjs';

const registry = (enabled, server) => `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x${enabled ? 1 : 0}\r\n    ProxyServer    REG_SZ    ${server}\r\n`;

test('Codex children inherit an enabled Windows system proxy only inside the current process', () => {
  assert.equal(typeof network.applyWindowsProxyEnv, 'function');
  const env = {};
  assert.equal(network.applyWindowsProxyEnv(env,{platform:'win32',query:()=>registry(true,'127.0.0.1:7892')}),'system');
  assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:7892');
  assert.equal(env.HTTP_PROXY,'http://127.0.0.1:7892');
});

test('explicit proxy settings win and disabled or unsafe system values are ignored', () => {
  assert.equal(typeof network.applyWindowsProxyEnv, 'function');
  const explicit = {HTTPS_PROXY:'http://127.0.0.1:9000'};
  assert.equal(network.applyWindowsProxyEnv(explicit,{platform:'win32',query:()=>registry(true,'127.0.0.1:7892')}),'explicit');
  assert.equal(explicit.HTTPS_PROXY,'http://127.0.0.1:9000');
  for (const text of [registry(false,'127.0.0.1:7892'),registry(true,'http://user:pass@127.0.0.1:7892'),registry(true,'')]) {
    const env = {};
    assert.equal(network.applyWindowsProxyEnv(env,{platform:'win32',query:()=>text}),'none');
    assert.equal(env.HTTPS_PROXY,undefined);
  }
});

test('per-protocol Windows proxy prefers the HTTPS endpoint', () => {
  assert.equal(typeof network.applyWindowsProxyEnv, 'function');
  const env = {};
  const text = registry(true,'http=127.0.0.1:8000;https=127.0.0.1:7892');
  assert.equal(network.applyWindowsProxyEnv(env,{platform:'win32',query:()=>text}),'system');
  assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:7892');
});

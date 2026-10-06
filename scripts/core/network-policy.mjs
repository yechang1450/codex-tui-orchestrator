// Provider selection for the SDK planner and for the visible/headless workers.
//
// Default: inherit the initiating Codex configuration (model, model_provider and
// its credentials). The planner and every worker therefore run on the same
// provider as the conversation that started the run, including third-party
// providers configured in CODEX_HOME.
//
// Opt-in: an OpenAI-authenticated Responses provider over HTTPS, without the
// failing WebSocket probe. It keeps the configured model and login, uses no
// third-party endpoint or credentials, and is selected explicitly through
// ORCH_PROVIDER=openai-https or through a relay base URL.
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {trustedWindowsHelper, trustedWindowsRoot, controllerEnvironment} from './leases.mjs';

export function systemProxyRegistry({run=spawnSync}={}) {
  const windows = process.platform === 'win32';
  const root = windows ? trustedWindowsRoot() : (process.env.SystemRoot || 'C:\\Windows');
  const helper = windows ? trustedWindowsHelper('reg') : path.win32.join(root, 'System32', 'reg.exe');
  const result = run(helper, ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
    {encoding:'utf8', windowsHide:true, timeout:3000, maxBuffer:64 * 1024, shell:false,
      cwd:root, env:windows ? controllerEnvironment() : process.env});
  return result.status === 0 ? result.stdout : '';
}

function proxyEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw || /\s/.test(raw)) return undefined;
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : 'http://' + raw); } catch { return undefined; }
  if (!['http:','https:'].includes(url.protocol) || !url.hostname || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
  return url.origin;
}

// Copy only a safe, enabled Windows user proxy into this process. Codex children
// inherit it; the host's registry and global environment are never changed.
export function applyWindowsProxyEnv(env = process.env, {platform = process.platform, query = systemProxyRegistry} = {}) {
  if (platform !== 'win32') return 'none';
  if (['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY','all_proxy']
    .some(key => String(env[key] || '').trim())) return 'explicit';
  let output = '';
  try { output = String(query() || ''); } catch { return 'none'; }
  if (!/^\s*ProxyEnable\s+REG_DWORD\s+0x0*1\s*$/im.test(output)) return 'none';
  const raw = /^\s*ProxyServer\s+REG_SZ\s+(.+)\s*$/im.exec(output)?.[1]?.trim();
  if (!raw) return 'none';
  const protocol = raw.includes('=')
    ? Object.fromEntries(raw.split(';').map(part => part.trim().split('=', 2))): null;
  const https = proxyEndpoint(protocol ? protocol.https : raw);
  if (!https) return 'none';
  const http = proxyEndpoint(protocol ? protocol.http || protocol.https : raw);
  env.HTTPS_PROXY = https;
  if (http) env.HTTP_PROXY = http;
  return 'system';
}

export const OPENAI_HTTPS_PROVIDER = 'orchestrator-openai-https';
export function resolveOpenAIBaseUrl(env = process.env) {
  const raw = String(env.ORCH_OPENAI_BASE_URL || env.ORCH_STEADY_RELAY_BASE_URL || '').trim();
  if (!raw) return undefined;
  const normalized = raw.replace(/\/+$/, '');
  let url;
  try { url = new URL(normalized); } catch { throw new Error('ORCH_OPENAI_BASE_URL must be an absolute http(s) URL ending in /v1'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('ORCH_OPENAI_BASE_URL must use http or https');
  // The value is passed to Codex as a command-line configuration argument.
  // Reject URL credentials and opaque suffixes so secrets cannot enter process
  // listings, diagnostics, or provider request URLs through this setting.
  if (url.username || url.password || url.search || url.hash) throw new Error('ORCH_OPENAI_BASE_URL must not contain username, password, query, or fragment');
  if (url.protocol === 'http:' && !['localhost','127.0.0.1','::1'].includes(url.hostname.toLowerCase())) throw new Error('ORCH_OPENAI_BASE_URL must use https for non-loopback hosts');
  // The value is also serialized into a child configuration argument. Only
  // the fixed API path is accepted so credentials cannot hide in a custom
  // path segment that would later appear in process listings or diagnostics.
  if (!url.hostname || url.pathname !== '/v1') throw new Error('ORCH_OPENAI_BASE_URL must be an absolute http(s) URL with the fixed /v1 path');
  return url.toString().replace(/\/$/, '');
}

export const networkConfig = Object.freeze({
  model_provider: OPENAI_HTTPS_PROVIDER,
  model_providers: {
    [OPENAI_HTTPS_PROVIDER]: {
      name: 'OpenAI', wire_api: 'responses', requires_openai_auth: true,
      supports_websockets: false, supports_standalone_web_search: true,
    },
  },
});

// Explicit ORCH_PROVIDER wins. Without it, a configured relay base URL keeps the
// documented relay workflow on the hardened HTTPS provider; everything else
// inherits the initiating configuration.
export function resolveProviderMode(env = process.env) {
  const explicit = String(env.ORCH_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'inherit' || explicit === 'native') return 'inherit';
  if (explicit === 'openai-https' || explicit === 'relay') return 'openai-https';
  if (explicit) throw new Error(`Invalid ORCH_PROVIDER: ${explicit}; expected inherit or openai-https`);
  return resolveOpenAIBaseUrl(env) ? 'openai-https' : 'inherit';
}

export function networkArgs(env = process.env) {
  if (resolveProviderMode(env) === 'inherit') return [];
  const baseUrl = resolveOpenAIBaseUrl(env);
  const provider = { ...networkConfig.model_providers[networkConfig.model_provider],
    ...(baseUrl ? { base_url: baseUrl } : {}) };
  return ['-c', `model_provider=${JSON.stringify(networkConfig.model_provider)}`,
    ...Object.entries(provider).flatMap(([key, value]) =>
      ['-c', `model_providers.${networkConfig.model_provider}.${key}=${JSON.stringify(value)}`])];
}

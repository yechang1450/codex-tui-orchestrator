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
export const OPENAI_HTTPS_PROVIDER = 'orchestrator-openai-https';
export function resolveOpenAIBaseUrl(env = process.env) {
  const raw = String(env.ORCH_OPENAI_BASE_URL || env.ORCH_STEADY_RELAY_BASE_URL || '').trim();
  if (!raw) return undefined;
  const normalized = raw.replace(/\/+$/, '');
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`ORCH_OPENAI_BASE_URL must be an absolute http(s) URL ending in /v1: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`ORCH_OPENAI_BASE_URL must use http or https: ${raw}`);
  }
  if (!url.pathname.endsWith('/v1')) {
    throw new Error(`ORCH_OPENAI_BASE_URL must end with /v1: ${raw}`);
  }
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

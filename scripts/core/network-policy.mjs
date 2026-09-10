// OpenAI-authenticated Responses over HTTPS, without the failing WebSocket probe.
// Keep the configured model and login. No third-party endpoint or credentials.
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
  model_provider: 'orchestrator-openai-https',
  model_providers: {
    'orchestrator-openai-https': {
      name: 'OpenAI', wire_api: 'responses', requires_openai_auth: true,
      supports_websockets: false, supports_standalone_web_search: true,
    },
  },
});

export function networkArgs() {
  const provider = networkConfig.model_providers[networkConfig.model_provider];
  return ['-c', `model_provider=${JSON.stringify(networkConfig.model_provider)}`,
    ...Object.entries(provider).flatMap(([key, value]) =>
      ['-c', `model_providers.${networkConfig.model_provider}.${key}=${JSON.stringify(value)}`])];
}

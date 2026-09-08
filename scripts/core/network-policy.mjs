// OpenAI-authenticated Responses over HTTPS, without the failing WebSocket probe.
// Keep the configured model and login. No third-party endpoint or credentials.
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

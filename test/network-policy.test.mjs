import {test} from 'node:test';
import assert from 'node:assert/strict';
import {networkConfig, networkArgs, resolveOpenAIBaseUrl} from '../scripts/network-policy.mjs';
import {launchArgs} from '../scripts/host-cli.mjs';
test('HTTPS is applied to actual TUI arguments without replacing model or login', () => {
  const args=launchArgs({id:'codex'}, {approval:['on','request'].join('-')});
  assert.ok(args.includes('model_providers.orchestrator-openai-https.supports_websockets=false'));
  assert.equal(args.includes('-a'), false);
  assert.equal(args.includes('never'), false);
  assert.ok(networkArgs().every(a=>args.includes(a)));
  const provider=networkConfig.model_providers[networkConfig.model_provider];
  assert.equal(provider.requires_openai_auth,true);
  assert.equal(provider.supports_standalone_web_search,true);
  assert.equal(provider.base_url,undefined);
  assert.equal(networkConfig.model,undefined);
});

test('relay base URL is optional, normalized, and must end in /v1', () => {
  const prevOpenAI = process.env.ORCH_OPENAI_BASE_URL;
  const prevRelay = process.env.ORCH_STEADY_RELAY_BASE_URL;
  try {
    delete process.env.ORCH_OPENAI_BASE_URL;
    delete process.env.ORCH_STEADY_RELAY_BASE_URL;
    assert.equal(resolveOpenAIBaseUrl(), undefined);
    process.env.ORCH_STEADY_RELAY_BASE_URL = 'http://127.0.0.1:8080/v1/';
    assert.equal(resolveOpenAIBaseUrl(), 'http://127.0.0.1:8080/v1');
    process.env.ORCH_OPENAI_BASE_URL = 'http://127.0.0.1:8080';
    assert.throws(() => resolveOpenAIBaseUrl(), /\/v1/);
  } finally {
    if (prevOpenAI === undefined) delete process.env.ORCH_OPENAI_BASE_URL; else process.env.ORCH_OPENAI_BASE_URL = prevOpenAI;
    if (prevRelay === undefined) delete process.env.ORCH_STEADY_RELAY_BASE_URL; else process.env.ORCH_STEADY_RELAY_BASE_URL = prevRelay;
  }
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {networkConfig, networkArgs} from '../scripts/network-policy.mjs';
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

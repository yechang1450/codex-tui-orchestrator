import {test} from 'node:test';
import assert from 'node:assert/strict';
import {networkConfig, networkArgs, resolveOpenAIBaseUrl, resolveProviderMode, OPENAI_HTTPS_PROVIDER} from '../scripts/core/network-policy.mjs';
import {launchArgs} from '../scripts/core/host-cli.mjs';
const providerKeys=['ORCH_PROVIDER','ORCH_OPENAI_BASE_URL','ORCH_STEADY_RELAY_BASE_URL'];
function withoutProviderEnv(fn){
  const saved=Object.fromEntries(providerKeys.map(k=>[k,process.env[k]]));
  try{for(const k of providerKeys)delete process.env[k];return fn();}
  finally{for(const k of providerKeys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}}
}
test('planner and workers inherit the initiating Codex provider by default', () => {
  withoutProviderEnv(()=>{
    assert.equal(resolveProviderMode(),'inherit');
    assert.deepEqual(networkArgs(),[]);
    const args=launchArgs({id:'codex'}, {approval:['on','request'].join('-')});
    assert.equal(args.includes('model_provider='+JSON.stringify(OPENAI_HTTPS_PROVIDER)),false);
    assert.equal(args.some(a=>String(a).startsWith('model_providers.')),false);
    assert.equal(args[args.indexOf('-a')+1], 'on-request');
    assert.equal(args.includes('never'), false);
  });
});
test('the hardened HTTPS provider remains available as an explicit opt-in', () => {
  withoutProviderEnv(()=>{
    process.env.ORCH_PROVIDER='openai-https';
    assert.equal(resolveProviderMode(),'openai-https');
    const args=launchArgs({id:'codex'}, {approval:['on','request'].join('-')});
    assert.ok(args.includes('model_providers.orchestrator-openai-https.supports_websockets=false'));
    assert.ok(networkArgs().every(a=>args.includes(a)));
    const provider=networkConfig.model_providers[networkConfig.model_provider];
    assert.equal(networkConfig.model_provider,OPENAI_HTTPS_PROVIDER);
    assert.equal(provider.requires_openai_auth,true);
    assert.equal(provider.supports_standalone_web_search,true);
    assert.equal(provider.base_url,undefined);
    assert.equal(networkConfig.model,undefined);
  });
});
test('an explicit inherit choice wins over a relay URL and unknown provider modes fail closed', () => {
  withoutProviderEnv(()=>{
    process.env.ORCH_OPENAI_BASE_URL='https://proxy.example/v1';
    assert.equal(resolveProviderMode(),'openai-https','a relay URL still selects the hardened provider');
    process.env.ORCH_PROVIDER='inherit';
    assert.equal(resolveProviderMode(),'inherit');
    assert.deepEqual(networkArgs(),[]);
    process.env.ORCH_PROVIDER='deepseek';
    assert.throws(()=>resolveProviderMode(),/Invalid ORCH_PROVIDER/);
    assert.throws(()=>networkArgs(),/Invalid ORCH_PROVIDER/);
  });
});

test('relay base URL is optional, normalized, and must end in /v1', () => {
  withoutProviderEnv(()=>{
    assert.equal(resolveOpenAIBaseUrl(), undefined);
    process.env.ORCH_STEADY_RELAY_BASE_URL = 'http://127.0.0.1:8080/v1/';
    assert.equal(resolveOpenAIBaseUrl(), 'http://127.0.0.1:8080/v1');
    process.env.ORCH_OPENAI_BASE_URL = 'http://127.0.0.1:8080';
    assert.throws(() => resolveOpenAIBaseUrl(), /\/v1/);
  });
});

test('relay base URL rejects credentials and opaque suffixes before CLI construction', () => {
  withoutProviderEnv(()=>{
    for (const value of [
      'https://user:secret@proxy.example/v1',
      'https://proxy.example/v1?token=secret',
      'https://proxy.example/v1#secret',
    ]) {
      process.env.ORCH_OPENAI_BASE_URL = value;
      assert.throws(() => resolveOpenAIBaseUrl(), error =>
        /must not contain username, password, query, or fragment/.test(error.message) && !error.message.includes('secret'));
    }
    process.env.ORCH_OPENAI_BASE_URL = 'http://proxy.example/v1';
    assert.throws(() => resolveOpenAIBaseUrl(), /must use https for non-loopback hosts/);
    process.env.ORCH_OPENAI_BASE_URL = 'http://127.0.0.1:8080/v1';
    assert.equal(resolveOpenAIBaseUrl(), 'http://127.0.0.1:8080/v1');
    process.env.ORCH_OPENAI_BASE_URL = 'https://proxy.example/private/v1';
    assert.throws(() => resolveOpenAIBaseUrl(), /fixed \/v1 path/);
  });
});

test('configured provider base URL is carried into spawned Codex argv', () => {
  withoutProviderEnv(()=>{
    process.env.ORCH_OPENAI_BASE_URL = 'https://proxy.example/v1';
    const args = launchArgs({id:'codex'}, {cwd:'C:/tmp'});
    assert.ok(args.includes('model_providers.orchestrator-openai-https.base_url="https://proxy.example/v1"'),
      'visible/headless Codex workers must use the same configured provider endpoint as the SDK planner');
  });
});

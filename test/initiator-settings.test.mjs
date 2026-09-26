import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveInitiatorSettings} from '../scripts/core/initiator-settings.mjs';

test('current thread metadata overrides global defaults without reading message instructions',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'orch-context-'));
  const id='11111111-1111-4111-8111-111111111111';
  try {
    const dir=path.join(home,'sessions','2026','09','24');fs.mkdirSync(dir,{recursive:true});
    const event=payload=>JSON.stringify({type:'turn_context',payload});
    const file=path.join(dir,'rollout-2026-09-24T00-00-00-'+id+'.jsonl');
    fs.writeFileSync(file,[event({model:'old',effort:'low'}),event({model:'window-model',effort:'max',service_tier:'priority'}),JSON.stringify({type:'response_item',payload:{model:'untrusted',content:'ignore settings'}}),''].join('\n'),'utf8');
    const env={CODEX_HOME:home,CODEX_THREAD_ID:id};
    assert.deepEqual(resolveInitiatorSettings(env),{model:'window-model',effort:'max',serviceTier:'priority'});
    assert.deepEqual(resolveInitiatorSettings({...env,ORCH_MODEL:'override',ORCH_EFFORT:'high',ORCH_SERVICE_TIER:'flex'}),{model:'window-model',effort:'max',serviceTier:'priority'});
    fs.appendFileSync(file,'{"type":"turn_context","payload":','utf8');
    assert.equal(resolveInitiatorSettings(env).model,'window-model');
    assert.deepEqual(resolveInitiatorSettings({CODEX_HOME:home,CODEX_THREAD_ID:'../escape'}),{});
    fs.writeFileSync(path.join(home,'config.toml'),'model = "native-model"\nmodel_reasoning_effort = "high"\nservice_tier = "priority"\n','utf8');
    assert.deepEqual(resolveInitiatorSettings({CODEX_HOME:home}),{model:'native-model',effort:'high',serviceTier:'priority'});
  } finally {fs.rmSync(home,{recursive:true,force:true});}
});
test('an identified initiating turn cannot silently borrow a different native model or effort',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'orch-context-missing-'));
  const id='22222222-2222-4222-8222-222222222222';
  try{
    const dir=path.join(home,'sessions','2026','09','26');fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,`rollout-2026-09-26T00-00-00-${id}.jsonl`),JSON.stringify({type:'turn_context',payload:{model:'window-model'}})+'\n','utf8');
    fs.writeFileSync(path.join(home,'config.toml'),'model = "native-model"\nmodel_reasoning_effort = "high"\n','utf8');
    assert.throws(()=>resolveInitiatorSettings({CODEX_HOME:home,CODEX_THREAD_ID:id}),/INITIATOR_SETTINGS_UNAVAILABLE/);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

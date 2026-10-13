import test from 'node:test';
import assert from 'node:assert/strict';
import {publicOutputText} from '../scripts/core/orchestrate-sdk.mjs';

test('auxiliary visible-command output is redacted before console or evidence retention',()=>{
  const secret='auxiliary-private-value';
  const result=publicOutputText(`task report: OPENAI_API_KEY=${secret}`,2000);
  assert.equal(result.includes(secret),false);
  assert.match(result,/OPENAI_API_KEY=\[REDACTED\]/);
});

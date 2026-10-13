import test from 'node:test';
import assert from 'node:assert/strict';
import {fatalMessage} from '../scripts/core/fatal.mjs';

test('fatal diagnostics redact credential-shaped error details',()=>{
  const secret='fatal-private-value';
  const message=fatalMessage(new Error(`provider failed with OPENAI_API_KEY=${secret}`));
  assert.equal(message.includes(secret),false);
  assert.match(message,/OPENAI_API_KEY=\[REDACTED\]/);
});

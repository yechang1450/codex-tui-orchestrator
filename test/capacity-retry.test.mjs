import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capacityRetryPolicy, isCapacityError, isProviderQuotaError, rolloutQuotaError } from '../scripts/core/orchestrate-sdk.mjs';
import { waitTaskComplete, waitForSessionFile } from '../scripts/core/orchestrate-sdk.mjs';

test('capacity errors recognize the visible UI and structured overload signals', () => {
  assert.equal(isCapacityError('Selected model is at capacity. Please try a different model.'), true);
  assert.equal(isCapacityError('codex_error_info=server_overloaded'), true);
  assert.equal(isCapacityError({ error: { code: 'server_overloaded', message: 'overloaded' } }), true);
  assert.equal(isCapacityError('invalid api key'), false);
  assert.equal(isCapacityError('request rejected: malformed input'), false);
});

test('transient HTTP 429 provider responses are retryable, but typed quota stays terminal', () => {
  assert.equal(isCapacityError({ status: 429, message: '429 Too Many Requests' }), true);
  assert.equal(isCapacityError({ status: 429, codex_error_info: 'usage_limit_exceeded', message: "You've hit your usage limit" }), false);
});

test('capacity retry policy honors retry-after countdown and bounded attempts', () => {
  const env = {
    ORCH_CAPACITY_RETRIES: '3',
    ORCH_CAPACITY_RETRY_MS: '1000',
    ORCH_CAPACITY_RETRY_MAX_MS: '5000',
  };
  const first = capacityRetryPolicy('Selected model is at capacity; retry after 2 seconds', 1, env);
  assert.deepEqual(first, { retry: true, attempt: 1, delayMs: 2000, maxRetries: 3 });
  const capped = capacityRetryPolicy('Selected model is at capacity; 20 seconds later', 2, env);
  assert.equal(capped.retry, true);
  assert.equal(capped.delayMs, 5000);
  const exhausted = capacityRetryPolicy('Selected model is at capacity', 4, env);
  assert.equal(exhausted.retry, false);
  assert.equal(exhausted.attempt, 4);
});

test('capacity retry policy rejects unrelated errors and invalid attempts', () => {
  assert.equal(capacityRetryPolicy('invalid api key', 1, { ORCH_CAPACITY_RETRIES: '3' }).retry, false);
  assert.equal(capacityRetryPolicy('Selected model is at capacity', 0, { ORCH_CAPACITY_RETRIES: '3' }).retry, false);
});

test('account usage limits are terminal and only typed provider errors identify them', () => {
  assert.equal(isProviderQuotaError({ codex_error_info: 'usage_limit_exceeded', message: "You've hit your usage limit" }), true);
  assert.equal(isProviderQuotaError("usage_limit_exceeded"), true);
  assert.equal(isProviderQuotaError('retry after 2 seconds'), false);
  assert.ok(rolloutQuotaError(JSON.stringify({
    type: 'turn.failed',
    error: { codex_error_info: 'usage_limit_exceeded', message: "You've hit your usage limit" },
  })));
  assert.ok(rolloutQuotaError(JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      error: { codex_error_info: 'usage_limit_exceeded', message: "You've hit your usage limit" },
    },
  })), 'task_complete.error is a typed provider terminal event');
  assert.equal(rolloutQuotaError(JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ text: 'usage_limit_exceeded' }] },
  })), '');
});

test('visible-window polling marks a capacity rollout as retryable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-capacity-'));
  try {
    const rollout = path.join(dir, 'rollout.jsonl');
    const exit = path.join(dir, 'exit.json');
    fs.writeFileSync(rollout, JSON.stringify({type:'event_msg',payload:{type:'error',message:'Selected model is at capacity. Please try a different model.'}})+'\n', 'utf8');
    fs.writeFileSync(exit, JSON.stringify({ __EXIT__: 1 }), 'utf8');
    const result = await waitTaskComplete(rollout, 100, exit, '', undefined);
    assert.equal(result.done, true);
    assert.equal(result.retryable, 'capacity');
    assert.match(result.capacityError, /Selected model is at capacity/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('visible-window polling marks a typed usage-limit rollout as terminal quota', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-quota-'));
  try {
    const rollout = path.join(dir, 'rollout.jsonl');
    const exit = path.join(dir, 'exit.json');
    fs.writeFileSync(rollout, JSON.stringify({
      type: 'turn.failed',
      error: { codex_error_info: 'usage_limit_exceeded', message: "You've hit your usage limit" },
    }) + '\n', 'utf8');
    fs.writeFileSync(exit, JSON.stringify({ __EXIT__: 1 }), 'utf8');
    const result = await waitTaskComplete(rollout, 100, exit, '', undefined);
    assert.equal(result.done, true);
    assert.equal(result.retryable, 'quota');
    assert.match(result.quotaError, /usage_limit_exceeded/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session discovery performs one final ownership scan after a fast launcher exit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-session-final-scan-'));
  const previous = process.env.ORCH_SESSION_DIR;
  try {
    process.env.ORCH_SESSION_DIR = dir;
    const rollout = path.join(dir, 'rollout-final.jsonl');
    fs.writeFileSync(rollout, JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ text: '【本块唯一标识】quota-final-scan' }] },
    }) + '\n', 'utf8');
    const marker = path.join(dir, 'window.result.json');
    fs.writeFileSync(marker, '{}', 'utf8');
    const found = await waitForSessionFile('【本块唯一标识】quota-final-scan', 100, marker);
    assert.equal(found, rollout);
  } finally {
    if (previous === undefined) delete process.env.ORCH_SESSION_DIR;
    else process.env.ORCH_SESSION_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('user task text and tool output cannot impersonate a provider capacity error',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-capacity-text-'));
  try {
    const file=path.join(dir,'rollout.jsonl'),token='own-capacity-text';
    fs.writeFileSync(file,[
      {type:'turn_context',payload:{turn_id:'t1'}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{text:token+' fix Selected model is at capacity'}]}},
      {type:'response_item',payload:{type:'function_call_output',output:'server_overloaded'}},
    ].map(JSON.stringify).join('\n')+'\n');
    const waiting=await waitTaskComplete(file,1,undefined,token);
    assert.equal(waiting.retryable,undefined,'task data must never trigger a retry');
    assert.equal(waiting.done,false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

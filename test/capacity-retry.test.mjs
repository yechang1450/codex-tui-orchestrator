import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capacityRetryPolicy, isCapacityError } from '../scripts/core/orchestrate-sdk.mjs';
import { waitTaskComplete } from '../scripts/core/orchestrate-sdk.mjs';

test('capacity errors recognize the visible UI and structured overload signals', () => {
  assert.equal(isCapacityError('Selected model is at capacity. Please try a different model.'), true);
  assert.equal(isCapacityError('codex_error_info=server_overloaded'), true);
  assert.equal(isCapacityError({ error: { code: 'server_overloaded', message: 'overloaded' } }), true);
  assert.equal(isCapacityError('invalid api key'), false);
  assert.equal(isCapacityError('request rejected: malformed input'), false);
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

test('visible-window polling marks a capacity rollout as retryable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-capacity-'));
  try {
    const rollout = path.join(dir, 'rollout.jsonl');
    const exit = path.join(dir, 'exit.json');
    fs.writeFileSync(rollout, 'Selected model is at capacity. Please try a different model.\n', 'utf8');
    fs.writeFileSync(exit, JSON.stringify({ __EXIT__: 1 }), 'utf8');
    const result = await waitTaskComplete(rollout, 100, exit, '', undefined);
    assert.equal(result.done, true);
    assert.equal(result.retryable, 'capacity');
    assert.match(result.capacityError, /Selected model is at capacity/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

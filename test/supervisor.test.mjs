import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifySupervisorError,
  nextSupervisorDelay,
  createSupervisorState,
  canSupervisorRetry,
} from '../scripts/supervisor-core.mjs';
import {supervise} from '../scripts/supervise.mjs';

test('classifies transport, timeout, capacity and server errors as retryable', () => {
  for (const message of [
    'ECONNRESET while reading the response',
    'request timed out',
    'server overloaded; retry after 3 seconds',
    'HTTP 503 Service Unavailable',
    'HTTP 429 rate limit exceeded',
  ]) {
    assert.equal(classifySupervisorError(new Error(message)).retryable, true, message);
  }
});

test('does not retry user cancellation or invalid requests', () => {
  for (const message of ['aborted by user', 'HTTP 400 invalid request', 'permission denied']) {
    assert.equal(classifySupervisorError(new Error(message)).retryable, false, message);
  }
});

test('uses bounded exponential backoff and honors a retry-after hint', () => {
  assert.equal(nextSupervisorDelay(1, {baseMs: 100, maxMs: 1000}), 100);
  assert.equal(nextSupervisorDelay(2, {baseMs: 100, maxMs: 1000}), 200);
  assert.equal(nextSupervisorDelay(6, {baseMs: 100, maxMs: 1000}), 1000);
  assert.equal(nextSupervisorDelay(1, {baseMs: 100, maxMs: 1000, retryAfterMs: 750}), 750);
});

test('persists a resumable state shape and stops at the attempt limit', () => {
  const state = createSupervisorState({runId: 'r1', workspace: 'C:/work', prompt: 'continue'});
  assert.deepEqual(state, {
    version: 1,
    runId: 'r1',
    workspace: 'C:/work',
    prompt: 'continue',
    threadId: null,
    attempts: 0,
    status: 'starting',
    history: [],
  });
  assert.equal(canSupervisorRetry(state, 3), true);
  state.attempts = 3;
  assert.equal(canSupervisorRetry(state, 3), false);
});

test('resumes the same thread after a transient stream failure and persists completion', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-supervisor-'));
  const calls = [];
  const codex = {
    startThread() {
      return {id: null, async runStreamed() { this.id = 'thread-1'; throw new Error('ECONNRESET'); }};
    },
    resumeThread(id) {
      calls.push(id);
      return {id, async runStreamed() { return {events: (async function* () { yield {type: 'thread.started', thread_id: id}; yield {type: 'turn.completed'}; })()}; }};
    },
  };
  try {
    const state = await supervise({runId: 'resume-test', workspace, prompt: 'do work', maxAttempts: 2, backoffMs: 0, backoffMaxMs: 0}, {codexFactory: () => codex, sleep: async () => {}});
    assert.equal(state.status, 'completed');
    assert.equal(state.attempts, 2);
    assert.deepEqual(calls, ['thread-1']);
    const saved = JSON.parse(fs.readFileSync(path.join(workspace, 'temp', 'orchestrator', 'supervisor', 'runs', 'resume-test', 'state.json'), 'utf8'));
    assert.equal(saved.status, 'completed');
    assert.equal(saved.threadId, 'thread-1');
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('does not treat a stream that ends without turn.completed as success', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-supervisor-'));
  const codex = {
    startThread() { return {id: 'thread-1', async runStreamed() { return {events: (async function* () {})()}; }}; },
    resumeThread() { throw new Error('should not resume after a non-retryable stream end'); },
  };
  try {
    await assert.rejects(
      supervise({runId: 'incomplete-stream', workspace, prompt: 'do work', maxAttempts: 1, backoffMs: 0, backoffMaxMs: 0}, {codexFactory: () => codex, sleep: async () => {}}),
      /stream ended before turn.completed/,
    );
    const saved = JSON.parse(fs.readFileSync(path.join(workspace, 'temp', 'orchestrator', 'supervisor', 'runs', 'incomplete-stream', 'state.json'), 'utf8'));
    assert.equal(saved.status, 'failed');
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('accepts SDK event_msg envelopes and persists the thread identity', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-supervisor-envelope-'));
  const codex = {
    startThread() {
      return {id: null, async runStreamed() {
        return {events: (async function* () {
          yield {type: 'event_msg', payload: {type: 'thread.started', thread_id: 'thread-envelope'}};
          yield {type: 'event_msg', payload: {type: 'task_complete'}};
        })()};
      }};
    },
  };
  try {
    const state = await supervise({runId: 'envelope', workspace, prompt: 'do work', maxAttempts: 1, backoffMs: 0, backoffMaxMs: 0}, {codexFactory: () => codex, sleep: async () => {}});
    assert.equal(state.status, 'completed');
    assert.equal(state.threadId, 'thread-envelope');
    const saved = JSON.parse(fs.readFileSync(path.join(workspace, 'temp', 'orchestrator', 'supervisor', 'runs', 'envelope', 'state.json'), 'utf8'));
    assert.equal(saved.threadId, 'thread-envelope');
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

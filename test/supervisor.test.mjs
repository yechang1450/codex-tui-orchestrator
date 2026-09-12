import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifySupervisorError,
  nextSupervisorDelay,
  createSupervisorState,
  canSupervisorRetry,
} from '../scripts/supervisor-core.mjs';
import {supervise} from '../scripts/supervise.mjs';

const TEST_TEMP_ROOT = path.join(process.cwd(), 'temp', 'supervisor-tests');
const makeWorkspace = prefix => {
  fs.mkdirSync(TEST_TEMP_ROOT, {recursive: true});
  return fs.mkdtempSync(path.join(TEST_TEMP_ROOT, prefix));
};
after(() => fs.rmSync(TEST_TEMP_ROOT, {recursive: true, force: true}));

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
  const workspace = makeWorkspace('retry-');
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
  const workspace = makeWorkspace('incomplete-');
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
  const workspace = makeWorkspace('envelope-');
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

test('resume refuses a missing saved state before creating a run or calling Codex', async () => {
  const workspace = makeWorkspace('missing-');
  let factoryCalls = 0;
  try {
    await assert.rejects(
      supervise({runId: 'missing', workspace, resume: true, maxAttempts: 1, backoffMs: 0, backoffMaxMs: 0}, {
        codexFactory: () => { factoryCalls++; throw new Error('factory must not run'); },
      }),
      /saved supervisor state not found/i,
    );
    assert.equal(factoryCalls, 0);
    assert.equal(fs.existsSync(path.join(workspace, 'temp', 'orchestrator', 'supervisor', 'runs', 'missing')), false);
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('resume rejects damaged or mismatched state before Codex and before rewriting the file', async () => {
  const workspace = makeWorkspace('invalid-');
  const runDir = path.join(workspace, 'temp', 'orchestrator', 'supervisor', 'runs', 'resume-check');
  const file = path.join(runDir, 'state.json');
  fs.mkdirSync(runDir, {recursive: true});
  const original = JSON.stringify({
    version: 1,
    runId: 'another-run',
    workspace: path.join(workspace, 'other-workspace'),
    prompt: 'do work',
    threadId: null,
    attempts: 1,
    status: 'waiting',
    history: [{attempt: 1, startedAt: Date.now()}],
  }, null, 2);
  fs.writeFileSync(file, original, 'utf8');
  let factoryCalls = 0;
  try {
    await assert.rejects(
      supervise({runId: 'resume-check', workspace, resume: true, maxAttempts: 2, backoffMs: 0, backoffMaxMs: 0}, {
        codexFactory: () => { factoryCalls++; throw new Error('factory must not run'); },
      }),
      /invalid supervisor state|identity mismatch/i,
    );
    assert.equal(factoryCalls, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('handles terminal failure events as errors, including a failure after turn.completed', async () => {
  for (const [runId, events, expected] of [
    ['turn-failed', [{type: 'turn.failed', error: {message: 'HTTP 400 invalid request'}}], /HTTP 400/],
    ['task-failed', [{type: 'event_msg', payload: {type: 'task_failed', message: 'permanent task failure'}}], /permanent task failure/],
    ['completed-then-error', [{type: 'turn.completed'}, {type: 'error', message: 'HTTP 400 late failure'}], /late failure/],
  ]) {
    const workspace = makeWorkspace('events-');
    let resumeCalls = 0;
    const codex = {
      startThread() {
        return {id: 'thread-failure', async runStreamed() {
          return {events: (async function* () { for (const event of events) yield event; })()};
        }};
      },
      resumeThread() { resumeCalls++; throw new Error('permanent event must not retry'); },
    };
    try {
      await assert.rejects(
        supervise({runId, workspace, prompt: 'do work', maxAttempts: 3, backoffMs: 0, backoffMaxMs: 0}, {codexFactory: () => codex, sleep: async () => {}}),
        expected,
      );
      assert.equal(resumeCalls, 0);
      const saved = JSON.parse(fs.readFileSync(path.join(workspace, 'temp', 'orchestrator', 'supervisor', 'runs', runId, 'state.json'), 'utf8'));
      assert.equal(saved.status, 'failed');
      assert.match(saved.history.at(-1).error, expected);
    } finally {
      fs.rmSync(workspace, {recursive: true, force: true});
    }
  }
});

test('serializes concurrent resume controllers for one workspace and run id', async () => {
  const workspace = makeWorkspace('concurrent-');
  const runId = 'concurrent-resume';
  const file = path.join(workspace, 'temp', 'orchestrator', 'supervisor', 'runs', runId, 'state.json');
  const saved = createSupervisorState({runId, workspace, prompt: 'do work'});
  saved.status = 'waiting';
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(saved, null, 2), 'utf8');
  let enteredResolve;
  let unblockResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const unblock = new Promise(resolve => { unblockResolve = resolve; });
  const codex = {
    startThread() {
      return {id: 'thread-concurrent', async runStreamed() {
        enteredResolve();
        await unblock;
        return {events: (async function* () { yield {type: 'turn.completed'}; })()};
      }};
    },
  };
  const options = {runId, workspace, resume: true, maxAttempts: 1, backoffMs: 0, backoffMaxMs: 0};
  try {
    const first = supervise(options, {codexFactory: () => codex, sleep: async () => {}});
    await entered;
    let secondFactoryCalls = 0;
    await assert.rejects(
      supervise(options, {codexFactory: () => { secondFactoryCalls++; return codex; }, sleep: async () => {}}),
      /live controller/i,
    );
    assert.equal(secondFactoryCalls, 0);
    unblockResolve();
    assert.equal((await first).status, 'completed');
  } finally {
    unblockResolve();
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

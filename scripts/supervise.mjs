#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Codex} from '@openai/codex-sdk';
import {
  canSupervisorRetry,
  classifySupervisorError,
  continuationPrompt,
  createSupervisorState,
  nextSupervisorDelay,
} from './supervisor-core.mjs';

function usage() {
  console.error('Usage: node scripts/supervise.mjs --prompt <text> [--workspace <dir>] [--run-id <id>] [--max-attempts <n>] [--backoff-ms <n>] [--backoff-max-ms <n>] [--resume]');
}

function parseArgs(argv) {
  const out = {workspace: process.cwd(), maxAttempts: 3, backoffMs: 1000, backoffMaxMs: 30000, resume: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--resume') { out.resume = true; continue; }
    if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    const key = {'--prompt': 'prompt', '--workspace': 'workspace', '--run-id': 'runId', '--max-attempts': 'maxAttempts', '--backoff-ms': 'backoffMs', '--backoff-max-ms': 'backoffMaxMs'}[arg];
    if (!key || argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete argument: ${arg}`);
    out[key] = ['maxAttempts', 'backoffMs', 'backoffMaxMs'].includes(key) ? Number(argv[++i]) : argv[++i];
  }
  if (!out.prompt && !out.resume) throw new Error('--prompt is required unless --resume is used');
  if (![out.maxAttempts, out.backoffMs, out.backoffMaxMs].every(Number.isSafeInteger) || out.maxAttempts < 1 || out.backoffMs < 0 || out.backoffMaxMs < out.backoffMs) throw new Error('Invalid retry limits');
  out.workspace = path.resolve(out.workspace);
  out.runId ||= crypto.randomUUID();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(out.runId)) throw new Error('Invalid --run-id');
  return out;
}

function statePath(options) {
  return path.join(options.workspace, 'temp', 'orchestrator', 'supervisor', 'runs', options.runId, 'state.json');
}

function readState(file) {
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state?.version !== 1 || typeof state.runId !== 'string' || typeof state.workspace !== 'string' || typeof state.prompt !== 'string' || !Array.isArray(state.history)) throw new Error('Invalid supervisor state');
  return state;
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(temp, file);
  } finally {
    try { fs.rmSync(temp, {force: true}); } catch {}
  }
}

function emit(event, state) {
  process.stdout.write(`${JSON.stringify({event, runId: state.runId, attempt: state.attempts, threadId: state.threadId})}\n`);
}

export async function supervise(options, {codexFactory = config => new Codex(config), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  const file = statePath(options);
  let state;
  if (fs.existsSync(file)) {
    if (!options.resume) throw new Error(`Run already exists; use --resume: ${options.runId}`);
    state = readState(file);
    if (state.status === 'completed') return state;
  } else {
    state = createSupervisorState({runId: options.runId, workspace: options.workspace, prompt: options.prompt});
  }
  const codex = codexFactory({});
  let thread = state.threadId ? codex.resumeThread(state.threadId, {workingDirectory: state.workspace}) : codex.startThread({workingDirectory: state.workspace});
  while (canSupervisorRetry(state, options.maxAttempts)) {
    state.attempts++;
    state.status = 'running';
    state.history.push({attempt: state.attempts, startedAt: Date.now(), resumed: Boolean(state.threadId)});
    writeState(file, state);
    emit('attempt.started', state);
    try {
      const streamed = await thread.runStreamed(state.threadId ? continuationPrompt() : state.prompt);
      let completed = false;
      for await (const event of streamed.events) {
        // The SDK has emitted both direct events and event_msg envelopes over
        // time. Read the protocol payload before deciding whether the turn is
        // complete; otherwise a valid receipt is mistaken for a dropped
        // stream and recovery starts a new attempt with no durable identity.
        const payload = event?.payload && typeof event.payload === 'object' ? event.payload : event;
        const type = String(payload?.type || event?.type || '');
        const threadId = payload?.thread_id || payload?.threadId || event?.thread_id || event?.threadId;
        if (type === 'thread.started' && threadId) state.threadId = threadId;
        if (type === 'turn.completed' || type === 'task_complete') completed = true;
        if (thread.id) state.threadId = thread.id;
        writeState(file, state);
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }
      if (!completed) throw new Error('stream ended before turn.completed');
      state.status = 'completed';
      state.history.at(-1).endedAt = Date.now();
      writeState(file, state);
      emit('run.completed', state);
      return state;
    } catch (error) {
      if (thread.id) state.threadId = thread.id;
      const classified = classifySupervisorError(error);
      const entry = state.history.at(-1);
      Object.assign(entry, {endedAt: Date.now(), error: classified.text, retryable: classified.retryable});
      if (!classified.retryable || !canSupervisorRetry(state, options.maxAttempts)) {
        state.status = 'failed';
        writeState(file, state);
        emit('run.failed', state);
        throw error;
      }
      const delayMs = nextSupervisorDelay(state.attempts, {baseMs: options.backoffMs, maxMs: options.backoffMaxMs, retryAfterMs: classified.retryAfterMs});
      entry.retryDelayMs = delayMs;
      state.status = 'waiting';
      writeState(file, state);
      emit('attempt.retrying', state);
      await sleep(delayMs);
      thread = state.threadId ? codex.resumeThread(state.threadId, {workingDirectory: state.workspace}) : codex.startThread({workingDirectory: state.workspace});
    }
  }
  state.status = 'failed';
  writeState(file, state);
  throw new Error('Supervisor retry budget exhausted');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await supervise(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(`[supervise] ${error?.stack || error}`); process.exitCode = 1; }
}

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import './codex-entry.mjs';
import {resolveHost} from './core/host-cli.mjs';
import {networkConfig,resolveOpenAIBaseUrl,resolveProviderMode} from './core/network-policy.mjs';
import {atomicJson, claimRun, releaseRun} from './core/leases.mjs';
import {
  canSupervisorRetry,
  classifySupervisorError,
  continuationPrompt,
  createSupervisorState,
  nextSupervisorDelay,
} from './supervisor-core.mjs';

const {Codex} = await import('./sdk-dependency-check.mjs').then(() => import('@openai/codex-sdk'));

// 默认继承调用方 Codex 配置；显式中继模式保留历史上使用的兜底模型与力度。
const providerMode = resolveProviderMode();
const supervisorCodexOptions = Object.freeze(providerMode === 'openai-https'
  ? {
    codexPathOverride: resolveHost({agent:'codex'}).config.bin,
    baseUrl: resolveOpenAIBaseUrl(),
    config: networkConfig,
    model: process.env.ORCH_MODEL || 'gpt-5.3-codex-spark',
    modelReasoningEffort: process.env.ORCH_EFFORT || 'xhigh',
  }
  : {
    codexPathOverride: resolveHost({agent:'codex'}).config.bin,
    model: process.env.ORCH_MODEL,
    modelReasoningEffort: process.env.ORCH_EFFORT,
  });

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

function sameWorkspace(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function readState(file, options) {
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Invalid supervisor state: ${error.message}`); }
  const validStatus = new Set(['starting', 'running', 'waiting', 'completed', 'failed']);
  const validRunId = typeof state?.runId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(state.runId);
  const validHistory = Array.isArray(state?.history) && state.history.every((entry, index) => (
    entry && typeof entry === 'object' && entry.attempt === index + 1 && Number.isSafeInteger(entry.startedAt) && entry.startedAt > 0 &&
    (entry.endedAt === undefined || (Number.isSafeInteger(entry.endedAt) && entry.endedAt >= entry.startedAt)) &&
    (entry.error === undefined || typeof entry.error === 'string') &&
    (entry.retryable === undefined || typeof entry.retryable === 'boolean') &&
    (entry.retryDelayMs === undefined || (Number.isSafeInteger(entry.retryDelayMs) && entry.retryDelayMs >= 0))
  ));
  const valid = state?.version === 1 && validRunId && state.runId === options.runId &&
    typeof state.workspace === 'string' && sameWorkspace(state.workspace, options.workspace) &&
    typeof state.prompt === 'string' && state.prompt.trim().length > 0 &&
    (typeof state.threadId === 'string' || state.threadId === null);
  const attemptsValid = Number.isSafeInteger(state?.attempts) && state.attempts >= 0;
  if (!valid || !attemptsValid || !validStatus.has(state?.status) || !validHistory || state.history.length !== state.attempts) {
    throw new Error('Invalid supervisor state or identity mismatch');
  }
  return state;
}

function writeState(file, state) {
  atomicJson(file, state);
}

function emit(event, state) {
  process.stdout.write(`${JSON.stringify({event, runId: state.runId, attempt: state.attempts, threadId: state.threadId})}\n`);
}

export async function supervise(options, {codexFactory = config => new Codex({...supervisorCodexOptions,...config}), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  if (!options || typeof options !== 'object' || typeof options.runId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(options.runId) || typeof options.workspace !== 'string') throw new Error('Invalid supervisor options');
  options = {...options, workspace: path.resolve(options.workspace), resume: Boolean(options.resume)};
  const file = statePath(options);
  let state;
  let preexisting = fs.existsSync(file);
  if (preexisting) {
    if (!options.resume) throw new Error(`Run already exists; use --resume: ${options.runId}`);
    state = readState(file, options);
  } else if (options.resume) {
    throw new Error(`Saved supervisor state not found: ${options.runId}`);
  }
  const lockDir = path.join(options.workspace, 'temp', 'orchestrator', 'supervisor', 'locks');
  const runKey = `supervisor:${path.resolve(file).toLowerCase()}`;
  let claim;
  try {
    claim = claimRun(lockDir, runKey);
    // A contender may have written or changed the state between the initial
    // read and acquiring the kernel-backed lease. Re-read while ownership is
    // held so the Codex factory and any state write use one durable identity.
    if (preexisting) {
      state = readState(file, options);
      if (state.status === 'completed') return state;
    } else if (fs.existsSync(file)) {
      preexisting = true;
      if (!options.resume) throw new Error(`Run already exists; use --resume: ${options.runId}`);
      state = readState(file, options);
      if (state.status === 'completed') return state;
    } else {
      if (typeof options.prompt !== 'string' || options.prompt.trim().length === 0) throw new Error('--prompt is required for a new supervisor run');
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
        if (['turn.failed', 'turn_failed', 'task.failed', 'task_failed', 'error'].includes(type)) {
          const detail = payload?.message ?? payload?.error?.message ?? payload?.error ?? event?.message ?? event?.error?.message ?? event?.error;
          const message = typeof detail === 'string' ? detail : detail == null ? type : JSON.stringify(detail);
          throw new Error(message || type);
        }
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
  } finally {
    if (claim) releaseRun(lockDir, runKey, claim);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await supervise(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(`[supervise] ${error?.stack || error}`); process.exitCode = 1; }
}

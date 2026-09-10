const RETRYABLE = [
  /econnreset|econnrefused|enotfound|socket|network|transport|disconnect|broken pipe/i,
  /timed? ?out|timeout|deadline/i,
  /\b(429|500|502|503|504)\b/,
  /overload|capacity|rate limit|temporarily unavailable|server error/i,
  /stream ended|unexpected end|end of file|\beof\b/i,
];

const PERMANENT = [
  /\b(400|401|403|404|422)\b/,
  /aborted by user|cancelled|canceled|permission denied|invalid request/i,
];

function errorText(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  return [error.message, error.cause?.message, error.code, error.status]
    .filter(value => value != null)
    .join(' ');
}

function retryAfterMs(text) {
  const seconds = text.match(/retry[-_ ]?after[^\d]*(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i);
  if (seconds) return Math.ceil(Number(seconds[1]) * 1000);
  const millis = text.match(/retry[-_ ]?after[^\d]*(\d+)\s*ms\b/i);
  return millis ? Number(millis[1]) : 0;
}

export function classifySupervisorError(error) {
  const text = errorText(error);
  if (PERMANENT.some(pattern => pattern.test(text))) return {retryable: false, text};
  return {
    retryable: RETRYABLE.some(pattern => pattern.test(text)),
    retryAfterMs: retryAfterMs(text),
    text,
  };
}

export function nextSupervisorDelay(attempt, {baseMs = 1000, maxMs = 30000, retryAfterMs = 0} = {}) {
  const n = Math.max(1, Number(attempt) || 1);
  const exponential = Math.min(Math.max(0, Number(maxMs) || 0), Math.max(0, Number(baseMs) || 0) * 2 ** (n - 1));
  return Math.min(Math.max(0, Number(maxMs) || 0), Math.max(exponential, Number(retryAfterMs) || 0));
}

export function createSupervisorState({runId, workspace, prompt}) {
  return {
    version: 1,
    runId,
    workspace,
    prompt,
    threadId: null,
    attempts: 0,
    status: 'starting',
    history: [],
  };
}

export function canSupervisorRetry(state, maxAttempts) {
  return Number.isSafeInteger(Number(maxAttempts)) && Number(maxAttempts) > 0 && state.attempts < Number(maxAttempts);
}

export function continuationPrompt() {
  return [
    'The previous attempt was interrupted unexpectedly.',
    'Resume the original task from the current workspace and inspect the existing state first.',
    'Do not repeat completed side effects; verify their result before retrying any operation.',
    'Continue only the remaining work and report any state that cannot be proven safe to repeat.',
  ].join(' ');
}

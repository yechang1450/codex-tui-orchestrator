// Retry policy shared by planner and visible-window execution.
// Capacity failures are safe to retry only before a task checkpoint is written.
function errorText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.message}\n${value.stack || ""}`;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Return true only for provider capacity/overload responses. */
export function isCapacityError(value) {
  const text = errorText(value).toLowerCase();
  return /selected\s+model\s+is\s+at\s+capacity|model\s+is\s+at\s+capacity|try\s+a\s+different\s+model|server[_ -]?overloaded|service\s+(?:is\s+)?overloaded|temporarily\s+overloaded|capacity[_ -]?exceeded/.test(text);
}

function retryAfterMs(value) {
  const text = errorText(value);
  const patterns = [
    /(?:retry[-_ ]?after|retry_after|retryAfter)\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i,
    /(?:retry|重试)[^\d]{0,24}(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s|秒)/i,
    /(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s|秒)[^\n]{0,24}(?:retry|重试)/i,
    /(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s|秒)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return Math.max(0, Math.round(Number(m[1]) * 1000));
  }
  return null;
}

/**
 * Decide whether a capacity error may be retried.
 * `attempt` is one-based; `env` is injectable for deterministic tests.
 */
export function capacityRetryPolicy(error, attempt = 1, env = process.env) {
  const n = Number(attempt);
  const maxRetries = Math.max(0, Number(env?.ORCH_CAPACITY_RETRIES ?? 3) || 0);
  if (!isCapacityError(error) || !Number.isInteger(n) || n < 1 || n > maxRetries) return { retry: false, attempt: n, maxRetries, delayMs: 0 };
  const base = Math.max(0, Number(env?.ORCH_CAPACITY_RETRY_MS ?? 120000) || 0);
  const cap = Math.max(base, Number(env?.ORCH_CAPACITY_RETRY_MAX_MS ?? 600000) || 0);
  const hinted = retryAfterMs(error);
  const delayMs = Math.min(cap, hinted == null ? base * (2 ** (n - 1)) : hinted);
  return { retry: true, attempt: n, maxRetries, delayMs };
}

export function capacityErrorText(value) {
  return isCapacityError(value) ? errorText(value) : "";
}

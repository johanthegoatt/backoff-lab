// retryFetch: fetch with the rules from the rest of this repo applied.
//
// - Only retries what is safe to repeat. RFC 9110 9.2.2 lists GET, HEAD,
//   OPTIONS, TRACE, PUT and DELETE as idempotent; anything else is retried
//   only when it carries an Idempotency-Key (see idempotency-lab).
// - Retries network errors and 408, 429, 500, 502, 503, 504.
// - Honours Retry-After (RFC 9110 10.2.3), in seconds or as an HTTP-date,
//   and never waits less than the server asked. A Retry-After longer than
//   `maxRetryAfterMs` ends the loop and hands back that response instead of
//   parking the caller for an hour.
// - Draws delays from a jittered backoff, spends from an optional retry
//   budget, and refuses outright while an optional circuit breaker is open.

import { createBackoff } from "./backoff.js";

export const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "TRACE", "PUT", "DELETE"]);
export const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class CircuitOpenError extends Error {
  constructor() { super("circuit open"); this.name = "CircuitOpenError"; }
}

// Returns milliseconds to wait, or null when the header is absent or
// unparseable. Negative waits (a date in the past) become 0.
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const v = String(value).trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  // An HTTP-date always names a weekday or month. Without this check,
  // Date.parse("-5") happily returns a timestamp in the year -5.
  if (!/[a-z]{3}/i.test(v)) return null;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

export function isRetrySafe(method = "GET", headers) {
  if (IDEMPOTENT.has(method.toUpperCase())) return true;
  return new Headers(headers).has("idempotency-key");
}

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const id = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(id); reject(signal.reason); }, { once: true });
});

export async function retryFetch(input, init = {}, {
  fetch: doFetch = globalThis.fetch,
  maxAttempts = 3,
  strategy = "full", base = 100, cap = 10_000, random = Math.random,
  maxRetryAfterMs = cap,
  budget = null, breaker = null,
  now = () => Date.now(), sleep = defaultSleep,
  onRetry = () => {},
} = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const safe = isRetrySafe(method, init.headers);
  const backoff = createBackoff(strategy, { base, cap, random });
  const signal = init.signal;

  budget?.recordRequest(now());

  for (let attempt = 1; ; attempt++) {
    if (breaker && !breaker.allow(now())) throw new CircuitOpenError();

    let res, err;
    try {
      res = await doFetch(input, init);
    } catch (e) {
      if (e?.name === "AbortError" || signal?.aborted) throw e;
      err = e;
    }

    const retryable = err !== undefined || RETRYABLE_STATUS.has(res.status);
    if (breaker) {
      // 429 is the server pacing this client, not the server failing.
      if (err !== undefined || res.status >= 500) breaker.failure(now());
      else breaker.success();
    }
    if (!retryable) return res;

    let wait = backoff(attempt - 1);
    const asked = res ? parseRetryAfter(res.headers.get("retry-after"), now()) : null;
    const give = (reason) => {
      if (err !== undefined) throw err;
      res.retryGaveUp = reason;
      return res;
    };

    if (!safe) return give("not idempotent");
    if (attempt >= maxAttempts) return give("attempts exhausted");
    if (asked !== null) {
      if (asked > maxRetryAfterMs) return give("retry-after too long");
      wait = Math.max(wait, asked);
    }
    if (budget && !budget.tryRetry(now())) return give("retry budget spent");

    // Drain the body so the connection can be reused.
    await res?.body?.cancel?.().catch(() => {});
    onRetry({ attempt, wait, status: res?.status ?? null, error: err ?? null });
    await sleep(wait, signal);
  }
}

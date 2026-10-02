// A retry storm, small enough to read.
//
// A server works through a FIFO queue at a fixed capacity. Clients give up
// on a request after `timeoutMs`, but the server has no idea and still
// spends capacity on it when it reaches the front. A short capacity dip
// (the trigger) grows the queue past the timeout; from then on the server
// is busy answering requests nobody is waiting for, the timeouts produce
// retries, the retries keep the queue long, and the system stays broken
// after the trigger is gone. Bronson et al. named this a metastable failure
// ("Metastable Failures in Distributed Systems", HotOS 2021), and Huang et
// al. found retries driving it in real outages at AWS, Google Cloud and
// Azure ("Metastable Failures in the Wild", OSDI 2022). Retry policy decides
// whether the sustaining loop can close.
//
// Time advances in fixed ticks; arrivals are Poisson; every random draw
// comes from one seeded generator.

import { createBackoff, rng } from "./backoff.js";
import { createRetryBudget } from "./budget.js";

export const POLICIES = {
  none: { label: "No retries", maxAttempts: 1, budget: false },
  unbounded: { label: "Retry up to 10x", maxAttempts: 10, budget: false },
  three: { label: "3 attempts", maxAttempts: 3, budget: false },
  budget: { label: "3 attempts + 10% budget", maxAttempts: 3, budget: true },
};

function poisson(random, lambda) {
  // Knuth's method; fine for the per-tick means used here (< 30).
  const limit = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= random(); } while (p > limit);
  return k - 1;
}

export function simulateOverload({
  policy = "budget", seed = 1,
  durationMs = 30_000, tickMs = 10, bucketMs = 250,
  rate = 700, capacity = 1000,
  dipStart = 5_000, dipEnd = 8_000, dipCapacity = 200,
  timeoutMs = 1_000, strategy = "full", base = 100, cap = 2_000,
} = {}) {
  const p = POLICIES[policy];
  if (!p) throw new RangeError(`unknown policy "${policy}"`);
  const random = rng(seed);
  const backoff = createBackoff(strategy, { base, cap, random });
  const budget = p.budget ? createRetryBudget({ ratio: 0.1 }) : null;

  const ticks = Math.ceil(durationMs / tickMs);
  const perBucket = bucketMs / tickMs;
  const queue = [];
  let qHead = 0;
  const retriesAt = new Map(); // tick -> attempts to send
  const timeoutsAt = new Map(); // tick -> attempts to check
  const push = (m, k, v) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

  let credit = 0;
  const totals = { fresh: 0, sent: 0, served: 0, wasted: 0, succeeded: 0, failed: 0 };
  const timeline = [];
  let bucket = null;

  const send = (t, req) => {
    const attempt = { req, sentAt: t, done: false };
    queue.push(attempt);
    totals.sent++;
    bucket.sent++;
    push(timeoutsAt, Math.floor((t + timeoutMs) / tickMs), attempt);
  };

  for (let i = 0; i < ticks; i++) {
    const t = i * tickMs;
    if (i % perBucket === 0) {
      bucket = { t, sent: 0, good: 0, fresh: 0, queue: 0 };
      timeline.push(bucket);
    }

    const cap = t >= dipStart && t < dipEnd ? dipCapacity : capacity;
    credit = Math.min(credit + (cap * tickMs) / 1000, Math.max(1, (cap * tickMs) / 1000));

    const fresh = poisson(random, (rate * tickMs) / 1000);
    for (let k = 0; k < fresh; k++) {
      const req = { born: t, attempts: 1 };
      totals.fresh++;
      bucket.fresh++;
      budget?.recordRequest(t);
      send(t, req);
    }
    for (const req of retriesAt.get(i) ?? []) send(t, req);
    retriesAt.delete(i);

    while (credit >= 1 && qHead < queue.length) {
      const a = queue[qHead++];
      credit--;
      totals.served++;
      if (a.req.finished || t - a.sentAt > timeoutMs) {
        totals.wasted++;
        continue;
      }
      a.done = true;
      a.req.finished = true;
      totals.succeeded++;
      bucket.good++;
    }
    if (qHead > 4096 && qHead * 2 > queue.length) { queue.splice(0, qHead); qHead = 0; }

    for (const a of timeoutsAt.get(i) ?? []) {
      if (a.done || a.req.finished) continue;
      const req = a.req;
      const allowed = req.attempts < p.maxAttempts && (!budget || budget.tryRetry(t));
      if (!allowed) {
        req.finished = true;
        totals.failed++;
        continue;
      }
      const wait = backoff(req.attempts - 1);
      req.attempts++;
      push(retriesAt, Math.max(i + 1, Math.floor((t + wait) / tickMs)), req);
    }
    timeoutsAt.delete(i);

    bucket.queue = Math.max(bucket.queue, queue.length - qHead);
  }

  // Recovered means the last five seconds look like the first five: nearly
  // every fresh request is answered in time.
  const tail = timeline.filter((b) => b.t >= durationMs - 5_000);
  const tailFresh = tail.reduce((s, b) => s + b.fresh, 0);
  const tailGood = tail.reduce((s, b) => s + b.good, 0);
  const recovered = tailFresh > 0 && tailGood >= tailFresh * 0.9;
  const after = timeline.find((b) => b.t >= dipEnd && b.good >= b.fresh * 0.9 && b.queue < (capacity * timeoutMs) / 1000 / 2);

  return {
    policy, label: p.label, recovered,
    recoveredAfterMs: recovered && after ? after.t - dipEnd : null,
    amplification: totals.sent / Math.max(1, totals.fresh),
    wastedShare: totals.wasted / Math.max(1, totals.served),
    totals, timeline, capacity, rate, dipStart, dipEnd,
  };
}

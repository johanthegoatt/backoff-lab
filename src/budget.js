// Two ways to stop a client from making an outage worse.
//
// Retry budget, from Google's SRE book, chapter 22 "Addressing Cascading
// Failures" and chapter 21 "Handling Overload": cap retries per request at
// three attempts, and only retry while retries are under 10% of the requests
// this client sent recently. Three attempts alone can still push load to
// nearly 3x during an outage; the ratio holds it near 1.1x.
//
// Circuit breaker, as described by Michael Nygard in "Release It!" and
// Martin Fowler's CircuitBreaker bliki: after enough consecutive failures,
// stop calling for a cool-down, then let a single probe decide whether to
// close again.
//
// Both take `now` as an argument so simulations and tests drive the clock.

export function createRetryBudget({ ratio = 0.1, minPerSecond = 10, windowMs = 10_000, buckets = 10 } = {}) {
  const span = windowMs / buckets;
  const requests = new Array(buckets).fill(0);
  const retries = new Array(buckets).fill(0);
  let head = 0;
  let headStart = null;

  // Rotate the ring forward to `now`, zeroing every bucket we skip over.
  function advance(now) {
    if (headStart === null) {
      headStart = now - (now % span);
      return;
    }
    let steps = Math.floor((now - headStart) / span);
    if (steps <= 0) return;
    if (steps > buckets) steps = buckets;
    for (let i = 0; i < steps; i++) {
      head = (head + 1) % buckets;
      requests[head] = 0;
      retries[head] = 0;
    }
    headStart = now - (now % span);
  }

  const sum = (xs) => xs.reduce((a, b) => a + b, 0);

  return {
    // A first attempt. Always allowed; it is what the budget is measured against.
    recordRequest(now) {
      advance(now);
      requests[head]++;
    },
    // Asks to spend one retry. The floor of `minPerSecond` keeps a quiet
    // client, which sends too few requests for a ratio to mean anything,
    // from being refused its first retry.
    tryRetry(now) {
      advance(now);
      const allowance = Math.max(sum(requests) * ratio, (minPerSecond * windowMs) / 1000 * ratio);
      if (sum(retries) + 1 > allowance) return false;
      retries[head]++;
      return true;
    },
    stats(now) {
      advance(now);
      return { requests: sum(requests), retries: sum(retries) };
    },
  };
}

export function createCircuitBreaker({ failureThreshold = 5, resetMs = 5_000 } = {}) {
  let state = "closed";
  let failures = 0;
  let openedAt = 0;
  let probing = false;

  return {
    get state() { return state; },
    // Whether a call may go out at `now`. In half-open exactly one probe is
    // let through; everyone else is refused until it reports back.
    allow(now) {
      if (state === "open" && now - openedAt >= resetMs) {
        state = "half-open";
        probing = false;
      }
      if (state === "closed") return true;
      if (state === "half-open" && !probing) {
        probing = true;
        return true;
      }
      return false;
    },
    // The caller gave up on a call without learning anything (it aborted).
    // Hands the half-open probe slot back; otherwise nothing ever reports
    // and the breaker refuses every call from then on.
    release() {
      probing = false;
    },
    success() {
      state = "closed";
      failures = 0;
      probing = false;
    },
    failure(now) {
      failures++;
      if (state === "half-open" || failures >= failureThreshold) {
        state = "open";
        openedAt = now;
        probing = false;
      }
    },
  };
}

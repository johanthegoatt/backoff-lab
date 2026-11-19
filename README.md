# backoff-lab

Retry policy, measured. Jittered backoff, an SRE-style retry budget and a circuit breaker, plus two seeded simulations that show what each one does to a contended database row and to an overloaded server.

**Live:** https://backoff-lab.johanthegoat.xyz

Zero dependencies. Node 20+. `npm test` covers every module, including `retryFetch` against a real `node:http` server.

## What is in it

| File | What it does |
| --- | --- |
| `src/backoff.js` | Constant, capped exponential, full, equal and decorrelated jitter, written from the formulas in Brooker's article. A seeded mulberry32 generator so runs repeat exactly. |
| `src/budget.js` | A retry budget (retries allowed while under 10% of recent requests, over a ten-bucket sliding window) and a closed / open / half-open circuit breaker. Both take `now` so tests and simulations drive the clock. |
| `src/contention.js` | Discrete-event simulation of N clients doing optimistic-concurrency writes to one row, with 10ms ± 2ms network hops. |
| `src/overload.js` | A FIFO server with fixed capacity, Poisson arrivals, client timeouts and a capacity dip. Reproduces a metastable retry storm. |
| `src/retry.js` | `retryFetch`: `fetch` with all of the above applied. |
| `index.html` | The lab page. Runs both simulations in the tab. |

## Results the tests pin

**Contention, 100 clients, mean of 20 seeds**

| Schedule | Calls | Time to commit all |
| --- | --- | --- |
| Constant (5ms) | 2,897 | 1.1s |
| Exponential, no jitter | 2,584 | 38s |
| Full jitter | 1,490 | 3.2s |
| Equal jitter | 1,532 | 4.6s |
| Decorrelated jitter | 1,545 | 2.5s |

Exponential backoff without jitter spaces retries out but keeps the colliding clients in lockstep, so every wave collides again. Full jitter does about 42% less work and finishes more than ten times sooner. Reads and writes both count as calls.

**Overload, 700 req/s against 1,000 req/s capacity, capacity at 20% for 3s**

| Policy | Load amplification | Recovered |
| --- | --- | --- |
| No retries | 1.00x | yes, ~3.5s after the dip |
| Retry up to 10x | 6.26x | never |
| 3 attempts | 2.54x | never |
| 3 attempts + 10% budget | 1.03x | yes, ~6s after the dip |

The dip grows the queue past the client timeout. From then on the server spends 85% of its capacity on requests whose clients already gave up, the timeouts produce retries, and the retries keep the queue long. Removing the trigger does not fix it. The SRE book's numbers hold: three attempts push load to just under 3x, and the per-client 10% ratio holds it near 1.1x.

## Picking a schedule without running one

`moments(strategy, attempt, { base, cap })` gives the expected delay and its
spread for a single attempt on paper, so you can compare schedules before
simulating. The jittered schedules draw uniformly, so these are the textbook
moments of a uniform range (`c = min(cap, base * 2^attempt)`):

| Schedule | Mean | Variance |
| --- | --- | --- |
| Constant | `base` | 0 |
| Exponential | `c` | 0 |
| Full jitter | `c / 2` | `c² / 12` |
| Equal jitter | `3c / 4` | `c² / 48` |

Full jitter has the lower mean but the wider spread; equal jitter keeps a floor
of `c/2` so it never retries instantly but clusters less tightly. Decorrelated
jitter depends on the previous sleep rather than the attempt number, so it has
no per-attempt closed form and returns `null`. A test checks the formulas
against a 200k-draw seeded Monte Carlo run.

## retryFetch

```js
import { retryFetch } from "./src/retry.js";
import { createRetryBudget, createCircuitBreaker } from "./src/budget.js";

const budget = createRetryBudget({ ratio: 0.1 });
const breaker = createCircuitBreaker({ failureThreshold: 5, resetMs: 5000 });

const res = await retryFetch("https://api.example.com/orders/42", {}, {
  strategy: "full", base: 100, cap: 10_000, maxAttempts: 3, budget, breaker,
});
```

Decisions it makes, in order:

1. Refuse with `CircuitOpenError` if the breaker is open. No network call.
2. Network errors and 408, 429, 500, 502, 503, 504 are retryable. Anything else returns as is.
3. Only GET, HEAD, OPTIONS, TRACE, PUT and DELETE are retried (RFC 9110 9.2.2), or any request carrying an `Idempotency-Key`. Method and headers come from the `Request` when one is passed, and each attempt sends a fresh clone of it; a `ReadableStream` body is never retried. A POST without one returns its 503 rather than risk a second charge.
4. `Retry-After` in seconds or as an HTTP-date sets a floor on the wait (RFC 9110 10.2.3). One longer than `maxRetryAfterMs` ends the loop.
5. Each retry spends from the budget; an empty budget ends the loop.
6. 429 does not count against the breaker, because it is the server pacing this client rather than failing.
7. `attemptTimeoutMs` aborts an attempt that has not produced response headers in time and retries it as a `TimeoutError`. `deadlineMs` ends the loop before any wait that would finish past the overall deadline. The caller's own `signal` always wins and is never retried.

When it gives up on a response, `res.retryGaveUp` says why. Discarded bodies are cancelled so the connection can be reused.

## Run it

```sh
npm test
npx serve .        # or any static server, then open index.html
```

## Sources

- Marc Brooker, [Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/), AWS Architecture Blog, 2015
- Google, [Site Reliability Engineering, ch. 21: Handling Overload](https://sre.google/sre-book/handling-overload/)
- Bronson, Aghayev, Charapko, Zhu, Metastable Failures in Distributed Systems, HotOS 2021
- Huang et al., [Metastable Failures in the Wild](https://www.usenix.org/conference/osdi22/presentation/huang-lexiang), OSDI 2022
- [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110), HTTP Semantics, sections 9.2.2 and 10.2.3
- Martin Fowler, [CircuitBreaker](https://martinfowler.com/bliki/CircuitBreaker.html)

Related: [idempotency-lab](https://github.com/johanthegoatt/idempotency-lab) makes POST retries safe, [ratelimit-lab](https://github.com/johanthegoatt/ratelimit-lab) is the server side of 429.

MIT licensed.

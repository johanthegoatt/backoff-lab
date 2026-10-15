import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitOpenError, isRetrySafe, parseRetryAfter, retryFetch } from "../src/retry.js";
import { createCircuitBreaker, createRetryBudget } from "../src/budget.js";

// A scripted fetch: each call takes the next entry. A number is a status,
// an Error is thrown, an object is [status, headers].
function scripted(...steps) {
  const calls = [];
  const fetch = async (input, init) => {
    calls.push(init?.method ?? "GET");
    const s = steps.shift();
    if (s instanceof Error) throw s;
    const [status, headers] = Array.isArray(s) ? s : [s, {}];
    return new Response(status === 204 ? null : "x", { status, headers });
  };
  return { fetch, calls };
}

const fast = (extra = {}) => {
  const waits = [];
  return { waits, opts: { sleep: async (ms) => { waits.push(ms); }, random: () => 0.5, ...extra } };
};

test("parseRetryAfter reads seconds and HTTP-dates", () => {
  const now = Date.parse("Fri, 02 Oct 2026 03:00:00 GMT");
  assert.equal(parseRetryAfter("120", now), 120_000);
  assert.equal(parseRetryAfter("Fri, 02 Oct 2026 03:00:30 GMT", now), 30_000);
  assert.equal(parseRetryAfter("Fri, 02 Oct 2026 02:00:00 GMT", now), 0);
  assert.equal(parseRetryAfter("soon", now), null);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter("-5", now), null);
});

test("idempotent methods and keyed requests are safe to retry", () => {
  for (const m of ["GET", "head", "PUT", "DELETE", "OPTIONS"]) assert.ok(isRetrySafe(m), m);
  assert.equal(isRetrySafe("POST"), false);
  assert.equal(isRetrySafe("PATCH", { "Content-Type": "x" }), false);
  assert.ok(isRetrySafe("POST", { "Idempotency-Key": '"k1"' }));
});

test("retries a 503 then returns the success", async () => {
  const { fetch, calls } = scripted(503, 503, 200);
  const { waits, opts } = fast({ base: 100 });
  const res = await retryFetch("http://x/", {}, { fetch, ...opts });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [50, 100]); // full jitter at random=0.5
});

test("does not retry a 404 or a 400", async () => {
  for (const status of [400, 404]) {
    const { fetch, calls } = scripted(status, 200);
    const res = await retryFetch("http://x/", {}, { fetch, ...fast().opts });
    assert.equal(res.status, status);
    assert.equal(calls.length, 1);
  }
});

test("a POST without a key is never retried, with a key it is", async () => {
  const plain = scripted(503, 200);
  const r1 = await retryFetch("http://x/", { method: "POST" }, { fetch: plain.fetch, ...fast().opts });
  assert.equal(r1.status, 503);
  assert.equal(r1.retryGaveUp, "not idempotent");
  assert.equal(plain.calls.length, 1);

  const keyed = scripted(503, 201);
  const r2 = await retryFetch("http://x/", { method: "POST", headers: { "Idempotency-Key": '"a"' } },
    { fetch: keyed.fetch, ...fast().opts });
  assert.equal(r2.status, 201);
});

test("network errors are retried and rethrown when attempts run out", async () => {
  const boom = new TypeError("fetch failed");
  const { fetch, calls } = scripted(boom, boom, boom);
  await assert.rejects(retryFetch("http://x/", {}, { fetch, maxAttempts: 3, ...fast().opts }), boom);
  assert.equal(calls.length, 3);
});

test("Retry-After raises the wait, and too long a Retry-After ends the loop", async () => {
  const a = scripted([429, { "retry-after": "3" }], 200);
  const { waits, opts } = fast({ base: 100 });
  await retryFetch("http://x/", {}, { fetch: a.fetch, ...opts });
  assert.deepEqual(waits, [3000]);

  const b = scripted([503, { "retry-after": "3600" }], 200);
  const res = await retryFetch("http://x/", {}, { fetch: b.fetch, maxRetryAfterMs: 10_000, ...fast().opts });
  assert.equal(res.status, 503);
  assert.equal(res.retryGaveUp, "retry-after too long");
  assert.equal(b.calls.length, 1);
});

test("a spent retry budget stops retrying", async () => {
  let t = 0;
  const budget = createRetryBudget({ ratio: 0.1, minPerSecond: 0 });
  // 10 first attempts so far -> one retry allowed in the window
  for (let i = 0; i < 9; i++) budget.recordRequest(t);
  const { fetch, calls } = scripted(503, 503, 503, 200);
  const res = await retryFetch("http://x/", {}, { fetch, budget, now: () => t, maxAttempts: 5, ...fast().opts });
  assert.equal(res.status, 503);
  assert.equal(res.retryGaveUp, "retry budget spent");
  assert.equal(calls.length, 2);
});

test("an open breaker refuses without calling the network", async () => {
  const breaker = createCircuitBreaker({ failureThreshold: 2, resetMs: 1000 });
  const { fetch, calls } = scripted(500, 500, 200);
  const res = await retryFetch("http://x/", {}, { fetch, breaker, now: () => 0, maxAttempts: 2, ...fast().opts });
  assert.equal(res.status, 500);
  assert.equal(breaker.state, "open");
  await assert.rejects(retryFetch("http://x/", {}, { fetch, breaker, now: () => 10, ...fast().opts }), CircuitOpenError);
  assert.equal(calls.length, 2);
});

test("429 does not trip the breaker", async () => {
  const breaker = createCircuitBreaker({ failureThreshold: 1 });
  const { fetch } = scripted(429, 200);
  await retryFetch("http://x/", {}, { fetch, breaker, now: () => 0, ...fast().opts });
  assert.equal(breaker.state, "closed");
});

test("aborting stops a pending wait", async () => {
  const ac = new AbortController();
  const { fetch } = scripted(503, 200);
  const p = retryFetch("http://x/", { signal: ac.signal }, { fetch, base: 60_000, cap: 60_000, random: () => 1 });
  setTimeout(() => ac.abort(new Error("cancelled")), 20);
  await assert.rejects(p, /cancelled/);
});

test("works against a real server over sockets", async () => {
  const { createServer } = await import("node:http");
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (hits < 3) { res.writeHead(503, { "retry-after": "0" }).end("busy"); return; }
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const res = await retryFetch(url, {}, { base: 5, cap: 20 });
    assert.equal(await res.text(), "ok");
    assert.equal(hits, 3);
  } finally {
    server.close();
  }
});

test("a POST Request object is not retried even with no init", async () => {
  const { fetch, calls } = scripted(503, 200);
  const res = await retryFetch(new Request("http://x/", { method: "POST", body: "pay" }), undefined, { fetch, ...fast().opts });
  assert.equal(res.status, 503);
  assert.equal(res.retryGaveUp, "not idempotent");
  assert.equal(calls.length, 1);
});

test("a Request's Idempotency-Key header makes it retryable", async () => {
  const { fetch, calls } = scripted(503, 200);
  const req = new Request("http://x/", { method: "POST", body: "pay", headers: { "Idempotency-Key": "k1" } });
  const res = await retryFetch(req, undefined, { fetch, ...fast().opts });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});

test("every attempt gets a fresh copy of a Request body", async () => {
  const bodies = [];
  const fetch = async (input) => {
    bodies.push(await input.text());
    return new Response("x", { status: bodies.length < 3 ? 503 : 200 });
  };
  const req = new Request("http://x/", { method: "PUT", body: "same body" });
  const res = await retryFetch(req, undefined, { fetch, ...fast().opts });
  assert.equal(res.status, 200);
  assert.deepEqual(bodies, ["same body", "same body", "same body"]);
});

test("a stream body is sent once, since it cannot be replayed", async () => {
  const { fetch, calls } = scripted(503, 200);
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x")); c.close(); } });
  const res = await retryFetch("http://x/", { method: "PUT", body, duplex: "half" }, { fetch, ...fast().opts });
  assert.equal(res.retryGaveUp, "body not replayable");
  assert.equal(calls.length, 1);
});

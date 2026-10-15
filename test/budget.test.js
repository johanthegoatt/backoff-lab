import { test } from "node:test";
import assert from "node:assert/strict";
import { createCircuitBreaker, createRetryBudget } from "../src/budget.js";

test("retry budget allows about 10% of recent requests as retries", () => {
  const budget = createRetryBudget({ ratio: 0.1, minPerSecond: 0 });
  for (let i = 0; i < 500; i++) budget.recordRequest(1000 + i);
  let granted = 0;
  for (let i = 0; i < 200; i++) if (budget.tryRetry(1600)) granted++;
  assert.equal(granted, 50);
});

test("retry budget floor lets a quiet client retry at all", () => {
  const budget = createRetryBudget({ ratio: 0.1, minPerSecond: 10, windowMs: 10_000 });
  budget.recordRequest(5);
  // floor: 10/s over 10s at 10% -> 10 retries
  let granted = 0;
  for (let i = 0; i < 30; i++) if (budget.tryRetry(6)) granted++;
  assert.equal(granted, 10);
});

test("retry budget forgets traffic older than its window", () => {
  const budget = createRetryBudget({ ratio: 0.1, minPerSecond: 0, windowMs: 10_000, buckets: 10 });
  for (let i = 0; i < 100; i++) budget.recordRequest(1000);
  assert.ok(budget.tryRetry(1000));
  assert.deepEqual(budget.stats(5000), { requests: 100, retries: 1 });
  assert.deepEqual(budget.stats(30_000), { requests: 0, retries: 0 });
  assert.equal(budget.tryRetry(30_000), false);
});

test("breaker opens after consecutive failures and refuses calls", () => {
  const cb = createCircuitBreaker({ failureThreshold: 3, resetMs: 1000 });
  for (let i = 0; i < 2; i++) { assert.ok(cb.allow(0)); cb.failure(0); }
  assert.equal(cb.state, "closed");
  cb.failure(10);
  assert.equal(cb.state, "open");
  assert.equal(cb.allow(500), false);
});

test("a success resets the failure count", () => {
  const cb = createCircuitBreaker({ failureThreshold: 3 });
  cb.failure(0); cb.failure(0); cb.success(); cb.failure(0); cb.failure(0);
  assert.equal(cb.state, "closed");
});

test("half-open lets exactly one probe through", () => {
  const cb = createCircuitBreaker({ failureThreshold: 1, resetMs: 1000 });
  cb.failure(0);
  assert.equal(cb.allow(999), false);
  assert.equal(cb.allow(1000), true);
  assert.equal(cb.state, "half-open");
  assert.equal(cb.allow(1001), false);
  cb.success();
  assert.equal(cb.state, "closed");
  assert.equal(cb.allow(1002), true);
});

test("a failed probe reopens for a fresh cool-down", () => {
  const cb = createCircuitBreaker({ failureThreshold: 1, resetMs: 1000 });
  cb.failure(0);
  assert.ok(cb.allow(1000));
  cb.failure(1000);
  assert.equal(cb.state, "open");
  assert.equal(cb.allow(1999), false);
  assert.equal(cb.allow(2000), true);
});

test("release hands the half-open probe slot back", () => {
  const breaker = createCircuitBreaker({ failureThreshold: 1, resetMs: 10 });
  breaker.failure(0);
  assert.equal(breaker.allow(20), true);
  assert.equal(breaker.allow(20), false);
  breaker.release();
  assert.equal(breaker.allow(20), true);
  assert.equal(breaker.state, "half-open");
});

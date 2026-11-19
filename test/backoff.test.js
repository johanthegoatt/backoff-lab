import { test } from "node:test";
import assert from "node:assert/strict";
import { createBackoff, rng, STRATEGIES, moments } from "../src/backoff.js";

test("rng is deterministic per seed and stays in [0, 1)", () => {
  const a = rng(42), b = rng(42), c = rng(43);
  const xs = Array.from({ length: 1000 }, a);
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, b));
  assert.notEqual(xs[0], c());
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test("constant and exponential ignore randomness", () => {
  const never = () => assert.fail("should not draw");
  const constant = createBackoff("constant", { base: 50, random: never });
  const exp = createBackoff("exponential", { base: 100, cap: 1000, random: never });
  assert.deepEqual([0, 1, 2, 9].map(constant), [50, 50, 50, 50]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(exp), [100, 200, 400, 800, 1000, 1000]);
});

test("full jitter spans zero to the exponential ceiling", () => {
  const lo = createBackoff("full", { base: 100, cap: 1000, random: () => 0 });
  const hi = createBackoff("full", { base: 100, cap: 1000, random: () => 0.999999 });
  assert.equal(lo(3), 0);
  assert.ok(Math.abs(hi(3) - 800) < 0.01);
  assert.ok(hi(20) <= 1000);
});

test("equal jitter keeps at least half the ceiling", () => {
  const lo = createBackoff("equal", { base: 100, cap: 1000, random: () => 0 });
  const mid = createBackoff("equal", { base: 100, cap: 1000, random: () => 0.5 });
  assert.equal(lo(2), 200);
  assert.equal(mid(2), 300);
  assert.equal(lo(10), 500);
});

test("decorrelated jitter grows from the previous sleep and respects the cap", () => {
  const top = createBackoff("decorrelated", { base: 100, cap: 2000, random: () => 0.999999 });
  const seq = [0, 1, 2, 3, 4].map(() => Math.round(top()));
  assert.deepEqual(seq, [300, 900, 2000, 2000, 2000]);
  const bottom = createBackoff("decorrelated", { base: 100, cap: 2000, random: () => 0 });
  assert.equal(bottom(), 100);
});

test("every strategy stays inside [0, cap] over long runs", () => {
  for (const s of STRATEGIES) {
    const next = createBackoff(s, { base: 10, cap: 500, random: rng(7) });
    for (let i = 0; i < 2000; i++) {
      const d = next(i);
      assert.ok(Number.isFinite(d) && d >= 0 && d <= 500, `${s} attempt ${i} gave ${d}`);
    }
  }
});

test("bad configuration is rejected", () => {
  assert.throws(() => createBackoff("linear"), RangeError);
  assert.throws(() => createBackoff("full", { base: 0 }), RangeError);
  assert.throws(() => createBackoff("full", { base: 100, cap: 10 }), RangeError);
});

test("moments give exact mean and variance for the drawless schedules", () => {
  assert.deepEqual(moments("constant", 3, { base: 50 }), { mean: 50, variance: 0, stddev: 0 });
  // attempt 2 -> ceiling = 100 * 2^2 = 400 (under the cap)
  assert.deepEqual(moments("exponential", 2, { base: 100, cap: 10000 }), { mean: 400, variance: 0, stddev: 0 });
});

test("full jitter has the lower mean, equal jitter the tighter spread", () => {
  const full = moments("full", 2, { base: 100, cap: 10000 });   // c = 400
  const equal = moments("equal", 2, { base: 100, cap: 10000 });
  assert.equal(full.mean, 200);        // c/2
  assert.equal(equal.mean, 300);       // 3c/4
  assert.ok(full.mean < equal.mean);
  assert.ok(full.variance > equal.variance);   // full spreads wider
});

test("the moment formulas match a seeded Monte Carlo run", () => {
  const opts = { base: 100, cap: 100000 };     // cap high so attempt 2 isn't clipped
  for (const strategy of ["full", "equal"]) {
    const next = createBackoff(strategy, { ...opts, random: rng(7) });
    const N = 200000;
    let sum = 0, sumSq = 0;
    for (let i = 0; i < N; i++) { const d = next(2); sum += d; sumSq += d * d; }
    const mean = sum / N;
    const variance = sumSq / N - mean * mean;
    const m = moments(strategy, 2, opts);
    assert.ok(Math.abs(mean - m.mean) / m.mean < 0.01, `${strategy} mean ${mean} vs ${m.mean}`);
    assert.ok(Math.abs(variance - m.variance) / m.variance < 0.03, `${strategy} var ${variance} vs ${m.variance}`);
  }
});

test("decorrelated jitter has no per-attempt closed form", () => {
  assert.equal(moments("decorrelated", 3), null);
});

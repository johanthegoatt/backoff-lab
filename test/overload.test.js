import { test } from "node:test";
import assert from "node:assert/strict";
import { POLICIES, simulateOverload } from "../src/overload.js";

const SEEDS = [1, 2, 3, 4, 5];

test("a seed reproduces the same run exactly", () => {
  assert.deepEqual(simulateOverload({ policy: "three", seed: 4 }), simulateOverload({ policy: "three", seed: 4 }));
});

test("with no dip, every policy serves nearly everything", () => {
  for (const policy of Object.keys(POLICIES)) {
    const r = simulateOverload({ policy, seed: 1, dipCapacity: 1000 });
    assert.ok(r.recovered, policy);
    assert.ok(r.totals.succeeded / r.totals.fresh > 0.99, policy);
  }
});

test("unbounded and three-attempt retries stay broken after the dip ends", () => {
  for (const seed of SEEDS) {
    for (const policy of ["unbounded", "three"]) {
      const r = simulateOverload({ policy, seed });
      assert.equal(r.recovered, false, `${policy} seed ${seed}`);
      assert.ok(r.wastedShare > 0.8, `${policy} seed ${seed} wasted ${r.wastedShare}`);
    }
  }
});

test("three attempts amplify load to just under 3x, as the SRE book warns", () => {
  for (const seed of SEEDS) {
    const a = simulateOverload({ policy: "three", seed }).amplification;
    assert.ok(a > 2.3 && a < 3, `seed ${seed}: ${a}`);
  }
});

test("a 10% retry budget keeps amplification near 1.1x and recovers", () => {
  for (const seed of SEEDS) {
    const r = simulateOverload({ policy: "budget", seed });
    assert.ok(r.amplification <= 1.1, `seed ${seed}: ${r.amplification}`);
    assert.ok(r.recovered, `seed ${seed}`);
    assert.ok(r.recoveredAfterMs !== null && r.recoveredAfterMs < 10_000, `seed ${seed}: ${r.recoveredAfterMs}`);
  }
});

test("the timeline covers the whole run in fixed buckets", () => {
  const r = simulateOverload({ policy: "none", seed: 1, durationMs: 10_000, bucketMs: 500 });
  assert.equal(r.timeline.length, 20);
  assert.equal(r.timeline.reduce((s, b) => s + b.fresh, 0), r.totals.fresh);
});

test("unknown policies are rejected", () => {
  assert.throws(() => simulateOverload({ policy: "hope" }), RangeError);
});

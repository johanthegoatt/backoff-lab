import { test } from "node:test";
import assert from "node:assert/strict";
import { heap, simulateContention } from "../src/contention.js";
import { STRATEGIES } from "../src/backoff.js";

const mean = (strategy, clients, seeds = 20) => {
  let calls = 0, time = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const r = simulateContention({ clients, strategy, seed });
    calls += r.calls;
    time += r.completionMs;
  }
  return { calls: calls / seeds, time: time / seeds };
};

test("heap pops in time order, ties in insertion order", () => {
  const h = heap();
  [[5, "a"], [1, "b"], [5, "c"], [3, "d"], [1, "e"]].forEach(([t, v]) => h.push(t, v));
  const out = [];
  while (h.size) out.push(h.pop()[2]);
  assert.deepEqual(out, ["b", "e", "d", "a", "c"]);
});

test("a seed reproduces the same run exactly", () => {
  const a = simulateContention({ clients: 30, strategy: "full", seed: 9 });
  const b = simulateContention({ clients: 30, strategy: "full", seed: 9 });
  assert.deepEqual(a, b);
});

test("every client eventually commits, whatever the strategy", () => {
  for (const strategy of STRATEGIES) {
    const r = simulateContention({ clients: 40, strategy, seed: 3 });
    assert.equal(r.completed, 40, strategy);
  }
});

test("a lone client commits on its first attempt", () => {
  const r = simulateContention({ clients: 1, strategy: "exponential", seed: 1 });
  assert.equal(r.calls, 2); // one read, one write
});

test("full jitter does far less work than unjittered exponential at 100 clients", () => {
  const exp = mean("exponential", 100);
  const full = mean("full", 100);
  // Brooker reports jitter cutting calls by more than half; here it is ~42%
  // fewer calls (reads and writes both counted) and ~10x faster completion.
  assert.ok(full.calls < exp.calls * 0.65, `full ${full.calls} vs exponential ${exp.calls}`);
  assert.ok(full.time * 5 < exp.time, `full ${full.time}ms vs exponential ${exp.time}ms`);
});

test("decorrelated and full jitter both beat equal jitter on completion time", () => {
  const equal = mean("equal", 100);
  assert.ok(mean("full", 100).time < equal.time);
  assert.ok(mean("decorrelated", 100).time < equal.time);
});

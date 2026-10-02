// Brooker's contention experiment, rebuilt as a discrete-event simulation.
//
// N clients all try to update the same row at t=0 using optimistic
// concurrency: read the version, write it back conditionally. A write
// succeeds only if no other write committed since that client's read.
// Losers back off and try again. Every hop takes a normally distributed
// network delay (mean 10ms, sd 2ms, the article's numbers).
//
// What it measures is the article's point: without jitter, clients who
// collided once collide again, because they all wake at the same instant.

import { createBackoff, rng } from "./backoff.js";

// Binary min-heap of [time, seq, event]. seq breaks ties in insertion order
// so a run is fully determined by its seed.
function heap() {
  const a = [];
  const less = (i, j) => a[i][0] < a[j][0] || (a[i][0] === a[j][0] && a[i][1] < a[j][1]);
  const swap = (i, j) => { [a[i], a[j]] = [a[j], a[i]]; };
  let seq = 0;
  return {
    get size() { return a.length; },
    push(time, ev) {
      a.push([time, seq++, ev]);
      for (let i = a.length - 1; i > 0;) {
        const p = (i - 1) >> 1;
        if (!less(i, p)) break;
        swap(i, p); i = p;
      }
    },
    pop() {
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        for (let i = 0; ;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && less(l, m)) m = l;
          if (r < a.length && less(r, m)) m = r;
          if (m === i) break;
          swap(i, m); i = m;
        }
      }
      return top;
    },
  };
}

export { heap };

export function simulateContention({
  clients = 50, strategy = "full", base = 5, cap = 2000,
  meanDelay = 10, sdDelay = 2, seed = 1, maxAttempts = 10_000,
} = {}) {
  const random = rng(seed);
  // Box-Muller, clipped so a hop is never instant or negative.
  const delay = () => {
    const u = 1 - random(), v = random();
    return Math.max(1, meanDelay + sdDelay * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  };

  const q = heap();
  let version = 0;
  let calls = 0;
  let done = 0;
  let finishedAt = 0;
  const attempts = new Array(clients).fill(0);
  const schedules = Array.from({ length: clients }, () => createBackoff(strategy, { base, cap, random }));
  // Server-side arrivals per 10ms, for the load chart.
  const load = [];

  for (let c = 0; c < clients; c++) q.push(delay(), { type: "read", c });

  while (q.size) {
    const [t, , ev] = q.pop();
    if (ev.type === "read") {
      calls++;
      load[Math.floor(t / 10)] = (load[Math.floor(t / 10)] ?? 0) + 1;
      q.push(t + delay(), { type: "write", c: ev.c, seen: version });
    } else if (ev.type === "write") {
      calls++;
      load[Math.floor(t / 10)] = (load[Math.floor(t / 10)] ?? 0) + 1;
      const ok = ev.seen === version;
      if (ok) version++;
      q.push(t + delay(), { type: "reply", c: ev.c, ok });
    } else {
      const c = ev.c;
      if (ev.ok) {
        done++;
        finishedAt = Math.max(finishedAt, t);
        continue;
      }
      if (++attempts[c] >= maxAttempts) continue;
      q.push(t + schedules[c](attempts[c] - 1) + delay(), { type: "read", c });
    }
  }

  for (let i = 0; i < load.length; i++) load[i] ??= 0;
  return { strategy, clients, calls, completed: done, completionMs: finishedAt, load };
}

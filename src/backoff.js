// Backoff schedules, written from the formulas in Marc Brooker's
// "Exponential Backoff And Jitter" (AWS Architecture Blog, 2015):
//
//   exponential   sleep = min(cap, base * 2^attempt)
//   full          sleep = random_between(0, min(cap, base * 2^attempt))
//   equal         temp  = min(cap, base * 2^attempt)
//                 sleep = temp / 2 + random_between(0, temp / 2)
//   decorrelated  sleep = min(cap, random_between(base, sleep * 3))
//
// Every schedule takes its randomness from the caller, so a seeded run gives
// the same delays every time and the tests can pin exact values.

export const STRATEGIES = ["constant", "exponential", "full", "equal", "decorrelated"];

// mulberry32: a 32-bit seeded generator, small enough to read and good enough
// for simulation. Returns floats in [0, 1).
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (random, lo, hi) => lo + random() * (hi - lo);

// 2^attempt overflows to Infinity past attempt 1023, and min(cap, Infinity)
// is still cap, so a long-running retry loop can never produce NaN here.
const ceiling = (base, cap, attempt) => Math.min(cap, base * 2 ** attempt);

// Returns next(attempt) -> delay in ms. attempt counts from 0 for the first
// retry. Decorrelated jitter depends on the previous sleep rather than the
// attempt number, so each schedule is its own object with its own state.
export function createBackoff(strategy, { base = 100, cap = 10_000, random = Math.random } = {}) {
  if (!(base > 0) || !(cap >= base)) throw new RangeError("need 0 < base <= cap");
  let prev = base;
  switch (strategy) {
    case "constant":
      return () => base;
    case "exponential":
      return (attempt) => ceiling(base, cap, attempt);
    case "full":
      return (attempt) => between(random, 0, ceiling(base, cap, attempt));
    case "equal":
      return (attempt) => {
        const temp = ceiling(base, cap, attempt);
        return temp / 2 + between(random, 0, temp / 2);
      };
    case "decorrelated":
      return () => (prev = Math.min(cap, between(random, base, prev * 3)));
    default:
      throw new RangeError(`unknown strategy "${strategy}", expected one of ${STRATEGIES.join(", ")}`);
  }
}

// The expected delay and its spread for one attempt, worked out on paper rather
// than by simulation, so you can compare strategies without running one. Each
// jittered schedule draws uniformly, so the mean and variance are the textbook
// moments of a uniform range:
//
//   full    sleep ~ U(0, c)        mean = c/2,    var = c^2 / 12
//   equal   sleep ~ c/2 + U(0,c/2) mean = 3c/4,   var = c^2 / 48
//
// where c = min(cap, base * 2^attempt). Full jitter has the lower mean but the
// wider spread; equal jitter keeps a floor of c/2 so it never retries instantly
// but clusters less tightly. Constant and exponential draw nothing, so their
// variance is zero. Decorrelated jitter depends on the previous sleep, not the
// attempt number, so it has no per-attempt closed form and returns null.
export function moments(strategy, attempt, { base = 100, cap = 10_000 } = {}) {
  if (!(base > 0) || !(cap >= base)) throw new RangeError("need 0 < base <= cap");
  const c = ceiling(base, cap, attempt);
  const make = (mean, variance) => ({ mean, variance, stddev: Math.sqrt(variance) });
  switch (strategy) {
    case "constant":
      return make(base, 0);
    case "exponential":
      return make(c, 0);
    case "full":
      return make(c / 2, (c * c) / 12);
    case "equal":
      return make((3 * c) / 4, (c * c) / 48);
    case "decorrelated":
      return null;
    default:
      throw new RangeError(`unknown strategy "${strategy}", expected one of ${STRATEGIES.join(", ")}`);
  }
}

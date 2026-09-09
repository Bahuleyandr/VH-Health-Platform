// src/tests/unit/circuitBreakerResetJitter.test.js
//
// The Prisma circuit breaker's reset window was a fixed 30_000 ms, which is
// phase-locked to the `*/30 * * * * *` cron cadence in utils/scheduler.js: the
// breaker trips on a boundary storm at second ~02, its half-open probe fires at
// second ~32, and four scheduled jobs fire at second 30. The one call that
// decides whether the breaker closes was therefore aimed into a fresh wave,
// every cycle, by construction.
//
// The defect is the PHASE LOCK, not the state machine. Re-opening on the first
// failure after half-open is deliberate — it stops a genuinely dead database
// being handed a fresh budget of five calls every 30 s — so this suite pins
// that behaviour as UNCHANGED and asserts only the timing.
import { readFileSync } from 'node:fs';
import {
  resolveCircuitBreakerResetMs,
  __circuitBreakerTuning as TUNING,
} from '../../lib/prisma.js';

// The rig's backend livenessProbe, from
// infra/kubernetes/overlays/dalekdefender/backend.yaml.
const LIVENESS_PERIOD_MS = 30_000;
const LIVENESS_FAILURE_THRESHOLD = 3;

// A restart needs `failureThreshold` consecutive failures, so the outage has to
// span at least (threshold - 1) probe periods. Best case for the pod; the worst
// case is one further period, depending on the probe's phase.
const RESTART_FLOOR_MS = (LIVENESS_FAILURE_THRESHOLD - 1) * LIVENESS_PERIOD_MS;

// Measured on the rig 2026-09-09: two open cycles ran 33.312 s and 33.314 s,
// i.e. the reset plus ~3.3 s of the storm that tripped it.
const OBSERVED_STORM_MS = 3_314;

// The cron cadence the fixed reset was locked to: `*/30 * * * * *`.
const CRON_PHASE_MS = 30_000;

const draws = (n, random = Math.random) => Array.from(
  { length: n }, () => resolveCircuitBreakerResetMs(random),
);

describe('circuit breaker reset window — jitter', () => {
  it('never lengthens an open cycle', () => {
    // The whole liveness argument below is an UPPER bound, and stays one only
    // if the jitter is downward. Upward jitter would push a doubled cycle
    // deeper into the restart band this PR exists to warn about.
    const sample = draws(500);
    expect(sample).toHaveLength(500);
    for (const ms of sample) {
      expect(ms).toBeLessThanOrEqual(TUNING.resetMs);
      expect(ms).toBeGreaterThanOrEqual(TUNING.resetMs * (1 - TUNING.resetJitter));
    }
  });

  it('spans a real range rather than collapsing to the constant', () => {
    // Population guard: a jitter that always returned the same number would
    // satisfy the bounds above and fix nothing.
    const sample = draws(500);
    const distinct = new Set(sample);
    expect(distinct.size).toBeGreaterThan(100);
    expect(Math.max(...sample) - Math.min(...sample))
      .toBeGreaterThan(TUNING.resetMs * TUNING.resetJitter * 0.5);
  });

  it('breaks the phase lock — control arm shows what the fixed reset did', () => {
    // Control: the pre-change behaviour, a constant. Every retry lands on the
    // same offset within the cron cadence, forever.
    const fixed = Array.from({ length: 500 }, () => TUNING.resetMs);
    expect(new Set(fixed.map(ms => ms % CRON_PHASE_MS)).size).toBe(1);

    // Treatment: the offsets spread across the cadence instead of stacking on
    // one point. If this ever collapses toward the control the suite fails.
    const jittered = draws(500);
    expect(new Set(jittered.map(ms => ms % CRON_PHASE_MS)).size).toBeGreaterThan(100);
  });

  it('is driven by the injected source, so the distribution is testable', () => {
    expect(resolveCircuitBreakerResetMs(() => 0)).toBe(TUNING.resetMs);
    expect(resolveCircuitBreakerResetMs(() => 1))
      .toBe(Math.round(TUNING.resetMs * (1 - TUNING.resetJitter)));
  });
});

describe('circuit breaker reset window — the liveness budget it is load-bearing for', () => {
  // These assert the ARITHMETIC RELATIONSHIP the constant's comment states, not
  // the numbers themselves, so changing either side fails loudly and says why.

  it('keeps a single open cycle clear of the restart floor', () => {
    const worstSingleCycle = TUNING.resetMs + OBSERVED_STORM_MS;
    expect(worstSingleCycle).toBeLessThan(RESTART_FLOOR_MS);
    // The comment claims roughly 1.8x of headroom; hold it to at least 1.5x so
    // the claim cannot quietly become false.
    expect(RESTART_FLOOR_MS / worstSingleCycle).toBeGreaterThan(1.5);
  });

  it('shows a DOUBLED cycle already inside the restart band', () => {
    // This is the finding, not a regression: the dip cannot grow gradually, it
    // can only double, and one database call decides which.
    const doubled = 2 * (TUNING.resetMs + OBSERVED_STORM_MS);
    expect(doubled).toBeGreaterThanOrEqual(RESTART_FLOOR_MS);
  });

  it('pins the ceiling above which even a single cycle would restart the pod', () => {
    // Any reset above (restart floor - storm) puts one cycle in the band.
    const ceilingMs = RESTART_FLOOR_MS - OBSERVED_STORM_MS;
    expect(ceilingMs).toBeGreaterThan(56_000);
    expect(ceilingMs).toBeLessThan(58_000);
    expect(TUNING.resetMs).toBeLessThan(ceilingMs);
  });

  it('leaves the failure threshold alone', () => {
    // Named here so a change to the budget cannot ride along with a timing fix.
    expect(TUNING.thresholdFailures).toBe(5);
  });
});

describe('circuit breaker half-open semantics — pinned as UNCHANGED', () => {
  // The source is the contract here: the half-open path deliberately does NOT
  // reset consecutiveFailures, so the counter is still at or above the
  // threshold when the probe fires and a single infrastructure failure
  // re-opens. That is textbook and is not what this PR changes.
  const source = readSource();

  it('lets exactly one call through at half-open and does not clear the counter', () => {
    const halfOpen = source.slice(
      source.indexOf('// Half-open: let one request through'),
      source.indexOf('try {', source.indexOf('// Half-open: let one request through')),
    );
    expect(halfOpen.length).toBeGreaterThan(50);
    expect(halfOpen).toContain('breaker.circuitOpen = false;');
    expect(halfOpen).not.toContain('consecutiveFailures = 0');
  });

  it('re-opens on the first failure after half-open, via the same threshold test', () => {
    const failurePath = source.slice(source.indexOf('breaker.consecutiveFailures += 1;'));
    expect(failurePath).toContain('breaker.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD');
    expect(failurePath).toContain('breaker.circuitOpen = true;');
  });

  it('draws a fresh window on every open', () => {
    const failurePath = source.slice(source.indexOf('breaker.consecutiveFailures += 1;'));
    expect(failurePath).toContain('breaker.circuitResetMs = resolveCircuitBreakerResetMs();');
  });

  it('honours the drawn window in the open check and in the status report', () => {
    expect(source).toContain('elapsed < (breaker.circuitResetMs ?? CIRCUIT_BREAKER_RESET_MS)');
    // circuitBreakerStatus() must report the window this breaker actually drew,
    // or operators are told the reset is further away than it is.
    expect(source).toContain('(b.circuitResetMs ?? CIRCUIT_BREAKER_RESET_MS) - (Date.now() - b.circuitOpenedAt)');
  });
});

function readSource() {
  return readFileSync(new URL('../../lib/prisma.js', import.meta.url), 'utf8');
}

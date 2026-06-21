// src/tests/schedulerAdvisoryLock.deep.test.js
//
// Deep real-PG integration test for the cross-process job lock (audit C-5).
// Proves that withDbAdvisoryLock prevents a SECOND concurrent run of the same
// job: while caller A holds the advisory lock (its body parked on a barrier),
// caller B attempting the same jobName is skipped (returns false, body never
// runs). A distinct jobName is unaffected.
//
// Requires a reachable Postgres (DATABASE_URL). Skipped if none configured.

import { withDbAdvisoryLock } from '../utils/scheduler.js';
import prisma from '../lib/prisma.js';

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

// Unique per run so parallel CI shards / leftover locks never collide.
const JOB = `test-advisory-${process.pid}-${Date.now()}`;

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

d('scheduler cross-process advisory lock (deep)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('blocks a second concurrent run of the same job, then allows it after release', async () => {
    const barrier = deferred();
    let aBodyRan = false;
    let bBodyRan = false;

    // Caller A acquires the lock and parks inside its body until we release it.
    const aStarted = deferred();
    const aPromise = withDbAdvisoryLock(JOB, async () => {
      aBodyRan = true;
      aStarted.resolve();
      await barrier.promise; // hold the lock open
    });

    // Wait until A is definitely inside its locked body.
    await aStarted.promise;

    // Caller B tries the SAME job while A holds the lock → must be skipped.
    const bRan = await withDbAdvisoryLock(JOB, async () => {
      bBodyRan = true;
    });

    expect(bRan).toBe(false);     // lock not acquired
    expect(bBodyRan).toBe(false); // body never executed

    // Release A; it should report it ran.
    barrier.resolve();
    const aRan = await aPromise;
    expect(aRan).toBe(true);
    expect(aBodyRan).toBe(true);

    // Now that A released, the lock is free — a fresh attempt acquires it.
    let cBodyRan = false;
    const cRan = await withDbAdvisoryLock(JOB, async () => { cBodyRan = true; });
    expect(cRan).toBe(true);
    expect(cBodyRan).toBe(true);
  });

  it('does not block a DIFFERENT job name held concurrently', async () => {
    const barrier = deferred();
    const otherJob = `${JOB}-other`;

    const aStarted = deferred();
    const aPromise = withDbAdvisoryLock(JOB, async () => {
      aStarted.resolve();
      await barrier.promise;
    });
    await aStarted.promise;

    // A different lock id (different job name) is independent → acquires fine.
    let otherRan = false;
    const otherAcquired = await withDbAdvisoryLock(otherJob, async () => { otherRan = true; });
    expect(otherAcquired).toBe(true);
    expect(otherRan).toBe(true);

    barrier.resolve();
    await aPromise;
  });
});

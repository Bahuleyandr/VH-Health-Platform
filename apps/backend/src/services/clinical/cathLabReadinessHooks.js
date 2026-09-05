// apps/backend/src/services/clinical/cathLabReadinessHooks.js
//
// Off-critical-path scheduling for the cath-lab readiness refresh.
// Spec: docs/superpowers/specs/2026-09-04-cath-pre-procedure-lab-readiness-design.md §6
//
// The lab writers (ORU ingest, manual entry, panel entry, pathologist sign-off)
// used to `await refreshOpenCasesForPatient(...)` inline after their commit.
// That put ~8 queries per OPEN CASE on the writer's latency for a refresh whose
// own contract already says it is best-effort: a snapshot one event behind is
// repaired by the next refresh, and a failure must never unwind a lab write
// that has already committed (Plan 3 final review, F2).
//
// This module is the seam that takes it off that path while keeping every
// guarantee the inline call had:
//
//   - BEST-EFFORT. scheduleReadinessRefresh() is synchronous, returns a boolean
//     and throws nothing; the job itself catches everything and logs a warn.
//   - TENANT EXPLICIT. The job passes tenantId into refreshOpenCasesForPatient,
//     which opens its own setTenant scope. Nothing here relies on an ambient
//     request context that the scheduled tick would no longer be inside.
//   - BOUNDED FAN-OUT. Identical (tenantId, patientUid) pairs scheduled before
//     the job runs collapse into one refresh, so an ORU carrying twenty rows
//     for one patient still refreshes that patient once.
//   - DETERMINISTIC FOR TESTS. flushScheduledReadinessRefreshes() awaits every
//     scheduled job (including jobs a running job schedules), so a test can
//     assert the post-state instead of polling for it.
//
// Cycles. cathLabReadinessService imports labResultsService (the outside-lab
// entry point), so the lab services cannot statically import the readiness
// service back. They import THIS module statically — it pulls in nothing but
// the logger — and the readiness service is reached through the same dynamic
// import the inline call sites used, now inside the job.
//
// setImmediate, not a timer or a microtask: process.nextTick/queueMicrotask
// would drain inside the caller's own continuation (defeating the point), and a
// timer would add wall-clock delay for no gain. setImmediate runs the job in
// the check phase after the current operation yields — off the caller's stack,
// still in this process, still before the event loop goes idle.

import logger from '../../logging/logger.js';

// Jobs scheduled but not yet started, keyed by tenant + patient. The key is
// deleted the moment its job STARTS, so a lab event that lands while a refresh
// is running still gets a refresh of its own.
const scheduled = new Set();

// Every job that has been scheduled and not yet settled. Jobs remove themselves;
// flushScheduledReadinessRefreshes() drains this.
const inFlight = new Set();

function jobKey(tenantId, patientUid) {
  // NUL cannot appear in either value, so the pair cannot be spoofed by a value
  // containing the separator.
  return `${tenantId}\u0000${patientUid}`;
}

async function runReadinessRefresh({ tenantId, patientUid, source }) {
  try {
    // Resolved inside the job, exactly as the inline call sites resolved it:
    // the readiness service imports the lab services, so this side of the pair
    // can only ever reach it dynamically. Hoisting the import to schedule time
    // was tried and reverted — a module-link failure then lands outside any
    // caller's try, and under Jest that crashes the worker rather than logging.
    const { refreshOpenCasesForPatient } = await import('./cathLabReadinessService.js');
    await refreshOpenCasesForPatient({ tenantId, patientUid });
  } catch (err) {
    logger.warn('Cath lab readiness refresh after lab event failed (lab write stands)', {
      tenantId,
      patientUid,
      source: source ?? null,
      error: err?.message,
    });
  }
}

/**
 * Schedule a best-effort readiness refresh for one patient, off the caller's
 * critical path. Synchronous, never throws, never awaited by a lab writer.
 *
 * @returns {boolean} true if a job was enqueued, false if the pair was already
 *   queued for this tick or the arguments were unusable.
 */
export function scheduleReadinessRefresh({ tenantId, patientUid, source } = {}) {
  const tid = String(tenantId ?? '').trim();
  const uid = String(patientUid ?? '').trim();
  // A refresh with no tenant or no patient cannot resolve a case; dropping it
  // here keeps the log clean of failures the caller could never act on.
  if (!tid || !uid) return false;

  const key = jobKey(tid, uid);
  if (scheduled.has(key)) return false;
  scheduled.add(key);

  const job = new Promise((resolve) => {
    setImmediate(() => {
      // Released before the work, not after: the dedupe window is "not started
      // yet", so a later lab event is never folded into a refresh that has
      // already read the database.
      scheduled.delete(key);
      runReadinessRefresh({ tenantId: tid, patientUid: uid, source }).then(resolve, resolve);
    });
  }).finally(() => { inFlight.delete(job); });
  inFlight.add(job);
  return true;
}

/**
 * Await every scheduled readiness refresh, including any a running job
 * schedules. Its job is test determinism — a deep test asserts the post-state
 * instead of polling for it — and it is also what a shutdown path would call to
 * wait out in-flight refreshes before the pool closes.
 *
 * @returns {Promise<number>} how many jobs this call drained.
 */
export async function flushScheduledReadinessRefreshes() {
  let drained = 0;
  while (inFlight.size > 0) {
    const batch = [...inFlight];
    drained += batch.length;
    // Jobs never reject (runReadinessRefresh swallows), but allSettled keeps
    // the flush itself unable to throw into a test's teardown.
    await Promise.allSettled(batch);
  }
  return drained;
}

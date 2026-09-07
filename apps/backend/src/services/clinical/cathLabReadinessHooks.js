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
//   - BOUNDED CONCURRENCY. Distinct pairs do NOT collapse, and taking the
//     refresh off the writer's `await` removed the only thing that used to
//     serialise them. One ORU message can carry rows for many patients, so the
//     jobs run one at a time through the tail below: each refresh holds a pool
//     connection across 10-17 statements, and that is the same pool the lab
//     writers themselves are competing for.
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
// setImmediate FIRST, then the queue. The first hop off the caller's stack is
// always setImmediate, even when the queue is idle: process.nextTick,
// queueMicrotask — and a bare promise chain, which is the same thing — would
// drain inside the caller's own continuation, before the writer's HTTP response
// has been written, which is the whole point of the seam; and a timer would add
// wall-clock delay for no gain. setImmediate runs in the check phase after the
// current operation yields, and the tail then decides when it is this job's
// turn — off the caller's stack, still in this process, still before the event
// loop goes idle.

import logger from '../../logging/logger.js';

// Jobs scheduled but not yet started, keyed by tenant + patient. The key is
// deleted the moment its job STARTS, so a lab event that lands while a refresh
// is running still gets a refresh of its own.
const scheduled = new Set();

// The serial tail: every scheduled job is chained onto it, so at most one
// refresh is ever in flight. A job cannot reject (runReadinessRefresh swallows
// everything), but the chain is built with .then(job, job) anyway so that
// nothing which somehow settled rejected can strand every job queued behind it.
let tail = Promise.resolve();

// Jobs chained onto the tail and not yet settled — the queued ones AND the one
// running. Zero means the queue is empty and nothing is running.
let pendingJobs = 0;

// Monotonic. flushScheduledReadinessRefreshes() reports the delta across its own
// wait, which is exactly how many jobs that call drained.
let settledJobs = 0;

function jobKey(tenantId, patientUid) {
  // NUL cannot appear in either value, so the pair cannot be spoofed by a value
  // containing the separator.
  return `${tenantId}\u0000${patientUid}`;
}

function markJobSettled() {
  pendingJobs -= 1;
  settledJobs += 1;
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
    // `patientUid` is REDACTED by the log masker (`patient` is one of its
    // sensitive key terms); `tenantId` and `source` are the fields triage
    // actually reads. Do not rename the key to dodge the masker — the redaction
    // is correct here, and a masked value still shows the field was populated.
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

  const runJob = () => new Promise((resolve) => {
    setImmediate(() => {
      // Released before the work, not after: the dedupe window is "queued but
      // not started yet", so a later lab event is never folded into a refresh
      // that has already read the database. A pair scheduled while this job is
      // RUNNING therefore takes the key again and is enqueued behind it; a pair
      // scheduled while this job is still WAITING for its turn is deduped into
      // it.
      scheduled.delete(key);
      runReadinessRefresh({ tenantId: tid, patientUid: uid, source }).then(resolve, resolve);
    });
  }).then(markJobSettled, markJobSettled);

  pendingJobs += 1;
  tail = tail.then(runJob, runJob);
  return true;
}

/**
 * Await every scheduled readiness refresh, including any a running job
 * schedules, returning once the queue is empty AND nothing is running.
 *
 * This is a TEST BARRIER, not a shutdown drain: it is what lets the deep tests
 * assert the post-state instead of polling for it, and nothing outside the
 * tests imports it. It deliberately takes no deadline — a caller that had to
 * give up after N ms would be a shutdown drain, and this seam does not offer
 * one: the refresh is best-effort, so a snapshot lost to a restart is repaired
 * by the next lab event or by the readiness GET's own read-through.
 *
 * @returns {Promise<number>} how many jobs this call drained.
 */
export async function flushScheduledReadinessRefreshes() {
  const before = settledJobs;
  // Bounded when jobs do not re-schedule: pendingJobs > 0 means some job chained
  // onto `tail` has not settled, so `tail` is genuinely outstanding and every
  // turn makes progress. A job that a RUNNING job schedules lands on a newer
  // tail, which the next turn picks up and awaits.
  while (pendingJobs > 0) {
    await tail;
  }
  return settledJobs - before;
}

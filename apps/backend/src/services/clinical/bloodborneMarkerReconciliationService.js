// src/services/clinical/bloodborneMarkerReconciliationService.js
//
// The reconciliation sweep named in spec 2026-09-04 §18: signed HIV/HBsAg/HCV
// lab results that carry no ACTIVE blood-borne marker row, repaired by
// re-driving the same writer the lab sign-off hook drives.
//
// WHY THERE IS A GAP TO SWEEP. The hook in labResultsService.js runs
// post-commit inside a try/catch, deliberately: the sign-off must stand
// whether or not the marker write succeeds (§7.1). So a crash or a database
// blip between the sign-off commit and the marker write leaves a signed
// serology result with no marker, and retrying the same HTTP request does not
// repair it — idempotency replays the stored response. Until the next
// corrective sign-off touches that same result, the reuse resolver reads
// "unknown" for a patient the laboratory has already answered for. This sweep
// is the repair path, and §18 asks for it before any device-reuse reader goes
// live.
//
// WHY IT CALLS THE WRITER RATHER THAN WRITING ROWS. `recordMarkersFromSigned
// Results` is a content-aware upsert under a per-lab-result advisory lock: it
// inserts when the slot is empty, skips when the active row already says
// exactly this, and voids-then-inserts when the result changed. Re-driving it
// therefore makes the sweep idempotent for free, and — the reason §7.1 spells
// it out — inherits the reactive clamp rule, so a reactive result with a
// skewed analyzer clock is clamped and recorded here exactly as it would have
// been on sign-off, never dropped. It also inherits the exposure fan-out (see
// EXPOSURE HANDLERS below), which a sweep writing its own INSERT would lose
// silently.
//
// ONE CALL PER CANDIDATE, NOT ONE PER BATCH. The writer runs a whole batch in
// a single transaction, where "a database error is all-or-nothing for the
// whole batch" (§7.1). That is right for a sign-off, whose result ids are one
// clinical act; it is wrong for a sweep, where a single poisoned row would
// roll back every repair that had already succeeded beside it. So candidates
// are driven one at a time — the same four named arguments the hook passes,
// with a one-element `resultIds` — which is also what makes a failure
// attributable to one lab_result_id in the log. The cath sweep in §5.1 states
// the same resilience contract for the same reason.
//
// EXPOSURE HANDLERS ARE A PRECONDITION, NOT A DETAIL. Recording a REACTIVE
// marker fans out through `notifyExposureHandlers`, which is what quarantines
// the cath devices used on that patient. The handlers register as a module-load
// side effect of their owners, so a process that never imports them notifies an
// EMPTY set and the repair looks clean while the clinical action never happens.
// services/clinical/exposureHandlerBootstrap.js makes that registration
// explicit; the operator script imports it and refuses to --apply with a count
// of zero. This service deliberately does NOT import the bootstrap itself: a
// caller that has genuinely wired its own handlers (the API process, a test
// with a probe) must not be forced through cathDeviceReuseService's import
// graph, and the refusal belongs at the entry point that can explain itself.
//
// TOMBSTONES (owner-vetoable decision, 2026-09-05). A marker row that a person
// voided through voidMarker() is a deliberate act — "this marker does not
// belong on this patient". Re-marking that lab result on the next sweep would
// undo a clinical decision silently and repeatedly, and the operator running
// the sweep is not the person who voided it. So: a lab result carrying ANY
// voided marker row whose void_reason is not the writer's own supersession
// reason is never re-marked. The writer's own supersessions
// (SUPERSESSION_VOID_REASON) stay repairable, because those are the writer
// saying "the result changed", not a person saying "this is wrong". Lifting a
// tombstone is a corrective sign-off, which drives the writer directly and does
// not go through this sweep. See findUnreconciledSerologyResults.
//
// INVOCATION. Operator-run script (scripts/reconcile-bloodborne-markers.mjs),
// mirroring scripts/reconcile-lab-threshold-exceptions.mjs: same
// `runForEachTenant` fan-out, same JSON summary line. This backend DOES have a
// scheduler (utils/scheduler.js: registerCron + withJobLock), and the sweep
// could be registered there. It deliberately is not, yet: it is a repair job
// that writes clinical rows and, until it has run under supervision on real
// data often enough to be boring, it stays under human control. What it does
// NOT rely on is the fan-out for mutual exclusion —
// `runForEachTenant`'s `lockKey` only labels the `scheduled_job_runs` receipt
// (it is compared in the stale-run reaper); it takes no lock that would stop a
// second concurrent run. `withReconciliationJobLock` below does that, on the
// same advisory-lock namespace and key derivation `withJobLock` uses, so an
// operator run and a future cron registration of the same job label contend
// for the SAME lock rather than running past each other.

import pg from 'pg';
import { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { runForEachTenant } from '../../utils/tenantFanout.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  BLOODBORNE_MARKER_ITEM_CODES,
  LAB_ANALYTE_ITEMS,
  markerForResult,
} from '../lab/labAnalyteCodes.js';
import {
  SIGNED_STATUSES,
  SUPERSESSION_VOID_REASON,
  recordMarkersFromSignedResults,
} from './bloodborneMarkerService.js';

export const RECONCILIATION_JOB_LABEL = 'bloodborne-marker-reconciliation';
export const DEFAULT_LIMIT = 500;
// Exported so the script bounds its --batch-size against the SAME ceiling the
// service enforces instead of keeping a second copy that can drift below or
// above it.
export const MAX_LIMIT = 5000;
// How many rows one keyset page scans. Smaller than the per-tenant cap on
// purpose: see reconcileTenant's cursor note.
export const DEFAULT_PAGE_SIZE = 200;
const EXAMPLE_LIMIT = 5;
// 'VH' — the namespace utils/scheduler.js pins its job locks to. Shared
// deliberately: same namespace + same hashtext(job label) means this sweep and
// a `withJobLock('bloodborne-marker-reconciliation')` cron are the same lock.
const ADVISORY_LOCK_NAMESPACE = 0x5648;

// Both lists are derived from the modules that own them, never retyped here.
// BLOODBORNE_MARKER_ITEM_CODES is ['hiv','hbsag','hcv'] — item KEYS — so the
// aliases that actually land in lab_results.test_code come from each item's
// own analyteCodes. Adding an alias to the map extends this sweep with it.
const SEROLOGY_ANALYTE_CODES = Object.freeze(
  BLOODBORNE_MARKER_ITEM_CODES.flatMap((key) => LAB_ANALYTE_ITEMS[key].analyteCodes),
);
const SIGNED_STATUS_LIST = Object.freeze([...SIGNED_STATUSES]);

// lab_results has no status-blind "already reconciled" column, so the filter
// is the sign-off vocabulary itself. The writer validates `decision` against
// SIGN_OFF_DECISIONS and stores it only in evidence.decision — it never
// decides whether to void — so the honest value for a repair is the decision
// the result's own status records, not a flat 'verified' that would tell the
// audit trail a corrective sign-off had been a routine one.
export const DECISION_FOR_SIGNED_STATUS = Object.freeze({
  final: 'verified',
  verified: 'verified',
  corrected: 'corrected',
  amended: 'amended',
});

function boundedLimit(value) {
  if (value == null) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
    throw AppError.badRequest(
      `limit must be an integer between 1 and ${MAX_LIMIT}`,
      'BLOODBORNE_MARKER_RECONCILIATION_LIMIT_INVALID',
    );
  }
  return parsed;
}

function boundedPageSize(value, cap) {
  if (value == null) return Math.min(DEFAULT_PAGE_SIZE, cap);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
    throw AppError.badRequest(
      `pageSize must be an integer between 1 and ${MAX_LIMIT}`,
      'BLOODBORNE_MARKER_RECONCILIATION_PAGE_SIZE_INVALID',
    );
  }
  return Math.min(parsed, cap);
}

function boundedAfterId(value) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw AppError.badRequest(
      'afterId must be a non-negative integer',
      'BLOODBORNE_MARKER_RECONCILIATION_CURSOR_INVALID',
    );
  }
  return parsed;
}

// Normalised to an ISO instant before it is bound, so the window boundary
// cannot be re-interpreted in the database session's timezone (the trap
// check-timestamptz-clock-comparisons.mjs exists for). Null means "no window".
function boundedSince(value) {
  if (value == null || value === '') return null;
  const instant = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(instant.getTime())) {
    throw AppError.badRequest(
      'since must be a valid instant',
      'BLOODBORNE_MARKER_RECONCILIATION_SINCE_INVALID',
    );
  }
  return instant.toISOString();
}

// ---------------------------------------------------------------------------
// The candidate predicate, written ONCE.
//
// Both the candidate page and the unrepairable census below have to agree
// about what "a gap" is; two hand-kept copies would drift the moment one of
// them gained a clause, and the census would then report a number about a
// different question than the one the sweep answers. Parameter positions are
// fixed by this fragment: $1 tenant, $2 signed statuses, $3 analyte codes,
// $4 since, $5 the writer's supersession void reason.
// ---------------------------------------------------------------------------
const CANDIDATE_PREDICATE = `
        result.signed_off_at IS NOT NULL
    AND LOWER(result.status) = ANY($2::text[])
    AND UPPER(BTRIM(REGEXP_REPLACE(result.test_code, '[[:space:]-]+', '_', 'g'), '_'))
          = ANY($3::text[])
    AND ($4::timestamptz IS NULL OR result.signed_off_at >= $4::timestamptz)
    -- Already represented: an ACTIVE marker row for this lab result.
    AND NOT EXISTS (
          SELECT 1
            FROM patient_bloodborne_markers AS active
           WHERE active.tenant_id = result.tenant_id
             AND active.lab_result_id = result.id
             AND active.voided_at IS NULL
        )
    -- TOMBSTONE: voided for any reason OTHER than the writer's own
    -- supersession. A person voided this marker deliberately and the sweep
    -- must not resurrect it. IS DISTINCT FROM, not <>, so a NULL void_reason
    -- also tombstones: an unattributed void is the one case where guessing
    -- "the writer probably did it" would be the permissive direction.
    AND NOT EXISTS (
          SELECT 1
            FROM patient_bloodborne_markers AS tombstone
           WHERE tombstone.tenant_id = result.tenant_id
             AND tombstone.lab_result_id = result.id
             AND tombstone.voided_at IS NOT NULL
             AND tombstone.void_reason IS DISTINCT FROM $5::text
        )`;

// Structurally unrepairable, excluded in SQL rather than discovered per row.
//
// These two are not transient: recorded_by is NOT NULL behind an FK to users,
// so a result with no signer can never be attributed; and the marker table's
// patient FK is (tenant_id, patient_uid) into users, so a result pointing at a
// patient row that is gone can never be inserted against. Leaving them in the
// candidate set would let a handful of them sit at the head of every ORDER BY
// id window forever, consuming the batch and failing identically each run.
// They are counted (see countUnrepairableCandidates) so excluding them is
// visible rather than silent.
const REPAIRABLE_PREDICATE = `
        result.signed_off_by IS NOT NULL
    AND EXISTS (
          SELECT 1
            FROM users AS subject
           WHERE subject.tenant_id = result.tenant_id
             AND subject.uid = result.patient_uid
        )`;

/**
 * One keyset page of signed serology results in one tenant with no marker.
 *
 * The SQL filter on test_code is a COARSE pre-filter — it normalises the
 * column the way labAnalyteCodes' own normalizeCode does (uppercase, runs of
 * whitespace and hyphens to one underscore) so that 'HBs Ag' and 'Anti-HCV'
 * reach the alias list, and then `markerForResult` re-decides every row it
 * returns. The map stays the authority: over-selecting in SQL costs a dropped
 * row in JS, whereas under-selecting would silently leave a patient's marker
 * unrepaired.
 *
 * Because that JS filter runs AFTER the SQL LIMIT, an empty `rows` does not
 * mean the window is exhausted — `scanned` and `lastScannedId` are the
 * cursor's authority, never `rows.length`.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {Date|string|null} [params.since] only results signed at or after this
 * @param {number} [params.limit=500]
 * @param {number|null} [params.afterId] keyset cursor: only results with a
 *   greater lab_result_id
 * @returns {Promise<{rows: Array<Object>, scanned: number, lastScannedId: number|null}>}
 */
export async function findCandidatePage({
  tenantId,
  since = null,
  limit = DEFAULT_LIMIT,
  afterId = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const rowLimit = boundedLimit(limit);
  const sinceIso = boundedSince(since);
  const cursor = boundedAfterId(afterId);
  const raw = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT result.id AS lab_result_id,
            result.patient_uid,
            result.test_code,
            result.loinc_code,
            result.status,
            result.signed_off_at,
            result.signed_off_by
       FROM lab_results AS result
      WHERE result.tenant_id = $1::uuid
        AND ${CANDIDATE_PREDICATE}
        AND ${REPAIRABLE_PREDICATE}
        AND ($6::int IS NULL OR result.id > $6::int)
      ORDER BY result.id
      LIMIT $7::int`,
    tid,
    SIGNED_STATUS_LIST,
    SEROLOGY_ANALYTE_CODES,
    sinceIso,
    SUPERSESSION_VOID_REASON,
    cursor,
    rowLimit,
  ));
  const scannedRows = Array.isArray(raw) ? raw : [];
  const rows = scannedRows
    .filter((row) => markerForResult(row) !== null)
    .map((row) => ({
      lab_result_id: Number(row.lab_result_id),
      patient_uid: row.patient_uid,
      test_code: row.test_code,
      status: row.status,
      signed_off_at: row.signed_off_at,
      // Not one of the five identity fields, but the repair needs an actor and
      // re-reading the row to find one would be a second query per candidate.
      signed_off_by: row.signed_off_by,
    }));
  return {
    rows,
    scanned: scannedRows.length,
    lastScannedId: scannedRows.length
      ? Number(scannedRows[scannedRows.length - 1].lab_result_id)
      : null,
  };
}

/**
 * The first page of candidates as a plain array — the reader's entry point and
 * the shape the deep suite asserts on.
 *
 * @param {Object} params see findCandidatePage
 * @returns {Promise<Array<{lab_result_id: number, patient_uid: string,
 *   test_code: string, status: string, signed_off_at: *, signed_off_by: string|null}>>}
 */
export async function findUnreconciledSerologyResults(params = {}) {
  const { rows } = await findCandidatePage(params);
  return rows;
}

/**
 * Census of the gaps this sweep can never close, over the same window.
 *
 * Reported rather than dropped: "0 candidates" and "0 candidates, 40 of them
 * excluded because their patient row is gone" are very different answers to
 * "is the serology record whole?", and the second one is a data-integrity
 * ticket, not a clean sweep.
 *
 * Counts lab_results rows, not markers, so the coarse test_code pre-filter is
 * as coarse here as it is above — a non-serology row that slips the pre-filter
 * and has no signer is counted, which over-reports rather than hiding a gap.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {Date|string|null} [params.since]
 * The two breakdown counters can overlap (a row with neither a signer nor a
 * patient row is in both); `total` counts each row once, so total <= the sum.
 *
 * @returns {Promise<{total: number, missing_actor: number, missing_subject: number}>}
 */
export async function countUnrepairableCandidates({ tenantId, since = null } = {}) {
  const tid = requireTenantId(tenantId);
  const sinceIso = boundedSince(since);
  const rows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE result.signed_off_by IS NULL)::int AS missing_actor,
            COUNT(*) FILTER (
              WHERE NOT EXISTS (
                SELECT 1
                  FROM users AS subject
                 WHERE subject.tenant_id = result.tenant_id
                   AND subject.uid = result.patient_uid
              )
            )::int AS missing_subject
       FROM lab_results AS result
      WHERE result.tenant_id = $1::uuid
        AND ${CANDIDATE_PREDICATE}
        AND NOT (${REPAIRABLE_PREDICATE})`,
    tid,
    SIGNED_STATUS_LIST,
    SEROLOGY_ANALYTE_CODES,
    sinceIso,
    SUPERSESSION_VOID_REASON,
  ));
  const row = (Array.isArray(rows) ? rows : [])[0] || {};
  return {
    total: Number(row.total || 0),
    missing_actor: Number(row.missing_actor || 0),
    missing_subject: Number(row.missing_subject || 0),
  };
}

// Everything a repair needs that SQL did not already guarantee. Run in BOTH
// modes: a dry run that skipped it would report a candidate count the apply
// run then failed on, which is exactly the surprise a dry run exists to
// prevent. With REPAIRABLE_PREDICATE in the query this should now be
// unreachable — it is kept because "should be unreachable" is a claim about
// today's schema, and reporting a rejection costs one comparison.
function preflight(candidate) {
  const decision = DECISION_FOR_SIGNED_STATUS[String(candidate.status || '').toLowerCase()];
  const actorUid = candidate.signed_off_by || null;
  if (!decision) return { ok: false, reason: 'unmapped_signed_status' };
  if (!actorUid) return { ok: false, reason: 'missing_signing_actor' };
  return { ok: true, decision, actorUid };
}

/**
 * Sweep one tenant. Never throws for a candidate: a failure is counted and
 * logged against its own lab_result_id so one poisoned row cannot cost the
 * tenant its other repairs, and the tenant loop above sees a clean return.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {Date|string|null} [params.since]
 * @param {number} [params.limit=500] per-tenant cap on rows SCANNED this run
 * @param {number} [params.pageSize=200] keyset page size, clamped to `limit`
 * @param {boolean} [params.dryRun=false] load candidates, write nothing
 * @param {Function} [params.recorder] test seam over recordMarkersFromSignedResults
 * @returns {Promise<{candidates: number, recorded: number, voided: number,
 *   skipped: number, failed: number, would_fail: number,
 *   unrepairable_excluded: number, unrepairable_missing_actor: number,
 *   unrepairable_missing_subject: number, candidate_examples: number[],
 *   repaired_examples: number[]}>}
 */
export async function reconcileTenant({
  tenantId,
  since = null,
  limit = DEFAULT_LIMIT,
  pageSize = null,
  dryRun = false,
  recorder = recordMarkersFromSignedResults,
} = {}) {
  const tid = requireTenantId(tenantId);
  const cap = boundedLimit(limit);
  const page = boundedPageSize(pageSize, cap);
  const unrepairable = await countUnrepairableCandidates({ tenantId: tid, since });
  const summary = {
    candidates: 0,
    recorded: 0,
    voided: 0,
    skipped: 0,
    failed: 0,
    would_fail: 0,
    unrepairable_excluded: unrepairable.total,
    unrepairable_missing_actor: unrepairable.missing_actor,
    unrepairable_missing_subject: unrepairable.missing_subject,
    candidate_examples: [],
    repaired_examples: [],
  };

  // KEYSET, NOT REPEATED LIMIT. Some candidates fail every time they are
  // driven (the writer drops a future-dated NON-reactive result by design), and
  // they keep their place at the head of `ORDER BY result.id`. Re-issuing the
  // same query would hand back the same failures forever and never reach the
  // repairable rows behind them, within a run and across runs alike. `id >
  // $last` walks past whatever the last page scanned — repaired, skipped or
  // failed — so a failure costs its own slot in the window and nothing else.
  let cursor = null;
  let scannedTotal = 0;
  while (scannedTotal < cap) {
    const pageLimit = Math.min(page, cap - scannedTotal);
    const { rows, scanned, lastScannedId } = await findCandidatePage({
      tenantId: tid,
      since,
      limit: pageLimit,
      afterId: cursor,
    });
    if (scanned === 0) break;
    scannedTotal += scanned;
    cursor = lastScannedId;
    summary.candidates += rows.length;
    for (const row of rows) {
      if (summary.candidate_examples.length < EXAMPLE_LIMIT) {
        summary.candidate_examples.push(row.lab_result_id);
      }
    }

    for (const candidate of rows) {
      const labResultId = candidate.lab_result_id;
      const checked = preflight(candidate);
      if (!checked.ok) {
        // recorded_by is NOT NULL behind an FK to users; there is no honest
        // actor to attribute the repair to, and inventing one would put a
        // fabricated author on a clinical row. Reported, never guessed.
        summary.would_fail += 1;
        if (!dryRun) summary.failed += 1;
        logger.warn(
          `Blood-borne marker reconciliation cannot repair lab result ${labResultId}`,
          { tenantId: tid, dryRun, labResultId, reason: checked.reason },
        );
        continue;
      }
      if (dryRun) continue;
      try {
        // The sign-off hook's own argument shape (labResultsService.js), with
        // one result id: same four named arguments, same actor provenance
        // (the row's signed_off_by, not a service principal).
            const outcome = await recorder({
          tenantId: tid,
          resultIds: [labResultId],
          decision: checked.decision,
          actorUid: checked.actorUid,
        });
        const inserted = outcome?.recorded?.length || 0;
        summary.recorded += inserted;
        summary.voided += Number(outcome?.voided || 0);
        summary.skipped += outcome?.skipped?.length || 0;
        summary.failed += outcome?.failed?.length || 0;
        if (inserted > 0 && summary.repaired_examples.length < EXAMPLE_LIMIT) {
          summary.repaired_examples.push(labResultId);
        }
      } catch (err) {
        summary.failed += 1;
        logger.error(
          `Blood-borne marker reconciliation failed for lab result ${labResultId}`,
          {
            tenantId: tid,
            labResultId,
            code: err?.code || null,
            error: err?.message,
          },
        );
      }
    }
    if (scanned < pageLimit) break;
  }

  // Counts and a handful of lab_result_ids only: no patient uid, no analyte
  // code, no result value.
  //
  // The meta keys are NOT the summary's own key names. logMasking.js's
  // SENSITIVE_KEY_RE matches `record` — and `patient` — so a field called
  // `recorded` (or `missing_patient`) reaches the log as "[REDACTED]" and the
  // operator's summary loses the numbers the sweep exists to report.
  // `inserted`/`unchanged`/`failures`/`..._subject` say the same thing and
  // survive the scrubber; the returned object keeps the writer's vocabulary.
  logger.info('Blood-borne marker reconciliation swept a tenant', {
    tenantId: tid,
    dryRun,
    candidates: summary.candidates,
    inserted: summary.recorded,
    voided: summary.voided,
    unchanged: summary.skipped,
    failures: summary.failed,
    would_fail: summary.would_fail,
    unrepairable: summary.unrepairable_excluded,
    unrepairable_missing_actor: summary.unrepairable_missing_actor,
    unrepairable_missing_subject: summary.unrepairable_missing_subject,
    candidate_examples: summary.candidate_examples,
    repaired_examples: summary.repaired_examples,
  });
  return summary;
}

const TOTAL_KEYS = Object.freeze([
  'candidates',
  'recorded',
  'voided',
  'skipped',
  'failed',
  'would_fail',
  'unrepairable_excluded',
  'unrepairable_missing_actor',
  'unrepairable_missing_subject',
]);

/**
 * Sweep every active tenant through the shared fan-out helper, which owns
 * discovery, the durable run receipt and the per-tenant failure boundary. It
 * is fail-closed by design: a tenant that throws rejects the aggregate so the
 * caller cannot report a clean pass. The per-tenant rows gathered before that
 * ride out on the error as `err.result`, MERGED into whatever the fan-out
 * already attached (its runId and tenant counters) rather than replacing it —
 * overwriting that object was losing the run id the operator needs to find the
 * receipt.
 *
 * @param {Object} [params]
 * @param {Date|string|null} [params.since]
 * @param {number} [params.limit=500] per-tenant scan cap
 * @param {number} [params.pageSize] keyset page size
 * @param {boolean} [params.dryRun=false]
 * @param {Function} [params.recorder] test seam, forwarded to reconcileTenant
 */
export async function reconcileAllTenants({
  since = null,
  limit = DEFAULT_LIMIT,
  pageSize = null,
  dryRun = false,
  recorder,
} = {}) {
  const tenants = [];
  const totals = Object.fromEntries(TOTAL_KEYS.map((key) => [key, 0]));
  const summarise = (extra) => ({
    job: RECONCILIATION_JOB_LABEL,
    dry_run: dryRun,
    ...extra,
    ...totals,
    tenants,
  });

  try {
    const run = await runForEachTenant(
      RECONCILIATION_JOB_LABEL,
      async (tenantId) => {
        const result = await reconcileTenant({
          tenantId, since, limit, pageSize, dryRun, recorder,
        });
        tenants.push({ tenant_id: tenantId, ...result });
        for (const key of TOTAL_KEYS) totals[key] += Number(result[key] || 0);
      },
      { lockKey: RECONCILIATION_JOB_LABEL },
    );
    return summarise({
      run_id: run.runId,
      tenants_discovered: run.tenantsDiscovered,
      tenants_run: run.tenantsRun,
    });
  } catch (err) {
    const fanout = (err?.result && typeof err.result === 'object') ? err.result : {};
    err.result = {
      ...fanout,
      ...summarise({
        run_id: err?.runId ?? fanout.runId ?? null,
        tenants_discovered: fanout.tenantsDiscovered ?? null,
        tenants_run: fanout.tenantsRun ?? null,
      }),
    };
    throw err;
  }
}

/**
 * Run `fn` under the fleet advisory lock for this job, or not at all.
 *
 * Why not `withJobLock` from utils/scheduler.js, which this mirrors:
 *   1. It is not exported — only the cron registrations inside that module use
 *      it.
 *   2. It CATCHES and logs whatever the body throws. A cron wants that; an
 *      operator script whose exit code is the whole contract must not have its
 *      failures swallowed.
 *   3. Importing utils/scheduler.js at all registers every cron in the
 *      backend as a module-load side effect whenever NODE_ENV is not 'test'.
 *      A one-shot script that did so would start ~60 timers, fire them mid-run
 *      and never exit.
 * So the LOCK is reused — same namespace, same `hashtext(job label)`, so a
 * future `withJobLock('bloodborne-marker-reconciliation')` cron and an operator
 * run cannot both be inside the sweep — while the error and lifecycle policy
 * stays the script's.
 *
 * A dedicated pg.Client, not prisma: the Prisma pg adapter pools, so a
 * `pg_try_advisory_lock` taken on one pooled connection and unlocked later on
 * another leaks the session lock forever. A connection we own end to end
 * cannot.
 *
 * @param {() => Promise<T>} fn
 * @param {Object} [options]
 * @param {string} [options.jobName=RECONCILIATION_JOB_LABEL]
 * @returns {Promise<{ran: boolean, result: T|null}>} ran=false means another
 *   process holds the lock and `fn` was NOT called.
 */
export async function withReconciliationJobLock(fn, {
  jobName = RECONCILIATION_JOB_LABEL,
} = {}) {
  if (typeof fn !== 'function') throw new TypeError('withReconciliationJobLock expects a function');
  // Never a statement_timeout on the lock connection: it sits idle holding the
  // lock for the whole sweep and must not be reaped mid-run.
  const connectionString = process.env.SCHEDULER_LOCK_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(`A database URL is required to lock ${jobName}`);
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  let acquired = false;
  try {
    const res = await client.query(
      'SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked',
      [ADVISORY_LOCK_NAMESPACE, jobName],
    );
    acquired = res.rows?.[0]?.locked === true;
    if (!acquired) {
      logger.warn(`Skipping ${jobName} — advisory lock held by another process`);
      return { ran: false, result: null };
    }
    return { ran: true, result: await fn() };
  } finally {
    if (acquired) {
      try {
        await client.query(
          'SELECT pg_advisory_unlock($1, hashtext($2))',
          [ADVISORY_LOCK_NAMESPACE, jobName],
        );
      } catch (err) {
        // Same connection we acquired on, and it is about to close — which
        // releases the lock anyway.
        logger.warn(`Advisory unlock failed for ${jobName}: ${err?.message}`);
      }
    }
    await client.end().catch(() => {});
  }
}

export default {
  DECISION_FOR_SIGNED_STATUS,
  DEFAULT_LIMIT,
  DEFAULT_PAGE_SIZE,
  MAX_LIMIT,
  RECONCILIATION_JOB_LABEL,
  countUnrepairableCandidates,
  findCandidatePage,
  findUnreconciledSerologyResults,
  reconcileAllTenants,
  reconcileTenant,
  withReconciliationJobLock,
};

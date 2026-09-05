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
// been on sign-off, never dropped. A sweep that wrote its own INSERT would
// have to re-derive both, and would drift.
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
// INVOCATION. Operator-run script (scripts/reconcile-bloodborne-markers.mjs),
// mirroring scripts/reconcile-lab-threshold-exceptions.mjs: same
// `runForEachTenant` fan-out, same job-label/lock-key pairing, same JSON
// summary line. The lab threshold sibling also has a governance ROUTE, but
// that route reconciles one named exception by id — it is not the sweep, and
// the sweep half of both siblings is a script. There is no worker or cron tree
// in this backend to register with.

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
import { SIGNED_STATUSES, recordMarkersFromSignedResults } from './bloodborneMarkerService.js';

export const RECONCILIATION_JOB_LABEL = 'bloodborne-marker-reconciliation';
export const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
const EXAMPLE_LIMIT = 5;

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

/**
 * Signed serology results in one tenant with no active marker row.
 *
 * The SQL filter on test_code is a COARSE pre-filter — it normalises the
 * column the way labAnalyteCodes' own normalizeCode does (uppercase, runs of
 * whitespace and hyphens to one underscore) so that 'HBs Ag' and 'Anti-HCV'
 * reach the alias list, and then `markerForResult` re-decides every row it
 * returns. The map stays the authority: over-selecting in SQL costs a dropped
 * row in JS, whereas under-selecting would silently leave a patient's marker
 * unrepaired.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {Date|string|null} [params.since] only results signed at or after this
 * @param {number} [params.limit=500]
 * @returns {Promise<Array<{lab_result_id: number, patient_uid: string,
 *   test_code: string, status: string, signed_off_at: *, signed_off_by: string|null}>>}
 */
export async function findUnreconciledSerologyResults({
  tenantId,
  since = null,
  limit = DEFAULT_LIMIT,
} = {}) {
  const tid = requireTenantId(tenantId);
  const rowLimit = boundedLimit(limit);
  const sinceIso = boundedSince(since);
  const rows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT result.id AS lab_result_id,
            result.patient_uid,
            result.test_code,
            result.loinc_code,
            result.status,
            result.signed_off_at,
            result.signed_off_by
       FROM lab_results AS result
      WHERE result.tenant_id = $1::uuid
        AND result.signed_off_at IS NOT NULL
        AND LOWER(result.status) = ANY($2::text[])
        AND UPPER(BTRIM(REGEXP_REPLACE(result.test_code, '[[:space:]-]+', '_', 'g'), '_'))
              = ANY($3::text[])
        AND ($4::timestamptz IS NULL OR result.signed_off_at >= $4::timestamptz)
        AND NOT EXISTS (
              SELECT 1
                FROM patient_bloodborne_markers AS marker
               WHERE marker.tenant_id = result.tenant_id
                 AND marker.lab_result_id = result.id
                 AND marker.voided_at IS NULL
            )
      ORDER BY result.id
      LIMIT $5::int`,
    tid,
    SIGNED_STATUS_LIST,
    SEROLOGY_ANALYTE_CODES,
    sinceIso,
    rowLimit,
  ));
  return (Array.isArray(rows) ? rows : [])
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
}

/**
 * Sweep one tenant. Never throws for a candidate: a failure is counted and
 * logged against its own lab_result_id so one poisoned row cannot cost the
 * tenant its other repairs, and the tenant loop above sees a clean return.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {Date|string|null} [params.since]
 * @param {number} [params.limit=500]
 * @param {boolean} [params.dryRun=false] load candidates, write nothing
 * @param {Function} [params.recorder] test seam over recordMarkersFromSignedResults
 * @returns {Promise<{candidates: number, recorded: number, voided: number,
 *   skipped: number, failed: number, examples: number[]}>}
 */
export async function reconcileTenant({
  tenantId,
  since = null,
  limit = DEFAULT_LIMIT,
  dryRun = false,
  recorder = recordMarkersFromSignedResults,
} = {}) {
  const tid = requireTenantId(tenantId);
  const candidates = await findUnreconciledSerologyResults({ tenantId: tid, since, limit });
  const summary = {
    candidates: candidates.length,
    recorded: 0,
    voided: 0,
    skipped: 0,
    failed: 0,
    examples: candidates.slice(0, EXAMPLE_LIMIT).map((row) => row.lab_result_id),
  };

  if (!dryRun) {
    for (const candidate of candidates) {
      const labResultId = candidate.lab_result_id;
      const decision = DECISION_FOR_SIGNED_STATUS[String(candidate.status || '').toLowerCase()];
      const actorUid = candidate.signed_off_by || null;
      if (!decision || !actorUid) {
        // recorded_by is NOT NULL behind an FK to users; there is no honest
        // actor to attribute the repair to, and inventing one would put a
        // fabricated author on a clinical row. Reported, never guessed.
        summary.failed += 1;
        logger.warn(
          `Blood-borne marker reconciliation cannot repair lab result ${labResultId}`,
          {
            tenantId: tid,
            labResultId,
            reason: actorUid ? 'unmapped_signed_status' : 'missing_signing_actor',
          },
        );
        continue;
      }
      try {
        // The sign-off hook's own argument shape (labResultsService.js), with
        // one result id: same four named arguments, same actor provenance
        // (the row's signed_off_by, not a service principal).
        const outcome = await recorder({
          tenantId: tid,
          resultIds: [labResultId],
          decision,
          actorUid,
        });
        summary.recorded += outcome?.recorded?.length || 0;
        summary.voided += Number(outcome?.voided || 0);
        summary.skipped += outcome?.skipped?.length || 0;
        summary.failed += outcome?.failed?.length || 0;
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
  }

  // Counts and a handful of lab_result_ids only: no patient uid, no analyte
  // code, no result value.
  //
  // The meta keys are NOT the summary's own key names. logMasking.js's
  // SENSITIVE_KEY_RE matches `record`, so a field called `recorded` is logged
  // as "[REDACTED]" and the operator's summary loses the one number the sweep
  // exists to report. `inserted`/`unchanged`/`failures` say the same thing and
  // survive the scrubber; the returned object keeps the writer's vocabulary.
  logger.info('Blood-borne marker reconciliation swept a tenant', {
    tenantId: tid,
    dryRun,
    candidates: summary.candidates,
    inserted: summary.recorded,
    voided: summary.voided,
    unchanged: summary.skipped,
    failures: summary.failed,
    examples: summary.examples,
  });
  return summary;
}

/**
 * Sweep every active tenant through the shared fan-out helper, which owns
 * discovery, the fleet advisory lock and the durable run receipt. It is
 * fail-closed by design: a tenant that throws rejects the aggregate so the
 * caller cannot report a clean pass. The per-tenant rows gathered before that
 * ride out on the error as `err.result`, the way the lab threshold sibling
 * attaches its counters, so partial progress is never lost with the failure.
 *
 * @param {Object} [params]
 * @param {Date|string|null} [params.since]
 * @param {number} [params.limit=500] per-tenant candidate cap
 * @param {boolean} [params.dryRun=false]
 * @param {Function} [params.recorder] test seam, forwarded to reconcileTenant
 */
export async function reconcileAllTenants({
  since = null,
  limit = DEFAULT_LIMIT,
  dryRun = false,
  recorder,
} = {}) {
  const tenants = [];
  const totals = { candidates: 0, recorded: 0, voided: 0, skipped: 0, failed: 0 };
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
        const result = await reconcileTenant({ tenantId, since, limit, dryRun, recorder });
        tenants.push({ tenant_id: tenantId, ...result });
        for (const key of Object.keys(totals)) totals[key] += Number(result[key] || 0);
      },
      { lockKey: RECONCILIATION_JOB_LABEL },
    );
    return summarise({
      run_id: run.runId,
      tenants_discovered: run.tenantsDiscovered,
      tenants_run: run.tenantsRun,
    });
  } catch (err) {
    err.result = summarise({ run_id: err?.runId ?? null });
    throw err;
  }
}

export default {
  DECISION_FOR_SIGNED_STATUS,
  DEFAULT_LIMIT,
  RECONCILIATION_JOB_LABEL,
  findUnreconciledSerologyResults,
  reconcileAllTenants,
  reconcileTenant,
};

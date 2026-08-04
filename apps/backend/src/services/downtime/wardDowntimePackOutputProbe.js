// src/services/downtime/wardDowntimePackOutputProbe.js
//
// Observes whether ward downtime packs ACTUALLY EXIST, and publishes the
// answer as Prometheus series (observability/wardDowntimePackMetrics.js).
//
// ── Why an output probe was needed ───────────────────────────────────────────
// The `ward-downtime-packs` CronJob invokes `generateWardDowntimePacks()` with
// zero arguments (infra/kubernetes/apps/backend/ward-downtime-packs-cronjob.yaml).
// That signature branches to the governed C3 sweep,
// `generateClinicalContinuityPackSets()`, which returns an empty array without
// touching the database or the filesystem whenever any of three preconditions
// is unmet:
//
//   1. `CLINICAL_CONTINUITY_PACKS_ENABLED` is not "true" — it is unset in the
//      backend ConfigMap and pinned to "false" by the continuity-publication
//      component, asserted by infra/continuity-edge/test/platform-contract.test.mjs;
//   2. no active signed facility continuity policy is enumerable;
//   3. no operator signer is wired — the CronJob passes none, so the signer
//      preflight cannot pass even once (1) and (2) are satisfied.
//
// The job then exits 0. `kube_cronjob_status_last_successful_time` advances
// every 15 minutes, the CronJob-liveness alert that used to watch it stayed
// green permanently, and no ward pack existed to print. Today the ONLY code
// path that writes a 'ward_pack' row is the admin-triggered
// `POST /api/v1/downtime/generate`.
//
// This probe therefore asks the question monitoring must actually ask: for
// every ward that has an occupied bed, is there a pack that exists, is fresh,
// and is non-empty? It runs inside the backend Deployment because that is the
// process Prometheus scrapes — a counter incremented inside the short-lived
// CronJob pod is never collected by anything.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  recordWardDowntimePackOutputObservation
} from '../../observability/wardDowntimePackMetrics.js';
import { WARD_PACK_SCOPE } from './wardDowntimePackService.js';

// A pack is "fresh" for far less time than it is valid. The stored validity
// window is 24 hours (C-D2's hard expiry), but generation is supposed to run
// every 15 minutes, so a pack older than three missed cycles means generation
// has stopped even though the sheet has not yet expired. 45 minutes is the
// threshold the retired CronJob-liveness alert used, kept so the replacement
// is no less sensitive to a stalled producer than the rule it replaces.
export const WARD_PACK_FRESHNESS_WINDOW_MINUTES = 45;

/**
 * Wards requiring a pack are defined EXACTLY as the generator defines them
 * (wardDowntimePackService.js census: occupied status + a patient on the bed),
 * so the probe cannot drift into measuring a different population than the one
 * being produced for. The coverage test mirrors the three properties the pack
 * has to have to be usable at the bedside: it exists, it is fresh, and it
 * carries at least one bed.
 */
const OUTPUT_COVERAGE_SQL = `
  WITH occupied_wards AS (
    SELECT DISTINCT b.tenant_id, b.ward_id
      FROM beds b
      JOIN wards w ON w.id = b.ward_id
     WHERE LOWER(COALESCE(b.status, '')) = 'occupied'
       AND b.patient_uid IS NOT NULL
       AND b.ward_id IS NOT NULL
  )
  SELECT COUNT(*)::int AS wards_expected,
         COUNT(*) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM downtime_snapshots s
              WHERE s.scope = $1
                AND s.tenant_id = occupied_wards.tenant_id
                AND s.ward_id = occupied_wards.ward_id
                AND s.created_at > NOW() - ($2::int * INTERVAL '1 minute')
                AND (s.expires_at IS NULL OR s.expires_at > NOW())
                AND jsonb_array_length(COALESCE(s.payload->'beds', '[]'::jsonb)) > 0
           )
         )::int AS wards_covered
    FROM occupied_wards`;

/** The uncovered wards themselves, for the log line. Bounded for safety. */
const UNCOVERED_WARD_SQL = `
  SELECT b.tenant_id, b.ward_id, MIN(w.name) AS ward_name
    FROM beds b
    JOIN wards w ON w.id = b.ward_id
   WHERE LOWER(COALESCE(b.status, '')) = 'occupied'
     AND b.patient_uid IS NOT NULL
     AND b.ward_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM downtime_snapshots s
        WHERE s.scope = $1
          AND s.tenant_id = b.tenant_id
          AND s.ward_id = b.ward_id
          AND s.created_at > NOW() - ($2::int * INTERVAL '1 minute')
          AND (s.expires_at IS NULL OR s.expires_at > NOW())
          AND jsonb_array_length(COALESCE(s.payload->'beds', '[]'::jsonb)) > 0
     )
   GROUP BY b.tenant_id, b.ward_id
   ORDER BY b.tenant_id, b.ward_id
   LIMIT 20`;

/**
 * Accept only what the `::int` casts in the coverage query can legitimately
 * produce — a JS number, or a bigint if a driver widens the cast. Anything
 * else (null, undefined, '', a string, an object) is an unusable reading, not
 * a zero.
 */
function coverageCount(value) {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/**
 * Measure ward downtime-pack coverage and publish it. Never throws — a probe
 * that crashes the scheduler would replace a wrong signal with no signal.
 *
 * @returns {Promise<{wardsExpected:number, wardsCovered:number, wardsMissing:number}|null>}
 *   null when the observation could not be taken (metrics are left untouched
 *   so the absent() guard, not a stale value, describes the situation).
 */
export async function observeWardDowntimePackOutput() {
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      OUTPUT_COVERAGE_SQL,
      WARD_PACK_SCOPE,
      WARD_PACK_FRESHNESS_WINDOW_MINUTES,
    );
  } catch (err) {
    logger.error('Ward downtime pack output probe failed', { error: err?.message });
    return null;
  }

  // An ungrouped aggregate always returns exactly one row, so a missing or
  // malformed one means the read did not happen as written. Coercing it to 0/0
  // would publish "no wards need packs, none are missing" — a fabricated
  // all-clear, which is the precise failure this probe exists to end. Note
  // that Number(null) is 0, so the check has to reject the value's SHAPE
  // rather than lean on Number.isFinite. Report nothing and let the absent()
  // guard speak instead.
  const row = Array.isArray(rows) ? rows[0] : undefined;
  const wardsExpected = coverageCount(row?.wards_expected);
  const wardsCovered = coverageCount(row?.wards_covered);
  if (wardsExpected == null || wardsCovered == null) {
    logger.error('Ward downtime pack output probe returned no usable coverage row', {
      row_count: Array.isArray(rows) ? rows.length : null,
    });
    return null;
  }
  const wardsMissing = wardsExpected - wardsCovered;

  try {
    recordWardDowntimePackOutputObservation({
      wardsExpected,
      wardsCovered,
      observedAt: new Date(),
    });
  } catch (err) {
    logger.error('Ward downtime pack output probe produced an unusable observation', {
      wards_expected: wardsExpected,
      wards_covered: wardsCovered,
      error: err?.message,
    });
    return null;
  }

  if (wardsMissing > 0) {
    let uncovered = [];
    try {
      const uncoveredRows = await prisma.$queryRawUnsafe(
        UNCOVERED_WARD_SQL,
        WARD_PACK_SCOPE,
        WARD_PACK_FRESHNESS_WINDOW_MINUTES,
      );
      // Naming the wards is a nicety; the count is the signal. Never let the
      // nicety throw and lose the alarm.
      uncovered = Array.isArray(uncoveredRows) ? uncoveredRows : [];
    } catch (err) {
      logger.warn('Ward downtime pack output probe could not enumerate uncovered wards', {
        error: err?.message,
      });
    }
    logger.error(
      `Ward downtime packs missing for ${wardsMissing} occupied ward(s) — nothing to print during an outage`,
      {
        wards_expected: wardsExpected,
        wards_covered: wardsCovered,
        wards_missing: wardsMissing,
        freshness_window_minutes: WARD_PACK_FRESHNESS_WINDOW_MINUTES,
        uncovered_sample: uncovered.map((row) => ({
          tenant_id: row.tenant_id,
          ward_id: row.ward_id,
          ward_name: row.ward_name,
        })),
      },
    );
  }

  return { wardsExpected, wardsCovered, wardsMissing };
}

export default {
  observeWardDowntimePackOutput,
  WARD_PACK_FRESHNESS_WINDOW_MINUTES,
};

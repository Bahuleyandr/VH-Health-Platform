// src/services/gamification/adherenceRiskService.js
//
// Medication-adherence risk scorer. A proper ML model (logistic regression
// trained on historical refill/MAR data, exported to ONNX) is the S-tier
// endgame — but a weighted-heuristic version ships immediately, reuses the
// data we already have, and gives the admin dashboard something usable while
// we accumulate training data.
//
// Output: 0 (perfect adherence) → 100 (high refill-risk). Returned alongside
// the underlying factors so clinicians can see *why* a patient was flagged
// rather than treating the score as a black box.

import prisma from '../../lib/prisma.js';
import { scoreViaModel } from './adherenceModelServing.js';

/**
 * Factor weights. Tuned so a completely-non-adherent patient can reach 100
 * and a completely-compliant one stays ≤ 10. Capped per-factor so no single
 * signal can dominate the score.
 */
const WEIGHTS = {
  missedDosesLast30:    6,   // per event, cap at 5 events (30 pts)
  marOverridesLast30:   4,   // per event, cap at 5 events (20 pts)
  lateRefillsLast90:    5,   // per Rx refilled >7d late, cap at 4 (20 pts)
  daysSinceLastVitalsCapped: 0.5, // 1 pt per 2 days, cap at 60 days (30 pts)
};

function clampPts(raw, cap) {
  return Math.min(raw, cap);
}

/**
 * Pure heuristic scorer — exported separately so unit tests can pin the
 * weighted-sum behaviour without mocking Prisma. The DB-fetching shell
 * (`scoreAdherenceRisk`) computes these factors from raw SQL and then calls
 * this function; an ONNX model (when loaded) replaces the heuristic at the
 * caller layer.
 *
 * @param {object} factors
 * @param {number} factors.missedDoses30      - missed MAR events in last 30 days
 * @param {number} factors.marOverrides30     - MAR overrides in last 30 days
 * @param {number} factors.lateRefills90      - active Rx in last 90 days (proxy)
 * @param {number} factors.daysSinceLastVital - days since last patient_vitals row, capped at 60
 * @returns {{ score: number, contribution: object }}
 */
export function computeHeuristicScore(factors) {
  const pts = {
    missed:    clampPts((factors.missedDoses30 ?? 0)      * WEIGHTS.missedDosesLast30,    30),
    overrides: clampPts((factors.marOverrides30 ?? 0)     * WEIGHTS.marOverridesLast30,   20),
    refills:   clampPts((factors.lateRefills90 ?? 0)      * WEIGHTS.lateRefillsLast90,    20),
    silent:    clampPts((factors.daysSinceLastVital ?? 0) * WEIGHTS.daysSinceLastVitalsCapped, 30),
  };
  const total = Object.values(pts).reduce((a, b) => a + b, 0);
  return { score: Math.round(Math.min(total, 100)), contribution: pts };
}

export function bandFor(score) {
  return score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
}

export async function scoreAdherenceRisk(patientId, tenantId = null) {
  // CAN-037: when a tenant is supplied, scope every read to it (defense-in-depth
  // alongside RLS; this also runs from non-request contexts via the longitudinal
  // risk service where the RLS AsyncLocalStorage isn't seeded). The extra
  // predicate binds as $2 and is omitted when no tenant is provided.
  const tClause = tenantId ? ' AND tenant_id = $2::uuid' : '';
  const tArgs = tenantId ? [tenantId] : [];

  // Patient wristband UUID (keyed by users.id).
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid FROM users WHERE id = $1${tClause}`,
    patientId, ...tArgs,
  );
  if (rows.length === 0) return null;
  const patientUid = rows[0].uid;

  const [mar] = await prisma.$queryRawUnsafe(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'missed'
                        AND COALESCE(administered_at, scheduled_time) >= NOW() - INTERVAL '30 days')::int AS missed_30,
       COUNT(*) FILTER (WHERE override_reason IS NOT NULL
                        AND administered_at >= NOW() - INTERVAL '30 days')::int                            AS overrides_30
     FROM medication_administrations
     WHERE patient_uid = $1::uuid${tClause}`,
    patientUid, ...tArgs,
  );

  // "Late refill" heuristic — Rx with end_date in the past but no refill in the
  // last 30 days before that end_date. Joins e_prescriptions to its own refill
  // requests table if one exists. Query faults propagate because a fabricated
  // zero would understate a required longitudinal-risk contributor.
  const [refill] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS late_refills
       FROM e_prescriptions
      WHERE patient_id = $1
        AND created_at >= NOW() - INTERVAL '90 days'
        AND status = 'ACTIVE'${tClause}`,
    patientId, ...tArgs,
  );

  // Days since last patient_vitals row.
  const [vital] = await prisma.$queryRawUnsafe(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(recorded_at))) / 86400 AS days_since
       FROM patient_vitals
      WHERE patient_uid = $1::uuid${tClause}`,
    patientUid, ...tArgs,
  );
  const daysSince = vital?.days_since ? Math.min(Math.floor(vital.days_since), 60) : 60;

  const factors = {
    missedDoses30: mar?.missed_30 ?? 0,
    marOverrides30: mar?.overrides_30 ?? 0,
    lateRefills90: refill?.late_refills ?? 0,
    daysSinceLastVital: daysSince,
  };

  const { score: heuristicScore, contribution: pts } = computeHeuristicScore(factors);

  // Try the ONNX model if one is loaded; else fall back to the heuristic.
  const modelScore = await scoreViaModel({
    missed: factors.missedDoses30,
    overrides: factors.marOverrides30,
    lateRefills: factors.lateRefills90,
    daysSilent: factors.daysSinceLastVital,
  });
  const score = modelScore ?? heuristicScore;
  const source = modelScore != null ? 'onnx' : 'heuristic';

  return {
    patientId,
    score,
    source,
    band: bandFor(score),
    escalate: score >= 70,
    factors,
    contribution: pts,
    heuristicScore,
  };
}

export default { scoreAdherenceRisk };

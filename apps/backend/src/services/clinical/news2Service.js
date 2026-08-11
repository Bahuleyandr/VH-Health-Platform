// src/services/clinical/news2Service.js
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { recordCanonicalClinicalEvent } from './canonicalClinicalPlatformService.js';

// ===================================================================
// NEWS2 Scoring — Pure calculation functions + persistence
// Royal College of Physicians National Early Warning Score 2
// ===================================================================

/**
 * Calculate individual NEWS2 parameter scores from vital signs.
 * @param {Object} vitals
 * @returns {Object} { scores, totalScore, clinicalRisk, escalationAction }
 */
// The physiological parameters that carry a NEWS2 sub-score (supplemental_o2 is
// a modifier, scored only when at least one real parameter is present).
const NEWS2_CORE_PARAMS = [
  'respiration_rate', 'spo2', 'temperature', 'systolic_bp', 'heart_rate', 'consciousness',
];

function presentNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize an SpO2 scale value to 1 or 2, or null when unrecognized.
 * Accepts numeric and string forms ('2' arrives from JSON bodies and the
 * nursing-assessment inputs blob).
 */
export function normalizeSpo2Scale(value) {
  const n = presentNumber(value);
  if (n === 1 || n === 2) return n;
  return null;
}

/**
 * Resolve which NEWS2 SpO2 scale applies to a patient from the patient-level
 * flag (users.news2_spo2_scale, migration 646 — set only for patients with a
 * documented hypercapnic-respiratory-failure risk, RCP NEWS2 Scale 2).
 * A missing or invalid stored value falls back to Scale 1 for compatibility,
 * but a database failure must propagate. Scale 1 can under-score a Scale-2
 * patient's high saturation while they are on supplemental oxygen, and a
 * failed query inside a PostgreSQL transaction has already aborted that
 * transaction, so swallowing the error would be both unsafe and ineffective.
 * @param {string} patientUid
 * @param {{ db?: object }} [options] transaction client when called in-tx
 * @returns {Promise<1|2>}
 */
export async function resolveSpo2ScaleForPatient(patientUid, { db } = {}) {
  if (!patientUid) return 1;
  const client = db || prisma;
  const rows = await client.$queryRawUnsafe(
    `SELECT news2_spo2_scale FROM users WHERE uid = $1::uuid LIMIT 1`,
    String(patientUid),
  );
  return normalizeSpo2Scale(rows?.[0]?.news2_spo2_scale) ?? 1;
}

/**
 * The single NEWS2 scorer (C-M7 — the divergent copy in
 * nursingAssessmentService.scoreNews2 now delegates here).
 * @param {Object} vitals
 * @param {{ spo2Scale?: 1|2 }} [options] resolved SpO2 scale; wins over a
 *   per-reading vitals.spo2_scale. Unrecognized values fall back to Scale 1 —
 *   the elevated Scale-2 bands must never apply by accident.
 */
export function calculateNEWS2(vitals, options = {}) {
  const {
    supplemental_o2,
    consciousness,
  } = vitals;
  const supplementalO2Known = supplemental_o2 !== undefined
    && supplemental_o2 !== null
    && supplemental_o2 !== '';
  const spo2Scale = normalizeSpo2Scale(options.spo2Scale ?? vitals.spo2_scale) ?? 1;

  // Partial scoring (audit 2026-06-18 §4): score a parameter ONLY when a usable
  // value is present. Previously every parameter ran through a fall-through
  // if/else, so an ABSENT value (undefined) fell to the final `else` and scored
  // the worst band (e.g. a missing respiration_rate scored 3) — and the vitals
  // path compensated by refusing to compute unless RR+SpO2+SBP+HR were ALL
  // present, silently dropping partial sets. Now: present params score; absent
  // params are omitted; the total is a genuine partial sum.
  const scores = {};
  const missingParams = [];

  const rr = presentNumber(vitals.respiration_rate);
  if (rr === null) missingParams.push('respiration_rate');
  else if (rr <= 8) scores.respiration_rate = 3;
  else if (rr <= 11) scores.respiration_rate = 1;
  else if (rr <= 20) scores.respiration_rate = 0;
  else if (rr <= 24) scores.respiration_rate = 2;
  else scores.respiration_rate = 3;

  const spo2Value = presentNumber(vitals.spo2);
  if (spo2Value === null) missingParams.push('spo2');
  else if (spo2Scale === 1) {
    // Scale 1 (most patients)
    if (spo2Value <= 91) scores.spo2 = 3;
    else if (spo2Value <= 93) scores.spo2 = 2;
    else if (spo2Value <= 95) scores.spo2 = 1;
    else scores.spo2 = 0;
  } else {
    // Scale 2 (patients with hypercapnic respiratory failure, target 88-92%).
    // RCP NEWS2: the elevated >=93 bands (93-94→1, 95-96→2, >=97→3) apply
    // ONLY when the patient is ON supplemental oxygen; on room air any
    // saturation >92 scores 0 — a normal saturation must never be a red
    // parameter (previously spo2 >= 97 on room air scored 3 and fired the
    // single-red escalation).
    if (spo2Value <= 83) scores.spo2 = 3;
    else if (spo2Value <= 85) scores.spo2 = 2;
    else if (spo2Value <= 87) scores.spo2 = 1;
    else if (spo2Value <= 92 || !supplementalO2Known || !supplemental_o2) scores.spo2 = 0;
    else if (spo2Value <= 94) scores.spo2 = 1;
    else if (spo2Value <= 96) scores.spo2 = 2;
    else scores.spo2 = 3;
  }

  // Temperature (Celsius)
  const temp = presentNumber(vitals.temperature);
  if (temp === null) missingParams.push('temperature');
  else if (temp <= 35.0) scores.temperature = 3;
  else if (temp <= 36.0) scores.temperature = 1;
  else if (temp <= 38.0) scores.temperature = 0;
  else if (temp <= 39.0) scores.temperature = 1;
  else scores.temperature = 2;

  // Systolic BP (mmHg)
  const sbp = presentNumber(vitals.systolic_bp);
  if (sbp === null) missingParams.push('systolic_bp');
  else if (sbp <= 90) scores.systolic_bp = 3;
  else if (sbp <= 100) scores.systolic_bp = 2;
  else if (sbp <= 110) scores.systolic_bp = 1;
  else if (sbp <= 219) scores.systolic_bp = 0;
  else scores.systolic_bp = 3;

  // Heart rate (bpm)
  const hr = presentNumber(vitals.heart_rate);
  if (hr === null) missingParams.push('heart_rate');
  else if (hr <= 40) scores.heart_rate = 3;
  else if (hr <= 50) scores.heart_rate = 1;
  else if (hr <= 90) scores.heart_rate = 0;
  else if (hr <= 110) scores.heart_rate = 1;
  else if (hr <= 130) scores.heart_rate = 2;
  else scores.heart_rate = 3;

  // Consciousness (ACVPU scale) — A = alert, all others score 3. Only scored
  // when a level was actually supplied (absent ≠ "alert").
  const level = consciousness == null || consciousness === ''
    ? null
    : String(consciousness).toUpperCase();
  if (level === null) missingParams.push('consciousness');
  else scores.consciousness = level === 'A' ? 0 : 3;

  // Supplemental oxygen is a modifier — only contribute it when at least one
  // core parameter is present (a lone "on O2" with no vitals isn't a score).
  const anyCorePresent = NEWS2_CORE_PARAMS.some((p) => p in scores);
  if (anyCorePresent) {
    if (supplementalO2Known) scores.supplemental_o2 = supplemental_o2 ? 2 : 0;
    else missingParams.push('supplemental_o2');
  }

  const totalScore = Object.values(scores).reduce((sum, v) => sum + v, 0);
  // RCP NEWS2: a score of 3 in ANY single parameter mandates urgent review even
  // when the aggregate is low. Surfaced here so getClinicalRisk + the CDS
  // surfacing layer can honor that rule.
  const anyParamThree = Object.values(scores).some((v) => v === 3);
  const { clinicalRisk, escalationAction } = getClinicalRisk(totalScore, { anyParamThree });
  const partial = anyCorePresent && missingParams.length > 0;

  return {
    scores,
    totalScore,
    anyParamThree,
    clinicalRisk,
    escalationAction,
    // `scorable` = at least one core parameter was present (worth recording);
    // `partial` = scorable but some core params were absent.
    scorable: anyCorePresent,
    partial,
    missingParams,
  };
}

/**
 * Map total NEWS2 score to clinical risk level and recommended action.
 * @param {number} score
 * @returns {{ clinicalRisk: string, escalationAction: string }}
 */
export function getClinicalRisk(score, { anyParamThree = false } = {}) {
  if (score >= 7) {
    return {
      clinicalRisk: 'high',
      escalationAction: 'Emergency response — immediate assessment by clinical team with critical care competencies. Continuous monitoring.',
    };
  }
  if (score >= 5) {
    return {
      clinicalRisk: 'medium',
      escalationAction: 'Urgent response — clinician assessment within 30 minutes. Consider transfer to higher-dependency environment.',
    };
  }
  if (score >= 1) {
    return {
      clinicalRisk: 'low_to_medium',
      // RCP NEWS2 single-parameter rule: a 3 in any one parameter requires
      // urgent ward-doctor review even at a low aggregate.
      escalationAction: anyParamThree
        ? 'Urgent review by the ward doctor — a single NEWS2 parameter scored 3. Determine the cause and decide on escalation/monitoring frequency.'
        : 'Ward-based response — inform registered nurse. Increase monitoring frequency to minimum 1-hourly.',
    };
  }
  return {
    clinicalRisk: 'low',
    escalationAction: 'Continue routine monitoring — minimum every 12 hours.',
  };
}

// NEWS2 aggregate at or above which escalation is mandatory (RCP: medium risk).
const NEWS2_ESCALATION_THRESHOLD = 5;

/**
 * Persist a NEWS2 assessment row. Runs on the supplied db client (the vitals
 * transaction when called from vitalsChartService.recordVitals, so the score
 * commits atomically with the vitals row — audit 2026-06-18 §4) or plain prisma
 * for the standalone NEWS2 endpoint. Returns the saved record plus the computed
 * fields the caller needs to escalate, or null when the vitals carry no usable
 * NEWS2 parameter (nothing to record).
 * @param {string} patientUid
 * @param {Object} vitals
 * @param {string} recordedBy
 * @param {{ db?: object, spo2Scale?: 1|2, vitalsChartId?: number|null }}
 *   [options] `spo2Scale` is the resolved patient-level scale
 *   (resolveSpo2ScaleForPatient); it wins over a per-reading
 *   vitals.spo2_scale and is what gets persisted. `vitalsChartId` links the
 *   score to its source vitals_chart row (migration 652) so a later
 *   correction of that row can find and supersede this score.
 */
export async function persistNews2(patientUid, vitals, recordedBy, options = {}) {
  const db = options.db || prisma;
  const spo2Scale = normalizeSpo2Scale(options.spo2Scale ?? vitals.spo2_scale) ?? 1;
  const computed = calculateNEWS2(vitals, { spo2Scale });
  // Partial scoring: record whenever at least one core parameter is present.
  // Nothing usable → nothing to persist.
  if (!computed.scorable) return null;

  const { totalScore, clinicalRisk, escalationAction } = computed;
  const consciousness = vitals.consciousness == null || vitals.consciousness === ''
    ? null
    : String(vitals.consciousness).toUpperCase();

  const rows = await db.$queryRawUnsafe(
    `INSERT INTO news2_scores
       (patient_uid, respiration_rate, spo2, spo2_scale, supplemental_o2,
        temperature, systolic_bp, heart_rate, consciousness,
        total_score, clinical_risk, escalation_action, recorded_by,
        vitals_chart_id, partial_score, missing_params)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid,
             $14::int, $15, $16::text[])
     RETURNING id, patient_uid, total_score, clinical_risk, clinical_risk AS risk_level,
               vitals_chart_id, partial_score, missing_params,
               recorded_by, recorded_at, created_at`,
    patientUid,
    vitals.respiration_rate ?? null,
    vitals.spo2 ?? null,
    spo2Scale,
    vitals.supplemental_o2 ?? null,
    vitals.temperature ?? null,
    vitals.systolic_bp ?? null,
    vitals.heart_rate ?? null,
    consciousness,
    totalScore,
    clinicalRisk,
    escalationAction,
    recordedBy,
    options.vitalsChartId ?? null,
    computed.partial === true,
    computed.partial ? computed.missingParams : null,
  );

  return { record: rows[0], computed };
}

/**
 * Mark every LIVE NEWS2 score derived from a given vitals_chart row as
 * superseded. A replacement id records the append-only successor; null is
 * valid when a correction removed the final scorable parameter and therefore
 * produced no replacement score. Runs on the caller's tx so retirement is
 * atomic with the correction and optional replacement insert.
 */
export async function supersedeNews2ForVitalsRow(vitalsChartId, replacementScoreId, { db } = {}) {
  if (!vitalsChartId) return 0;
  const client = db || prisma;
  return client.$executeRawUnsafe(
    `UPDATE news2_scores
        SET superseded_by_id = $1::int,
            superseded_at = NOW()
      WHERE vitals_chart_id = $2::int
        AND ($1::int IS NULL OR id <> $1::int)
        AND superseded_at IS NULL`,
    replacementScoreId == null ? null : Number(replacementScoreId),
    Number(vitalsChartId),
  );
}

// Resolve the patient's tenant for routing and canonical persistence when the
// caller did not pass one (the standalone NEWS2 path). A database fault must
// propagate; treating it as an absent tenant can misroute a clinical write to
// the default tenant in compatibility-mode deployments.
async function resolvePatientTenantId(patientUid) {
  if (!patientUid) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT tenant_id::text AS tenant_id FROM users WHERE uid = $1::uuid LIMIT 1`,
    patientUid,
  );
  return rows?.[0]?.tenant_id || null;
}

/**
 * Escalate a recorded NEWS2 score: create an assigned, acknowledgement-tracked
 * results-inbox task (the escalation engine chases it if unacked) and surface it
 * onto the CDS card pipeline. Escalation fires when the aggregate is >= threshold
 * OR when any single parameter scored 3 (the RCP single-parameter "red score"
 * rule — e.g. new altered consciousness — mandates urgent review even at a low
 * aggregate). Must run POST-COMMIT (it touches other tables / the CDS module). A
 * NEWS2 escalation that fails to land an assigned task is LOUD — it throws so the
 * caller / Sentry sees a deteriorating-patient alert that reached no one. CDS
 * surfacing stays best-effort. Pass { tenantId } from the caller's resolved
 * tenant; otherwise it is resolved from the patient.
 *
 * `resourceType` defaults to the news2_scores row ('news2_score'). The
 * nursing-assessment path passes 'nursing_assessment' with the assessment
 * row's id — the ids come from different sequences, so sharing the
 * news2_score dedup slot would let an unrelated score's open task swallow a
 * genuine nursing-assessment escalation (and vice versa).
 */
export async function escalateNews2(patientUid, record, computed, { tenantId = null, resourceType = 'news2_score' } = {}) {
  const { totalScore, clinicalRisk, escalationAction, scores, anyParamThree } = computed;

  // RCP NEWS2: escalate on a high aggregate OR a single red (=3) parameter. Both
  // conditions route through ONE results-inbox task (the resource-slot lock on
  // news2_score/record.id dedups a re-escalation of the same reading), so a
  // reading that trips both triggers still raises a single task — with a reason
  // that names both.
  const aggregateTrigger = totalScore >= NEWS2_ESCALATION_THRESHOLD;
  const redParams = Object.keys(scores).filter((p) => scores[p] === 3);
  const singleRedTrigger = anyParamThree && redParams.length > 0;

  if (aggregateTrigger || singleRedTrigger) {
    // Build a trigger label so the clinician sees WHY the task fired: a high
    // aggregate, a single red parameter, or both (with the offending parameters).
    const redLabel = redParams.length
      ? `single red score: ${redParams.map((p) => p.replace(/_/g, ' ')).join(', ')} = 3`
      : null;
    const triggerLabel = aggregateTrigger && redLabel
      ? `aggregate ${totalScore} + ${redLabel}`
      : aggregateTrigger
        ? `aggregate ${totalScore}`
        : redLabel;

    // Route the deterioration alert to a REAL, assigned, acknowledgement-tracked
    // recipient via the results-inbox producer (DUTY-role fallback when there is
    // no single ordering clinician), so the escalation engine chases it if it
    // goes unacked. (audit 2026-06-22 W1-H4: the previous notificationOutbox
    // queue carried no recipient_id/recipient_phone and silently dead-lettered
    // after 3 retries — the deteriorating-patient page reached nobody.)
    let result;
    try {
      const { enqueueCriticalResultTask } = await import('../results/resultsInboxService.js');
      const effectiveTenantId = tenantId || (await resolvePatientTenantId(patientUid));
      result = await enqueueCriticalResultTask({
        tenantId: effectiveTenantId,
        patientUid,
        source: 'news2',
        resourceType,
        resourceId: record?.id ?? null,
        // A high aggregate (>=7) is critical; an urgent single-red review that is
        // not also a high aggregate is 'high'.
        severity: totalScore >= 7 ? 'critical' : 'high',
        title: `NEWS2 ${totalScore} (${clinicalRisk.replace(/_/g, ' ')}) — ${triggerLabel} — review required`,
        summary: redLabel ? `${escalationAction} [${redLabel}]` : escalationAction,
        // No single ordering clinician for a ward vital → DUTY-role fallback.
        orderingClinicianUid: null,
        resolveMergedPatient: true,
      });
    } catch (err) {
      logger.error(`NEWS2 escalation FAILED for patient ${patientUid} (score=${totalScore}, trigger=${triggerLabel}): ${err.message}`);
      throw err;
    }
    // LOUD only on a genuine FAILURE: enqueueCriticalResultTask returns
    // created:false for TWO reasons — (a) a DB error (it carries `error`), which
    // means the deteriorating-patient alert reached no one → must surface; and
    // (b) an idempotency conflict (no `error`): an OPEN task for this score
    // already exists, i.e. a duplicate/retry escalation. The alert already
    // reached a recipient, so a conflict is a safe no-op, NOT a miss — throwing on
    // it would crash the caller on any re-escalation of the same score.
    if (!result?.created) {
      if (result?.error) {
        const msg = `NEWS2 escalation FAILED to create a task for patient ${patientUid} (score=${totalScore}): ${result.error}`;
        logger.error(msg);
        throw new Error(msg);
      }
      logger.info(`NEWS2 escalation skipped for patient ${patientUid} (score=${totalScore}): an open task for this score already exists (idempotent)`);
    }
  }

  // Surface NEWS2 deterioration onto the CDS card pipeline (gated/adult-only
  // inside the service). Best-effort — a CDS-surfacing hiccup must never undo a
  // recorded score or block the caller.
  try {
    const { surfaceNews2Cds } = await import('../cds/deteriorationEarlyWarningService.js');
    await surfaceNews2Cds({ patientUid, news2: { totalScore, clinicalRisk, escalationAction, scores, anyParamThree } });
  } catch (err) {
    logger.warn(`NEWS2 CDS surfacing failed for patient ${patientUid}: ${err.message}`);
  }
}

/**
 * Calculate, persist, and escalate a NEWS2 assessment (standalone path). Kept
 * for the dedicated NEWS2 endpoint; vitalsChartService.recordVitals instead
 * calls persistNews2({ db: tx }) inside its transaction and escalateNews2
 * post-commit so the score is atomic with the vitals row.
 *
 * A caller-supplied spo2_scale (bedside clinical judgment) is honored after
 * validation; when absent the patient-level flag decides (migration 646).
 *
 * The detail row + canonical timeline/audit pair commit in ONE transaction
 * (docs/CANONICAL_CLINICAL_TIMELINE.md): a failed canonical emit rolls back
 * the news2_scores row. The canonical emit lives HERE and not in persistNews2
 * on purpose — on the vitals path the vitals.recorded event already covers the
 * timeline, and the invariant is exactly one timeline row per clinical action.
 * @returns {Object|null} Saved NEWS2 record (null when no usable parameter)
 */
export async function recordNEWS2(patientUid, vitals, recordedBy, options = {}) {
  const explicitScale = vitals?.spo2_scale ?? options.spo2Scale;
  let spo2Scale;
  if (explicitScale === undefined || explicitScale === null || explicitScale === '') {
    spo2Scale = await resolveSpo2ScaleForPatient(patientUid);
  } else {
    spo2Scale = normalizeSpo2Scale(explicitScale);
    if (spo2Scale === null) {
      throw AppError.badRequest('spo2_scale must be 1 or 2');
    }
  }

  // Resolve the tenant BEFORE the write: the canonical emit must carry it
  // explicitly (the emit funnel default-stamps DEFAULT_TENANT_ID otherwise)
  // and setTenantTx sets the GUC that stamps news2_scores.tenant_id — the
  // standalone path previously ran on plain prisma and default-stamped both.
  const tenantId = requireTenantId(options?.tenantId ?? await resolvePatientTenantId(patientUid));

  const persisted = await setTenantTx(tenantId, async (tx) => {
    const p = await persistNews2(patientUid, vitals, recordedBy, { db: tx, spo2Scale });
    if (!p) return null;
    await recordCanonicalClinicalEvent({
      tenantId,
      patientUid,
      eventType: 'news2.recorded',
      eventStatus: 'recorded',
      sourceTable: 'news2_scores',
      sourceId: p.record.id,
      resourceType: 'news2_score',
      resourceId: p.record.id,
      actorUid: recordedBy || null,
      summary: `NEWS2 ${p.computed.totalScore} (${p.computed.clinicalRisk.replace(/_/g, ' ')}) recorded`,
      payload: {
        total_score: p.computed.totalScore,
        clinical_risk: p.computed.clinicalRisk,
        escalation_action: p.computed.escalationAction,
        scores: p.computed.scores,
        any_param_three: p.computed.anyParamThree,
        partial: p.computed.partial,
        missing_params: p.computed.missingParams,
        spo2_scale: spo2Scale,
      },
      afterState: p.record,
      tags: ['news2'],
    }, { db: tx });
    return p;
  });
  if (!persisted) return null;
  const { record, computed } = persisted;
  await escalateNews2(patientUid, record, computed, { tenantId });
  logger.info(`NEWS2 recorded for patient ${patientUid}: score=${computed.totalScore}, risk=${computed.clinicalRisk}`);
  return record;
}

/**
 * Get NEWS2 history for a patient, most recent first.
 * @param {string} patientUid
 * @param {number} limit
 * @returns {Object} { scores, trend }
 */
export async function getPatientNEWS2History(patientUid, limit = 50) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, respiration_rate, spo2, spo2_scale, supplemental_o2,
            temperature, systolic_bp, heart_rate, consciousness,
            total_score, clinical_risk, escalation_action, recorded_by, recorded_at,
            vitals_chart_id, superseded_by_id, superseded_at,
            partial_score, missing_params
     FROM news2_scores
     WHERE patient_uid = $1
     ORDER BY recorded_at DESC
     LIMIT $2`,
    patientUid, limit
  );

  // Build trend from last 10 scores (oldest to newest)
  const recentScores = rows.filter((row) => row.superseded_at == null).slice(0, 10).reverse();
  let trend = 'stable';
  if (recentScores.length >= 2) {
    const latest = recentScores[recentScores.length - 1].total_score;
    const previous = recentScores[recentScores.length - 2].total_score;
    if (latest > previous) trend = 'increasing';
    else if (latest < previous) trend = 'decreasing';
  }

  return { scores: rows, trend };
}

export default {
  calculateNEWS2,
  getClinicalRisk,
  normalizeSpo2Scale,
  resolveSpo2ScaleForPatient,
  persistNews2,
  supersedeNews2ForVitalsRow,
  escalateNews2,
  recordNEWS2,
  getPatientNEWS2History,
};

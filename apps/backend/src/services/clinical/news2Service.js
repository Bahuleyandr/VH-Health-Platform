// src/services/clinical/news2Service.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

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

export function calculateNEWS2(vitals) {
  const {
    spo2_scale = 1,
    supplemental_o2 = false,
    consciousness,
  } = vitals;

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
  else if (spo2_scale === 1) {
    // Scale 1 (most patients)
    if (spo2Value <= 91) scores.spo2 = 3;
    else if (spo2Value <= 93) scores.spo2 = 2;
    else if (spo2Value <= 95) scores.spo2 = 1;
    else scores.spo2 = 0;
  } else {
    // Scale 2 (patients with hypercapnic respiratory failure, target 88-92%)
    if (spo2Value <= 83) scores.spo2 = 3;
    else if (spo2Value <= 85) scores.spo2 = 2;
    else if (spo2Value <= 87) scores.spo2 = 1;
    else if (spo2Value <= 92) scores.spo2 = 0;
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
    scores.supplemental_o2 = supplemental_o2 ? 2 : 0;
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
 * @param {{ db?: object }} [options]
 */
export async function persistNews2(patientUid, vitals, recordedBy, options = {}) {
  const db = options.db || prisma;
  const computed = calculateNEWS2(vitals);
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
        total_score, clinical_risk, escalation_action, recorded_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid)
     RETURNING id, patient_uid, total_score, clinical_risk, clinical_risk AS risk_level,
               recorded_by, recorded_at, created_at`,
    patientUid,
    vitals.respiration_rate ?? null,
    vitals.spo2 ?? null,
    vitals.spo2_scale || 1,
    vitals.supplemental_o2 || false,
    vitals.temperature ?? null,
    vitals.systolic_bp ?? null,
    vitals.heart_rate ?? null,
    consciousness,
    totalScore,
    clinicalRisk,
    escalationAction,
    recordedBy,
  );

  return { record: rows[0], computed };
}

// Resolve the patient's tenant for routing a deterioration alert when the
// caller did not pass one (the standalone NEWS2 path). Best-effort: a failed
// lookup yields null and enqueueCriticalResultTask then surfaces the miss LOUDLY.
async function resolvePatientTenantId(patientUid) {
  if (!patientUid) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id FROM users WHERE uid = $1::uuid LIMIT 1`,
      patientUid,
    );
    return rows?.[0]?.tenant_id || null;
  } catch {
    return null;
  }
}

/**
 * Escalate a recorded NEWS2 score: for a score >= threshold, create an assigned,
 * acknowledgement-tracked results-inbox task (the escalation engine chases it if
 * unacked), and surface it onto the CDS card pipeline. Must run POST-COMMIT (it
 * touches other tables / the CDS module). A HIGH-NEWS2 (>=5) escalation that
 * fails to land an assigned task is LOUD — it throws so the caller / Sentry sees
 * a deteriorating-patient alert that reached no one. CDS surfacing stays
 * best-effort. Pass { tenantId } from the caller's resolved tenant; otherwise it
 * is resolved from the patient.
 */
export async function escalateNews2(patientUid, record, computed, { tenantId = null } = {}) {
  const { totalScore, clinicalRisk, escalationAction, scores, anyParamThree } = computed;

  if (totalScore >= NEWS2_ESCALATION_THRESHOLD) {
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
        resourceType: 'news2_score',
        resourceId: record?.id ?? null,
        severity: totalScore >= 7 ? 'critical' : 'high',
        title: `NEWS2 ${totalScore} (${clinicalRisk.replace(/_/g, ' ')}) — review required`,
        summary: escalationAction,
        // No single ordering clinician for a ward vital → DUTY-role fallback.
        orderingClinicianUid: null,
      });
    } catch (err) {
      logger.error(`NEWS2 escalation FAILED for patient ${patientUid} (score=${totalScore}): ${err.message}`);
      throw err;
    }
    // LOUD: a high-NEWS2 alert that produced NO assigned task must not be
    // silently lost — surface it so Sentry / the caller sees the miss.
    if (!result?.created) {
      const msg = `NEWS2 escalation produced no assigned task for patient ${patientUid} (score=${totalScore}): ${result?.error || 'unknown'}`;
      logger.error(msg);
      throw new Error(msg);
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
 * @returns {Object|null} Saved NEWS2 record (null when no usable parameter)
 */
export async function recordNEWS2(patientUid, vitals, recordedBy, options = {}) {
  const persisted = await persistNews2(patientUid, vitals, recordedBy, options);
  if (!persisted) return null;
  const { record, computed } = persisted;
  await escalateNews2(patientUid, record, computed, { tenantId: options?.tenantId ?? null });
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
            total_score, clinical_risk, escalation_action, recorded_by, recorded_at
     FROM news2_scores
     WHERE patient_uid = $1
     ORDER BY recorded_at DESC
     LIMIT $2`,
    patientUid, limit
  );

  // Build trend from last 10 scores (oldest to newest)
  const recentScores = rows.slice(0, 10).reverse();
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
  persistNews2,
  escalateNews2,
  recordNEWS2,
  getPatientNEWS2History,
};

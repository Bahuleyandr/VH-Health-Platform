// src/services/clinical/news2Service.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import notificationOutbox from '../../utils/notifications/notificationOutbox.js'; // eslint-disable-line import/no-named-as-default

// ===================================================================
// NEWS2 Scoring — Pure calculation functions + persistence
// Royal College of Physicians National Early Warning Score 2
// ===================================================================

/**
 * Calculate individual NEWS2 parameter scores from vital signs.
 * @param {Object} vitals
 * @returns {Object} { scores, totalScore, clinicalRisk, escalationAction }
 */
export function calculateNEWS2(vitals) {
  const {
    respiration_rate,
    spo2,
    spo2_scale = 1,
    supplemental_o2 = false,
    temperature,
    systolic_bp,
    heart_rate,
    consciousness,
  } = vitals;

  const scores = {};

  // Respiration rate (breaths/min)
  if (respiration_rate <= 8) scores.respiration_rate = 3;
  else if (respiration_rate <= 11) scores.respiration_rate = 1;
  else if (respiration_rate <= 20) scores.respiration_rate = 0;
  else if (respiration_rate <= 24) scores.respiration_rate = 2;
  else scores.respiration_rate = 3;

  // SpO2 scoring depends on scale
  if (spo2_scale === 1) {
    // Scale 1 (most patients)
    if (spo2 <= 91) scores.spo2 = 3;
    else if (spo2 <= 93) scores.spo2 = 2;
    else if (spo2 <= 95) scores.spo2 = 1;
    else scores.spo2 = 0;
  } else {
    // Scale 2 (patients with hypercapnic respiratory failure, target 88-92%)
    if (spo2 <= 83) scores.spo2 = 3;
    else if (spo2 <= 85) scores.spo2 = 2;
    else if (spo2 <= 87) scores.spo2 = 1;
    else if (spo2 <= 92) scores.spo2 = 0;
    else if (spo2 <= 94) scores.spo2 = 1;
    else if (spo2 <= 96) scores.spo2 = 2;
    else scores.spo2 = 3;
  }

  // Supplemental oxygen
  scores.supplemental_o2 = supplemental_o2 ? 2 : 0;

  // Temperature (Celsius)
  const temp = parseFloat(temperature);
  if (temp <= 35.0) scores.temperature = 3;
  else if (temp <= 36.0) scores.temperature = 1;
  else if (temp <= 38.0) scores.temperature = 0;
  else if (temp <= 39.0) scores.temperature = 1;
  else scores.temperature = 2;

  // Systolic BP (mmHg)
  if (systolic_bp <= 90) scores.systolic_bp = 3;
  else if (systolic_bp <= 100) scores.systolic_bp = 2;
  else if (systolic_bp <= 110) scores.systolic_bp = 1;
  else if (systolic_bp <= 219) scores.systolic_bp = 0;
  else scores.systolic_bp = 3;

  // Heart rate (bpm)
  if (heart_rate <= 40) scores.heart_rate = 3;
  else if (heart_rate <= 50) scores.heart_rate = 1;
  else if (heart_rate <= 90) scores.heart_rate = 0;
  else if (heart_rate <= 110) scores.heart_rate = 1;
  else if (heart_rate <= 130) scores.heart_rate = 2;
  else scores.heart_rate = 3;

  // Consciousness (ACVPU scale) — A = alert, all others score 3
  const level = (consciousness || '').toUpperCase();
  scores.consciousness = level === 'A' ? 0 : 3;

  const totalScore = Object.values(scores).reduce((sum, v) => sum + v, 0);
  // RCP NEWS2: a score of 3 in ANY single parameter mandates urgent review even
  // when the aggregate is low. Surfaced here so getClinicalRisk + the CDS
  // surfacing layer can honor that rule.
  const anyParamThree = Object.values(scores).some((v) => v === 3);
  const { clinicalRisk, escalationAction } = getClinicalRisk(totalScore, { anyParamThree });

  return { scores, totalScore, anyParamThree, clinicalRisk, escalationAction };
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

/**
 * Calculate, persist, and trigger alerts for a NEWS2 assessment.
 * @param {string} patientUid
 * @param {Object} vitals
 * @param {string} recordedBy - Staff UID
 * @returns {Object} Saved NEWS2 record
 */
export async function recordNEWS2(patientUid, vitals, recordedBy) {
  const { totalScore, clinicalRisk, escalationAction } = calculateNEWS2(vitals);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO news2_scores
       (patient_uid, respiration_rate, spo2, spo2_scale, supplemental_o2,
        temperature, systolic_bp, heart_rate, consciousness,
        total_score, clinical_risk, escalation_action, recorded_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid)
     RETURNING id, patient_uid, total_score, clinical_risk, clinical_risk AS risk_level,
               recorded_by, recorded_at, created_at`,
    
      patientUid,
      vitals.respiration_rate,
      vitals.spo2,
      vitals.spo2_scale || 1,
      vitals.supplemental_o2 || false,
      vitals.temperature,
      vitals.systolic_bp,
      vitals.heart_rate,
      (vitals.consciousness || 'A').toUpperCase(),
      totalScore,
      clinicalRisk,
      escalationAction,
      recordedBy,
    
  );

  const record = rows[0];

  // Trigger alerts for medium and high risk
  if (totalScore >= 5) {
    try {
      await notificationOutbox.queue({
        type: 'NEWS2_ALERT',
        title: `NEWS2 Alert — Score ${totalScore} (${clinicalRisk.replace(/_/g, ' ')})`,
        body: escalationAction,
        data: {
          patient_uid: patientUid,
          news2_id: record.id,
          total_score: totalScore,
          clinical_risk: clinicalRisk,
        },
        priority: totalScore >= 7 ? 'CRITICAL' : 'HIGH',
      });
    } catch (err) {
      // Fire-and-forget — notification failure must not block clinical recording
      logger.error('Failed to queue NEWS2 alert notification:', err);
    }
  }

  logger.info(`NEWS2 recorded for patient ${patientUid}: score=${totalScore}, risk=${clinicalRisk}`);
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
  recordNEWS2,
  getPatientNEWS2History,
};

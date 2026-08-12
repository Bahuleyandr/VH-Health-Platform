// src/services/clinical/news2Service.js
import { createHash } from 'node:crypto';
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
  if (typeof value !== 'number' && typeof value !== 'string') return null;
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
export const NEWS2_ESCALATION_RECENCY_MS = 4 * 60 * 60 * 1000;

/**
 * NEWS2 may be calculated for recovered observations, but a historical reading
 * must not page today's duty team. Missing/invalid source time fails closed.
 */
export function isNews2EscalationFresh(recordedAt, { now = Date.now() } = {}) {
  const sourceTime = new Date(recordedAt).getTime();
  if (!Number.isFinite(sourceTime)) return false;
  const age = Number(now) - sourceTime;
  return age >= -5 * 60 * 1000 && age <= NEWS2_ESCALATION_RECENCY_MS;
}

/**
 * Read-surface contract: a partial sum is useful, but cannot truthfully carry
 * the complete-score risk band or its reassuring/escalation action.
 */
export function presentNews2Record(row) {
  if (!row) return row;
  const partial = row.partial_score === true;
  const missing = Array.isArray(row.missing_params) ? row.missing_params : [];
  return {
    ...row,
    clinical_risk: partial ? null : row.clinical_risk,
    escalation_action: partial ? null : row.escalation_action,
    risk_band_available: !partial,
    display: partial
      ? `NEWS2 ${row.total_score} (partial; risk band unavailable${missing.length ? `; missing ${missing.join(', ')}` : ''})`
      : `NEWS2 ${row.total_score}${row.clinical_risk ? ` (${String(row.clinical_risk).replace(/_/g, ' ')})` : ''}`,
  };
}

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
 * @param {{ db?: object, spo2Scale?: 1|2, vitalsChartId?: number|null, recordedAt?: Date|string|null }}
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
  const recordedAt = options.recordedAt ?? vitals.recorded_at ?? null;
  if (recordedAt != null && !Number.isFinite(new Date(recordedAt).getTime())) {
    throw AppError.badRequest('NEWS2 recorded_at must be a valid timestamp');
  }
  // PrismaPg/pg can represent timestamptz through local wall time at the raw
  // boundary. Carry epoch milliseconds instead so a source Date cannot move by
  // the server/client timezone offset on write or RETURNING.
  const recordedAtEpochMs = recordedAt == null ? Date.now() : new Date(recordedAt).getTime();

  const rows = await db.$queryRawUnsafe(
    `INSERT INTO news2_scores
       (patient_uid, respiration_rate, spo2, spo2_scale, supplemental_o2,
        temperature, systolic_bp, heart_rate, consciousness,
        total_score, clinical_risk, escalation_action, recorded_by,
        vitals_chart_id, partial_score, missing_params, recorded_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid,
             $14::int, $15, $16::text[], to_timestamp($17::double precision / 1000.0))
     RETURNING id, patient_uid, total_score, clinical_risk, clinical_risk AS risk_level,
               vitals_chart_id, partial_score, missing_params,
               recorded_by, recorded_at, created_at,
               (EXTRACT(EPOCH FROM recorded_at) * 1000)::double precision AS recorded_at_epoch_ms`,
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
    recordedAtEpochMs,
  );

  const record = rows[0];
  if (Number.isFinite(Number(record?.recorded_at_epoch_ms))) {
    record.recorded_at = new Date(Number(record.recorded_at_epoch_ms));
  }
  delete record?.recorded_at_epoch_ms;
  return { record, computed };
}

/**
 * Mark every LIVE NEWS2 score derived from a given vitals_chart row as
 * superseded. A replacement id records the append-only successor; null is
 * valid when a correction removed the final scorable parameter and therefore
 * produced no replacement score. Runs on the caller's tx so retirement is
 * atomic with the correction and optional replacement insert.
 */
export async function supersedeNews2ForVitalsRow(
  vitalsChartId,
  replacementScoreId,
  {
    db,
    tenantId = null,
    correctedBy = null,
    currentVitalAnomalies = [],
    patientId = null,
    patientUid = null,
    deferNews2TaskRetirement = false,
    replacementNews2 = null,
  } = {},
) {
  if (!vitalsChartId) return {
    scoresSuperseded: 0,
    alertsResolved: 0,
    cdsAlertsResolved: 0,
    tasksSuperseded: 0,
  };
  const client = db || prisma;
  const oldScores = await client.$queryRawUnsafe(
    `SELECT id
       FROM news2_scores
      WHERE vitals_chart_id = $1::int
        AND ($2::int IS NULL OR id <> $2::int)
        AND superseded_at IS NULL
      FOR UPDATE`,
    Number(vitalsChartId),
    replacementScoreId == null ? null : Number(replacementScoreId),
  );
  const oldScoreIds = oldScores.map((row) => String(row.id));
  if (!tenantId || !correctedBy) {
    throw AppError.internal('NEWS2 correction consequence cleanup requires tenant and correcting actor');
  }

  const existingAlertRows = await client.$queryRawUnsafe(
    `SELECT id, vital_name, severity
       FROM clinical_alerts
      WHERE tenant_id = $1::uuid
        AND source_vitals_chart_id = $2::int
        AND COALESCE(acknowledged, FALSE) = FALSE
        AND acknowledged_at IS NULL
      ORDER BY id DESC
      FOR UPDATE`,
    tenantId,
    Number(vitalsChartId),
  );
  const currentByVitalName = new Map(
    currentVitalAnomalies.map((alert) => [String(alert.vital_name), alert]),
  );
  const activeAlertIdsByVitalName = {};
  const demotedCriticalAlertIds = [];

  for (const [vitalName, alert] of currentByVitalName) {
    const existingForVital = existingAlertRows.filter((row) => row.vital_name === vitalName);
    if (existingForVital.length > 0) {
      const ids = existingForVital.map((row) => Number(row.id));
      if (String(alert.severity).toUpperCase() !== 'CRITICAL') {
        demotedCriticalAlertIds.push(
          ...existingForVital
            .filter((row) => String(row.severity).toUpperCase() === 'CRITICAL')
            .map((row) => Number(row.id)),
        );
      }
      await client.$executeRawUnsafe(
        `UPDATE clinical_alerts
            SET vital_value = $2,
                severity = $3,
                message = $4
          WHERE id = ANY($1::int[])
            AND tenant_id = $5::uuid`,
        ids,
        alert.value,
        alert.severity,
        alert.message,
        tenantId,
      );
      activeAlertIdsByVitalName[vitalName] = ids[0];
      continue;
    }

    if (!patientId) {
      throw AppError.internal('NEWS2 correction alert reconciliation requires patient identity');
    }
    const inserted = await client.$queryRawUnsafe(
      `INSERT INTO clinical_alerts
         (patient_id, alert_type, vital_name, vital_value, severity, message,
          created_by, source_vitals_chart_id, tenant_id, created_at)
       VALUES ($1::int, 'VITAL_ANOMALY', $2, $3, $4, $5, $6::int, $7::int, $8::uuid, NOW())
       RETURNING id`,
      Number(patientId),
      vitalName,
      alert.value,
      alert.severity,
      alert.message,
      alert.recorded_by == null ? null : Number(alert.recorded_by),
      Number(vitalsChartId),
      tenantId,
    );
    activeAlertIdsByVitalName[vitalName] = Number(inserted[0].id);
  }

  const resolvedAlertIds = existingAlertRows
    .filter((row) => !currentByVitalName.has(String(row.vital_name)))
    .map((row) => Number(row.id));
  if (resolvedAlertIds.length > 0) {
    await client.$executeRawUnsafe(
      `UPDATE clinical_alerts
          SET acknowledged = TRUE,
              acknowledged_at = COALESCE(acknowledged_at, NOW())
        WHERE tenant_id = $1::uuid
          AND id = ANY($2::int[])`,
      tenantId,
      resolvedAlertIds,
    );
  }
  const retiredAlertTaskIdTexts = [...new Set([
    ...resolvedAlertIds,
    ...demotedCriticalAlertIds,
  ])].map(String);

  const existingAlertIdTexts = existingAlertRows.map((row) => String(row.id));
  const pregnancyCdsRows = await client.$queryRawUnsafe(
    `SELECT id,
            alert_type,
            severity,
            source_data->>'clinical_alert_id' AS clinical_alert_id,
            source_data->>'vital_name' AS vital_name
       FROM cds_alerts
      WHERE tenant_id = $1::uuid
        AND COALESCE(acknowledged, FALSE) = FALSE
        AND alert_type IN ('PREGNANCY_HYPERTENSION', 'PREECLAMPSIA_SCREEN_POSITIVE')
        AND (
          source_data->>'source_vitals_chart_id' = $2::text
          OR source_data->>'clinical_alert_id' = ANY($3::text[])
        )
      FOR UPDATE`,
    tenantId,
    String(vitalsChartId),
    existingAlertIdTexts,
  );
  const currentPregnancyByAlertId = new Map();
  const currentPregnancyByVitalName = new Map();
  for (const [vitalName, alert] of currentByVitalName) {
    if (alert.is_pregnancy_bp_signal !== true) continue;
    const clinicalAlertId = activeAlertIdsByVitalName[vitalName];
    if (clinicalAlertId == null) continue;
    const current = { alert, clinicalAlertId, vitalName };
    currentPregnancyByAlertId.set(String(clinicalAlertId), current);
    currentPregnancyByVitalName.set(vitalName, current);
  }

  let pregnancyCdsResolved = 0;
  let pregnancyCdsReconciled = 0;
  const reconciledPregnancyAlertIds = new Set();
  for (const cdsRow of pregnancyCdsRows) {
    const current = currentPregnancyByAlertId.get(String(cdsRow.clinical_alert_id))
      || currentPregnancyByVitalName.get(String(cdsRow.vital_name));
    if (!current) {
      const acknowledged = await client.$queryRawUnsafe(
        `UPDATE cds_alerts
            SET acknowledged = TRUE,
                ack_at = COALESCE(ack_at, NOW())
          WHERE tenant_id = $1::uuid
            AND id = $2::int
            AND COALESCE(acknowledged, FALSE) = FALSE
            AND alert_type IN ('PREGNANCY_HYPERTENSION', 'PREECLAMPSIA_SCREEN_POSITIVE')
          RETURNING id`,
        tenantId,
        Number(cdsRow.id),
      );
      pregnancyCdsResolved += acknowledged.length;
      continue;
    }

    const { alert, clinicalAlertId, vitalName } = current;
    const alertType = vitalName === 'preeclampsia_screen'
      ? 'PREECLAMPSIA_SCREEN_POSITIVE'
      : 'PREGNANCY_HYPERTENSION';
    const title = vitalName === 'preeclampsia_screen'
      ? 'Positive pre-eclampsia screen'
      : `Gestational hypertension (${vitalName.replace(/_/g, ' ')} ${alert.value}${alert.unit})`;
    const updated = await client.$queryRawUnsafe(
      `UPDATE cds_alerts
          SET alert_type = $3,
              severity = $4,
              title = $5,
              description = $6,
              source_data = COALESCE(source_data, '{}'::jsonb) || $7::jsonb
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND COALESCE(acknowledged, FALSE) = FALSE
          AND alert_type IN ('PREGNANCY_HYPERTENSION', 'PREECLAMPSIA_SCREEN_POSITIVE')
        RETURNING id`,
      tenantId,
      Number(cdsRow.id),
      alertType,
      alert.severity,
      title,
      alert.message,
      JSON.stringify({
        vital_name: vitalName,
        value: alert.value,
        unit: alert.unit,
        normal_range: alert.normal_range,
        cohort: alert.cohort,
        clinical_alert_id: clinicalAlertId,
        source_vitals_chart_id: Number(vitalsChartId),
        source: 'vitals.corrected',
      }),
    );
    pregnancyCdsReconciled += updated.length;
    reconciledPregnancyAlertIds.add(String(clinicalAlertId));
  }

  for (const { alert, clinicalAlertId, vitalName } of currentPregnancyByAlertId.values()) {
    if (reconciledPregnancyAlertIds.has(String(clinicalAlertId))) continue;
    if (!patientUid) {
      throw AppError.internal('Pregnancy CDS reconciliation requires patient identity');
    }
    const alertType = vitalName === 'preeclampsia_screen'
      ? 'PREECLAMPSIA_SCREEN_POSITIVE'
      : 'PREGNANCY_HYPERTENSION';
    const title = vitalName === 'preeclampsia_screen'
      ? 'Positive pre-eclampsia screen'
      : `Gestational hypertension (${vitalName.replace(/_/g, ' ')} ${alert.value}${alert.unit})`;
    const inserted = await client.$queryRawUnsafe(
      `INSERT INTO cds_alerts
         (patient_uid, alert_type, severity, title, description, source_data)
       SELECT $1::uuid, $2, $3, $4, $5, $6::jsonb
        WHERE NOT EXISTS (
          SELECT 1
            FROM cds_alerts
           WHERE tenant_id = $7::uuid
             AND COALESCE(acknowledged, FALSE) = FALSE
             AND alert_type IN ('PREGNANCY_HYPERTENSION', 'PREECLAMPSIA_SCREEN_POSITIVE')
             AND source_data->>'clinical_alert_id' = $8::text
        )
       RETURNING id`,
      patientUid,
      alertType,
      alert.severity,
      title,
      alert.message,
      JSON.stringify({
        vital_name: vitalName,
        value: alert.value,
        unit: alert.unit,
        normal_range: alert.normal_range,
        cohort: alert.cohort,
        clinical_alert_id: clinicalAlertId,
        source_vitals_chart_id: Number(vitalsChartId),
        source: 'vitals.corrected',
      }),
      tenantId,
      String(clinicalAlertId),
    );
    pregnancyCdsReconciled += inserted.length;
  }

  let news2CdsRows;
  let cdsAlertsResolved = pregnancyCdsResolved;
  let cdsAlertsReconciled = pregnancyCdsReconciled;
  if (deferNews2TaskRetirement && replacementNews2) {
    news2CdsRows = await client.$queryRawUnsafe(
      `UPDATE cds_alerts
          SET severity = $4,
              title = $5,
              description = $6,
              source_data = COALESCE(source_data, '{}'::jsonb) || jsonb_build_object(
                'news2_score_id', $7::text,
                'vitals_chart_id', $3::int,
                'total_score', $8::int,
                'clinical_risk', $9::text
              )
        WHERE tenant_id = $1::uuid
          AND COALESCE(acknowledged, FALSE) = FALSE
          AND alert_type = 'NEWS2_DETERIORATION'
          AND (
            source_data->>'news2_score_id' = ANY($2::text[])
            OR source_data->>'vitals_chart_id' = $3::text
          )
        RETURNING id`,
      tenantId,
      oldScoreIds,
      String(vitalsChartId),
      replacementNews2.severity,
      replacementNews2.title,
      replacementNews2.description,
      String(replacementScoreId),
      Number(replacementNews2.totalScore),
      replacementNews2.clinicalRisk,
    );
    cdsAlertsReconciled += news2CdsRows.length;
  } else {
    news2CdsRows = await client.$queryRawUnsafe(
      `UPDATE cds_alerts
          SET acknowledged = TRUE,
              ack_at = COALESCE(ack_at, NOW())
        WHERE tenant_id = $1::uuid
          AND COALESCE(acknowledged, FALSE) = FALSE
          AND alert_type = 'NEWS2_DETERIORATION'
          AND (
            source_data->>'news2_score_id' = ANY($2::text[])
            OR source_data->>'vitals_chart_id' = $3::text
          )
        RETURNING id`,
      tenantId,
      oldScoreIds,
      String(vitalsChartId),
    );
    cdsAlertsResolved += news2CdsRows.length;
  }

  const tasks = await client.$queryRawUnsafe(
    `SELECT id, related_resource_type, related_resource_id, workflow_sla_instance_id
       FROM tasks
      WHERE tenant_id = $1::uuid
        AND status IN ('open', 'overdue', 'in_progress', 'blocked')
        AND (
           (related_resource_type = 'news2_score' AND related_resource_id = ANY($2::text[])
            AND $4::boolean = FALSE)
           OR
           (related_resource_type = 'clinical_alert' AND related_resource_id = ANY($3::text[]))
        )
      FOR UPDATE`,
    tenantId,
    oldScoreIds,
    retiredAlertTaskIdTexts,
    deferNews2TaskRetirement,
  );
  if (tasks.length > 0) {
    const { supersedeAcknowledgementTaskFromTrustedWorkflow } = await import('../workflow/taskService.js');
    for (const task of tasks) {
      await supersedeAcknowledgementTaskFromTrustedWorkflow({
        tenantId,
        id: task.id,
        relatedResourceType: task.related_resource_type,
        relatedResourceId: task.related_resource_id,
        workflowSlaInstanceId: task.workflow_sla_instance_id,
        supersededByActorUid: correctedBy,
        supersessionReason: 'superseded_by_correction',
        tx: client,
      });
    }
  }

  const scoresSuperseded = await client.$executeRawUnsafe(
    `UPDATE news2_scores
        SET superseded_by_id = $1::int,
            superseded_at = NOW()
      WHERE vitals_chart_id = $2::int
        AND ($1::int IS NULL OR id <> $1::int)
        AND superseded_at IS NULL`,
    replacementScoreId == null ? null : Number(replacementScoreId),
    Number(vitalsChartId),
  );
  return {
    scoresSuperseded,
    alertsResolved: resolvedAlertIds.length,
    alertsReconciled: Object.keys(activeAlertIdsByVitalName).length,
    activeAlertIdsByVitalName,
    cdsAlertsResolved,
    cdsAlertsReconciled,
    tasksSuperseded: tasks.length,
  };
}

/**
 * Complete the safe hand-off from an old NEWS2 escalation task only after the
 * replacement score's task has been durably created. If this cleanup fails,
 * the old task remains open alongside the replacement; there is never a period
 * in which a still-deteriorating patient has no acknowledgement owner.
 */
export async function retireSupersededNews2TasksAfterReplacement(
  vitalsChartId,
  { tenantId = null, correctedBy = null } = {},
) {
  if (!vitalsChartId) return { tasksSuperseded: 0 };
  if (!tenantId || !correctedBy) {
    throw AppError.internal('NEWS2 replacement task retirement requires tenant and correcting actor');
  }
  return setTenantTx(tenantId, async (tx) => {
    const oldScores = await tx.$queryRawUnsafe(
      `SELECT id::text AS id
         FROM news2_scores
        WHERE vitals_chart_id = $1::int
          AND superseded_at IS NOT NULL`,
      Number(vitalsChartId),
    );
    const oldScoreIds = oldScores.map((row) => String(row.id));
    if (oldScoreIds.length === 0) return { tasksSuperseded: 0 };

    const tasks = await tx.$queryRawUnsafe(
      `SELECT id, related_resource_type, related_resource_id, workflow_sla_instance_id
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND status IN ('open', 'overdue', 'in_progress', 'blocked')
          AND related_resource_type = 'news2_score'
          AND related_resource_id = ANY($2::text[])
        FOR UPDATE`,
      tenantId,
      oldScoreIds,
    );
    if (tasks.length > 0) {
      const { supersedeAcknowledgementTaskFromTrustedWorkflow } = await import('../workflow/taskService.js');
      for (const task of tasks) {
        await supersedeAcknowledgementTaskFromTrustedWorkflow({
          tenantId,
          id: task.id,
          relatedResourceType: task.related_resource_type,
          relatedResourceId: task.related_resource_id,
          workflowSlaInstanceId: task.workflow_sla_instance_id,
          supersededByActorUid: correctedBy,
          supersessionReason: 'superseded_by_correction',
          tx,
        });
      }
    }
    return { tasksSuperseded: tasks.length };
  });
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
  const sourceRecordedAt = record?.recorded_at ?? record?.assessed_at ?? null;
  if ((aggregateTrigger || singleRedTrigger) && !isNews2EscalationFresh(sourceRecordedAt)) {
    logger.info(`NEWS2 escalation suppressed for historical observation patient=${patientUid}, recorded_at=${sourceRecordedAt || 'missing'}`);
    return { skipped: true, reason: 'stale_observation' };
  }

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
    await surfaceNews2Cds({
      patientUid,
      news2: {
        totalScore,
        clinicalRisk,
        escalationAction,
        scores,
        anyParamThree,
        news2ScoreId: resourceType === 'news2_score' ? record?.id ?? null : null,
        vitalsChartId: record?.vitals_chart_id ?? null,
      },
    });
  } catch (err) {
    logger.warn(`NEWS2 CDS surfacing failed for patient ${patientUid}: ${err.message}`);
  }
  return { skipped: false };
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
    const p = await persistNews2(patientUid, vitals, recordedBy, {
      db: tx,
      spo2Scale,
      recordedAt: vitals?.recorded_at ?? options?.recordedAt ?? null,
    });
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
      summary: p.computed.partial
        ? `NEWS2 ${p.computed.totalScore} partial score recorded — risk band unavailable`
        : `NEWS2 ${p.computed.totalScore} (${p.computed.clinicalRisk.replace(/_/g, ' ')}) recorded`,
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
      occurredAt: p.record.recorded_at,
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

  const recentScores = rows.filter((row) => row.superseded_at == null).slice(0, 10);
  const latestScore = recentScores[0];
  if (latestScore?.partial_score === true) {
    return {
      scores: rows.map(presentNews2Record),
      trend: null,
      trend_available: false,
      trend_reason: 'latest_score_partial',
    };
  }
  const completeScores = recentScores.filter((row) => row.partial_score !== true);
  if (completeScores.length < 2) {
    return {
      scores: rows.map(presentNews2Record),
      trend: null,
      trend_available: false,
      trend_reason: 'insufficient_complete_scores',
    };
  }
  let trend = 'stable';
  const latest = completeScores[0].total_score;
  const previous = completeScores[1].total_score;
  if (latest > previous) trend = 'increasing';
  else if (latest < previous) trend = 'decreasing';

  return {
    scores: rows.map(presentNews2Record),
    trend,
    trend_available: true,
    trend_reason: null,
  };
}

/**
 * Patient-level NEWS2 SpO2 scale is clinical state, not profile decoration.
 * Update and canonical timeline/audit evidence therefore commit together.
 */
export async function updatePatientSpo2Scale({
  tenantId,
  patientUid,
  spo2Scale,
  actorUid,
  actorRole = null,
  idempotencyKey,
  requestId = null,
  ipAddress = null,
}) {
  const normalizedScale = normalizeSpo2Scale(spo2Scale);
  if (normalizedScale === null || spo2Scale === null || spo2Scale === '') {
    throw AppError.badRequest('spo2_scale must be 1 or 2');
  }
  const resolvedTenantId = requireTenantId(tenantId);
  if (!patientUid || !actorUid || !idempotencyKey) {
    throw AppError.badRequest('patient uid, actor, and idempotency key are required');
  }

  return setTenantTx(resolvedTenantId, async (tx) => {
    const currentRows = await tx.$queryRawUnsafe(
      `SELECT uid, news2_spo2_scale
         FROM users
        WHERE uid = $1::uuid
          AND tenant_id = $2::uuid
          AND role = 'PATIENT'
        FOR UPDATE`,
      patientUid,
      resolvedTenantId,
    );
    const current = currentRows[0];
    if (!current) throw AppError.notFound('Patient not found');
    const beforeScale = normalizeSpo2Scale(current.news2_spo2_scale) ?? 1;
    if (beforeScale === normalizedScale) {
      return { news2_spo2_scale: normalizedScale, changed: false };
    }

    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE users
          SET news2_spo2_scale = $3,
              updated_at = NOW()
        WHERE uid = $1::uuid
          AND tenant_id = $2::uuid
          AND role = 'PATIENT'
        RETURNING uid, news2_spo2_scale`,
      patientUid,
      resolvedTenantId,
      normalizedScale,
    );
    const updated = updatedRows[0];
    if (!updated) throw AppError.notFound('Patient not found');

    // The public contract accepts 200-character request keys, while the
    // canonical timeline/audit columns are VARCHAR(220). Prefixing the raw key
    // can exceed that limit, so use a fixed-width, collision-resistant digest.
    const stableKey = createHash('sha256')
      .update(String(idempotencyKey), 'utf8')
      .digest('hex');
    await recordCanonicalClinicalEvent({
      tenantId: resolvedTenantId,
      patientUid,
      eventType: 'news2.spo2_scale_updated',
      eventStatus: 'updated',
      sourceTable: 'users',
      sourceId: patientUid,
      resourceType: 'patient_news2_spo2_scale',
      resourceId: patientUid,
      actorUid,
      actorRole,
      summary: `NEWS2 SpO2 scale changed from ${beforeScale} to ${normalizedScale}`,
      beforeState: { news2_spo2_scale: beforeScale },
      afterState: { news2_spo2_scale: normalizedScale },
      payload: { request_id: requestId, ip_address: ipAddress },
      timelineIdempotencyKey: `patient:${patientUid}:news2-spo2-scale:${stableKey}`,
      auditIdempotencyKey: `patient:${patientUid}:news2-spo2-scale:audit:${stableKey}`,
      tags: ['news2', 'spo2-scale'],
    }, { db: tx, strict: true });

    return { ...updated, changed: true };
  });
}

export default {
  calculateNEWS2,
  getClinicalRisk,
  normalizeSpo2Scale,
  resolveSpo2ScaleForPatient,
  persistNews2,
  supersedeNews2ForVitalsRow,
  retireSupersededNews2TasksAfterReplacement,
  escalateNews2,
  recordNEWS2,
  getPatientNEWS2History,
  isNews2EscalationFresh,
  presentNews2Record,
  updatePatientSpo2Scale,
};

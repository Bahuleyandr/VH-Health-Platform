import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { dispatch } from '../notifications/notificationDispatcher.js';
import { emitVitalAnomaly, emitCodeBlue } from '../websocket/realtimeEmitter.js';

/**
 * Adult clinical reference ranges (default).
 */
const ADULT_RANGES = {
  heart_rate: { min: 40, max: 150, critical_min: 30, critical_max: 180, unit: 'bpm' },
  systolic_bp: { min: 80, max: 160, critical_min: 60, critical_max: 200, unit: 'mmHg' },
  diastolic_bp: { min: 50, max: 100, critical_min: 40, critical_max: 120, unit: 'mmHg' },
  temperature: { min: 35.5, max: 38.5, critical_min: 34.0, critical_max: 40.0, unit: '°C' },
  oxygen_saturation: { min: 92, max: 100, critical_min: 85, critical_max: 100, unit: '%' },
  respiratory_rate: { min: 10, max: 24, critical_min: 6, critical_max: 35, unit: '/min' },
  blood_glucose: { min: 70, max: 180, critical_min: 50, critical_max: 400, unit: 'mg/dL' },
};

/**
 * Paediatric ranges (broad — covers 1y–12y as a single band; intentionally
 * permissive rather than wrong-direction strict). Refined per-age-band tables
 * are a follow-up; the immediate patient-safety fix is to stop applying adult
 * ranges to children. See finding
 * 2026-05-08-pediatric-opd-nurse-adult-vital-ranges.
 */
const PAEDIATRIC_RANGES = {
  heart_rate: { min: 70, max: 140, critical_min: 50, critical_max: 200, unit: 'bpm' },
  systolic_bp: { min: 75, max: 115, critical_min: 60, critical_max: 130, unit: 'mmHg' },
  diastolic_bp: { min: 45, max: 80, critical_min: 35, critical_max: 95, unit: 'mmHg' },
  temperature: { min: 35.5, max: 38.0, critical_min: 34.0, critical_max: 40.0, unit: '°C' },
  oxygen_saturation: { min: 94, max: 100, critical_min: 88, critical_max: 100, unit: '%' },
  respiratory_rate: { min: 18, max: 40, critical_min: 10, critical_max: 60, unit: '/min' },
  blood_glucose: { min: 60, max: 180, critical_min: 40, critical_max: 400, unit: 'mg/dL' },
};

/**
 * Pregnancy-specific BP thresholds. Gestational hypertension is ≥140
 * systolic OR ≥90 diastolic; severe / pre-eclampsia is ≥160 / ≥110. Other
 * vitals fall back to adult ranges. See finding
 * 2026-05-08-obstetric-anc-nurse-bp-no-preeclampsia-alert.
 */
const PREGNANCY_BP_OVERRIDES = {
  systolic_bp: { min: 90, max: 140, critical_min: 70, critical_max: 160, unit: 'mmHg', preeclampsia: true },
  diastolic_bp: { min: 50, max: 90, critical_min: 40, critical_max: 110, unit: 'mmHg', preeclampsia: true },
};

/**
 * Resolve patient context (age, pregnancy state) for picking the right
 * range table. Best-effort — if the lookup fails we fall back to adult
 * ranges (caller is unaffected, no exception escapes).
 */
async function resolvePatientContext(patientId) {
  if (!patientId) return { isPaediatric: false, isPregnant: false };
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         CASE WHEN birthday IS NOT NULL THEN
           DATE_PART('year', AGE(NOW()::date, birthday))::int
         ELSE NULL END AS age_years,
         COALESCE(is_pregnant, FALSE) AS is_pregnant
       FROM users WHERE id = $1 LIMIT 1`,
      patientId,
    );
    const row = rows[0] ?? {};
    const ageYears = row.age_years ?? null;
    const isPaediatric = ageYears !== null && ageYears < 12;
    const isPregnant = row.is_pregnant === true;
    return { isPaediatric, isPregnant, ageYears };
  } catch (err) {
    logger.warn(`vitalSignMonitor: patient context lookup failed for patient=${patientId}: ${err.message}`);
    return { isPaediatric: false, isPregnant: false };
  }
}

function pickRanges({ isPaediatric, isPregnant }) {
  let table = isPaediatric ? PAEDIATRIC_RANGES : ADULT_RANGES;
  if (isPregnant) {
    // Pregnancy BP overrides on top of the adult table.
    table = { ...table, ...PREGNANCY_BP_OVERRIDES };
  }
  return table;
}

/**
 * Check vitals against reference ranges and generate alerts for abnormal values.
 * Call this after any vital sign is recorded.
 * @param {number} patientId - Patient DB ID
 * @param {Object} vitals - { heart_rate, systolic_bp, diastolic_bp, temperature, oxygen_saturation, ... }
 * @param {Object} context - { recordedBy, requestId }
 * @returns {Array} alerts - Array of generated alerts
 */
export async function checkVitalAnomalies(patientId, vitals, context = {}) {
  const alerts = [];

  const patientCtx = await resolvePatientContext(patientId);
  const ranges = pickRanges(patientCtx);

  for (const [vitalName, value] of Object.entries(vitals)) {
    if (value === null || !ranges[vitalName]) continue;

    const range = ranges[vitalName];
    const numValue = parseFloat(value);
    if (isNaN(numValue)) continue;

    let severity = null;
    if (numValue <= range.critical_min || numValue >= range.critical_max) {
      severity = 'CRITICAL';
    } else if (numValue < range.min || numValue > range.max) {
      severity = 'WARNING';
    }

    if (severity) {
      const cohortLabel = patientCtx.isPaediatric
        ? `paediatric${patientCtx.ageYears != null ? `, age ${patientCtx.ageYears}y` : ''}`
        : patientCtx.isPregnant
          ? 'pregnant'
          : 'adult';
      const direction = numValue < range.min ? 'low' : 'high';
      const isPreeclampsiaSignal = range.preeclampsia === true && direction === 'high';
      const message = isPreeclampsiaSignal
        ? `Pregnancy-induced hypertension: ${vitalName.replace(/_/g, ' ')} ${numValue}${range.unit} is ${severity === 'CRITICAL' ? 'critically high — possible severe pre-eclampsia' : 'high — recheck BP and dipstick urine for proteinuria'} (${cohortLabel} normal: ${range.min}-${range.max}${range.unit}).`
        : `${vitalName.replace(/_/g, ' ')} ${numValue}${range.unit} is ${severity === 'CRITICAL' ? 'critically' : ''} ${direction} (${cohortLabel} normal: ${range.min}-${range.max}${range.unit})`;

      const alert = {
        patient_id: patientId,
        vital_name: vitalName,
        value: numValue,
        unit: range.unit,
        severity,
        normal_range: `${range.min}-${range.max}`,
        cohort: cohortLabel,
        message,
        recorded_by: context.recordedBy,
      };
      alerts.push(alert);
    }
  }

  // PATIENT SAFETY: Alerts are persisted synchronously — a CRITICAL vital sign alert
  // must never be silently lost due to fire-and-forget (setImmediate). If persistence
  // fails, the error propagates to the caller so it can be handled appropriately.
  if (alerts.length > 0) {
    for (const alert of alerts) {
      await prisma.$queryRawUnsafe(
        `INSERT INTO clinical_alerts (patient_id, alert_type, vital_name, vital_value, severity, message, created_by, created_at)
         VALUES ($1, 'VITAL_ANOMALY', $2, $3, $4, $5, $6, NOW())`,
        alert.patient_id, alert.vital_name, alert.value, alert.severity, alert.message, alert.recorded_by
      );

      // Realtime fabric: push to staff clinical-alerts channel (all severities);
      // CRITICAL also fans out on staff:code-blue for full-screen staff-app alerts.
      emitVitalAnomaly(alert);
      if (alert.severity === 'CRITICAL' && isCodeBlueVital(alert.vital_name)) {
        emitCodeBlue({
          patientId: alert.patient_id,
          triggeredBy: alert.recorded_by,
          reason: alert.message,
        });
      }

      // Dispatch notification to the responsible clinician for CRITICAL alerts
      if (alert.severity === 'CRITICAL') {
        try {
          await dispatch({
            userId: String(alert.recorded_by),
            title: `CRITICAL Vital Alert — Patient #${alert.patient_id}`,
            body: alert.message,
            channels: ['push', 'inapp'],
            data: { patient_id: String(alert.patient_id), vital_name: alert.vital_name, severity: 'CRITICAL' },
            type: 'clinical_alert',
          });
        } catch (notifyErr) {
          // Notification failure must not block alert persistence — log and continue
          logger.error(`Failed to dispatch CRITICAL alert notification for patient ${alert.patient_id}:`, notifyErr.message);
        }
      }
    }
    logger.warn(`Clinical alerts generated for patient ${patientId} (${patientCtx.isPaediatric ? 'paediatric' : patientCtx.isPregnant ? 'pregnant' : 'adult'}):`, alerts.map(a => `${a.vital_name}=${a.value} (${a.severity})`).join(', '));
  }

  return alerts;
}

// Vitals whose CRITICAL breach constitutes a Code Blue event
// (cardiopulmonary failure signals — HR, SpO2, respiratory rate, systolic BP collapse).
const CODE_BLUE_VITALS = new Set(['heart_rate', 'oxygen_saturation', 'respiratory_rate', 'systolic_bp']);
function isCodeBlueVital(name) {
  return CODE_BLUE_VITALS.has(name);
}

// Backward-compat export — callers used to read VITAL_REFERENCE_RANGES
// directly. Keep it as the adult table since that was the previous single
// source of truth.
const VITAL_REFERENCE_RANGES = ADULT_RANGES;
export { VITAL_REFERENCE_RANGES, ADULT_RANGES, PAEDIATRIC_RANGES, PREGNANCY_BP_OVERRIDES };
export default { checkVitalAnomalies, VITAL_REFERENCE_RANGES, ADULT_RANGES, PAEDIATRIC_RANGES, PREGNANCY_BP_OVERRIDES };

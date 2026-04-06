// src/services/emr/vitalsChartService.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { checkVitalAnomalies } from '../../utils/clinical/vitalSignMonitor.js';
import news2Service from '../clinical/news2Service.js';


// ===================================================================
// Vitals Charting Service
// ===================================================================

const VALID_VITAL_TYPES = [
  'heart_rate', 'systolic_bp', 'diastolic_bp', 'temperature', 'spo2',
  'respiratory_rate', 'blood_glucose', 'pain_score', 'weight_kg',
  'height_cm', 'gcs_score', 'o2_flow_rate',
];

const VALID_IO_TYPES = ['intake', 'output'];
const VALID_IO_CATEGORIES = ['oral', 'iv', 'blood', 'urine', 'drain', 'vomit', 'stool', 'other'];
const VALID_CONSCIOUSNESS = ['A', 'C', 'V', 'P', 'U'];

// ===================================================================
// recordVitals
// ===================================================================

/**
 * Record a vitals entry and auto-trigger NEWS2 + anomaly checks.
 * @param {Object} data - Vitals data
 * @returns {Object} Created vitals record with any alerts
 */
export async function recordVitals(data) {
  const {
    patient_uid,
    encounter_id,
    heart_rate,
    systolic_bp,
    diastolic_bp,
    temperature,
    spo2,
    respiratory_rate,
    blood_glucose,
    pain_score,
    weight_kg,
    height_cm,
    gcs_score,
    supplemental_o2,
    o2_flow_rate,
    consciousness,
    notes,
    recorded_by,
  } = data;

  if (!patient_uid || !recorded_by) {
    throw AppError.badRequest('patient_uid and recorded_by are required');
  }

  // Validate at least one vital sign is provided
  const vitalValues = [heart_rate, systolic_bp, diastolic_bp, temperature, spo2,
    respiratory_rate, blood_glucose, pain_score, weight_kg, height_cm, gcs_score];
  if (vitalValues.every((v) => v === undefined || v === null)) {
    throw AppError.badRequest('At least one vital sign measurement is required');
  }

  // Validate pain score range
  if (pain_score !== undefined && pain_score !== null && (pain_score < 0 || pain_score > 10)) {
    throw AppError.badRequest('pain_score must be between 0 and 10');
  }

  // Validate GCS range
  if (gcs_score !== undefined && gcs_score !== null && (gcs_score < 3 || gcs_score > 15)) {
    throw AppError.badRequest('gcs_score must be between 3 and 15');
  }

  // Validate consciousness level
  if (consciousness && !VALID_CONSCIOUSNESS.includes(consciousness)) {
    throw AppError.badRequest(`consciousness must be one of: ${VALID_CONSCIOUSNESS.join(', ')}`);
  }

  const { rows } = await prisma.$queryRawUnsafe(
    `INSERT INTO vitals_chart
       (patient_uid, encounter_id, heart_rate, systolic_bp, diastolic_bp, temperature,
        spo2, respiratory_rate, blood_glucose, pain_score, weight_kg, height_cm,
        gcs_score, supplemental_o2, o2_flow_rate, consciousness, notes, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())
     RETURNING id, patient_uid, encounter_id, heart_rate, systolic_bp, diastolic_bp,
               temperature, spo2, respiratory_rate, blood_glucose, pain_score,
               weight_kg, height_cm, gcs_score, supplemental_o2, o2_flow_rate,
               consciousness, notes, recorded_by, recorded_at`,
    [
      patient_uid,
      encounter_id || null,
      heart_rate ?? null,
      systolic_bp ?? null,
      diastolic_bp ?? null,
      temperature ?? null,
      spo2 ?? null,
      respiratory_rate ?? null,
      blood_glucose ?? null,
      pain_score ?? null,
      weight_kg ?? null,
      height_cm ?? null,
      gcs_score ?? null,
      supplemental_o2 ?? false,
      o2_flow_rate ?? null,
      consciousness || null,
      notes || null,
      recorded_by,
    ]
  );

  const record = rows[0];
  let alerts = [];
  let news2Result = null;

  // Auto-trigger NEWS2 calculation if core vitals are present
  if (respiratory_rate !== null && spo2 !== null && temperature !== null &&
      systolic_bp !== null && heart_rate !== null && consciousness) {
    try {
      news2Result = await news2Service.recordNEWS2(patient_uid, {
        respiration_rate: respiratory_rate,
        spo2,
        temperature,
        systolic_bp,
        heart_rate,
        consciousness,
        supplemental_o2: supplemental_o2 || false,
      }, recorded_by);
    } catch (err) {
      logger.warn(`NEWS2 auto-calculation failed for patient=${patient_uid}: ${err.message}`);
    }
  }

  // Auto-check for vital sign anomalies
  try {
    const vitalsForCheck = {};
    if (heart_rate !== null) vitalsForCheck.heart_rate = heart_rate;
    if (systolic_bp !== null) vitalsForCheck.systolic_bp = systolic_bp;
    if (diastolic_bp !== null) vitalsForCheck.diastolic_bp = diastolic_bp;
    if (temperature !== null) vitalsForCheck.temperature = temperature;
    if (spo2 !== null) vitalsForCheck.oxygen_saturation = spo2;
    if (respiratory_rate !== null) vitalsForCheck.respiratory_rate = respiratory_rate;

    if (Object.keys(vitalsForCheck).length > 0) {
      alerts = await checkVitalAnomalies(patient_uid, vitalsForCheck, {
        recordedBy: recorded_by,
      });
    }
  } catch (err) {
    logger.warn(`Vital anomaly check failed for patient=${patient_uid}: ${err.message}`);
  }

  logger.info(`Vitals recorded: id=${record.id}, patient=${patient_uid}, by=${recorded_by}`);

  return {
    vitals: record,
    news2: news2Result,
    alerts: alerts || [],
  };
}

// ===================================================================
// getVitalsTrend
// ===================================================================

/**
 * Get time-series data for a specific vital sign.
 * @param {string} patientUid
 * @param {string} vitalType - Column name (e.g., 'heart_rate', 'systolic_bp')
 * @param {string|null} dateFrom
 * @param {string|null} dateTo
 * @returns {Array} Array of { timestamp, value }
 */
export async function getVitalsTrend(patientUid, vitalType, dateFrom, dateTo) {
  if (!VALID_VITAL_TYPES.includes(vitalType)) {
    throw AppError.badRequest(`Invalid vital type: ${vitalType}. Must be one of: ${VALID_VITAL_TYPES.join(', ')}`);
  }

  const conditions = ['patient_uid = $1', `${vitalType} IS NOT NULL`];
  const params = [patientUid];
  let paramIdx = 2;

  if (dateFrom) {
    conditions.push(`recorded_at >= $${paramIdx}`);
    params.push(dateFrom);
    paramIdx++;
  }

  if (dateTo) {
    conditions.push(`recorded_at <= $${paramIdx}`);
    params.push(dateTo);
    paramIdx++;
  }

  // vitalType is validated against VALID_VITAL_TYPES whitelist above — safe for interpolation
  const { rows } = await prisma.$queryRawUnsafe(
    `SELECT recorded_at AS timestamp, ${vitalType} AS value
     FROM vitals_chart
     WHERE ${conditions.join(' AND ')}
     ORDER BY recorded_at ASC`,
    params
  );

  return rows;
}

// ===================================================================
// getLatestVitals
// ===================================================================

/**
 * Get the most recent complete set of vitals for a patient.
 * @param {string} patientUid
 * @returns {Object|null} Latest vitals record
 */
export async function getLatestVitals(patientUid) {
  const { rows } = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, encounter_id, heart_rate, systolic_bp, diastolic_bp,
            temperature, spo2, respiratory_rate, blood_glucose, pain_score,
            weight_kg, height_cm, gcs_score, supplemental_o2, o2_flow_rate,
            consciousness, notes, recorded_by, recorded_at
     FROM vitals_chart
     WHERE patient_uid = $1
     ORDER BY recorded_at DESC
     LIMIT 1`,
    [patientUid]
  );

  return rows.length > 0 ? rows[0] : null;
}

// ===================================================================
// getVitalsChart
// ===================================================================

/**
 * Get all vitals for an encounter, paginated.
 * @param {string} patientUid
 * @param {string|null} encounterId
 * @param {Object} pagination - { page?, limit? }
 * @returns {Object} { vitals, pagination }
 */
export async function getVitalsChart(patientUid, encounterId, pagination = {}) {
  const { page = 1, limit = 50 } = pagination;

  const conditions = ['patient_uid = $1'];
  const params = [patientUid];
  let paramIdx = 2;

  if (encounterId) {
    conditions.push(`encounter_id = $${paramIdx}`);
    params.push(encounterId);
    paramIdx++;
  }

  const whereClause = conditions.join(' AND ');
  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10)), 100);
  const offset = (Math.max(1, parseInt(page, 10)) - 1) * safeLimit;

  const { rows: countRows } = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS total FROM vitals_chart WHERE ${whereClause}`,
    params
  );
  const total = parseInt(countRows[0].total, 10);

  const { rows } = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, encounter_id, heart_rate, systolic_bp, diastolic_bp,
            temperature, spo2, respiratory_rate, blood_glucose, pain_score,
            weight_kg, height_cm, gcs_score, supplemental_o2, o2_flow_rate,
            consciousness, notes, recorded_by, recorded_at
     FROM vitals_chart
     WHERE ${whereClause}
     ORDER BY recorded_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, safeLimit, offset]
  );

  return {
    vitals: rows,
    pagination: {
      page: parseInt(page, 10),
      limit: safeLimit,
      total,
      total_pages: Math.ceil(total / safeLimit),
    },
  };
}

// ===================================================================
// recordIntakeOutput
// ===================================================================

/**
 * Record an intake/output entry.
 * @param {Object} data - { patient_uid, encounter_id?, io_type, category, amount_ml, description?, recorded_by }
 * @returns {Object} Created I/O record
 */
export async function recordIntakeOutput(data) {
  const { patient_uid, encounter_id, io_type, category, amount_ml, description, recorded_by } = data;

  if (!patient_uid || !io_type || !category || amount_ml === undefined || !recorded_by) {
    throw AppError.badRequest('patient_uid, io_type, category, amount_ml, and recorded_by are required');
  }

  if (!VALID_IO_TYPES.includes(io_type)) {
    throw AppError.badRequest(`Invalid io_type: ${io_type}. Must be one of: ${VALID_IO_TYPES.join(', ')}`);
  }

  if (!VALID_IO_CATEGORIES.includes(category)) {
    throw AppError.badRequest(`Invalid category: ${category}. Must be one of: ${VALID_IO_CATEGORIES.join(', ')}`);
  }

  if (typeof amount_ml !== 'number' || amount_ml < 0) {
    throw AppError.badRequest('amount_ml must be a non-negative number');
  }

  const { rows } = await prisma.$queryRawUnsafe(
    `INSERT INTO intake_output
       (patient_uid, encounter_id, io_type, category, amount_ml, description, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     RETURNING id, patient_uid, encounter_id, io_type, category, amount_ml, description, recorded_by, recorded_at`,
    [patient_uid, encounter_id || null, io_type, category, amount_ml, description || null, recorded_by]
  );

  logger.info(`I/O recorded: id=${rows[0].id}, type=${io_type}, category=${category}, amount=${amount_ml}ml, patient=${patient_uid}`);
  return rows[0];
}

// ===================================================================
// getIOBalance
// ===================================================================

/**
 * Calculate fluid balance for a specific day (total intake - total output).
 * @param {string} patientUid
 * @param {string|null} encounterId
 * @param {string} date - ISO date (YYYY-MM-DD)
 * @returns {Object} { date, total_intake, total_output, balance, entries }
 */
export async function getIOBalance(patientUid, encounterId, date) {
  if (!date) {
    throw AppError.badRequest('date is required (YYYY-MM-DD)');
  }

  const conditions = ['patient_uid = $1', 'recorded_at::date = $2::date'];
  const params = [patientUid, date];
  let paramIdx = 3;

  if (encounterId) {
    conditions.push(`encounter_id = $${paramIdx}`);
    params.push(encounterId);
    paramIdx++;
  }

  const whereClause = conditions.join(' AND ');

  // Get totals by type
  const { rows: totals } = await prisma.$queryRawUnsafe(
    `SELECT io_type, COALESCE(SUM(amount_ml), 0) AS total_ml
     FROM intake_output
     WHERE ${whereClause}
     GROUP BY io_type`,
    params
  );

  let totalIntake = 0;
  let totalOutput = 0;
  for (const row of totals) {
    if (row.io_type === 'intake') totalIntake = parseInt(row.total_ml, 10);
    if (row.io_type === 'output') totalOutput = parseInt(row.total_ml, 10);
  }

  // Get individual entries
  const { rows: entries } = await prisma.$queryRawUnsafe(
    `SELECT id, io_type, category, amount_ml, description, recorded_by, recorded_at
     FROM intake_output
     WHERE ${whereClause}
     ORDER BY recorded_at ASC`,
    params
  );

  return {
    date,
    total_intake: totalIntake,
    total_output: totalOutput,
    balance: totalIntake - totalOutput,
    entries,
  };
}

// ===================================================================
// getIOChart
// ===================================================================

/**
 * Get I/O chart data for a date range.
 * @param {string} patientUid
 * @param {string|null} encounterId
 * @param {string|null} dateFrom
 * @param {string|null} dateTo
 * @returns {Array} I/O entries sorted by recorded_at
 */
export async function getIOChart(patientUid, encounterId, dateFrom, dateTo) {
  const conditions = ['patient_uid = $1'];
  const params = [patientUid];
  let paramIdx = 2;

  if (encounterId) {
    conditions.push(`encounter_id = $${paramIdx}`);
    params.push(encounterId);
    paramIdx++;
  }

  if (dateFrom) {
    conditions.push(`recorded_at >= $${paramIdx}`);
    params.push(dateFrom);
    paramIdx++;
  }

  if (dateTo) {
    conditions.push(`recorded_at <= $${paramIdx}`);
    params.push(dateTo);
    paramIdx++;
  }

  const whereClause = conditions.join(' AND ');

  const { rows } = await prisma.$queryRawUnsafe(
    `SELECT id, io_type, category, amount_ml, description, recorded_by, recorded_at
     FROM intake_output
     WHERE ${whereClause}
     ORDER BY recorded_at ASC`,
    params
  );

  return rows;
}

export default {
  recordVitals,
  getVitalsTrend,
  getLatestVitals,
  getVitalsChart,
  recordIntakeOutput,
  getIOBalance,
  getIOChart,
};

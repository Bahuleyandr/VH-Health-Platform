// src/controllers/health/patientHealthController.js
import { HEALTH_MESSAGES } from '../../config/healthConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as vitalsChartService from '../../services/emr/vitalsChartService.js';
import * as pointService from '../../services/gamification/pointService.js';
import * as healthRecordService from '../../services/health/healthRecordService.js';
import * as patientHealthService from '../../services/health/patientHealthService.js';
import {
  correctPatientWearableVital,
  recordPatientWearableVital,
} from '../../services/health/patientWearableVitalsService.js';
import { AppError } from '../../utils/AppError.js';
import { assertVitalPlausibility, RECORDED_AT_MAX_FUTURE_MS } from '../../utils/clinical/vitalPlausibility.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';

let vitalsSourceColumnsSupported;

const STRICT_DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function strictNumberOrUndefined(value, field, { integer = false } = {}) {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'boolean' || typeof value === 'object') {
    throw AppError.badRequest(`${field} must be a number`);
  }
  const text = String(value).trim();
  if (text === '') return undefined;
  if (!STRICT_DECIMAL_PATTERN.test(text)) {
    throw AppError.badRequest(`${field} must be a number`);
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw AppError.badRequest(`${field} must be a finite number`);
  }
  if (integer && !Number.isInteger(parsed)) {
    throw AppError.badRequest(`${field} must be an integer`);
  }
  return parsed;
}

function strictPositiveInteger(value, field) {
  const parsed = strictNumberOrUndefined(value, field, { integer: true });
  if (parsed === undefined || parsed <= 0) {
    throw AppError.badRequest(`${field} must be a positive integer`);
  }
  return parsed;
}

function normalizeWearableVitalPayload(body, {
  sourceNorm,
  sourceRecordId = body.sourceRecordId,
} = {}) {
  const recordedAtSource = body.recordedAtSource
    ? new Date(body.recordedAtSource)
    : null;
  if (!recordedAtSource || Number.isNaN(recordedAtSource.getTime())) {
    throw AppError.badRequest(
      body.recordedAtSource
        ? 'recordedAtSource must be a valid ISO-8601 timestamp'
        : 'recordedAtSource is required for wearable vitals',
    );
  }

  const heartRate = strictNumberOrUndefined(body.heartRate, 'heartRate', { integer: true });
  const temperature = strictNumberOrUndefined(body.temperature, 'temperature');
  const bloodSugar = strictNumberOrUndefined(body.bloodSugar, 'bloodSugar', { integer: true });
  const weight = strictNumberOrUndefined(body.weight, 'weight');
  const spO2 = strictNumberOrUndefined(body.spO2, 'spO2', { integer: true });
  let bloodPressure = null;
  if (body.bloodPressure != null) {
    if (typeof body.bloodPressure !== 'object' || Array.isArray(body.bloodPressure)) {
      throw AppError.badRequest('bloodPressure must be an object');
    }
    bloodPressure = {
      systolic: strictNumberOrUndefined(
        body.bloodPressure.systolic,
        'bloodPressure.systolic',
      ),
      diastolic: strictNumberOrUndefined(
        body.bloodPressure.diastolic,
        'bloodPressure.diastolic',
      ),
    };
  }

  const hasWearableVital = [
    bloodPressure?.systolic,
    bloodPressure?.diastolic,
    heartRate,
    temperature,
    bloodSugar,
    weight,
    spO2,
  ].some(value => value !== undefined && value !== null);
  if (!hasWearableVital) {
    throw AppError.badRequest('At least one wearable vital sign is required');
  }
  if (weight !== undefined && (weight <= 0 || weight > 600)) {
    throw AppError.badRequest('weight must be between 0 and 600 kg');
  }
  assertVitalPlausibility({
    heart_rate: heartRate,
    systolic_bp: bloodPressure?.systolic,
    diastolic_bp: bloodPressure?.diastolic,
    temperature,
    blood_glucose: bloodSugar,
    spo2: spO2,
  });
  if (recordedAtSource.getTime() - Date.now() > RECORDED_AT_MAX_FUTURE_MS) {
    throw AppError.badRequest('recordedAtSource cannot be in the future');
  }

  return {
    bloodPressure,
    heartRate,
    temperature,
    bloodSugar,
    weight,
    spO2,
    source: sourceNorm,
    sourceRecordId,
    recordedAtSource,
  };
}

async function hasVitalsSourceColumns() {
  if (vitalsSourceColumnsSupported !== undefined) {
    return vitalsSourceColumnsSupported;
  }

  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM information_schema.columns
      WHERE table_name = 'patient_vitals'
        AND column_name IN ('source', 'recorded_at_source')`
  );
  vitalsSourceColumnsSupported = Number(rows[0]?.count || 0) === 2;
  return vitalsSourceColumnsSupported;
}

export async function getPatientSummary(req, res) {
  try {
    const { patient_id } = req.params;
    const days = parseInt(req.query.days) || 30;

    // Patients can only access their own health data
    if (req.user?.role === 'PATIENT' && String(req.user?.id) !== String(patient_id)) {
      return error(res, 'Access denied — you can only view your own health data', HTTP_STATUS.FORBIDDEN);
    }

    // Role-based access control
    if (req.user?.role === 'DOCTOR') {
      // Check if doctor has treated this patient
      const hasAccess = await healthRecordService.checkDoctorPatientAccess(req.user.id, patient_id);
      if (!hasAccess) {
        return error(res, 'Access denied - you have not treated this patient', HTTP_STATUS.FORBIDDEN);
      }
    }

    logPhiAccess({
      userId: req.user?.id || req.user?.uid,
      userRole: req.user?.role,
      patientId: patient_id,
      recordType: 'HEALTH_SUMMARY',
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      requestId: req.id
    });

    const summary = await patientHealthService.getPatientSummary(patient_id, days);

    success(res, {
      ...summary,
      accessedBy: req.user?.name
    }, 'Patient health summary retrieved successfully');
  } catch (err) {
    logger.error('Database error:', err);
    
    if (err.message === 'Patient not found') {
      return error(res, HEALTH_MESSAGES.PATIENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    error(res, 'Failed to retrieve patient health summary', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getPatientVitalTrends(req, res) {
  try {
    const { patient_id } = req.params;
    const days = parseInt(req.query.days) || 30;
    const vital_type = req.query.vital_type;

    // Patients can only access their own health data
    if (req.user?.role === 'PATIENT' && String(req.user?.id) !== String(patient_id)) {
      return error(res, 'Access denied — you can only view your own health data', HTTP_STATUS.FORBIDDEN);
    }

    // Role-based access control
    if (req.user?.role === 'DOCTOR') {
      const hasAccess = await healthRecordService.checkDoctorPatientAccess(req.user.id, patient_id);
      if (!hasAccess) {
        return error(res, 'Access denied - you have not treated this patient', HTTP_STATUS.FORBIDDEN);
      }
    }

    logPhiAccess({
      userId: req.user?.id || req.user?.uid,
      userRole: req.user?.role,
      patientId: patient_id,
      recordType: 'VITAL_TRENDS',
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      requestId: req.id
    });

    const trends = await patientHealthService.getPatientVitalTrends(patient_id, days, vital_type);

    success(res, {
      ...trends,
      accessedBy: req.user?.name
    }, 'Patient vital trends retrieved successfully');
  } catch (err) {
    logger.error('Database error:', err);
    error(res, 'Failed to retrieve vital trends', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getPatientAllergies(req, res) {
  try {
    const { patient_id } = req.params;

    // Patients can only access their own health data
    if (req.user?.role === 'PATIENT' && String(req.user?.id) !== String(patient_id)) {
      return error(res, 'Access denied — you can only view your own health data', HTTP_STATUS.FORBIDDEN);
    }

    // Role-based access control
    if (req.user?.role === 'DOCTOR') {
      const hasAccess = await healthRecordService.checkDoctorPatientAccess(req.user.id, patient_id);
      if (!hasAccess) {
        return error(res, 'Access denied - you have not treated this patient', HTTP_STATUS.FORBIDDEN);
      }
    }

    logPhiAccess({
      userId: req.user?.id || req.user?.uid,
      userRole: req.user?.role,
      patientId: patient_id,
      recordType: 'ALLERGIES',
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      requestId: req.id
    });

    const allergies = await patientHealthService.getPatientAllergies(patient_id);

    success(res, {
      ...allergies,
      accessedBy: req.user?.name
    }, 'Patient allergies retrieved successfully');
  } catch (err) {
    logger.error('Database error:', err);
    error(res, 'Failed to retrieve patient allergies', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getPatientConditions(req, res) {
  try {
    const { patient_id } = req.params;
    const active_only = req.query.active_only === 'true';

    // Patients can only access their own health data
    if (req.user?.role === 'PATIENT' && String(req.user?.id) !== String(patient_id)) {
      return error(res, 'Access denied — you can only view your own health data', HTTP_STATUS.FORBIDDEN);
    }

    // Role-based access control
    if (req.user?.role === 'DOCTOR') {
      const hasAccess = await healthRecordService.checkDoctorPatientAccess(req.user.id, patient_id);
      if (!hasAccess) {
        return error(res, 'Access denied - you have not treated this patient', HTTP_STATUS.FORBIDDEN);
      }
    }

    logPhiAccess({
      userId: req.user?.id || req.user?.uid,
      userRole: req.user?.role,
      patientId: patient_id,
      recordType: 'CONDITIONS',
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      requestId: req.id
    });

    const conditions = await patientHealthService.getPatientConditions(patient_id, active_only);

    success(res, {
      ...conditions,
      accessedBy: req.user?.name
    }, 'Patient conditions retrieved successfully');
  } catch (err) {
    logger.error('Database error:', err);
    error(res, 'Failed to retrieve patient conditions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// ── Patient Self-Reported Vitals ────────────────────────────────────────────

export async function recordPatientVitals(req, res) {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);
    }

    const {
      bloodPressure,
      heartRate,
      temperature,
      bloodSugar,
      weight,
      spO2,
      mood,
      source,
      sourceRecordId,
      recordedAtSource,
    } = req.body;

    // At least one vital OR a mood must be provided (mood alone is a valid
    // check-in submission from the dashboard check-in modal).
    if (!bloodPressure && heartRate == null && temperature == null &&
        bloodSugar == null && weight == null && spO2 == null && !mood) {
      return error(res, 'At least one vital sign or a mood is required', HTTP_STATUS.BAD_REQUEST);
    }

    // Validate mood if present
    const allowedMoods = ['great', 'good', 'okay', 'poor', 'bad'];
    const moodNorm = mood ? String(mood).toLowerCase() : null;
    if (moodNorm && !allowedMoods.includes(moodNorm)) {
      return error(res, 'mood must be one of: great, good, okay, poor, bad', HTTP_STATUS.BAD_REQUEST);
    }

    // Validate source tag. Accept only known wearable origins so invalid
    // values don't pollute the sync-status map.
    const allowedSources = ['manual', 'healthkit', 'health_connect', 'google_fit'];
    const sourceNorm = source ? String(source).toLowerCase() : 'manual';
    if (!allowedSources.includes(sourceNorm)) {
      return error(res, `source must be one of: ${allowedSources.join(', ')}`, HTTP_STATUS.BAD_REQUEST);
    }
    const recordedAtSourceTs = recordedAtSource
      ? new Date(recordedAtSource)
      : null;
    if (recordedAtSource && isNaN(recordedAtSourceTs?.getTime())) {
      return error(res, 'recordedAtSource must be a valid ISO-8601 timestamp', HTTP_STATUS.BAD_REQUEST);
    }

    const isWearable = sourceNorm !== 'manual';
    if (isWearable && !recordedAtSourceTs) {
      return error(res, 'recordedAtSource is required for wearable vitals', HTTP_STATUS.BAD_REQUEST);
    }

    if (isWearable) {
      const wearablePayload = normalizeWearableVitalPayload(req.body, {
        sourceNorm,
        sourceRecordId,
      });

      const tenantId = req.tenantId || req.user?.tenant_id || req.user?.tenantId || null;
      const wearable = await recordPatientWearableVital({
        tenantId,
        patientUid: uid,
        actorRole: req.user?.role,
        ...wearablePayload,
      });

      logPhiAccess({
        userId: uid,
        userRole: req.user?.role,
        patientId: uid,
        recordType: 'PATIENT_VITALS',
        action: wearable.created ? 'CREATE' : 'REPLAY',
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
        requestId: req.id,
        tenantId,
      });

      if (wearable.created) {
        pointService.awardVitalsPoints(uid, tenantId).catch(err =>
          logger.warn('Gamification: vitals point award failed', { error: err.message })
        );
      }

      return success(res, {
        id: wearable.row.id,
        recordedAt: wearable.row.recorded_at,
        source: wearable.row.source,
        sourceRecordId: wearable.row.source_record_id,
        recordedAtSource: wearable.row.recorded_at_source,
        syncReceipt: wearable.receipt,
      }, wearable.duplicate ? 'Vitals already recorded' : 'Vitals recorded successfully');
    }

    const baseParams = [
      uid,
      bloodPressure ? JSON.stringify(bloodPressure) : null,
      heartRate != null ? parseInt(heartRate, 10) : null,
      temperature != null ? parseFloat(temperature) : null,
      bloodSugar != null ? parseInt(bloodSugar, 10) : null,
      weight != null ? parseFloat(weight) : null,
      spO2 != null ? parseInt(spO2, 10) : null,
      moodNorm,
    ];

    const supportsSourceColumns = await hasVitalsSourceColumns();
    const result = supportsSourceColumns
      ? await prisma.$queryRawUnsafe(
        `INSERT INTO patient_vitals (patient_uid, blood_pressure, heart_rate, temperature, blood_sugar, weight, spo2, mood, source, recorded_at_source)
         VALUES ($1::uuid, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, recorded_at, source, recorded_at_source`,
        ...baseParams,
        sourceNorm,
        recordedAtSourceTs,
      )
      : await prisma.$queryRawUnsafe(
        `INSERT INTO patient_vitals (patient_uid, blood_pressure, heart_rate, temperature, blood_sugar, weight, spo2, mood)
         VALUES ($1::uuid, $2::jsonb, $3, $4, $5, $6, $7, $8)
         RETURNING id, recorded_at`,
        ...baseParams,
      );

    logPhiAccess({
      userId: uid,
      userRole: req.user?.role,
      patientId: uid,
      recordType: 'PATIENT_VITALS',
      action: 'CREATE',
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      requestId: req.id
    });

    // Gamification: fire-and-forget vitals points (CAN-012: pass tenant so the
    // ledger row is correctly attributed; non-throwing resolve since this is
    // best-effort).
    pointService.awardVitalsPoints(uid, req.tenantId || req.user?.tenant_id || req.user?.tenantId || null).catch(err =>
      logger.warn('Gamification: vitals point award failed', { error: err.message })
    );

    success(res, {
      id: result[0].id,
      recordedAt: result[0].recorded_at,
      source: result[0].source || sourceNorm,
      recordedAtSource: result[0].recorded_at_source || recordedAtSourceTs,
    }, 'Vitals recorded successfully');
  } catch (err) {
    logger.error('Record vitals error:', err);
    relayAppError(res, err, 'Failed to record vitals');
  }
}

export async function correctPatientWearableVitals(req, res) {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);
    }

    const sourceNorm = req.body?.source
      ? String(req.body.source).toLowerCase()
      : '';
    if (!['healthkit', 'health_connect', 'google_fit'].includes(sourceNorm)) {
      throw AppError.badRequest(
        'source must identify a supported wearable provider',
      );
    }
    const wearablePayload = normalizeWearableVitalPayload(req.body || {}, {
      sourceNorm,
      sourceRecordId: req.params?.sourceRecordId,
    });
    const tenantId = req.tenantId ||
      req.user?.tenant_id ||
      req.user?.tenantId ||
      null;
    const wearable = await correctPatientWearableVital({
      tenantId,
      patientUid: uid,
      actorRole: req.user?.role,
      ...wearablePayload,
    });

    logPhiAccess({
      userId: uid,
      userRole: req.user?.role,
      patientId: uid,
      recordType: 'PATIENT_VITALS',
      action: wearable.corrected ? 'UPDATE' : 'REPLAY',
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      requestId: req.id,
      tenantId,
    });

    return success(res, {
      id: wearable.row.id,
      recordedAt: wearable.row.recorded_at,
      source: wearable.row.source,
      sourceRecordId: wearable.row.source_record_id,
      recordedAtSource: wearable.row.recorded_at_source,
      syncReceipt: wearable.receipt,
    }, wearable.corrected
      ? 'Wearable vital corrected successfully'
      : 'Wearable vital correction already applied');
  } catch (err) {
    logger.error('Correct wearable vitals error:', err);
    return relayAppError(res, err, 'Failed to correct wearable vitals');
  }
}

export async function recordStaffVitals(req, res) {
  try {
    const {
      patient_id,
      vital_signs = {},
      measurements = {},
      notes,
      admission_id,
      admissionId,
      encounter_id,
      encounterId,
    } = req.body || {};
    if (!patient_id) {
      return error(res, 'patient_id is required', HTTP_STATUS.BAD_REQUEST);
    }

    const patientId = strictPositiveInteger(patient_id, 'patient_id');

    const tenantId = req.tenantId || req.user?.tenant_id || req.user?.tenantId || null;
    if (!tenantId) {
      throw AppError.badRequest('Tenant context is required');
    }

    // Inpatient encounter linkage. Without these, ward vitals float free
    // of the admission and the doctor's IPD chart cannot filter "vitals
    // during this admission".
    const admissionIdRaw = admission_id ?? admissionId;
    let admissionIdValue = null;
    if (admissionIdRaw !== undefined && admissionIdRaw !== null && admissionIdRaw !== '') {
      admissionIdValue = strictPositiveInteger(admissionIdRaw, 'admission_id');
    }
    const encounterIdRaw = encounter_id ?? encounterId;
    let encounterIdValue = null;
    if (encounterIdRaw !== undefined && encounterIdRaw !== null && encounterIdRaw !== '') {
      const candidate = String(encounterIdRaw);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) {
        return error(res, 'encounter_id must be a UUID', HTTP_STATUS.BAD_REQUEST);
      }
      encounterIdValue = candidate;
    }

    const patient = await prisma.$queryRawUnsafe(
      `SELECT id, uid, birthday, gender, tenant_id, role
         FROM users
        WHERE id = $1
          AND tenant_id = $2::uuid
          AND COALESCE(is_active, true) = true
        LIMIT 1`,
      patientId,
      tenantId,
    );
    if (patient.length === 0) {
      return error(res, HEALTH_MESSAGES.PATIENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    if (patient[0].role !== 'PATIENT') {
      return error(res, 'patient_id must identify a patient', HTTP_STATUS.BAD_REQUEST);
    }

    const vitalSigns = vital_signs && typeof vital_signs === 'object' ? vital_signs : {};
    const measurementValues = measurements && typeof measurements === 'object' ? measurements : {};
    const bloodPressure = vitalSigns.blood_pressure ?? vitalSigns.bloodPressure;
    if (bloodPressure != null && (typeof bloodPressure !== 'object' || Array.isArray(bloodPressure))) {
      throw AppError.badRequest('blood_pressure must be an object');
    }
    const systolicBp = strictNumberOrUndefined(bloodPressure?.systolic, 'systolic_bp');
    const diastolicBp = strictNumberOrUndefined(bloodPressure?.diastolic, 'diastolic_bp');
    const heartRate = strictNumberOrUndefined(
      vitalSigns.heart_rate ?? vitalSigns.heartRate ?? vitalSigns.pulse,
      'heart_rate',
    );
    const temperature = strictNumberOrUndefined(vitalSigns.temperature, 'temperature');
    const bloodSugar = strictNumberOrUndefined(
      vitalSigns.blood_sugar ?? vitalSigns.bloodSugar,
      'blood_glucose',
    );
    const spO2 = strictNumberOrUndefined(
      vitalSigns.spo2 ?? vitalSigns.spO2,
      'spo2',
    );
    const weight = strictNumberOrUndefined(measurementValues.weight, 'weight');
    const heightCm = strictNumberOrUndefined(
      measurementValues.height_cm ?? measurementValues.height,
      'height_cm',
    );

    // Temperature route (axillary/oral/rectal/tympanic) — axillary runs
    // ~0.5 C below oral, so the route changes a paediatric fever band.
    // Finding: 2026-05-09-pediatric-opd-nurse-no-temperature-route-field.
    if (systolicBp == null && diastolicBp == null && heartRate == null && temperature == null &&
        bloodSugar == null && weight == null && spO2 == null) {
      return error(res, 'At least one vital sign or measurement is required', HTTP_STATUS.BAD_REQUEST);
    }

    let canonicalEncounterId = encounterIdValue;
    if (admissionIdValue != null) {
      const admissions = await prisma.$queryRawUnsafe(
        `SELECT encounter_id, patient_uid
           FROM admissions
          WHERE id = $1
            AND tenant_id = $2::uuid
          LIMIT 1`,
        admissionIdValue,
        tenantId,
      );
      const admission = admissions[0] ?? null;
      if (!admission || String(admission.patient_uid) !== String(patient[0].uid)) {
        throw AppError.notFound('Admission not found for patient');
      }
      if (!admission.encounter_id) {
        throw AppError.badRequest('admission_id has no encounter_id');
      }
      if (canonicalEncounterId && canonicalEncounterId !== String(admission.encounter_id)) {
        throw AppError.badRequest('encounter_id does not match admission_id');
      }
      canonicalEncounterId = String(admission.encounter_id);
    }

    const result = await vitalsChartService.recordVitals({
      tenant_id: tenantId,
      patient_uid: String(patient[0].uid),
      patient_id: patientId,
      encounter_id: canonicalEncounterId,
      heart_rate: heartRate,
      systolic_bp: systolicBp,
      diastolic_bp: diastolicBp,
      temperature,
      temperature_unit: vitalSigns.temperature_unit ?? vitalSigns.temperatureUnit ?? 'F',
      temperature_route: vitalSigns.temperature_route ?? vitalSigns.temperatureRoute,
      spo2: spO2,
      spo2_scale: vitalSigns.spo2_scale ?? vitalSigns.spo2Scale,
      blood_glucose: bloodSugar,
      weight_kg: weight,
      height_cm: heightCm,
      notes,
      recorded_by: req.user?.uid,
      source: 'staff',
    });

    logPhiAccess({
      userId: req.user?.uid,
      userRole: req.user?.role,
      patientId: patient[0].uid,
      recordType: 'STAFF_RECORDED_VITALS',
      action: 'CREATE',
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      requestId: req.id,
      tenantId,
    });

    success(res, {
      id: result.vitals.id,
      patientId: patient[0].id,
      patientUid: patient[0].uid,
      recordedAt: result.vitals.recorded_at,
      source: result.vitals.source || 'staff',
      admissionId: admissionIdValue,
      encounterId: result.vitals.encounter_uid ?? result.vitals.encounter_id ?? null,
      growth: result.growth ?? null,
      news2: result.news2 ?? null,
      alerts: result.alerts ?? [],
    }, 'Vitals recorded successfully');
  } catch (err) {
    relayAppError(res, err, 'Failed to record vitals');
  }
}

/**
 * PUT /health/records/:id — compatibility adapter for the canonical vitals
 * correction service. The ID returned by POST /health/records is a
 * vitals_chart ID; keeping correction on the same canonical row preserves its
 * NEWS2 re-score, timeline, clinical audit, tenant, and five-minute window.
 */
export async function updateStaffVitals(req, res) {
  try {
    const vitalId = strictPositiveInteger(req.params.id, 'vital id');

    const tenantId = req.tenantId || req.user?.tenant_id || req.user?.tenantId || null;
    if (!tenantId) {
      throw AppError.badRequest('Tenant context is required');
    }
    const body = req.body || {};
    const vitalSigns = body.vital_signs && typeof body.vital_signs === 'object' ? body.vital_signs : {};
    const measurementValues = body.measurements && typeof body.measurements === 'object' ? body.measurements : {};
    const bloodPressure = vitalSigns.blood_pressure ?? vitalSigns.bloodPressure;
    if (bloodPressure != null && (typeof bloodPressure !== 'object' || Array.isArray(bloodPressure))) {
      throw AppError.badRequest('blood_pressure must be an object');
    }
    const systolicBp = bloodPressure == null
      ? undefined
      : strictNumberOrUndefined(bloodPressure.systolic, 'systolic_bp');
    const diastolicBp = bloodPressure == null
      ? undefined
      : strictNumberOrUndefined(bloodPressure.diastolic, 'diastolic_bp');
    const heartRate = strictNumberOrUndefined(
      vitalSigns.heart_rate ?? vitalSigns.heartRate ?? vitalSigns.pulse,
      'heart_rate',
    );
    const temperature = strictNumberOrUndefined(vitalSigns.temperature, 'temperature');
    const bloodSugar = strictNumberOrUndefined(
      vitalSigns.blood_sugar ?? vitalSigns.bloodSugar,
      'blood_glucose',
    );
    const spO2 = strictNumberOrUndefined(
      vitalSigns.spo2 ?? vitalSigns.spO2,
      'spo2',
    );
    const weight = strictNumberOrUndefined(measurementValues.weight, 'weight');
    const heightCm = strictNumberOrUndefined(
      measurementValues.height_cm ?? measurementValues.height,
      'height_cm',
    );

    const corrected = await vitalsChartService.correctVitals(vitalId, {
      ...(bloodPressure === null ? { systolic_bp: null, diastolic_bp: null } : {}),
      ...(systolicBp !== undefined ? { systolic_bp: systolicBp } : {}),
      ...(diastolicBp !== undefined ? { diastolic_bp: diastolicBp } : {}),
      ...(heartRate !== undefined ? { heart_rate: heartRate } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(bloodSugar !== undefined ? { blood_glucose: bloodSugar } : {}),
      ...(weight !== undefined ? { weight_kg: weight } : {}),
      ...(heightCm !== undefined ? { height_cm: heightCm } : {}),
      ...(spO2 !== undefined ? { spo2: spO2 } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, 'notes') ? { notes: body.notes } : {}),
      temperature_unit: vitalSigns.temperature_unit ?? vitalSigns.temperatureUnit ?? 'F',
      corrected_by: req.user?.uid,
      actor_role: req.user?.role,
      ip_address: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      tenantId,
    });

    logPhiAccess({
      userId: req.user?.uid,
      userRole: req.user?.role,
      patientId: corrected.patient_uid,
      recordType: 'STAFF_RECORDED_VITALS',
      action: 'UPDATE',
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      requestId: req.id,
      tenantId,
    });

    const temperatureF = corrected.temperature == null
      ? null
      : (Number(corrected.temperature) * 9) / 5 + 32;
    success(res, {
      id: corrected.id,
      patient_uid: corrected.patient_uid,
      blood_pressure: corrected.systolic_bp == null && corrected.diastolic_bp == null
        ? null
        : {
            systolic: corrected.systolic_bp == null ? null : Number(corrected.systolic_bp),
            diastolic: corrected.diastolic_bp == null ? null : Number(corrected.diastolic_bp),
          },
      heart_rate: corrected.heart_rate == null ? null : Number(corrected.heart_rate),
      temperature: temperatureF,
      blood_sugar: corrected.blood_glucose == null ? null : Number(corrected.blood_glucose),
      weight: corrected.weight_kg == null ? null : Number(corrected.weight_kg),
      spo2: corrected.spo2 == null ? null : Number(corrected.spo2),
      recorded_at: corrected.recorded_at,
      source: corrected.source,
    }, 'Vital record corrected');
  } catch (err) {
    if (err?.statusCode === HTTP_STATUS.CONFLICT && /correction window has expired/i.test(err.message)) {
      return error(
        res,
        'Edit window expired — corrections beyond 5 minutes must be filed as a clinical-note addendum',
        HTTP_STATUS.FORBIDDEN,
        { code: 'EDIT_WINDOW_EXPIRED' },
      );
    }
    return relayAppError(res, err, 'Failed to correct vital record');
  }
}

/**
 * GET /health/patient/:patient_id/sync-status
 *
 * Returns the most recent `recorded_at_source` timestamp per source tag, so
 * HealthKit / Google Fit clients can compute deltas ("sync everything since
 * the last healthkit timestamp"). Patients are scoped to their own data;
 * clinicians and admins can query any patient.
 */
export async function getVitalsSyncStatus(req, res) {
  try {
    const { patient_id } = req.params;
    if (req.user?.role === 'PATIENT'
        && String(req.user?.id) !== String(patient_id)
        && String(req.user?.uid) !== String(patient_id)) {
      return error(res, 'Access denied — you can only view your own sync status', HTTP_STATUS.FORBIDDEN);
    }

    const supportsSourceColumns = await hasVitalsSourceColumns();
    const rows = supportsSourceColumns
      ? await prisma.$queryRawUnsafe(
        `SELECT source, MAX(COALESCE(recorded_at_source, recorded_at)) AS last_at
           FROM patient_vitals
          WHERE patient_uid = $1::uuid
          GROUP BY source`,
        patient_id,
      )
      : await prisma.$queryRawUnsafe(
        `SELECT 'manual'::text AS source, MAX(recorded_at) AS last_at
           FROM patient_vitals
          WHERE patient_uid = $1::uuid`,
        patient_id,
      );
    const bySource = {};
    for (const r of rows) bySource[r.source] = r.last_at;

    success(res, {
      patientId: patient_id,
      lastSyncBySource: bySource,
    }, 'Vitals sync status');
  } catch (err) {
    logger.error('Get sync status error:', err);
    error(res, 'Failed to fetch sync status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function getPatientVitals(req, res) {
  try {
    const { patient_id } = req.params;

    // Patients can only access their own vitals. Patient app passes the
    // numeric `users.id`; allow either int id or uid match (some legacy
    // callers in the staff app pass the uuid). Sibling endpoints in
    // this file already do the same — this one was the outlier.
    if (req.user?.role === 'PATIENT'
        && String(req.user?.id) !== String(patient_id)
        && String(req.user?.uid) !== String(patient_id)) {
      return error(res, 'Access denied — you can only view your own vitals', HTTP_STATUS.FORBIDDEN);
    }

    logPhiAccess({
      userId: req.user?.uid || req.user?.id,
      userRole: req.user?.role,
      patientId: patient_id,
      recordType: 'PATIENT_VITALS',
      action: 'VIEW',
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      requestId: req.id
    });

    // patient_vitals keys on uuid; if caller sent the int id (the
    // patient app does), resolve users.id → users.uid first.
    let patientUid = patient_id;
    if (/^\d+$/.test(String(patient_id))) {
      const lookup = await prisma.$queryRawUnsafe(
        'SELECT uid FROM users WHERE id = $1',
        parseInt(patient_id, 10)
      );
      if (lookup.length === 0) {
        return success(res, [], 'Patient vitals retrieved successfully');
      }
      patientUid = lookup[0].uid;
    }

    const supportsSourceColumns = await hasVitalsSourceColumns();
    const sourceColumns = supportsSourceColumns
      ? ', source, recorded_at_source AS "recordedAtSource"'
      : ', \'manual\'::text AS source, NULL::timestamp AS "recordedAtSource"';
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, blood_pressure AS "bloodPressure", heart_rate AS "heartRate",
              temperature, blood_sugar AS "bloodSugar", weight, spo2 AS "spO2",
              recorded_at AS "createdAt"${sourceColumns}
       FROM patient_vitals
       WHERE patient_uid = $1::uuid
       ORDER BY recorded_at DESC
       LIMIT 100`,
      patientUid
    );

    success(res, rows, 'Patient vitals retrieved successfully');
  } catch (err) {
    logger.error('Get vitals error:', err);
    error(res, 'Failed to retrieve vitals', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

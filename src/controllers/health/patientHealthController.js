// src/controllers/health/patientHealthController.js
import { HEALTH_MESSAGES } from '../../config/healthConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as pointService from '../../services/gamification/pointService.js';
import * as healthRecordService from '../../services/health/healthRecordService.js';
import * as patientHealthService from '../../services/health/patientHealthService.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success, error } from '../../utils/responseHelper.js';

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

    const { bloodPressure, heartRate, temperature, bloodSugar, weight, spO2, mood, source, recordedAtSource } = req.body;

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
    const allowedSources = ['manual', 'healthkit', 'google_fit'];
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

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO patient_vitals (patient_uid, blood_pressure, heart_rate, temperature, blood_sugar, weight, spo2, mood, source, recorded_at_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, recorded_at, source, recorded_at_source`,
      uid,
      bloodPressure ? JSON.stringify(bloodPressure) : null,
      heartRate != null ? parseInt(heartRate, 10) : null,
      temperature != null ? parseFloat(temperature) : null,
      bloodSugar != null ? parseInt(bloodSugar, 10) : null,
      weight != null ? parseFloat(weight) : null,
      spO2 != null ? parseInt(spO2, 10) : null,
      moodNorm,
      sourceNorm,
      recordedAtSourceTs,
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

    // Gamification: fire-and-forget vitals points
    pointService.awardVitalsPoints(uid).catch(err =>
      logger.warn('Gamification: vitals point award failed', { error: err.message })
    );

    success(res, {
      id: result[0].id,
      recordedAt: result[0].recorded_at,
      source: result[0].source,
      recordedAtSource: result[0].recorded_at_source,
    }, 'Vitals recorded successfully');
  } catch (err) {
    logger.error('Record vitals error:', err);
    error(res, 'Failed to record vitals', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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
    if (req.user?.role === 'PATIENT' && String(req.user?.uid) !== String(patient_id)) {
      return error(res, 'Access denied — you can only view your own sync status', HTTP_STATUS.FORBIDDEN);
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT source, MAX(COALESCE(recorded_at_source, recorded_at)) AS last_at
         FROM patient_vitals
        WHERE patient_uid = $1
        GROUP BY source`,
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

    // Patients can only access their own vitals
    if (req.user?.role === 'PATIENT' && String(req.user?.uid) !== String(patient_id)) {
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

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, blood_pressure AS "bloodPressure", heart_rate AS "heartRate",
              temperature, blood_sugar AS "bloodSugar", weight, spo2 AS "spO2",
              recorded_at AS "createdAt"
       FROM patient_vitals
       WHERE patient_uid = $1
       ORDER BY recorded_at DESC
       LIMIT 100`,
      patient_id
    );

    success(res, rows, 'Patient vitals retrieved successfully');
  } catch (err) {
    logger.error('Get vitals error:', err);
    error(res, 'Failed to retrieve vitals', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}
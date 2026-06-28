// src/controllers/health/patientHealthController.js
import { HEALTH_MESSAGES } from '../../config/healthConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { computeGrowthSnapshot } from '../../services/clinical/growthPercentileService.js';
import * as pointService from '../../services/gamification/pointService.js';
import * as healthRecordService from '../../services/health/healthRecordService.js';
import * as patientHealthService from '../../services/health/patientHealthService.js';
import { normaliseTemperatureRoute } from '../../utils/clinical/temperatureRoute.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success, error } from '../../utils/responseHelper.js';

let vitalsSourceColumnsSupported;

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
    error(res, 'Failed to record vitals', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function recordStaffVitals(req, res) {
  try {
    const {
      patient_id,
      vital_signs = {},
      measurements = {},
      admission_id,
      admissionId,
      encounter_id,
      encounterId,
    } = req.body || {};
    if (!patient_id) {
      return error(res, 'patient_id is required', HTTP_STATUS.BAD_REQUEST);
    }

    if (req.user?.role === 'PATIENT' && String(req.user?.id) !== String(patient_id)) {
      return error(res, 'Access denied — patients can only record their own vitals', HTTP_STATUS.FORBIDDEN);
    }

    const patientId = Number.parseInt(patient_id, 10);
    if (!Number.isInteger(patientId) || patientId <= 0) {
      return error(res, 'patient_id must be a positive integer', HTTP_STATUS.BAD_REQUEST);
    }

    // Inpatient encounter linkage. Without these, ward vitals float free
    // of the admission and the doctor's IPD chart cannot filter "vitals
    // during this admission".
    const admissionIdRaw = admission_id ?? admissionId;
    let admissionIdValue = null;
    if (admissionIdRaw !== undefined && admissionIdRaw !== null && admissionIdRaw !== '') {
      const parsedAdmission = Number.parseInt(admissionIdRaw, 10);
      if (!Number.isInteger(parsedAdmission) || parsedAdmission <= 0) {
        return error(res, 'admission_id must be a positive integer', HTTP_STATUS.BAD_REQUEST);
      }
      admissionIdValue = parsedAdmission;
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
      'SELECT id, uid, birthday, gender FROM users WHERE id = $1 AND COALESCE(is_active, true) = true LIMIT 1',
      patientId
    );
    if (patient.length === 0) {
      return error(res, HEALTH_MESSAGES.PATIENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }

    const vitalSigns = vital_signs && typeof vital_signs === 'object' ? vital_signs : {};
    const measurementValues = measurements && typeof measurements === 'object' ? measurements : {};
    const numberOrNull = (value, parser = Number.parseFloat) => {
      if (value === null || value === undefined || value === '') return null;
      const parsed = parser(String(value), 10);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const bloodPressure = vitalSigns.blood_pressure || vitalSigns.bloodPressure || null;
    const heartRate = numberOrNull(
      vitalSigns.heart_rate ?? vitalSigns.heartRate ?? vitalSigns.pulse,
      Number.parseInt
    );
    const temperature = numberOrNull(vitalSigns.temperature);
    const bloodSugar = numberOrNull(
      vitalSigns.blood_sugar ?? vitalSigns.bloodSugar,
      Number.parseInt
    );
    const spO2 = numberOrNull(vitalSigns.spo2 ?? vitalSigns.spO2, Number.parseInt);
    const weight = numberOrNull(measurementValues.weight);
    // height isn't a patient_vitals column, but the nurse may still send it
    // in measurements — read it so the growth percentile can use it.
    const heightCm = numberOrNull(measurementValues.height_cm ?? measurementValues.height);

    // Temperature route (axillary/oral/rectal/tympanic) — axillary runs
    // ~0.5 C below oral, so the route changes a paediatric fever band.
    // Finding: 2026-05-09-pediatric-opd-nurse-no-temperature-route-field.
    const routeResult = normaliseTemperatureRoute(
      vitalSigns.temperature_route ?? vitalSigns.temperatureRoute
    );
    if (routeResult.error) {
      return error(res, routeResult.error, HTTP_STATUS.BAD_REQUEST);
    }
    const temperatureRoute = routeResult.value;

    if (!bloodPressure && heartRate == null && temperature == null &&
        bloodSugar == null && weight == null && spO2 == null) {
      return error(res, 'At least one vital sign or measurement is required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO patient_vitals
         (patient_uid, blood_pressure, heart_rate, temperature, temperature_route, blood_sugar, weight, spo2, source, admission_id, encounter_id)
       VALUES ($1::uuid, $2::jsonb, $3, $4, $5, $6, $7, $8, 'manual', $9, $10::uuid)
       RETURNING id, recorded_at, source, admission_id, encounter_id`,
      patient[0].uid,
      bloodPressure ? JSON.stringify(bloodPressure) : null,
      heartRate,
      temperature,
      temperatureRoute,
      bloodSugar,
      weight,
      spO2,
      admissionIdValue,
      encounterIdValue,
    );

    logPhiAccess({
      userId: req.user?.uid,
      userRole: req.user?.role,
      patientId: patient[0].uid,
      recordType: 'STAFF_RECORDED_VITALS',
      action: 'CREATE',
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      requestId: req.id
    });

    // Paediatric growth percentile — compute WHO percentiles from the
    // weight/height the nurse just entered so the value surfaces in this
    // same response instead of requiring a separate growth-chart POST.
    // Best-effort: never blocks the vitals save. Findings:
    //   2026-05-09-pediatric-opd-nurse-growth-chart-not-linked-to-vitals
    //   2026-05-11-pediatric-opd-nurse-4354eb08
    let growth = null;
    try {
      growth = computeGrowthSnapshot({
        gender: patient[0].gender,
        birthday: patient[0].birthday,
        weightKg: weight,
        heightCm,
      });
    } catch (err) {
      logger.warn('Growth percentile computation failed', { error: err.message });
    }

    success(res, {
      id: result[0].id,
      patientId: patient[0].id,
      patientUid: patient[0].uid,
      recordedAt: result[0].recorded_at,
      source: result[0].source || 'manual',
      admissionId: result[0].admission_id ?? null,
      encounterId: result[0].encounter_id ?? null,
      growth,
    }, 'Vitals recorded successfully');
  } catch (err) {
    logger.error('Record staff vitals error:', err);
    error(res, 'Failed to record vitals', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// Correction window for staff-recorded vitals. A nurse should be able
// to fix a transposed BP / glucose / heart rate within a few minutes
// of recording (data entered under time pressure during a vitals round
// or pre-op holding area). Outside the window, a correction has to go
// through a clinical-note addendum rather than silently overwriting
// the row.
const VITALS_EDIT_WINDOW_MS = 5 * 60 * 1000;

/**
 * PUT /health/records/:id — Correct a staff-recorded vital sign row
 * within the 5-minute edit window. Accepts the same shape as
 * POST /health/records (vital_signs / measurements). Returns 403 with
 * `EDIT_WINDOW_EXPIRED` once the window has closed.
 */
export async function updateStaffVitals(req, res) {
  try {
    const vitalId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(vitalId) || vitalId <= 0) {
      return error(res, 'vital id must be a positive integer', HTTP_STATUS.BAD_REQUEST);
    }

    const existingRows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, recorded_at
         FROM patient_vitals
        WHERE id = $1
        LIMIT 1`,
      vitalId,
    );
    if (existingRows.length === 0) {
      return error(res, 'Vital record not found', HTTP_STATUS.NOT_FOUND);
    }
    const existing = existingRows[0];

    const recordedAtMs = new Date(existing.recorded_at).getTime();
    if (!Number.isFinite(recordedAtMs)) {
      return error(res, 'Vital record has no recorded_at timestamp', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
    if (Date.now() - recordedAtMs > VITALS_EDIT_WINDOW_MS) {
      return error(
        res,
        'Edit window expired — corrections beyond 5 minutes must be filed as a clinical-note addendum',
        HTTP_STATUS.FORBIDDEN,
        { code: 'EDIT_WINDOW_EXPIRED', recordedAt: existing.recorded_at },
      );
    }

    const body = req.body || {};
    const vitalSigns = body.vital_signs && typeof body.vital_signs === 'object' ? body.vital_signs : {};
    const measurementValues = body.measurements && typeof body.measurements === 'object' ? body.measurements : {};
    const numberOrNull = (value, parser = Number.parseFloat) => {
      if (value === null || value === undefined || value === '') return undefined;
      const parsed = parser(String(value), 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    };

    const bloodPressure = vitalSigns.blood_pressure ?? vitalSigns.bloodPressure;
    const heartRate = numberOrNull(
      vitalSigns.heart_rate ?? vitalSigns.heartRate ?? vitalSigns.pulse,
      Number.parseInt,
    );
    const temperature = numberOrNull(vitalSigns.temperature);
    const bloodSugar = numberOrNull(
      vitalSigns.blood_sugar ?? vitalSigns.bloodSugar,
      Number.parseInt,
    );
    const spO2 = numberOrNull(vitalSigns.spo2 ?? vitalSigns.spO2, Number.parseInt);
    const weight = numberOrNull(measurementValues.weight);

    const updates = [];
    const params = [];
    const pushSet = (column, value, cast = '') => {
      params.push(value);
      updates.push(`${column} = $${params.length}${cast}`);
    };
    if (bloodPressure !== undefined) {
      pushSet('blood_pressure', bloodPressure ? JSON.stringify(bloodPressure) : null, '::jsonb');
    }
    if (heartRate !== undefined) pushSet('heart_rate', heartRate);
    if (temperature !== undefined) pushSet('temperature', temperature);
    if (bloodSugar !== undefined) pushSet('blood_sugar', bloodSugar);
    if (weight !== undefined) pushSet('weight', weight);
    if (spO2 !== undefined) pushSet('spo2', spO2);

    if (updates.length === 0) {
      return error(res, 'At least one vital field is required to correct', HTTP_STATUS.BAD_REQUEST);
    }

    params.push(vitalId);
    const result = await prisma.$queryRawUnsafe(
      `UPDATE patient_vitals
          SET ${updates.join(', ')}
        WHERE id = $${params.length}
        RETURNING id, patient_uid, blood_pressure, heart_rate, temperature,
                  blood_sugar, weight, spo2, recorded_at, source`,
      ...params,
    );

    logPhiAccess({
      userId: req.user?.uid,
      userRole: req.user?.role,
      patientId: existing.patient_uid,
      recordType: 'STAFF_RECORDED_VITALS',
      action: 'UPDATE',
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      requestId: req.id,
    });

    success(res, result[0], 'Vital record corrected');
  } catch (err) {
    logger.error('Update staff vitals error:', err);
    error(res, 'Failed to correct vital record', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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

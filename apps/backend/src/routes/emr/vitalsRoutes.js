// src/routes/emr/vitalsRoutes.js
import express from 'express';
import * as vitalsChartService from '../../services/emr/vitalsChartService.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

// ===================================================================
// POST /emr/vitals — Record vitals
// ===================================================================

router.post('/vitals', async (req, res, next) => {
  try {
    const {
      patient_uid, encounter_id, heart_rate, systolic_bp, diastolic_bp,
      temperature, temperature_unit, temperature_route, spo2, respiratory_rate, blood_glucose,
      pain_score, weight_kg, height_cm, gcs_score, supplemental_o2,
      o2_flow_rate, consciousness, notes,
      fhr, fundal_height_cm,
      urine_albumin, urine_sugar, urine_ketones,
    } = req.body;

    if (!patient_uid) {
      return error(res, 'patient_uid is required', 400);
    }

    const result = await vitalsChartService.recordVitals({
      patient_uid,
      encounter_id: encounter_id || null,
      heart_rate,
      systolic_bp,
      diastolic_bp,
      temperature,
      temperature_unit,
      temperature_route,
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
      fhr,
      fundal_height_cm,
      urine_albumin,
      urine_sugar,
      urine_ketones,
      recorded_by: req.user.uid,
    });

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patient_uid,
      recordType: 'vitals',
      action: 'CREATE',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, result, 'Vitals recorded', 201);
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// PUT /emr/vitals/:vitalsId — Correct vitals within entry window
// ===================================================================

router.put('/vitals/:vitalsId', async (req, res, next) => {
  try {
    const { vitalsId } = req.params;
    const result = await vitalsChartService.correctVitals(vitalsId, {
      ...req.body,
      corrected_by: req.user.uid,
      ip_address: req.ip,
    });

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: result.patient_uid,
      recordType: 'vitals',
      action: 'UPDATE',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, result, 'Vitals corrected');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/vitals/:patientUid/latest — Latest vitals
// ===================================================================

router.get('/vitals/:patientUid/latest', async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const result = await vitalsChartService.getLatestVitals(patientUid);

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patientUid,
      recordType: 'vitals',
      action: 'READ',
      ip: req.ip,
      requestId: req.id,
    });

    if (!result) {
      return success(res, null, 'No vitals found for this patient');
    }

    return success(res, result, 'Latest vitals retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/vitals/:patientUid/trend — Vitals trend
// ===================================================================

router.get('/vitals/:patientUid/trend', async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const { vital, from, to } = req.query;

    if (!vital) {
      return error(res, 'vital query parameter is required (e.g., heart_rate, systolic_bp)', 400);
    }

    const result = await vitalsChartService.getVitalsTrend(patientUid, vital, from || null, to || null);

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patientUid,
      recordType: `vitals:${vital}`,
      action: 'READ',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, result, 'Vitals trend retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/vitals/:patientUid/chart — Full vitals chart
// ===================================================================

router.get('/vitals/:patientUid/chart', async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const { encounterId, page, limit } = req.query;

    const result = await vitalsChartService.getVitalsChart(
      patientUid,
      encounterId || null,
      { page, limit }
    );

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patientUid,
      recordType: 'vitals_chart',
      action: 'READ',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, result.vitals, 'Vitals chart retrieved', 200, result.pagination);
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// POST /emr/io — Record intake/output
// ===================================================================

router.post('/io', async (req, res, next) => {
  try {
    const { patient_uid, encounter_id, encounter_uid, io_type, category, amount_ml, description } = req.body;

    if (!patient_uid || !io_type || !category || amount_ml === undefined) {
      return error(res, 'patient_uid, io_type, category, and amount_ml are required', 400);
    }

    const result = await vitalsChartService.recordIntakeOutput({
      patient_uid,
      // Pass raw — service normalises into the int + uuid split. Stripping
      // to `|| null` here drops legitimate `encounter_id: 0` (rare) and
      // can't distinguish int vs uuid strings anyway. Finding:
      // 2026-05-09-inpatient-admission-nurse-io-encounter-uuid-500.
      encounter_id: encounter_id ?? null,
      encounter_uid: encounter_uid ?? null,
      io_type,
      category,
      amount_ml,
      description,
      recorded_by: req.user.uid,
    });

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patient_uid,
      recordType: `io:${io_type}`,
      action: 'CREATE',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, result, 'Intake/output recorded', 201);
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/io/:patientUid/balance — I/O balance
// ===================================================================

router.get('/io/:patientUid/balance', async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const { encounterId, date } = req.query;

    if (!date) {
      return error(res, 'date query parameter is required (YYYY-MM-DD)', 400);
    }

    const result = await vitalsChartService.getIOBalance(
      patientUid,
      encounterId || null,
      date
    );

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patientUid,
      recordType: 'io_balance',
      action: 'READ',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, result, 'I/O balance retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/io/:patientUid/chart — I/O chart data
// ===================================================================

router.get('/io/:patientUid/chart', async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const { encounterId, from, to } = req.query;

    const result = await vitalsChartService.getIOChart(
      patientUid,
      encounterId || null,
      from || null,
      to || null
    );

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patientUid,
      recordType: 'io_chart',
      action: 'READ',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, result, 'I/O chart retrieved');
  } catch (err) {
    next(err);
  }
});

export default router;

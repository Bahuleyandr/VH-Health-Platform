// src/routes/clinical/clinicalRoutes.js
import express from 'express';
import { validationResult } from 'express-validator';
import handoverService from '../../services/clinical/handoverService.js';
import marService from '../../services/clinical/marService.js';
import news2Service from '../../services/clinical/news2Service.js';
import { success, error } from '../../utils/responseHelper.js';
import {
  requiredUUID, requiredString, requiredNumber, optionalString, optionalNumber,
  optionalEnum, paramId,
} from '../../validators/sharedValidators.js';

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

// ===================================================================
// NEWS2 Scoring Routes
// ===================================================================

/**
 * POST /clinical/news2/record
 * Record a NEWS2 assessment for a patient.
 */
router.post('/news2/record', requiredUUID('patient_uid'), validate, async (req, res, next) => {
  try {
    const { patient_uid, vitals } = req.body;

    if (!patient_uid || !vitals) {
      return error(res, 'patient_uid and vitals are required', 400);
    }

    const requiredVitals = ['respiration_rate', 'spo2', 'temperature', 'systolic_bp', 'heart_rate', 'consciousness'];
    const missing = requiredVitals.filter((v) => vitals[v] === undefined && vitals[v] !== 0);
    if (missing.length > 0) {
      return error(res, `Missing required vital signs: ${missing.join(', ')}`, 400);
    }

    const record = await news2Service.recordNEWS2(patient_uid, vitals, req.user.uid);
    return success(res, record, 'NEWS2 assessment recorded', 201);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clinical/news2/patient/:patientUid
 * Get NEWS2 history for a patient.
 */
router.get('/news2/patient/:patientUid', async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const limit = parseInt(req.query.limit, 10) || 50;

    const result = await news2Service.getPatientNEWS2History(patientUid, limit);
    return success(res, result, 'NEWS2 history retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// Medication Administration Record (MAR) Routes
// ===================================================================

/**
 * POST /clinical/mar/schedule
 * Schedule medications for a patient.
 */
router.post('/mar/schedule', requiredUUID('patient_uid'), validate, async (req, res, next) => {
  try {
    const { patient_uid, prescription_id, medications } = req.body;

    if (!patient_uid || !medications) {
      return error(res, 'patient_uid and medications are required', 400);
    }

    const records = await marService.scheduleMedications(patient_uid, prescription_id, medications);
    return success(res, records, 'Medications scheduled', 201);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clinical/mar/:id/administer
 * Record medication administration.
 */
router.post('/mar/:id/administer', paramId(), optionalString('notes', 500), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { notes, witness_uid } = req.body;

    const record = await marService.recordAdministration(
      parseInt(id, 10),
      req.user.uid,
      notes || null,
      witness_uid || null
    );
    return success(res, record, 'Medication administration recorded');
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clinical/mar/:id/miss
 * Record a missed medication dose.
 */
router.post('/mar/:id/miss', paramId(), requiredString('reason', 500), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return error(res, 'Reason is required for missed medication', 400);
    }

    const record = await marService.recordMissed(parseInt(id, 10), reason);
    return success(res, record, 'Missed medication recorded');
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clinical/mar/:id/hold
 * Hold a medication with reason.
 */
router.post('/mar/:id/hold', paramId(), requiredString('reason', 500), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return error(res, 'Reason is required to hold medication', 400);
    }

    const record = await marService.holdMedication(parseInt(id, 10), reason, req.user.uid);
    return success(res, record, 'Medication held');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clinical/mar/patient/:patientUid
 * Get patient's MAR for a specific date.
 */
router.get('/mar/patient/:patientUid', async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const { date } = req.query;

    const records = await marService.getPatientMAR(patientUid, date || null);
    return success(res, records, 'Patient MAR retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clinical/mar/overdue
 * Get overdue medications, optionally filtered by ward.
 */
router.get('/mar/overdue', async (req, res, next) => {
  try {
    const { ward_id } = req.query;

    const records = await marService.getOverdueMedications(ward_id || null);
    return success(res, records, 'Overdue medications retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// Nurse Handover Routes
// ===================================================================

/**
 * POST /clinical/handover
 * Create a nurse handover note.
 */
router.post('/handover', requiredUUID('patient_uid'), requiredString('summary', 2000), requiredString('incoming_nurse'), validate, async (req, res, next) => {
  try {
    const data = {
      ...req.body,
      outgoing_nurse: req.body.outgoing_nurse || req.user.uid,
    };

    const record = await handoverService.createHandover(data);
    return success(res, record, 'Handover created', 201);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clinical/handover/:id/acknowledge
 * Acknowledge a handover as the incoming nurse.
 */
router.post('/handover/:id/acknowledge', paramId(), validate, async (req, res, next) => {
  try {
    const { id } = req.params;

    const record = await handoverService.acknowledgeHandover(parseInt(id, 10), req.user.uid);
    return success(res, record, 'Handover acknowledged');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clinical/handover/pending
 * Get pending (unacknowledged) handovers for the current nurse.
 */
router.get('/handover/pending', async (req, res, next) => {
  try {
    const records = await handoverService.getActiveHandovers(req.user.uid);
    return success(res, records, 'Pending handovers retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clinical/handover/patient/:patientUid
 * Get handover history for a patient.
 */
router.get('/handover/patient/:patientUid', async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const limit = parseInt(req.query.limit, 10) || 50;

    const records = await handoverService.getPatientHandoverHistory(patientUid, limit);
    return success(res, records, 'Patient handover history retrieved');
  } catch (err) {
    next(err);
  }
});

export default router;

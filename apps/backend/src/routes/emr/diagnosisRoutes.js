// src/routes/emr/diagnosisRoutes.js
import express from 'express';
import * as diagnosisService from '../../services/emr/diagnosisService.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

// ===================================================================
// POST /emr/diagnosis — Add diagnosis
// ===================================================================

router.post('/diagnosis', async (req, res, next) => {
  try {
    const {
      patient_uid, encounter_id, icd10_code, description,
      diagnosis_type, status, onset_date, severity, notes,
    } = req.body;

    if (!patient_uid || !description) {
      return error(res, 'patient_uid and description are required', 400);
    }

    const diagnosis = await diagnosisService.addDiagnosis({
      patient_uid,
      encounter_id: encounter_id || null,
      icd10_code: icd10_code || null,
      description,
      diagnosis_type: diagnosis_type || 'secondary',
      status: status || 'active',
      onset_date: onset_date || null,
      severity: severity || null,
      diagnosed_by: req.user.uid,
      notes: notes || null,
    });

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patient_uid,
      recordType: 'diagnosis',
      action: 'CREATE',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, diagnosis, 'Diagnosis added', 201);
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// PUT /emr/diagnosis/:id/status — Update diagnosis status
// ===================================================================

router.put('/diagnosis/:id/status', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status, resolved_date } = req.body;

    if (isNaN(id)) {
      return error(res, 'Valid diagnosis ID is required', 400);
    }

    if (!status) {
      return error(res, 'status is required', 400);
    }

    const updated = await diagnosisService.updateDiagnosisStatus(
      id,
      status,
      resolved_date || null,
      req.user.uid
    );

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: updated.patient_uid,
      recordType: 'diagnosis_status',
      action: 'UPDATE',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, updated, 'Diagnosis status updated');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/diagnosis/patient/:uid — Problem list (active + chronic)
// ===================================================================

router.get('/diagnosis/patient/:uid', async (req, res, next) => {
  try {
    const { uid } = req.params;

    const problemList = await diagnosisService.getActiveProblemList(uid);

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: uid,
      recordType: 'problem_list',
      action: 'VIEW',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, problemList, 'Problem list retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/diagnosis/encounter/:encounterId — Encounter diagnoses
// ===================================================================

router.get('/diagnosis/encounter/:encounterId', async (req, res, next) => {
  try {
    const { encounterId } = req.params;

    const diagnoses = await diagnosisService.getEncounterDiagnoses(encounterId);

    if (diagnoses.length > 0) {
      logPhiAccess({
        userId: req.user.uid,
        userRole: req.user.role,
        patientId: diagnoses[0].patient_uid,
        recordType: 'encounter_diagnoses',
        action: 'VIEW',
        ip: req.ip,
        requestId: req.id,
      });
    }

    return success(res, diagnoses, 'Encounter diagnoses retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/diagnosis/patient/:uid/history — Full diagnosis history
// ===================================================================

router.get('/diagnosis/patient/:uid/history', async (req, res, next) => {
  try {
    const { uid } = req.params;

    const history = await diagnosisService.getPatientDiagnosisHistory(uid);

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: uid,
      recordType: 'diagnosis_history',
      action: 'VIEW',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, history, 'Diagnosis history retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/icd10/search — Search ICD-10 codes
// ===================================================================

router.get('/icd10/search', async (req, res, next) => {
  try {
    const { q } = req.query;

    if (!q || q.trim().length < 2) {
      return error(res, 'Search query (q) must be at least 2 characters', 400);
    }

    const results = await diagnosisService.searchICD10(q);

    return success(res, results, 'ICD-10 codes retrieved');
  } catch (err) {
    next(err);
  }
});

export default router;

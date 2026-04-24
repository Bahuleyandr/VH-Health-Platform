// src/routes/health/protectedRoutes.js
import express from 'express';
import * as healthStatsController from '../../controllers/health/healthStatsController.js';
import * as patientHealthController from '../../controllers/health/patientHealthController.js';
import {
  activeOnlyValidator,
  patientIdValidator,
  trendsValidator,
} from '../../validators/health/healthValidators.js';

const router = express.Router();

// NB: the staff-facing CRUD routes
//   GET    /records
//   GET    /records/:id
//   POST   /records
//   PUT    /records/:id
//   GET    /test
// were removed in batch 45. They were all backed by healthRecordService
// methods that wrote to non-existent columns on the live health_records
// table (which is a file-upload store, not a vitals store). File-upload
// workflow is served by `/api/v1/records/health-records/*` via
// patientRecordController; vitals workflow is served by this file's
// `/patient/*/vitals` + `/patient/vitals` endpoints via
// patientHealthController. See the healthRecordService header for the
// full rationale.

// Patient health routes — IDOR-gated via
// healthRecordService.checkDoctorPatientAccess on DOCTOR-role callers.
router.get('/patient/:patient_id/summary',
  [...patientIdValidator, ...trendsValidator],
  patientHealthController.getPatientSummary
);

router.get('/patient/:patient_id/trends',
  [...patientIdValidator, ...trendsValidator],
  patientHealthController.getPatientVitalTrends
);

router.get('/patient/:patient_id/allergies',
  patientIdValidator,
  patientHealthController.getPatientAllergies
);

router.get('/patient/:patient_id/conditions',
  [...patientIdValidator, ...activeOnlyValidator],
  patientHealthController.getPatientConditions
);

// Patient self-reported vitals — writes to patient_vitals.
router.post('/patient/vitals',
  patientHealthController.recordPatientVitals
);

router.get('/patient/:patient_id/vitals',
  patientIdValidator,
  patientHealthController.getPatientVitals
);

router.get('/patient/:patient_id/sync-status',
  patientIdValidator,
  patientHealthController.getVitalsSyncStatus
);

// Statistics routes
router.get('/stats/overview',
  healthStatsController.getHealthStatistics
);

export default router;

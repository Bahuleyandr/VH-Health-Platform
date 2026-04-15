// src/routes/health/protectedRoutes.js
import express from 'express';
import * as healthRecordController from '../../controllers/health/healthRecordController.js';
import * as healthStatsController from '../../controllers/health/healthStatsController.js';
import * as patientHealthController from '../../controllers/health/patientHealthController.js';
import {
  healthRecordCreateValidator,
  healthRecordUpdateValidator,
  paginationValidator,
  recordFilterValidator,
  patientIdValidator,
  recordIdValidator,
  trendsValidator,
  activeOnlyValidator
} from '../../validators/health/healthValidators.js';

const router = express.Router();

// Test route
router.get('/test', healthRecordController.testRoute);

// Health records routes
router.get('/records', 
  [...paginationValidator, ...recordFilterValidator], 
  healthRecordController.getHealthRecords
);

router.get('/records/:id', 
  recordIdValidator, 
  healthRecordController.getHealthRecordById
);

router.post('/records', 
  healthRecordCreateValidator, 
  healthRecordController.createHealthRecord
);

router.put('/records/:id', 
  [...recordIdValidator, ...healthRecordUpdateValidator], 
  healthRecordController.updateHealthRecord
);

// Patient health routes
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

// Patient self-reported vitals
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
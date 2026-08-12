// src/routes/health/protectedRoutes.js
import express from 'express';
import { CLINICAL_STAFF_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import * as healthStatsController from '../../controllers/health/healthStatsController.js';
import * as patientHealthController from '../../controllers/health/patientHealthController.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { rejectMobileClinicalWrite } from '../../middleware/rejectMobileClinicalWriteMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import {
  activeOnlyValidator,
  patientIdValidator,
  trendsValidator,
} from '../../validators/health/healthValidators.js';
import {
  guardClinicalVitalsWrite,
  guardVitalsResourceWrite,
} from '../emr/vitalsRouteGuards.js';

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
router.put(
  '/patient/vitals/wearable/:sourceRecordId',
  requireRole('PATIENT'),
  requireIdempotencyKey({ scope: 'patient_wearable_vitals_correction' }),
  patientHealthController.correctPatientWearableVitals,
);

// Staff-app compatibility endpoint. The app historically posts its structured
// body to /health/records; the controller adapts that body to the canonical
// vitals_chart service so timeline, audit, NEWS2, and escalation all run.
//
// This is the staff offline-queue's vitals drain target — a lost-2xx retry or
// redrain would otherwise create a duplicate vitals row. The client now always
// sends a stable Idempotency-Key; consume it so replays collapse (finding #15).
router.post('/records',
  requireRole(...CLINICAL_STAFF_ROUTE_ROLES),
  rejectMobileClinicalWrite,
  guardClinicalVitalsWrite,
  requireIdempotencyKey({ scope: 'staff_vitals_record' }),
  patientHealthController.recordStaffVitals
);

// 5-minute correction window for nurses fixing a transposed vital right
// after recording. Outside the window, edits must go through a clinical
// note addendum. Finding:
//   2026-05-10-surgical-day-care-nurse-vitals-edit-window-missing
const correctionGuards = [
  requireRole(...CLINICAL_STAFF_ROUTE_ROLES),
  rejectMobileClinicalWrite,
  guardVitalsResourceWrite,
  requireIdempotencyKey({ scope: 'staff_vitals_correction' }),
];
router.put('/records/:id', ...correctionGuards, patientHealthController.updateStaffVitals);
router.patch('/records/:id', ...correctionGuards, patientHealthController.updateStaffVitals);

router.get('/patient/:patient_id/vitals',
  patientIdValidator,
  patientHealthController.getPatientVitals
);

router.get('/patient/:patient_id/sync-status',
  patientIdValidator,
  patientHealthController.getVitalsSyncStatus
);

// Statistics routes — CAN-053: platform-wide health_records aggregates must NOT
// be exposed to patients or broad staff. Restrict to admin/clinical-leadership
// analytics roles. (Tenant-scoping of the counts is part of the health-router
// tenant-context cluster CAN-028.)
router.get('/stats/overview',
  requireRole('ADMIN', 'SUPER_ADMIN', 'CMO', 'CNO', 'MEDICAL_SUPERINTENDENT'),
  healthStatsController.getHealthStatistics
);

export default router;

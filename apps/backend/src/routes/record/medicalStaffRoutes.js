// src/routes/record/medicalStaffRoutes.js
import express from 'express';
import { query } from 'express-validator';
import * as medicalStaffController from '../../controllers/record/medicalStaffRecordController.js';
import {
  paginationValidator,
  filterValidator,
  recordIdValidator,
  patientIdValidator,
  doctorIdValidator
} from '../../validators/record/recordValidators.js';

import { routePatientGuard } from '../../middleware/routePatientAccessGuards.js';

const router = express.Router();

// Per-route patient guard. The mount-level patientAccessGuard could never
// decide this route: mount middleware runs before Express binds the path
// param, so it saw req.params = {} and returned no_patient_context without
// evaluating a policy. routePatientAccessGuards.js carries the full
// rationale, the selector contract and the shadow-mode posture.
//
// RECORD TYPE — PATIENT_RECORD, not the mount's MEDICAL_RECORD. Both fall
// through policyCodeForRecordType to the same PATIENT_RECORD_VIEW policy,
// but PATIENT_RECORD is already in CARE_TEAM_GOVERNED_RECORD_TYPES and
// already at a governed call site (the sibling patientRoutes.js), so the
// exact-set census in careTeamGovernedRecordTypes.test.js is unchanged.
const guardRecordPatientId = routePatientGuard('PATIENT_RECORD', {
  tag: 'records:patient-id-param',
  patientSelector: (req) => ({ id: req.params?.patient_id }),
});

// Get all medical records with filtering
router.get('/records', 
  [...paginationValidator, ...filterValidator], 
  medicalStaffController.getMedicalRecords
);

// Get medical record by ID
router.get('/records/:id', 
  recordIdValidator, 
  medicalStaffController.getMedicalRecordById
);

// Get patient records
router.get('/patient/:patient_id', 
  patientIdValidator, 
  guardRecordPatientId,
  medicalStaffController.getPatientRecords
);

// Get doctor records
router.get('/doctor/:doctor_id', 
  doctorIdValidator,
  medicalStaffController.getDoctorRecords
);

// Get patient summary
router.get('/patient/:patient_id/summary', 
  patientIdValidator, 
  guardRecordPatientId,
  medicalStaffController.getPatientSummary
);

// Search medical records
router.get('/search', 
  query('q').notEmpty().withMessage('Search term required').trim(),
  medicalStaffController.searchMedicalRecords
);

export default router;
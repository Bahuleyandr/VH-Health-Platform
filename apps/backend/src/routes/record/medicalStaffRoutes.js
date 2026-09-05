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
// IDENTIFIER SPACE — :patient_id is NOT int-only, despite its name and despite
// patientIdValidator's isInt(). recordService#resolvePatientFilterToUuid takes
// EITHER a users.id integer OR a patient uuid, discriminating on the uuid
// shape, so GET /patient/<uuid> really does return that patient's records.
//
// patientIdValidator does not prevent that: it is express-validator, and
// NOTHING in this chain reads validationResult — not the route, not
// medicalStaffRecordController, not app.js. The isInt() failure is recorded
// and never enforced. (recordService#getPatientSummary's own comment,
// "patientId arrives as int (the API validator is isInt)", makes the same
// wrong assumption.)
//
// So the selector must discriminate exactly as the handler does. Matching on
// the loose shape recordService uses — not the stricter v1-5 form — keeps the
// two in step: any uuid the access engine then rejects as malformed resolves
// no patient and the guard refuses or records, which is the fail-closed side.
// Bind on the int alone and the uuid form of the URL reaches the handler with
// no patient resolved and NO policy evaluated — precisely the defect this
// guard exists to close.
const RECORD_PATIENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const guardRecordPatientId = routePatientGuard('PATIENT_RECORD', {
  tag: 'records:patient-id-param',
  patientSelector: (req) => {
    const raw = req.params?.patient_id;
    return RECORD_PATIENT_UUID_RE.test(String(raw ?? ''))
      ? { uid: raw }
      : { id: raw };
  },
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
// src/routes/patient/patientSearchRoutes.js
//
// Routes for clinical-staff patient lookup. Currently a single endpoint
// (`GET /search`) — kept in its own file so future patient-summary or
// patient-by-uid routes can be added here without bloating an unrelated
// router. Mounted at `/api/v1/patients` from `app.js`.

import express from 'express';
import {
  createPatient,
  searchPatients,
  updatePatient,
} from '../../controllers/patient/patientSearchController.js';
import { phiAccessLogger } from '../../middleware/phiAccessMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { PATIENT_REGISTRY_WRITE_ROLES } from '../../config/patientAccessRoles.js';

const router = express.Router();

// Patient name lookup is PHI access (returns who exists in the system).
// Apply the standard HIPAA audit logger so every search is recorded
// against the requesting clinician.
router.get(
  '/search',
  phiAccessLogger('PATIENT_SEARCH'),
  searchPatients,
);

router.post(
  '/',
  requireRole(...PATIENT_REGISTRY_WRITE_ROLES),
  phiAccessLogger('PATIENT_CREATE'),
  createPatient,
);

router.put(
  '/:uid',
  requireRole(...PATIENT_REGISTRY_WRITE_ROLES),
  phiAccessLogger('PATIENT_UPDATE'),
  updatePatient,
);

router.patch(
  '/:uid',
  requireRole(...PATIENT_REGISTRY_WRITE_ROLES),
  phiAccessLogger('PATIENT_UPDATE'),
  updatePatient,
);

export default router;

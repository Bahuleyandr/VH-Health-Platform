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
import { patientAccessGuard, phiAccessLogger } from '../../middleware/phiAccessMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { PATIENT_REGISTRY_WRITE_ROLES } from '../../config/patientAccessRoles.js';
import { readCanonicalPatientTimeline } from '../../services/clinical/canonicalClinicalPlatformService.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

// Patient name lookup is PHI access (returns who exists in the system).
// Apply the standard HIPAA audit logger so every search is recorded
// against the requesting clinician.
router.get(
  '/search',
  phiAccessLogger('PATIENT_SEARCH'),
  searchPatients,
);

// Canonical patient timeline read endpoint. The older
// `/api/v1/emr/timeline/:uid` route remains as a compatibility alias, but new
// Staff clients should use this patient-scoped path.
router.get(
  '/:uid/timeline',
  patientAccessGuard('EMR_TIMELINE', { policyCode: 'patient.timeline.view' }),
  phiAccessLogger('CLINICAL_TIMELINE'),
  async (req, res, next) => {
    try {
      const timeline = await readCanonicalPatientTimeline(req.params.uid, {
        tenantId: req.tenantId || req.user?.tenant_id,
        date_from: req.query.date_from || null,
        date_to: req.query.date_to || null,
        limit: req.query.limit,
        includeLegacy: req.query.include_legacy === 'true',
      });

      logPhiAccess({
        userId: req.user.uid,
        userRole: req.user.role,
        patientId: req.params.uid,
        recordType: 'canonical_clinical_timeline',
        action: 'VIEW',
        ip: req.ip,
        requestId: req.id,
      });

      return success(res, timeline, 'Canonical patient timeline retrieved');
    } catch (err) {
      next(err);
    }
  },
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

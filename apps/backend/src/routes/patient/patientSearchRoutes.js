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
import { singleUpload, validateFileContent, validatePatientUpload } from '../../middleware/uploadMiddleware.js';
import { PATIENT_REGISTRY_WRITE_ROLES } from '../../config/patientAccessRoles.js';
import { CLINICAL_STAFF_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { rejectMobileClinicalWrite } from '../../middleware/rejectMobileClinicalWriteMiddleware.js';
import { readCanonicalPatientTimeline } from '../../services/clinical/canonicalClinicalPlatformService.js';
import { updatePatientSpo2Scale } from '../../services/clinical/news2Service.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();
const guardClinicalNews2ScaleWrite = patientAccessGuard('NEWS2_SPO2_SCALE', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  careTeamModeGoverned: true,
});

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
        include_patient_generated: req.query.include_patient_generated !== 'false',
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
  singleUpload,
  validatePatientUpload,
  validateFileContent,
  phiAccessLogger('PATIENT_CREATE'),
  createPatient,
);

router.patch(
  '/:uid/news2-spo2-scale',
  requireRole(...CLINICAL_STAFF_ROUTE_ROLES),
  rejectMobileClinicalWrite,
  requireIdempotencyKey({ required: true, scope: 'patient_news2_spo2_scale' }),
  guardClinicalNews2ScaleWrite,
  phiAccessLogger('PATIENT_NEWS2_SPO2_SCALE_UPDATE'),
  async (req, res, next) => {
    try {
      const updated = await updatePatientSpo2Scale({
        tenantId: req.tenantId || req.user?.tenant_id,
        patientUid: req.params.uid,
        spo2Scale: req.body?.spo2_scale ?? req.body?.spo2Scale,
        actorUid: req.user.uid,
        actorRole: req.user.role,
        idempotencyKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
        requestId: req.id || null,
        ipAddress: req.ip || null,
      });
      logPhiAccess({
        userId: req.user.uid,
        userRole: req.user.role,
        patientId: req.params.uid,
        recordType: 'patient_news2_spo2_scale',
        action: 'UPDATE',
        ip: req.ip,
        requestId: req.id,
      });
      return success(res, updated, 'Patient NEWS2 SpO2 scale updated');
    } catch (err) {
      return next(err);
    }
  },
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

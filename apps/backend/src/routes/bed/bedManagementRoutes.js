// src/routes/bed/bedManagementRoutes.js
// Enhanced bed management routes: occupancy, transfers, discharge-to-cleaning workflow

import express from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import bedManagementService from '../../services/bed/bedManagementService.js';
import admissionService from '../../services/emr/admissionService.js';
import { patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import { rejectMobileClinicalWrite } from '../../middleware/rejectMobileClinicalWriteMiddleware.js';
import { success } from '../../utils/responseHelper.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import {
  BED_CLINICAL_ROUTE_ROLES,
  HOUSEKEEPING_ROUTE_ROLES,
} from '../../config/routeRolePolicy.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import { AppError } from '../../utils/AppError.js';

const router = express.Router();

// Wave-4B-1 — clinical-only narrowing for the sensitive bed endpoints.
// The parent `/api/v1/beds` gate in app.js is widened to include
// GENERAL_STAFF/HOUSEKEEPING_STAFF so they can close the cleaning loop
// via POST /:id/ready. This guard re-narrows the patient-movement
// endpoints (admit / transfer / discharge) back to clinical roles.
const requireClinicalForBedMovement = requireRole(...BED_CLINICAL_ROUTE_ROLES);
const requireHousekeepingForBedReady = requireRole(...HOUSEKEEPING_ROUTE_ROLES);
const guardBedResourceWrite = patientAccessGuardForResource('BED_MANAGEMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_BED_WRITE,
  resourceType: 'bed',
  allowNoPatientResource: true,
});
const guardBedResourceView = patientAccessGuardForResource('BED_BOARD', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_BED_VIEW,
  resourceType: 'bed',
  allowNoPatientResource: true,
});
const guardAdmissionBodyWrite = patientAccessGuardForResource('BED_MANAGEMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_BED_WRITE,
  resourceType: 'admission',
  idSelector: (req) => req.body?.admission_id,
});

// ---------------------------------------------------------------------------
// Helper: async route wrapper
// ---------------------------------------------------------------------------
function wrapAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requireCanonicalTransferIdentity(req, _res, next) {
  const admissionId = Number(req.body?.admission_id);
  if (!Number.isSafeInteger(admissionId) || admissionId <= 0) {
    return next(AppError.badRequest(
      'admission_id is required; transfer the canonical admission, not a patient-only bed record',
      'ADMISSION_ID_REQUIRED',
    ));
  }
  const toBedId = Number(req.body?.to_bed_id);
  if (!Number.isSafeInteger(toBedId) || toBedId <= 0) {
    return next(AppError.badRequest('to_bed_id is required', 'TO_BED_ID_REQUIRED'));
  }
  return next();
}

function tenantIdOf(req) {
  return req.tenantId || req.user?.tenant_id || req.user?.tenantId || req.tenant?.id || null;
}

function tenantOptions(req) {
  const tenantId = tenantIdOf(req);
  if (!tenantId) {
    const err = new Error('Tenant context is required');
    err.statusCode = HTTP_STATUS.FORBIDDEN;
    err.code = 'TENANT_CONTEXT_REQUIRED';
    throw err;
  }
  return { tenantId };
}

// ---------------------------------------------------------------------------
// GET /occupancy — Occupancy dashboard stats
// ---------------------------------------------------------------------------
router.get(
  '/occupancy',
  wrapAsync(async (req, res) => {
    const stats = await bedManagementService.getBedOccupancy(tenantOptions(req));
    success(res, stats, 'Bed occupancy retrieved');
  })
);

// ---------------------------------------------------------------------------
// GET /available — List available beds with optional filters
// ---------------------------------------------------------------------------
router.get(
  '/available',
  wrapAsync(async (req, res) => {
    const { ward_id, bed_type } = req.query;
    const beds = await bedManagementService.getAvailableBeds(
      ward_id ? parseInt(ward_id, 10) : null,
      bed_type || null,
      tenantOptions(req),
    );
    success(res, { beds, count: beds.length }, 'Available beds retrieved');
  })
);

// POST /:id/admit is defined only by bedRoutes. It is a late bed-assignment
// adapter for an existing canonical admission; this router intentionally has
// no parallel admission writer.

// ---------------------------------------------------------------------------
// POST /:id/discharge — Start discharge cascade for the active admission.
//
// The bed board's Discharge button must not vacate the bed immediately.
// It opens the hospital discharge workflow (summary, consults, pharmacy,
// billing reconciliation). The final `/emr/:id/discharge` call later frees
// the bed after readiness gates pass.
// ---------------------------------------------------------------------------
router.post(
  '/:id/discharge',
  rejectMobileClinicalWrite,
  requireClinicalForBedMovement,
  guardBedResourceWrite,
  wrapAsync(async (req, res) => {
    const bedId = parseInt(req.params.id, 10);
    const requestedBy = req.user?.uid || null;

    const bedAdmission = await bedManagementService.getActiveAdmissionForBed(bedId, tenantOptions(req));
    const result = await admissionService.markForDischarge(
      Number(bedAdmission.admission_id),
      requestedBy,
      req.user?.role,
      tenantOptions(req),
    );
    success(
      res,
      {
        ...result,
        bed: {
          id: bedAdmission.bed_id,
          bed_number: bedAdmission.bed_number,
          status: bedAdmission.bed_status,
        },
      },
      'Discharge workflow initiated; bed remains occupied until final discharge',
      HTTP_STATUS.CREATED,
    );
  })
);

// ---------------------------------------------------------------------------
// POST /transfer — Transfer a patient between beds
// ---------------------------------------------------------------------------
router.post(
  '/transfer',
  rejectMobileClinicalWrite,
  requireClinicalForBedMovement,
  requireCanonicalTransferIdentity,
  guardAdmissionBodyWrite,
  wrapAsync(async (req, res) => {
    const {
      admission_id, to_bed_id, reason,
      acknowledge_class_change, acknowledgeClassChange,
    } = req.body;
    const transferredBy = req.user?.uid || null;

    const admissionId = Number(admission_id);
    const toBedId = Number(to_bed_id);
    const acknowledgeClassUpgrade = acknowledge_class_change === true
      || acknowledgeClassChange === true
      || acknowledge_class_change === 'true'
      || acknowledgeClassChange === 'true';
    const admission = await admissionService.transferPatient(
      admissionId,
      null,
      toBedId,
      reason || null,
      transferredBy,
      {
        ...tenantOptions(req),
        actorRole: req.user?.role || null,
        acknowledgeClassChange: acknowledgeClassUpgrade,
      },
    );
    success(res, { admission }, 'Patient transferred');
  })
);

// ---------------------------------------------------------------------------
// POST /:id/ready — Mark bed as ready (cleaning complete)
//
// Optional body fields are persisted to audit_logs so an auditor can later
// reconstruct who closed the cleaning loop with what proof:
//   { cleaning_ticket_id?: string, cleaner_id?: string|number, notes?: string }
// ---------------------------------------------------------------------------
router.post(
  '/:id/ready',
  requireHousekeepingForBedReady,
  wrapAsync(async (req, res) => {
    const bedId = parseInt(req.params.id, 10);
    const bed = await bedManagementService.markBedReady(bedId, {
      actorUid: req.user?.uid || null,
      cleaningTicketId: req.body?.cleaning_ticket_id || null,
      cleanerId: req.body?.cleaner_id || null,
      notes: req.body?.notes || null,
      ...tenantOptions(req),
    });
    success(res, { bed }, 'Bed marked as available');
  })
);

// ---------------------------------------------------------------------------
// GET /:id/history — Bed transfer/admission history
// ---------------------------------------------------------------------------
router.get(
  '/:id/history',
  guardBedResourceView,
  wrapAsync(async (req, res) => {
    const bedId = parseInt(req.params.id, 10);
    const history = await bedManagementService.getBedHistory(bedId, tenantOptions(req));
    success(res, { history, count: history.length }, 'Bed history retrieved');
  })
);

export default router;

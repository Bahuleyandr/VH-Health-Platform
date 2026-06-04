// src/routes/bed/bedManagementRoutes.js
// Enhanced bed management routes: occupancy, transfers, discharge-to-cleaning workflow

import express from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import bedManagementService from '../../services/bed/bedManagementService.js';
import admissionService from '../../services/emr/admissionService.js';
import { patientAccessGuard, patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import { success, error } from '../../utils/responseHelper.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import {
  BED_ALLOCATION_ROUTE_ROLES,
  BED_CLINICAL_ROUTE_ROLES,
  HOUSEKEEPING_ROUTE_ROLES,
} from '../../config/routeRolePolicy.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';

const router = express.Router();

// Wave-4B-1 — clinical-only narrowing for the sensitive bed endpoints.
// The parent `/api/v1/beds` gate in app.js is widened to include
// GENERAL_STAFF/HOUSEKEEPING_STAFF so they can close the cleaning loop
// via POST /:id/ready. This guard re-narrows the patient-movement
// endpoints (admit / transfer / discharge) back to clinical roles.
const requireClinicalForBedMovement = requireRole(...BED_CLINICAL_ROUTE_ROLES);
const requireBedAllocation = requireRole(...BED_ALLOCATION_ROUTE_ROLES);
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
const guardBedPatientWrite = patientAccessGuard('BED_MANAGEMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_BED_WRITE,
});

// ---------------------------------------------------------------------------
// Helper: async route wrapper
// ---------------------------------------------------------------------------
function wrapAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------------------------------------------------------------------------
// GET /occupancy — Occupancy dashboard stats
// ---------------------------------------------------------------------------
router.get(
  '/occupancy',
  wrapAsync(async (req, res) => {
    const stats = await bedManagementService.getBedOccupancy();
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
      bed_type || null
    );
    success(res, { beds, count: beds.length }, 'Available beds retrieved');
  })
);

// ---------------------------------------------------------------------------
// POST /:id/admit — Admit a patient to a bed
// ---------------------------------------------------------------------------
router.post(
  '/:id/admit',
  requireBedAllocation,
  guardBedPatientWrite,
  wrapAsync(async (req, res) => {
    const bedId = parseInt(req.params.id, 10);
    const { patient_uid, expected_discharge } = req.body;

    if (!patient_uid) {
      return error(res, 'patient_uid is required', HTTP_STATUS.BAD_REQUEST);
    }

    const bed = await bedManagementService.admitPatient(
      bedId,
      patient_uid,
      expected_discharge || null,
      req.user?.role || null,
    );
    success(res, { bed }, 'Patient admitted', HTTP_STATUS.CREATED);
  })
);

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
  requireClinicalForBedMovement,
  guardBedResourceWrite,
  wrapAsync(async (req, res) => {
    const bedId = parseInt(req.params.id, 10);
    const requestedBy = req.user?.uid || null;

    const bedAdmission = await bedManagementService.getActiveAdmissionForBed(bedId);
    const result = await admissionService.markForDischarge(
      Number(bedAdmission.admission_id),
      requestedBy,
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
  requireClinicalForBedMovement,
  guardBedPatientWrite,
  wrapAsync(async (req, res) => {
    const {
      patient_uid, to_bed_id, reason,
      // D34 — Operator (cashier / admission-counter) must surface a
      // class-change consent to the patient before re-tariffing
      // general → private / deluxe. Pass the consent flag through to
      // the service which will 400 with BED_TRANSFER_CLASS_CHANGE_UNACKNOWLEDGED
      // for unacknowledged upgrades. Accept both snake_case and
      // camelCase from the staff app.
      acknowledge_class_change, acknowledgeClassChange,
    } = req.body;
    const transferredBy = req.user?.uid || null;

    if (!patient_uid || !to_bed_id) {
      return error(res, 'patient_uid and to_bed_id are required', HTTP_STATUS.BAD_REQUEST);
    }

    const ackFlag = acknowledge_class_change === true
      || acknowledgeClassChange === true
      || acknowledge_class_change === 'true'
      || acknowledgeClassChange === 'true';

    const result = await bedManagementService.transferPatient(
      patient_uid,
      parseInt(to_bed_id, 10),
      reason || null,
      transferredBy,
      req.user?.role || null,
      { acknowledgeClassChange: ackFlag },
    );
    success(res, result, 'Patient transferred');
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
    const history = await bedManagementService.getBedHistory(bedId);
    success(res, { history, count: history.length }, 'Bed history retrieved');
  })
);

export default router;

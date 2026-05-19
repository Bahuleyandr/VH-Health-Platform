// src/routes/bed/bedManagementRoutes.js
// Enhanced bed management routes: occupancy, transfers, discharge-to-cleaning workflow

import express from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import bedManagementService from '../../services/bed/bedManagementService.js';
import { success, error } from '../../utils/responseHelper.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';

const router = express.Router();

// Wave-4B-1 — clinical-only narrowing for the sensitive bed endpoints.
// The parent `/api/v1/beds` gate in app.js is widened to include
// GENERAL_STAFF/HOUSEKEEPING_STAFF so they can close the cleaning loop
// via POST /:id/ready. This guard re-narrows the patient-movement
// endpoints (admit / transfer / discharge) back to clinical roles.
const requireClinicalForBedMovement = requireRole(
  'ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF',
);

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
  requireClinicalForBedMovement,
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
// POST /:id/discharge — Discharge a patient (bed goes to cleaning)
// ---------------------------------------------------------------------------
router.post(
  '/:id/discharge',
  requireClinicalForBedMovement,
  wrapAsync(async (req, res) => {
    const bedId = parseInt(req.params.id, 10);
    const dischargedBy = req.user?.uid || null;

    const bed = await bedManagementService.dischargePatient(bedId, dischargedBy);
    success(res, { bed }, 'Patient discharged, bed set to cleaning');
  })
);

// ---------------------------------------------------------------------------
// POST /transfer — Transfer a patient between beds
// ---------------------------------------------------------------------------
router.post(
  '/transfer',
  requireClinicalForBedMovement,
  wrapAsync(async (req, res) => {
    const { patient_uid, to_bed_id, reason } = req.body;
    const transferredBy = req.user?.uid || null;

    if (!patient_uid || !to_bed_id) {
      return error(res, 'patient_uid and to_bed_id are required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await bedManagementService.transferPatient(
      patient_uid,
      parseInt(to_bed_id, 10),
      reason || null,
      transferredBy,
      req.user?.role || null,
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
  wrapAsync(async (req, res) => {
    const bedId = parseInt(req.params.id, 10);
    const history = await bedManagementService.getBedHistory(bedId);
    success(res, { history, count: history.length }, 'Bed history retrieved');
  })
);

export default router;

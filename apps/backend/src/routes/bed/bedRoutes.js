// src/routes/bed/bedRoutes.js
import express from 'express';
import * as bedController from '../../controllers/bed/bedController.js';
import { patientAccessGuard, patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import {
  ADMIN_ROUTE_ROLES,
  BED_ALLOCATION_ROUTE_ROLES,
  BED_CLINICAL_ROUTE_ROLES,
} from '../../config/routeRolePolicy.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import {
  createWardValidation, updateWardValidation, deleteWardValidation,
  createBedValidation, updateBedValidation, deleteBedValidation,
  admitValidation, wardIdValidation
} from '../../validators/bed/bedValidators.js';

export const bedRouter = express.Router();
export const wardRouter = express.Router();

// Wave-4B-1 — the parent `/api/v1/beds` gate in app.js was widened to
// admit housekeeping (GENERAL_STAFF / HOUSEKEEPING_STAFF) so they can
// close the cleaning loop via the management router's POST /:id/ready.
// Re-narrow patient-movement + bed-master endpoints here so housekeeping
// cannot create/delete beds or admit/discharge patients.
const requireClinical = requireRole(...BED_CLINICAL_ROUTE_ROLES);
const requireBedAllocation = requireRole(...BED_ALLOCATION_ROUTE_ROLES);
const requireBedAdmin = requireRole(...ADMIN_ROUTE_ROLES);
const guardBedWrite = patientAccessGuardForResource('BED_MANAGEMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_BED_WRITE,
  resourceType: 'bed',
  allowNoPatientResource: true,
});
const guardBedAdmitPatient = patientAccessGuard('BED_MANAGEMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_BED_WRITE,
});

// ===== BED ROUTES =====
bedRouter.get('/', bedController.listBeds);
bedRouter.get('/summary', bedController.getBedSummary);
bedRouter.get('/ward/:wardId', wardIdValidation, bedController.getBedsByWard);
bedRouter.post('/', requireBedAdmin, createBedValidation, bedController.createBed);
bedRouter.put('/:id', requireClinical, guardBedWrite, updateBedValidation, bedController.updateBed);
// PATCH /:id/notes — quick-note save from the staff bed-board sheet.
// Separate from PUT /:id because that handler's body contract requires
// patient fields and would null them out when the sheet only sends notes.
bedRouter.patch('/:id/notes', requireClinical, guardBedWrite, bedController.updateBedNotes);
bedRouter.delete('/:id', requireBedAdmin, deleteBedValidation, bedController.deleteBed);
bedRouter.post('/:id/admit', requireBedAllocation, guardBedAdmitPatient, admitValidation, bedController.admitPatient);
// /:id/discharge intentionally omitted — handled exclusively by bedManagementRoutes
// (mounted after this router at /api/v1/beds). Defining it here shadowed the new
// handler and bypassed the cleaning-status transition and housekeeping ticket.
// Finding: 2026-05-16-tpa-insurance-claim-discharge-c4c868fa

// ===== WARD ROUTES =====
wardRouter.get('/', bedController.listWards);
wardRouter.post('/', requireBedAdmin, createWardValidation, bedController.createWard);
wardRouter.put('/:id', requireBedAdmin, updateWardValidation, bedController.updateWard);
wardRouter.delete('/:id', requireBedAdmin, deleteWardValidation, bedController.deleteWard);

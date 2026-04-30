/**
 * Admin routes for patient identifier CRUD (Phase A2 PR1).
 *
 *   GET    /patient-identifiers                          — lookup by (type,value)
 *   GET    /patient-identifiers/by-patient/:uid          — list a patient's identifiers
 *   POST   /patient-identifiers                          — attach a new identifier
 *   GET    /patient-identifiers/:id                      — fetch a single row
 *   PATCH  /patient-identifiers/:id/retire               — soft-retire (status='retired')
 *   PATCH  /patient-identifiers/:id/primary              — set as primary for the type
 *
 * Mounted at /api/v1/admin/patient-identifiers via routes/admin/index.js.
 * RBAC inherits the admin gate already applied at the parent mount.
 */

import express from 'express';

import { error, success } from '../../utils/responseHelper.js';
import {
  addPatientIdentifier,
  getPatientIdentifier,
  listPatientIdentifiers,
  lookupByIdentifier,
  retirePatientIdentifier,
  setPrimaryIdentifier,
} from '../../services/patient/patientIdentifierService.js';

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    if (!req.query.identifier_type || !req.query.identifier_value) {
      return error(res, 'identifier_type and identifier_value query params are required', 400);
    }
    const result = await lookupByIdentifier({
      tenantId: req.tenantId,
      identifierType: req.query.identifier_type,
      identifierValue: req.query.identifier_value,
      hashValue: String(req.query.hash || '').toLowerCase() === 'true',
    });
    return success(res, result, 'Identifier lookup complete');
  } catch (err) {
    return next(err);
  }
});

router.get('/by-patient/:uid', async (req, res, next) => {
  try {
    const result = await listPatientIdentifiers({
      tenantId: req.tenantId,
      patientUid: req.params.uid,
      status: req.query.status || null,
      identifierType: req.query.identifier_type || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Patient identifiers retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const row = await addPatientIdentifier({
      tenantId: req.tenantId,
      patientUid: req.body?.patient_uid,
      identifierType: req.body?.identifier_type,
      identifierValue: req.body?.identifier_value,
      hashValue: Boolean(req.body?.hash_value),
      issuer: req.body?.issuer || null,
      assignedAt: req.body?.assigned_at || null,
      expiresAt: req.body?.expires_at || null,
      isPrimary: Boolean(req.body?.is_primary),
      metadata: req.body?.metadata || {},
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Patient identifier attached', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = await getPatientIdentifier({
      tenantId: req.tenantId,
      id: req.params.id,
    });
    return success(res, row, 'Patient identifier retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id/retire', async (req, res, next) => {
  try {
    const row = await retirePatientIdentifier({
      tenantId: req.tenantId,
      id: req.params.id,
    });
    return success(res, row, 'Patient identifier retired');
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id/primary', async (req, res, next) => {
  try {
    const row = await setPrimaryIdentifier({
      tenantId: req.tenantId,
      id: req.params.id,
    });
    return success(res, row, 'Patient identifier set as primary');
  } catch (err) {
    return next(err);
  }
});

export default router;

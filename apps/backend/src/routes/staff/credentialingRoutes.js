// src/routes/staff/credentialingRoutes.js
//
// Roadmap D3 — credential/privilege registry. Mounted at
// /api/v1/credentials (app.js). HR/admin manage; clinical surfaces read
// the privilege check.

import express from 'express';
import logger from '../../logging/logger.js';
import {
  addCredential,
  listCredentials,
  updateCredentialStatus,
  listExpiring,
  hasActivePrivilege,
} from '../../services/staff/credentialingService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { ROLES, isAdmin, isLeadership } from '../../utils/roleHelpers.js';

const router = express.Router();

const canManage = (role) => isAdmin(role) || isLeadership(role) || role === ROLES.HR_STAFF || role === 'SUPER_ADMIN';

function tenantOf(req) {
  return req?.tenantId || req?.user?.tenant_id || req?.user?.tenantId || req?.tenant?.id ||
    '00000000-0000-4000-8000-000000000001';
}

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Credentialing ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

router.post('/', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only HR/admin/leadership manage credentials', HTTP_STATUS.FORBIDDEN);
    const credential = await addCredential({
      staffUid: req.body.staff_uid,
      credentialType: req.body.credential_type,
      name: req.body.name,
      issuingBody: req.body.issuing_body || null,
      registrationNumber: req.body.registration_number || null,
      validFrom: req.body.valid_from || null,
      validUntil: req.body.valid_until || null,
      documentRef: req.body.document_ref || null,
      notes: req.body.notes || null,
      tenantId: tenantOf(req),
    }, { actorUid: req.user?.uid || null });
    return success(res, { credential }, 'Credential recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record credential');
  }
});

router.get('/staff/:staffUid', async (req, res) => {
  try {
    const credentials = await listCredentials(req.params.staffUid, {
      type: req.query.type || null,
      tenantId: tenantOf(req),
    });
    return success(res, { credentials, count: credentials.length }, 'Staff credentials');
  } catch (err) {
    return handleFailure(res, err, 'list credentials');
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only HR/admin/leadership manage credentials', HTTP_STATUS.FORBIDDEN);
    const credential = await updateCredentialStatus(req.params.id, {
      status: req.body.status, notes: req.body.notes || null, tenantId: tenantOf(req),
    }, { actorUid: req.user?.uid || null });
    return success(res, { credential }, 'Credential status updated');
  } catch (err) {
    return handleFailure(res, err, 'update credential');
  }
});

router.get('/expiring', async (req, res) => {
  try {
    const credentials = await listExpiring({ days: req.query.days, tenantId: tenantOf(req) });
    return success(res, { credentials, count: credentials.length }, 'Expiring credentials');
  } catch (err) {
    return handleFailure(res, err, 'list expiring credentials');
  }
});

// The gate clinical surfaces call (e.g. chemo administration, OT booking).
router.get('/check', async (req, res) => {
  try {
    const verdict = await hasActivePrivilege(req.query.staff_uid, req.query.privilege, {
      tenantId: tenantOf(req),
    });
    return success(res, verdict, verdict.allowed ? 'Privilege held' : 'Privilege not held');
  } catch (err) {
    return handleFailure(res, err, 'check privilege');
  }
});

export default router;

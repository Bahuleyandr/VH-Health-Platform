// src/routes/lab/resultReleaseRoutes.js
//
// Roadmap E6 — staff-side result release controls. Mounted at
// /api/v1/lab/release (app.js) behind clinical-staff RBAC. Patients never
// touch these; their visibility is computed in the portal queries.

import express from 'express';
import logger from '../../logging/logger.js';
import {
  setResultReleaseHold,
  releaseResultNow,
} from '../../services/portal/portalAccessService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { isAdmin, isClinical } from '../../utils/roleHelpers.js';

const router = express.Router();

const canControlRelease = (role) => isClinical(role) || isAdmin(role) || role === 'SUPER_ADMIN';

function tenantOf(req) {
  return req?.tenantId || req?.user?.tenant_id || req?.user?.tenantId || req?.tenant?.id ||
    '00000000-0000-4000-8000-000000000001';
}

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Result release ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

router.patch('/:id/hold', async (req, res) => {
  try {
    if (!canControlRelease(req.user?.role)) {
      return error(res, 'Only clinical staff control result release', HTTP_STATUS.FORBIDDEN);
    }
    const result = await setResultReleaseHold(req.params.id, {
      hold: req.body.hold,
      reason: req.body.reason || null,
    }, {
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
      tenantId: tenantOf(req),
    });
    return success(res, { result }, result.release_hold ? 'Result held from patient' : 'Hold lifted');
  } catch (err) {
    return handleFailure(res, err, 'update release hold');
  }
});

router.post('/:id/release-now', async (req, res) => {
  try {
    if (!canControlRelease(req.user?.role)) {
      return error(res, 'Only clinical staff control result release', HTTP_STATUS.FORBIDDEN);
    }
    const result = await releaseResultNow(req.params.id, {
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
      tenantId: tenantOf(req),
    });
    return success(res, { result }, 'Result released to patient');
  } catch (err) {
    return handleFailure(res, err, 'release result');
  }
});

export default router;

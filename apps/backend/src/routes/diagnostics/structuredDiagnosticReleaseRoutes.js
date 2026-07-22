import express from 'express';

import {
  releaseStructuredDiagnosticResultNow,
  setStructuredDiagnosticReleaseHold,
} from '../../services/portal/portalAccessService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import { getAuthenticatedActorRoles } from '../../utils/roleHelpers.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

function actorContext(req) {
  return {
    actorUid: req.user?.uid || null,
    actorRole: req.user?.role || null,
    actorRoles: getAuthenticatedActorRoles(req.user),
    actorRawRole: req.user?.rawRole || req.user?.role || null,
    tenantId: resolveTenantOrThrow(req),
  };
}

function setPatientContext(req, row) {
  if (!row?.patient_uid) return;
  req.phiContext = { ...(req.phiContext || {}), patientUid: row.patient_uid };
}

router.patch('/:generationId/hold', async (req, res, next) => {
  try {
    const allowed = new Set(['hold', 'reason']);
    if (Object.keys(req.body || {}).some((field) => !allowed.has(field))) {
      throw AppError.badRequest(
        'Diagnostic release hold request contains unsupported fields',
        'DIAGNOSTIC_RELEASE_INPUT_INVALID',
      );
    }
    if (typeof req.body?.hold !== 'boolean') {
      throw AppError.badRequest(
        'hold must be a boolean',
        'DIAGNOSTIC_RELEASE_INPUT_INVALID',
      );
    }
    const releaseState = await setStructuredDiagnosticReleaseHold(
      req.params.generationId,
      { hold: req.body.hold, reason: req.body.reason ?? null },
      actorContext(req),
    );
    setPatientContext(req, releaseState);
    return success(
      res,
      { release_state: releaseState },
      releaseState.release_hold ? 'Diagnostic result held from patient' : 'Diagnostic release hold lifted',
    );
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 404) {
      return next(AppError.forbidden('Not authorized to control this diagnostic result release'));
    }
    return next(err);
  }
});

router.post('/:generationId/release-now', async (req, res, next) => {
  try {
    if (Object.keys(req.body || {}).length > 0) {
      throw AppError.badRequest(
        'Diagnostic early-release request body must be empty',
        'DIAGNOSTIC_RELEASE_INPUT_INVALID',
      );
    }
    const releaseState = await releaseStructuredDiagnosticResultNow(
      req.params.generationId,
      actorContext(req),
    );
    setPatientContext(req, releaseState);
    return success(
      res,
      { release_state: releaseState },
      'Diagnostic result released to patient',
    );
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 404) {
      return next(AppError.forbidden('Not authorized to control this diagnostic result release'));
    }
    return next(err);
  }
});

export default router;

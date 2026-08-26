// src/routes/lab/resultReleaseRoutes.js
//
// Roadmap E6 — staff-side result release controls. Mounted at
// /api/v1/lab/release (app.js) behind clinical-staff RBAC. Patients never
// touch these; their visibility is computed in the portal queries.

import express from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  setResultReleaseHold,
  releaseResultNow,
} from '../../services/portal/portalAccessService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { getAuthenticatedActorRoles, isAdmin, isClinical } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';

const router = express.Router();

const POSTGRES_INT4_MAX = 2_147_483_647;

// ── Per-route patient-access guard ──────────────────────────────────────────
// The LAB_RESULT guard used to sit on the /api/v1/lab/release mount in app.js.
// A mount-level middleware runs before Express matches the route, so
// req.params was always empty there, and with the patient carried only in the
// :id path param the guard resolved no patient and returned no_patient_context
// without ever evaluating a policy — in shadow AND in enforce. The guard now
// runs per route with a selector that resolves the patient behind the exact
// lab_results row the handler is about to hold/release.
//
// Selector contract for this file: it NEVER throws. Malformed ids and lookup
// failures both return null, and the guard then refuses cleanly via
// requirePatientContext (403 in enforce; shadow records the unresolved
// decision and continues) — a selector error must not add a new 500 to the
// critical-result release path.
async function releaseResultPatientSelector(req) {
  try {
    const resultId = Number.parseInt(String(req.params?.id ?? ''), 10);
    if (!Number.isSafeInteger(resultId) || resultId <= 0 || resultId > POSTGRES_INT4_MAX) {
      return null;
    }
    // Same tenant-scoped row lookup portalAccessService.getResult performs
    // before either write (lab_results WHERE id AND tenant_id).
    const rows = await prisma.$queryRawUnsafe(
      `SELECT patient_uid AS uid
         FROM lab_results
        WHERE tenant_id = $1::uuid
          AND id = $2::int
        LIMIT 1`,
      resolveTenantOrThrow(req),
      resultId,
    );
    return rows[0] ?? null;
  } catch (err) {
    logger.warn('Result-release patient selector failed; guard will refuse without patient context', {
      resultId: req.params?.id ?? null,
      error: err?.message,
    });
    return null;
  }
}

// careTeamModeGoverned + record type are carried over unchanged from the old
// mount options. requirePatientContext keeps "result id present but
// unresolvable" and "no relationship to this patient" both at 403 in enforce
// mode, so the release surface cannot become a result-existence oracle.
const guardReleaseControl = patientAccessGuard('LAB_RESULT', {
  careTeamModeGoverned: true,
  requirePatientContext: true,
  patientSelector: releaseResultPatientSelector,
});

// Test surface (labPathologyNursingRouteGuards.test.js) — not a public API.
export const __patientAccessSelectors = { releaseResultPatientSelector };

const canControlRelease = (role) => isClinical(role) || isAdmin(role) || role === 'SUPER_ADMIN';

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

router.patch('/:id/hold', guardReleaseControl, async (req, res) => {
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
      actorRoles: getAuthenticatedActorRoles(req.user),
      actorRawRole: req.user?.rawRole || req.user?.role || null,
      tenantId: tenantOf(req),
    });
    return success(res, { result }, result.release_hold ? 'Result held from patient' : 'Hold lifted');
  } catch (err) {
    return handleFailure(res, err, 'update release hold');
  }
});

router.post('/:id/release-now', guardReleaseControl, async (req, res) => {
  try {
    if (!canControlRelease(req.user?.role)) {
      return error(res, 'Only clinical staff control result release', HTTP_STATUS.FORBIDDEN);
    }
    const result = await releaseResultNow(req.params.id, {
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
      actorRoles: getAuthenticatedActorRoles(req.user),
      actorRawRole: req.user?.rawRole || req.user?.role || null,
      tenantId: tenantOf(req),
    });
    return success(res, { result }, 'Result released to patient');
  } catch (err) {
    return handleFailure(res, err, 'release result');
  }
});

export default router;

// src/routes/clinical/bloodborneMarkerRoutes.js
//
// Read and void surface for the patient blood-borne marker record. Mounted at
// /api/v1/bloodborne-markers behind the clinical-staff gate + PHI logger (see
// app.js), mirroring /api/v1/allergies. There is no create route by owner
// decision: marker rows are written by the lab sign-off hook and by the cath
// readiness checklist's external-result path.
//
// Both routes carry their own per-route patientAccessGuard: the mount guard
// runs before Express has matched a route, so :patientUid is not visible to it
// (mountLevelPatientGuardCensus.test.js documents that class). The in-router
// guard is the authority here.

import express from 'express';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import {
  DEFAULT_VALIDITY_DAYS,
  listMarkersForPatient,
  voidMarker,
} from '../../services/clinical/bloodborneMarkerService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALIDITY_DAYS_MESSAGE = 'validity_days must be an integer between 1 and 365';

const guardMarkerAccess = patientAccessGuard('BLOODBORNE_MARKERS', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
});

// `{ value }` or `{ invalid: true }` — never throws, so the 400 for a bad
// window is distinguishable from a service AppError in the handler without
// inspecting error shapes. A repeated query key arrives as an array and
// stringifies to "30,90", which the digits-only test rejects.
function parseValidityDays(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: DEFAULT_VALIDITY_DAYS };
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return { invalid: true };
  const parsed = Number.parseInt(text, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) return { invalid: true };
  return { value: parsed };
}

router.get('/patient/:patientUid', guardMarkerAccess, async (req, res) => {
  try {
    const patientUid = String(req.params.patientUid || '').trim();
    if (!UUID_RE.test(patientUid)) {
      return error(res, 'patientUid must be a UUID', HTTP_STATUS.BAD_REQUEST);
    }
    const validityDays = parseValidityDays(req.query?.validity_days);
    if (validityDays.invalid) {
      return error(res, VALIDITY_DAYS_MESSAGE, HTTP_STATUS.BAD_REQUEST);
    }
    const data = await listMarkersForPatient({
      tenantId: resolveTenantOrThrow(req),
      patientUid,
      validityDays: validityDays.value,
      includeVoided: String(req.query?.include_voided ?? '').toLowerCase() === 'true',
    });
    return success(res, data, 'Blood-borne markers');
  } catch (err) {
    return relayAppError(res, err, 'Failed to read blood-borne markers');
  }
});

router.post(
  '/patient/:patientUid/markers/:id/void',
  guardMarkerAccess,
  requireIdempotencyKey({ required: true, scope: 'bloodborne_marker_void' }),
  async (req, res) => {
    try {
      const patientUid = String(req.params.patientUid || '').trim();
      if (!UUID_RE.test(patientUid)) {
        return error(res, 'patientUid must be a UUID', HTTP_STATUS.BAD_REQUEST);
      }
      const marker = await voidMarker({
        tenantId: resolveTenantOrThrow(req),
        patientUid,
        markerId: req.params.id,
        actorUid: req.user?.uid,
        reason: req.body?.reason,
      });
      return success(res, { marker }, 'Blood-borne marker voided');
    } catch (err) {
      return relayAppError(res, err, 'Failed to void blood-borne marker');
    }
  },
);

export default router;

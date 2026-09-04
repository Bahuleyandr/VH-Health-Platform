// src/routes/clinical/bloodborneMarkerRoutes.js
//
// Read and void surface for the patient blood-borne marker record. Mounted at
// /api/v1/bloodborne-markers behind the clinical-staff gate + PHI logger (see
// app.js), mirroring /api/v1/allergies. There is no create route by owner
// decision: marker rows are written by the lab sign-off hook, and by the cath
// readiness checklist's external-result path planned in the companion cath
// readiness work.
//
// Both routes carry their own per-route patientAccessGuard: the mount guard
// runs before Express has matched a route, so :patientUid is not visible to it
// (mountLevelPatientGuardCensus.test.js documents that class). The in-router
// guard is the authority here, and it fails closed: requirePatientContext
// makes an unresolvable :patientUid — a syntactically valid uid that is not a
// patient in this tenant — a 403 PATIENT_CONTEXT_REQUIRED rather than a
// no-patient-context pass-through into the handler. This guard is deliberately
// not careTeamModeGoverned, so it enforces whatever the tenant's care-team mode
// is (allergies parity); registering BLOODBORNE_MARKERS in
// CARE_TEAM_GOVERNED_RECORD_TYPES therefore only affects the mount-level guard.
//
// Chain order on the void route is guard → requirePatientUidParam →
// requireMarkerIdParam → requireIdempotencyKey: the guard first so an
// unauthorised caller cannot use the 400/403 split to probe which uids exist,
// and BOTH identifiers validated before the idempotency claim so malformed
// identifiers never burn an idempotency key.

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
const INCLUDE_VOIDED_MESSAGE = 'include_voided must be true or false';
const MARKER_ID_MESSAGE = 'marker id must be a positive integer';

// Tier decision 2026-09-04 (classification and the role delta are recorded on
// the BLOODBORNE_MARKERS branch in accessPolicyRegistry.js): the marker rides
// PATIENT_CLINICAL_WORKFLOW_ACCESS, not PATIENT_LAB_RESULT_VIEW. That policy's
// extra care_pathway_owner / care_pathway_transfer_recipient checks are inert
// here — plain patientAccessGuard never supplies a resourceContext
// (accessDecisionService.js:1294; phiAccessMiddleware.js:238 is the only site
// that does) — so both tiers decide on the same base relationship checks on
// this route. Revisit if these routes move to patientAccessGuardForResource
// with a care-pathway resource, or a named HIV-status compliance requirement
// lands: that would want its own policy, not the lab tier.
const guardMarkerAccess = patientAccessGuard('BLOODBORNE_MARKERS', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
  requirePatientContext: true,
});

// Both routes address one patient by :patientUid, so the shape check is the
// same on both and runs as its own layer — on the void route that puts it
// ahead of the idempotency claim, so a malformed uid cannot consume a key.
// The trimmed value is written back so the handlers read one normalised uid.
function requirePatientUidParam(req, res, next) {
  const patientUid = String(req.params.patientUid || '').trim();
  if (!UUID_RE.test(patientUid)) {
    return error(res, 'patientUid must be a UUID', HTTP_STATUS.BAD_REQUEST);
  }
  req.params.patientUid = patientUid;
  return next();
}

// The void route's second identifier, checked in its own layer for the same
// reason as the uid: it runs ahead of the idempotency claim, so a malformed
// marker id cannot consume the caller's key either. Decimal digits only — the
// service coerces with Number(), which would otherwise accept '0x29' and '4e1'
// as 41 and 40: two different ids reaching one row, and an id the audit trail
// cannot reproduce.
function requireMarkerIdParam(req, res, next) {
  if (!/^\d+$/.test(String(req.params.id ?? ''))) {
    return error(res, MARKER_ID_MESSAGE, HTTP_STATUS.BAD_REQUEST);
  }
  return next();
}

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

// Same never-throws shape as parseValidityDays. The contract is a closed set:
// true|1 and false|0 (case-insensitive), absent or empty meaning false.
// Anything else — 'yes', 'on', a repeated key stringifying to "true,false" —
// is a 400 rather than a silent false, so a client asking for voided rows can
// never be quietly served the active-only list.
function parseIncludeVoided(raw) {
  if (raw === undefined || raw === null) return { value: false };
  const text = String(raw).trim().toLowerCase();
  if (text === '' || text === 'false' || text === '0') return { value: false };
  if (text === 'true' || text === '1') return { value: true };
  return { invalid: true };
}

router.get('/patient/:patientUid', guardMarkerAccess, requirePatientUidParam, async (req, res) => {
  try {
    const validityDays = parseValidityDays(req.query?.validity_days);
    if (validityDays.invalid) {
      return error(res, VALIDITY_DAYS_MESSAGE, HTTP_STATUS.BAD_REQUEST);
    }
    const includeVoided = parseIncludeVoided(req.query?.include_voided);
    if (includeVoided.invalid) {
      return error(res, INCLUDE_VOIDED_MESSAGE, HTTP_STATUS.BAD_REQUEST);
    }
    const data = await listMarkersForPatient({
      tenantId: resolveTenantOrThrow(req),
      patientUid: req.params.patientUid,
      validityDays: validityDays.value,
      includeVoided: includeVoided.value,
    });
    return success(res, data, 'Blood-borne markers');
  } catch (err) {
    return relayAppError(res, err, 'Failed to read blood-borne markers');
  }
});

router.post(
  '/patient/:patientUid/markers/:id/void',
  guardMarkerAccess,
  requirePatientUidParam,
  requireMarkerIdParam,
  requireIdempotencyKey({
    required: true,
    scope: 'bloodborne_marker_void',
    // A void is irreversible: a 5xx raised after the UPDATE committed must not
    // release the claim, so the retry replays the stored outcome instead of
    // re-running the void against a row that is already voided.
    retainOnServerError: true,
  }),
  async (req, res) => {
    try {
      // Shape already pinned by requireMarkerIdParam above.
      const marker = await voidMarker({
        tenantId: resolveTenantOrThrow(req),
        patientUid: req.params.patientUid,
        markerId: String(req.params.id),
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

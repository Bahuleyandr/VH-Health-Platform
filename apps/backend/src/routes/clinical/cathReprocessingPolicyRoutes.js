// apps/backend/src/routes/clinical/cathReprocessingPolicyRoutes.js
//
// /api/v1/cath-reprocessing — cath device reuse GOVERNANCE.
//
// These four policy operations began life on the admin console's
// cath-consumables barrel, behind ADMIN_ROUTE_ROLES plus a route-level gate for
// the two officers. That shape was wrong in both directions: the mount gate is
// the platform-admin audience, which has nothing to do with device reuse, and
// the route-level gate could never admit an officer the mount had already
// refused — so it named QUALITY_OFFICER and INFECTION_CONTROL_OFFICER while
// letting neither through. Reprocessing policy is clinical governance, so it
// gets its own mount and its own audience (CATH_REPROCESSING_POLICY_ROUTE_ROLES).
//
// The device-history lookback is registered here too, on the SAME handler the
// cath router uses, so infection control can open the device tags named in the
// notifications this platform sends it (notificationOutbox
// 'bloodborne_reuse_exposure') without holding a cath-lab workflow role.
// Everything else on this router is tenant-level configuration and carries no
// patient identity — the mount is deliberately PHI-free apart from that one
// read, which writes its own per-patient access rows.

import { Router } from 'express';

import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import {
  getReadinessSettings,
  upsertReadinessSettings
} from '../../services/clinical/cathLabReadinessService.js';
import {
  getReprocessingSettings,
  listCategoryPolicies,
  upsertCategoryPolicies,
  upsertReprocessingSettings
} from '../../services/clinical/cathDeviceReuseService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { relayAppError, success } from '../../utils/responseHelper.js';
import cathDeviceHistoryHandler from './cathDeviceHistoryHandler.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

// Same shape the cath-lab router builds. The actor is the JWT subject and
// nothing else: upsertReprocessingSettings / upsertCategoryPolicies write it to
// reviewed_by / updated_by and to the append-only audit row, so a body-supplied
// identity must never be able to reach them.
function contextOf(req) {
  return {
    actorUid: req.user?.uid || null,
    actorRole: req.user?.role || req.user?.rawRole || null,
    rawRole: req.user?.rawRole || null,
    actorRoles: Array.isArray(req.user?.roles) ? req.user.roles : [],
    requestId: req.id || null,
    ipAddress: req.ip || null,
    userAgent: req.get?.('user-agent') || null,
    idempotencyKey: req.idempotencyClaim?.requestKey || req.get?.('idempotency-key') || null
  };
}

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

// Both writes are commands against a single tenant-wide row set, so a retried
// request must not be able to overwrite a decision twice under a different
// actor. One scope for the pair: settings and policies are edited from the
// same screen and a key is per-request anyway.
const policyIdempotency = requireIdempotencyKey({
  required: true,
  scope: 'cath_reprocessing_policy'
});

router.get('/settings', async (req, res) => {
  try {
    const settings = await getReprocessingSettings({ tenantId: tenantOf(req) });
    return success(res, { settings }, 'Cath reprocessing settings retrieved');
  } catch (err) {
    return handleFailure(res, err, 'get reprocessing settings');
  }
});

router.put('/settings', policyIdempotency, async (req, res) => {
  try {
    const settings = await upsertReprocessingSettings(
      { ...(req.body || {}), tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { settings }, 'Cath reprocessing settings saved');
  } catch (err) {
    return handleFailure(res, err, 'save reprocessing settings');
  }
});

router.get('/policies', async (req, res) => {
  try {
    const policies = await listCategoryPolicies({ tenantId: tenantOf(req) });
    return success(res, { policies, count: policies.length }, 'Cath reprocessing policies retrieved');
  } catch (err) {
    return handleFailure(res, err, 'list reprocessing policies');
  }
});

router.put('/policies', policyIdempotency, async (req, res) => {
  try {
    const policies = await upsertCategoryPolicies(
      { tenantId: tenantOf(req), policies: req.body?.policies },
      contextOf(req)
    );
    return success(res, { policies, count: policies.length }, 'Cath reprocessing policies saved');
  } catch (err) {
    return handleFailure(res, err, 'save reprocessing policies');
  }
});

// Pre-cath LAB readiness policy: which of the seven items a tenant requires,
// how long a value stays fresh, whether automation may pass the labs check and
// whether an outside laboratory's value counts. It is tenant-wide clinical
// governance with no patient identity — the same audience and the same mount as
// the reprocessing policy above, NOT the platform-admin console: the officers
// who own the device-reuse policy own this one too, and the admin barrel is the
// mount that could never admit them (see the header).
router.get('/lab-readiness-settings', async (req, res) => {
  try {
    const settings = await getReadinessSettings({ tenantId: tenantOf(req) });
    return success(res, { settings }, 'Cath lab readiness settings retrieved');
  } catch (err) {
    return handleFailure(res, err, 'get lab readiness settings');
  }
});

// Shares policyIdempotency's scope with the two writes above for the reason
// stated there: one screen, one command rail, and a key is per-request anyway.
router.put('/lab-readiness-settings', policyIdempotency, async (req, res) => {
  try {
    const settings = await upsertReadinessSettings(
      { ...(req.body || {}), tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { settings }, 'Cath lab readiness settings saved');
  } catch (err) {
    return handleFailure(res, err, 'save lab readiness settings');
  }
});

// The one PHI read on this mount — the same function the cath router registers,
// which writes one hipaa_access_log row per distinct patient in the answer.
router.get('/devices/:deviceId/history', cathDeviceHistoryHandler);

export default router;

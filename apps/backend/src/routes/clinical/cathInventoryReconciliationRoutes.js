import { Router } from 'express';

import { HTTP_STATUS } from '../../config/responseCodes.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { enforceStaffClinicalWriteDevicePosture } from '../../middleware/rejectMobileClinicalWriteMiddleware.js';
import {
  canMutateCathInventoryReconciliationRole,
  canViewCathInventoryReconciliationRole,
  getCathConsumableInventoryReconciliation,
  reconcileCathConsumableInventory
} from '../../services/clinical/cathLabService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { error, relayAppError, success } from '../../utils/responseHelper.js';

const router = Router({ mergeParams: true });

function hasRole(req, predicate) {
  return [
    req.user?.rawRole,
    req.user?.role,
    ...(Array.isArray(req.user?.roles) ? req.user.roles : [])
  ].some(role => predicate(role));
}

function requireExactRole(predicate, message, code) {
  return (req, res, next) => {
    if (hasRole(req, predicate)) return next();
    return error(res, message, HTTP_STATUS.FORBIDDEN, { code });
  };
}

function contextOf(req) {
  return {
    tenantId: resolveTenantOrThrow(req),
    actorUid: req.user?.uid || null,
    actorRole: req.user?.role || req.user?.rawRole || null,
    rawRole: req.user?.rawRole || null,
    actorRoles: Array.isArray(req.user?.roles) ? req.user.roles : [],
    requestId: req.id || null,
    idempotencyKey: req.idempotencyClaim?.requestKey || req.get?.('idempotency-key') || null,
    requestFingerprint: req.idempotencyClaim?.requestBodyHash || null,
    httpIdempotencyClaimId: req.idempotencyClaim?.id || null
  };
}

function canonicalCommandIdentity(req) {
  return {
    case_id: String(req.params.caseId),
    usage_id: String(req.params.usageId)
  };
}

function canonicalCommandPath(req) {
  return `/api/v1/cath-lab/cases/${String(req.params.caseId)}`
    + `/consumables/${String(req.params.usageId)}/inventory-reconcile`;
}

function requireEmptyBody(req, res, next) {
  if (req.body === undefined) return next();
  if (
    req.body
    && typeof req.body === 'object'
    && !Array.isArray(req.body)
    && Object.keys(req.body).length === 0
  ) {
    return next();
  }
  return error(
    res,
    'Cath inventory reconciliation does not accept a request body',
    HTTP_STATUS.BAD_REQUEST,
    { code: 'CATH_INVENTORY_RECONCILIATION_BODY_NOT_ALLOWED' }
  );
}

const requireCathInventoryRead = requireExactRole(
  canViewCathInventoryReconciliationRole,
  'Cath inventory reconciliation access is required',
  'CATH_INVENTORY_RECONCILIATION_FORBIDDEN'
);
const requireCathInventoryMutation = requireExactRole(
  canMutateCathInventoryReconciliationRole,
  'A pharmacy operator role is required to reconcile Cath inventory',
  'CATH_INVENTORY_RECONCILIATION_PHARMACY_ROLE_REQUIRED'
);

router.get(
  '/',
  requireCathInventoryRead,
  async (req, res) => {
    try {
      const reconciliation = await getCathConsumableInventoryReconciliation(
        req.params.caseId,
        req.params.usageId,
        contextOf(req)
      );
      return success(
        res,
        { reconciliation },
        'Cath consumable inventory reconciliation'
      );
    } catch (err) {
      return relayAppError(res, err, 'Failed to load Cath inventory reconciliation');
    }
  }
);

router.post(
  '/',
  requireCathInventoryMutation,
  enforceStaffClinicalWriteDevicePosture,
  requireEmptyBody,
  requireIdempotencyKey({
    required: true,
    scope: 'cath_consumable_inventory_reconciliation',
    requestBodyForIdempotency: canonicalCommandIdentity,
    requestPathForIdempotency: canonicalCommandPath
  }),
  async (req, res) => {
    try {
      const result = await reconcileCathConsumableInventory(
        req.params.caseId,
        req.params.usageId,
        contextOf(req)
      );
      return success(res, result, 'Cath consumable inventory reconciliation');
    } catch (err) {
      return relayAppError(res, err, 'Failed to reconcile Cath inventory');
    }
  }
);

export const __testing__ = {
  canonicalCommandIdentity,
  canonicalCommandPath,
  requireEmptyBody
};

export default router;

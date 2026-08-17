// src/routes/facility/facilityAssetRoutes.js
//
// General (non-biomedical) facility asset register (migration 704), mounted
// at /api/v1/facility/assets behind API key + JWT (see app.js). Operational
// master data — no patient linkage, so no phiAccessLogger; mutations write
// ordinary audit_logs rows via logAudit (the facility_asset_events table is
// the domain history and is written by the service in the same transaction
// as each mutation).

import { Router } from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import {
  createFacilityAsset,
  getFacilityAsset,
  listFacilityAssetCustodians,
  listFacilityAssetEvents,
  listFacilityAssets,
  recordFacilityAssetMaintenance,
  transitionFacilityAssetStatus,
  updateFacilityAsset,
} from '../../services/facility/facilityAssetService.js';
import { markRouterDomain } from '../../config/openapiDomain.js';
import { logAudit } from '../../utils/logAudit.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import {
  ADMIN,
  BIOMEDICAL_STAFF,
  HOUSEKEEPING_INCHARGE,
  IT_ADMIN,
  MAINTENANCE,
  STORES_PURCHASE_INCHARGE,
  SUPER_ADMIN,
  SYSTEM_ADMIN,
} from '../../utils/roles.js';
import {
  createFacilityAssetValidators,
  listFacilityAssetCustodianValidators,
  listFacilityAssetEventValidators,
  listFacilityAssetValidators,
  maintenanceFacilityAssetValidators,
  transitionFacilityAssetValidators,
  updateFacilityAssetValidators,
} from '../../validators/facilityAssetValidator.js';
import { paramId } from '../../validators/sharedValidators.js';

// Who may register/move/dispose general facility assets. Mirrors the biomed
// CMMS admin surface adapted to the general-ops staff roles.
export const FACILITY_ASSET_MANAGE_ROLES = Object.freeze([
  SUPER_ADMIN, ADMIN, MAINTENANCE, BIOMEDICAL_STAFF,
]);
// Read access additionally covers the operational supervisors who consume the
// register (housekeeping, stores, IT).
export const FACILITY_ASSET_READ_ROLES = Object.freeze([
  ...FACILITY_ASSET_MANAGE_ROLES,
  HOUSEKEEPING_INCHARGE, STORES_PURCHASE_INCHARGE, IT_ADMIN, SYSTEM_ADMIN,
]);

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

function requireRoles(roles, label) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return error(res, `Only ${label} can access the facility asset register`, 403, {
        topLevel: { code: 'FACILITY_ASSET_FORBIDDEN' },
      });
    }
    next();
  };
}

const requireRead = requireRoles(FACILITY_ASSET_READ_ROLES, 'facility operations staff');
const requireManage = requireRoles(FACILITY_ASSET_MANAGE_ROLES, 'facility asset managers');

function tenantOf(req) {
  return req.tenantId || req.user?.tenant_id;
}

function actorOf(req) {
  return {
    actorUid: req.acting?.actorUid ?? req.user?.uid ?? null,
    actorRole: req.acting?.actorRawRole
      ?? req.acting?.actorRole
      ?? req.user?.rawRole
      ?? req.user?.role
      ?? null,
  };
}

// logAudit owns the shared actor/subject shape. Facility mutations supply a
// request-shaped view whose role matches the authoritative event actor while
// preserving delegated actor/subject identity when acting-as is present.
function auditRequestOf(req) {
  const { actorRole } = actorOf(req);
  return {
    id: req.id,
    headers: req.headers,
    connection: req.connection,
    tenantId: req.tenantId,
    tenant: req.tenant,
    acting: req.acting ? { ...req.acting, actorRole } : null,
    user: req.user ? { ...req.user, role: actorRole } : req.user,
  };
}

const router = Router();
markRouterDomain(router, 'facility-asset');

/** GET /api/v1/facility/assets — register list with filters + pagination. */
router.get('/', requireRead, listFacilityAssetValidators, validate, async (req, res, next) => {
  try {
    const result = await listFacilityAssets(tenantOf(req), {
      q: req.query.q,
      status: req.query.status,
      category: req.query.category,
      custodianUid: req.query.custodian_uid ?? null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return success(res, result, 'Facility assets retrieved');
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Failed to list facility assets');
    logger.error('Failed to list facility assets:', { error: err.message });
    return next(err);
  }
});

/** GET /api/v1/facility/assets/custodians — active tenant staff picker. */
router.get('/custodians', requireRead, listFacilityAssetCustodianValidators, validate, async (req, res, next) => {
  try {
    const result = await listFacilityAssetCustodians(tenantOf(req), {
      q: req.query.q,
      limit: req.query.limit,
    });
    return success(res, result, 'Facility asset custodians retrieved');
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Failed to list facility asset custodians');
    logger.error('Failed to list facility asset custodians:', { error: err.message });
    return next(err);
  }
});

/** POST /api/v1/facility/assets — register a new asset. */
router.post('/', requireManage, createFacilityAssetValidators, validate, async (req, res, next) => {
  try {
    const asset = await createFacilityAsset(tenantOf(req), req.body, actorOf(req));
    await logAudit(auditRequestOf(req), 'facility-asset-create', { asset_tag: asset.assetTag }, {
      resource: 'facility_asset',
      resourceId: asset.id,
    });
    return success(res, asset, 'Facility asset registered', 201);
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Failed to register facility asset');
    logger.error('Failed to register facility asset:', { error: err.message });
    return next(err);
  }
});

/** GET /api/v1/facility/assets/:id — detail incl. recent events. */
router.get('/:id', requireRead, paramId('id'), validate, async (req, res, next) => {
  try {
    const asset = await getFacilityAsset(tenantOf(req), req.params.id);
    return success(res, asset, 'Facility asset retrieved');
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Failed to fetch facility asset');
    logger.error('Failed to fetch facility asset:', { error: err.message });
    return next(err);
  }
});

/** GET /api/v1/facility/assets/:id/events — full history page. */
router.get(
  '/:id/events',
  requireRead,
  paramId('id'),
  listFacilityAssetEventValidators,
  validate,
  async (req, res, next) => {
    try {
      const events = await listFacilityAssetEvents(tenantOf(req), req.params.id, {
        limit: req.query.limit,
        offset: req.query.offset,
      });
      return success(res, events, 'Facility asset events retrieved');
    } catch (err) {
      if (err.isOperational) return relayAppError(res, err, 'Failed to fetch facility asset events');
      logger.error('Failed to fetch facility asset events:', { error: err.message });
      return next(err);
    }
  },
);

/** PATCH /api/v1/facility/assets/:id — master fields / move / custodian / condition. */
router.patch('/:id', requireManage, paramId('id'), updateFacilityAssetValidators, validate, async (req, res, next) => {
  try {
    const asset = await updateFacilityAsset(tenantOf(req), req.params.id, req.body, actorOf(req));
    await logAudit(auditRequestOf(req), 'facility-asset-update', { asset_tag: asset.assetTag }, {
      resource: 'facility_asset',
      resourceId: asset.id,
    });
    return success(res, asset, 'Facility asset updated');
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Failed to update facility asset');
    logger.error('Failed to update facility asset:', { error: err.message });
    return next(err);
  }
});

/** POST /api/v1/facility/assets/:id/status — guarded status transition. */
router.post('/:id/status', requireManage, paramId('id'), transitionFacilityAssetValidators, validate, async (req, res, next) => {
  try {
    const asset = await transitionFacilityAssetStatus(tenantOf(req), req.params.id, {
      expectedVersion: req.body.expectedVersion,
      toStatus: req.body.toStatus,
      reason: req.body.reason,
      notes: req.body.notes,
    }, actorOf(req));
    await logAudit(auditRequestOf(req), 'facility-asset-status', {
      asset_tag: asset.assetTag,
      to_status: asset.status,
      reason: req.body.reason ?? null,
    }, {
      resource: 'facility_asset',
      resourceId: asset.id,
    });
    return success(res, asset, 'Facility asset status updated');
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Failed to transition facility asset');
    logger.error('Failed to transition facility asset:', { error: err.message });
    return next(err);
  }
});

/** POST /api/v1/facility/assets/:id/maintenance — record a maintenance action. */
router.post('/:id/maintenance', requireManage, paramId('id'), maintenanceFacilityAssetValidators, validate, async (req, res, next) => {
  try {
    const result = await recordFacilityAssetMaintenance(tenantOf(req), req.params.id, {
      notes: req.body.notes,
      cost: req.body.cost,
      vendor: req.body.vendor,
    }, actorOf(req));
    await logAudit(auditRequestOf(req), 'facility-asset-maintenance', {
      asset_tag: result.asset.assetTag,
    }, {
      resource: 'facility_asset',
      resourceId: result.asset.id,
    });
    return success(res, result, 'Facility asset maintenance recorded');
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Failed to record facility asset maintenance');
    logger.error('Failed to record facility asset maintenance:', { error: err.message });
    return next(err);
  }
});

export default router;

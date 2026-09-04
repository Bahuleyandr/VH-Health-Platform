import express from 'express';

import { phiAccessLogger } from '../../middleware/phiAccessMiddleware.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import {
  getCathConsumablesBillingSettings,
  listConsumableCatalog,
  listUnbilledConsumableUsage,
  resolveCathConsumableAuthorityRecovery,
  upsertCathConsumablesBillingSettings,
  upsertConsumableCatalogItem
} from '../../services/clinical/cathLabService.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

const actorContext = req => ({
  actorUid: req.user?.uid || null,
  actorRole: req.user?.role || req.user?.rawRole || null,
  actorRoles: Array.isArray(req.user?.roles) ? req.user.roles : [],
  requestId: req.id || null,
  commandKey: req.idempotencyClaim?.requestKey || req.get?.('idempotency-key') || null,
  requestFingerprint: req.idempotencyClaim?.requestBodyHash || null
});

router.get('/catalog', async (req, res, next) => {
  try {
    const items = await listConsumableCatalog({
      tenantId: req.tenantId,
      q: req.query.q || null,
      category: req.query.category || null,
      status: req.query.status || null,
      mapped: req.query.mapped ?? null,
      facilityId: req.query.facility_id,
      limit: req.query.limit || 200
    });
    return success(res, { items, count: items.length }, 'Cath consumable catalog retrieved');
  } catch (err) {
    return next(err);
  }
});

router.put(
  '/catalog',
  requireIdempotencyKey({
    required: true,
    scope: 'cath_consumable_catalog_upsert'
  }),
  async (req, res, next) => {
    try {
      const item = await upsertConsumableCatalogItem(
        { ...(req.body || {}), tenantId: req.tenantId },
        actorContext(req)
      );
      return success(res, { item }, 'Cath consumable catalog item saved');
    } catch (err) {
      return next(err);
    }
  }
);

router.post(
  '/authority-recovery/:id/resolve',
  requireIdempotencyKey({
    required: true,
    scope: 'cath_consumable_authority_recovery',
    retainOnServerError: true,
    durableDomainReceipt: true
  }),
  async (req, res, next) => {
    try {
      const recovery = await resolveCathConsumableAuthorityRecovery({
        tenantId: req.tenantId,
        recoveryId: req.params.id,
        resolution: req.body?.resolution || {},
        note: req.body?.resolution_note,
        ...actorContext(req)
      });
      return success(res, { recovery }, 'Cath consumable authority recovery resolved');
    } catch (err) {
      return next(err);
    }
  }
);

router.get('/billing-settings', async (req, res, next) => {
  try {
    const settings = await getCathConsumablesBillingSettings({ tenantId: req.tenantId });
    return success(res, { settings }, 'Cath consumable billing settings retrieved');
  } catch (err) {
    return next(err);
  }
});

router.put('/billing-settings', async (req, res, next) => {
  try {
    const settings = await upsertCathConsumablesBillingSettings(
      { ...(req.body || {}), tenantId: req.tenantId },
      actorContext(req)
    );
    return success(res, { settings }, 'Cath consumable billing settings saved');
  } catch (err) {
    return next(err);
  }
});

router.get(
  '/unbilled-usage',
  phiAccessLogger('CATH_CONSUMABLE_USAGE'),
  async (req, res, next) => {
    try {
      const result = await listUnbilledConsumableUsage({
        tenantId: req.tenantId,
        date_from: req.query.date_from || null,
        date_to: req.query.date_to || null,
        category: req.query.category || null,
        case_id: req.query.case_id || null,
        page: req.query.page || 1,
        limit: req.query.limit || 50
      });
      return success(res, result, 'Unbilled cath usage retrieved');
    } catch (err) {
      return next(err);
    }
  }
);

// Reprocessing settings and category policies USED to live here, behind the
// admin barrel's ADMIN_ROUTE_ROLES mount gate plus a route-level gate naming
// QUALITY_OFFICER and INFECTION_CONTROL_OFFICER. That second gate could never
// admit either officer — the mount had already refused them — so it was a dead
// gate over a surface neither owner could reach. Device reuse is clinical
// governance, so the four operations moved to their own mount with their own
// audience: /api/v1/cath-reprocessing (routes/clinical/cathReprocessingPolicyRoutes.js,
// CATH_REPROCESSING_POLICY_ROUTE_ROLES). This router keeps the billing-facing
// catalogue, billing settings, authority recovery and unbilled-usage surfaces.

export default router;

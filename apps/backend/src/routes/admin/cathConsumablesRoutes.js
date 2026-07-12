import express from 'express';

import { phiAccessLogger } from '../../middleware/phiAccessMiddleware.js';
import {
  getCathConsumablesBillingSettings,
  listConsumableCatalog,
  listUnbilledConsumableUsage,
  upsertCathConsumablesBillingSettings,
  upsertConsumableCatalogItem
} from '../../services/clinical/cathLabService.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

const actorContext = req => ({
  actorUid: req.user?.uid || null,
  actorRole: req.user?.role || req.user?.rawRole || null
});

router.get('/catalog', async (req, res, next) => {
  try {
    const items = await listConsumableCatalog({
      tenantId: req.tenantId,
      q: req.query.q || null,
      category: req.query.category || null,
      status: req.query.status || null,
      mapped: req.query.mapped ?? null,
      limit: req.query.limit || 200
    });
    return success(res, { items, count: items.length }, 'Cath consumable catalog retrieved');
  } catch (err) {
    return next(err);
  }
});

router.put('/catalog', async (req, res, next) => {
  try {
    const item = await upsertConsumableCatalogItem(
      { ...(req.body || {}), tenantId: req.tenantId },
      actorContext(req)
    );
    return success(res, { item }, 'Cath consumable catalog item saved');
  } catch (err) {
    return next(err);
  }
});

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

export default router;

import { Router } from 'express';
import * as linenLaundry from '../../services/linen/linenLaundryService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { success, relayAppError } from '../../utils/responseHelper.js';

const router = Router();

function contextOf(req) {
  return {
    tenantId: resolveTenantOrThrow(req),
    actorUid: req.user?.uid || null,
    actorRole: req.user?.role || null,
  };
}

function wrap(handler, { status = 200, message = 'Success' } = {}) {
  return async (req, res) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return undefined;
      return success(res, data, message, status);
    } catch (err) {
      return relayAppError(res, err, 'Linen/laundry request failed');
    }
  };
}

router.get('/board', wrap((req) =>
  linenLaundry.getLinenBoard({
    tenantId: contextOf(req).tenantId,
    wardId: req.query.ward_id,
    limit: req.query.limit,
  })));

router.get('/item-types', wrap((req) =>
  linenLaundry.listItemTypes({
    tenantId: contextOf(req).tenantId,
    active: req.query.active,
  })));

router.post('/item-types', wrap((req) =>
  linenLaundry.upsertItemType(req.body, contextOf(req)), {
  status: 201,
  message: 'Linen item type saved',
}));

router.put('/par-levels', wrap((req) =>
  linenLaundry.upsertWardParLevel(req.body, contextOf(req)), {
  message: 'Linen par level saved',
}));

router.post('/cycles', wrap((req) =>
  linenLaundry.createLaundryCycle(req.body, contextOf(req)), {
  status: 201,
  message: 'Laundry cycle created',
}));

router.get('/cycles/:id', wrap((req) =>
  linenLaundry.getLaundryCycle(req.params.id, contextOf(req))));

router.post('/cycles/:id/collect', wrap((req) =>
  linenLaundry.collectLaundryCycle(req.params.id, req.body, contextOf(req)), {
  message: 'Laundry collection recorded',
}));

router.post('/cycles/:id/laundry', wrap((req) =>
  linenLaundry.sendCycleToLaundry(req.params.id, req.body, contextOf(req)), {
  message: 'Laundry cycle sent to laundry',
}));

router.post('/cycles/:id/return', wrap((req) =>
  linenLaundry.returnLaundryCycle(req.params.id, req.body, contextOf(req)), {
  message: 'Laundry return recorded',
}));

router.post('/cycles/:id/reconcile', wrap((req) =>
  linenLaundry.reconcileLaundryCycle(req.params.id, req.body, contextOf(req)), {
  message: 'Laundry cycle reconciled',
}));

router.post('/cycles/:id/cancel', wrap((req) =>
  linenLaundry.cancelLaundryCycle(req.params.id, req.body, contextOf(req)), {
  message: 'Laundry cycle cancelled',
}));

export default router;

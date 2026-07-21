import express from 'express';

import { phiAccessLogger } from '../../middleware/phiAccessMiddleware.js';
import {
  listEvents,
  redriveFailedEvent,
} from '../../services/events/eventOutboxService.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

function actorRole(req) {
  return String(req.user?.rawRole || req.user?.role || '').trim().toUpperCase();
}

router.get('/', phiAccessLogger('EVENT_OUTBOX'), async (req, res, next) => {
  try {
    const events = await listEvents({
      tenantId: req.tenantId,
      status: req.query.status ?? 'pending',
      limit: req.query.limit ?? 50,
      offset: req.query.offset ?? 0,
    });
    return success(res, { events, count: events.length }, 'Event outbox retrieved');
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/redrive', async (req, res, next) => {
  try {
    const event = await redriveFailedEvent({
      tenantId: req.tenantId,
      id: req.params.id,
      reason: req.body?.reason,
      actorUid: req.user?.uid,
      actorRole: actorRole(req),
      requestId: req.id,
    });
    return success(res, event, 'Event outbox row redriven');
  } catch (error) {
    return next(error);
  }
});

export default router;

import express from 'express';
import { listEvents, markDelivered, markFailed } from '../../services/events/eventOutboxService.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const events = await listEvents({
      status: req.query.status || 'pending',
      limit: req.query.limit || 50,
      offset: req.query.offset || 0,
    });
    return success(res, { events, count: events.length }, 'Event outbox retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/delivered', async (req, res, next) => {
  try {
    const event = await markDelivered(req.params.id);
    if (!event) return error(res, 'Event not found', 404);
    return success(res, event, 'Event marked delivered');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/failed', async (req, res, next) => {
  try {
    const event = await markFailed(req.params.id, req.body?.message || 'Marked failed by admin');
    if (!event) return error(res, 'Event not found', 404);
    return success(res, event, 'Event marked failed');
  } catch (err) {
    return next(err);
  }
});

export default router;

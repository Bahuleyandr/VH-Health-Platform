// src/routes/admin/notificationOutboxRoutes.js
//
// Operator surface over notification_outbox dead letters and the per-channel
// delivery cursors (F7/F11 + R3, audit 2026-08-10). Pattern mirror of
// eventOutboxRoutes: mounted under /api/v1/admin (requireRole ADMIN tiers +
// requireSuperAdminStepUp + adminIpAllowlist + adminRateLimiter in app.js),
// tenant/actor/request provenance is server-derived — client-supplied
// tenant_id / actor_uid fields are ignored.
import express from 'express';

import { markRouterDomain } from '../../config/openapiDomain.js';
import { phiAccessLogger } from '../../middleware/phiAccessMiddleware.js';
import {
  listChannelCursors,
  resetChannelCursor,
} from '../../services/notification/notificationDeliveryLedgerService.js';
import {
  listNotificationOutboxRows,
  reconcileNotificationOutboxAttempt,
  replayNotificationOutboxRow,
} from '../../services/notification/notificationOutboxAdminService.js';
import { success } from '../../utils/responseHelper.js';

const router = markRouterDomain(express.Router(), 'notification');

function actorRole(req) {
  return String(req.user?.rawRole || req.user?.role || '').trim().toUpperCase();
}

router.get('/', phiAccessLogger('NOTIFICATION_OUTBOX'), async (req, res, next) => {
  try {
    const rows = await listNotificationOutboxRows({
      tenantId: req.tenantId,
      status: req.query.status ?? 'FAILED',
      limit: req.query.limit ?? 50,
      offset: req.query.offset ?? 0,
    });
    return success(res, { rows, count: rows.length }, 'Notification outbox retrieved');
  } catch (error) {
    return next(error);
  }
});

router.get('/cursors', async (req, res, next) => {
  try {
    const cursors = await listChannelCursors({ tenantId: req.tenantId });
    return success(res, { cursors, count: cursors.length }, 'Notification delivery cursors retrieved');
  } catch (error) {
    return next(error);
  }
});

router.post('/cursors/:channel/reset', async (req, res, next) => {
  try {
    const cursor = await resetChannelCursor({
      tenantId: req.tenantId,
      channel: req.params.channel,
      reason: req.body?.reason,
      actorUid: req.user?.uid,
      actorRole: actorRole(req),
      requestId: req.id,
    });
    return success(res, cursor, 'Notification delivery cursor reset');
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/replay', async (req, res, next) => {
  try {
    const result = await replayNotificationOutboxRow({
      tenantId: req.tenantId,
      id: req.params.id,
      reason: req.body?.reason,
      actorUid: req.user?.uid,
      actorRole: actorRole(req),
      requestId: req.id,
    });
    return success(res, result, 'Notification outbox row replayed');
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/reconcile', async (req, res, next) => {
  try {
    const result = await reconcileNotificationOutboxAttempt({
      tenantId: req.tenantId,
      id: req.params.id,
      attemptId: req.body?.attempt_id,
      providerReference: req.body?.provider_reference,
      evidence: req.body?.evidence,
      reason: req.body?.reason,
      actorUid: req.user?.uid,
      actorRole: actorRole(req),
      requestId: req.id,
    });
    return success(res, result, 'Notification provider acceptance recorded');
  } catch (error) {
    return next(error);
  }
});

export default router;

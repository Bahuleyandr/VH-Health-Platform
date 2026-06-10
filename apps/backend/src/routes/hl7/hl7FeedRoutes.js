// src/routes/hl7/hl7FeedRoutes.js
//
// Roadmap C2 — outbound HL7v2 feed management. Mounted at
// /api/v1/hl7-feeds (app.js); admin/integration territory.

import express from 'express';
import logger from '../../logging/logger.js';
import {
  listSubscriptions,
  createSubscription,
  deactivateSubscription,
  listFeedMessages,
  replayFeedMessage,
  deliverPendingFeedMessages,
} from '../../services/hl7/hl7OutboundService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { canManageIntegrations, isAdmin } from '../../utils/roleHelpers.js';

const router = express.Router();

const canManage = (role) => canManageIntegrations(role) || isAdmin(role) || role === 'SUPER_ADMIN';

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`HL7 feeds ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

router.get('/subscriptions', async (req, res) => {
  try {
    const subscriptions = await listSubscriptions();
    return success(res, { subscriptions, count: subscriptions.length }, 'HL7 feed subscriptions');
  } catch (err) {
    return handleFailure(res, err, 'list subscriptions');
  }
});

router.post('/subscriptions', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) {
      return error(res, 'Only integration admins can manage HL7 feeds', HTTP_STATUS.FORBIDDEN);
    }
    const subscription = await createSubscription({
      name: req.body.name,
      endpointUrl: req.body.endpoint_url,
      authHeader: req.body.auth_header || null,
      messageTypes: req.body.message_types || undefined,
    }, { actorUid: req.user?.uid || null });
    return success(res, { subscription }, 'Subscription saved', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create subscription');
  }
});

router.delete('/subscriptions/:id', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) {
      return error(res, 'Only integration admins can manage HL7 feeds', HTTP_STATUS.FORBIDDEN);
    }
    const subscription = await deactivateSubscription(Number.parseInt(req.params.id, 10));
    return success(res, { subscription }, 'Subscription deactivated');
  } catch (err) {
    return handleFailure(res, err, 'deactivate subscription');
  }
});

router.get('/messages', async (req, res) => {
  try {
    const messages = await listFeedMessages({
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, { messages, count: messages.length }, 'Outbound HL7 messages');
  } catch (err) {
    return handleFailure(res, err, 'list messages');
  }
});

router.post('/messages/:id/replay', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) {
      return error(res, 'Only integration admins can replay messages', HTTP_STATUS.FORBIDDEN);
    }
    const message = await replayFeedMessage(Number.parseInt(req.params.id, 10));
    return success(res, { message }, 'Message requeued');
  } catch (err) {
    return handleFailure(res, err, 'replay message');
  }
});

// Manual delivery tick (the scheduler runs this every 2 minutes anyway).
router.post('/deliver-now', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) {
      return error(res, 'Only integration admins can trigger delivery', HTTP_STATUS.FORBIDDEN);
    }
    const stats = await deliverPendingFeedMessages({ limit: req.body?.limit });
    return success(res, stats, 'Delivery pass complete');
  } catch (err) {
    return handleFailure(res, err, 'deliver messages');
  }
});

export default router;

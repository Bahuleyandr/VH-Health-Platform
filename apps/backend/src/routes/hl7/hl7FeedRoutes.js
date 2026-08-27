// src/routes/hl7/hl7FeedRoutes.js
//
// Roadmap C2 — outbound HL7v2 feed management. Mounted at
// /api/v1/hl7-feeds (app.js); admin/integration territory.

import express from 'express';
import {
  listSubscriptions,
  createSubscription,
  deactivateSubscription,
  listFeedMessages,
  deliverPendingFeedMessages,
} from '../../services/hl7/hl7OutboundService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { HL7_FEED_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { AppError } from '../../utils/AppError.js';
import { success, relayAppError } from '../../utils/responseHelper.js';

const router = express.Router();
const MAX_SUBSCRIPTION_ID = 2_147_483_647;

const requestTenantId = (req) => req.tenantId || req.user?.tenant_id || req.user?.tenantId || null;

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

function parseSubscriptionId(value) {
  const text = String(value || '');
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw AppError.badRequest(
      'subscription id must be a positive integer',
      'HL7_FEED_BAD_SUBSCRIPTION_ID',
    );
  }
  const id = Number(text);
  if (!Number.isInteger(id) || id > MAX_SUBSCRIPTION_ID) {
    throw AppError.badRequest(
      'subscription id must be a positive integer',
      'HL7_FEED_BAD_SUBSCRIPTION_ID',
    );
  }
  return id;
}

router.use(requireRole(...HL7_FEED_ROUTE_ROLES));

router.get('/subscriptions', async (req, res) => {
  try {
    const subscriptions = await listSubscriptions({ tenantId: requestTenantId(req) });
    return success(res, { subscriptions, count: subscriptions.length }, 'HL7 feed subscriptions');
  } catch (err) {
    return handleFailure(res, err, 'list subscriptions');
  }
});

router.post('/subscriptions', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const input = {
      name: body.name,
      endpointUrl: body.endpoint_url,
    };
    if (Object.hasOwn(body, 'auth_header')) input.authHeader = body.auth_header;
    if (Object.hasOwn(body, 'message_types')) input.messageTypes = body.message_types;
    const subscription = await createSubscription(input, {
      actorUid: req.user?.uid || null,
      tenantId: requestTenantId(req),
    });
    return success(res, { subscription }, 'Subscription saved', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create subscription');
  }
});

router.delete('/subscriptions/:id', async (req, res) => {
  try {
    const subscription = await deactivateSubscription(parseSubscriptionId(req.params.id), {
      tenantId: requestTenantId(req),
    });
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
      tenantId: requestTenantId(req),
    });
    return success(res, { messages, count: messages.length }, 'Outbound HL7 messages');
  } catch (err) {
    return handleFailure(res, err, 'list messages');
  }
});

// Manual delivery tick (the scheduler runs this every 2 minutes anyway).
router.post('/deliver-now', async (req, res) => {
  try {
    const stats = await deliverPendingFeedMessages({
      limit: req.body?.limit,
      tenantId: requestTenantId(req),
    });
    return success(res, stats, 'Delivery pass complete');
  } catch (err) {
    return handleFailure(res, err, 'deliver messages');
  }
});

export default router;

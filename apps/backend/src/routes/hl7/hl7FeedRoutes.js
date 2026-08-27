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
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { canManageIntegrations, isAdmin } from '../../utils/roleHelpers.js';

const router = express.Router();

const canManage = (role) => canManageIntegrations(role) || isAdmin(role) || role === 'SUPER_ADMIN';
const requestTenantId = (req) => req.tenantId || req.user?.tenant_id || req.user?.tenantId || null;

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

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
    if (!canManage(req.user?.role)) {
      return error(res, 'Only integration admins can manage HL7 feeds', HTTP_STATUS.FORBIDDEN);
    }
    const body = req.body || {};
    const subscription = await createSubscription({
      name: body.name,
      endpointUrl: body.endpoint_url,
      // ABSENT and NULL are different instructions (roadmap credential-wipe
      // fix): an omitted auth_header keeps the stored encrypted secret —
      // GET /subscriptions never returns it, so the caller cannot round-trip
      // it — while an explicit `auth_header: null` (or '') clears it.
      authHeader: Object.prototype.hasOwnProperty.call(body, 'auth_header')
        ? body.auth_header
        : undefined,
      messageTypes: body.message_types || undefined,
    }, { actorUid: req.user?.uid || null, tenantId: requestTenantId(req) });
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
    const subscription = await deactivateSubscription(Number.parseInt(req.params.id, 10), {
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
    if (!canManage(req.user?.role)) {
      return error(res, 'Only integration admins can trigger delivery', HTTP_STATUS.FORBIDDEN);
    }
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

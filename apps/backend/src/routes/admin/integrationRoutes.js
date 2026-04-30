/**
 * Admin routes for the integration registry + webhook subscriptions
 * (Phase A3 PR1).
 *
 *   GET    /integrations                                 — list
 *   POST   /integrations                                 — create
 *   GET    /integrations/:id                             — fetch one
 *   PATCH  /integrations/:id                             — update
 *   PATCH  /integrations/:id/archive                     — archive
 *   GET    /integrations/:id/logs                        — log tail
 *   GET    /integrations/:id/subscriptions               — sub list
 *   POST   /integrations/:id/subscriptions               — create sub
 *
 *   GET    /webhook-subscriptions                        — flat list
 *   GET    /webhook-subscriptions/:id                    — fetch one
 *   PATCH  /webhook-subscriptions/:id                    — update
 *   DELETE /webhook-subscriptions/:id                    — delete
 *
 * Mounted at /api/v1/admin/integrations and
 * /api/v1/admin/webhook-subscriptions via routes/admin/index.js.
 */

import express from 'express';

import { success } from '../../utils/responseHelper.js';
import {
  archiveIntegration,
  createIntegration,
  getIntegration,
  listIntegrationLogs,
  listIntegrations,
  updateIntegration,
  writeIntegrationLog,
} from '../../services/integrations/integrationService.js';
import {
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  updateSubscription,
} from '../../services/integrations/webhookSubscriptionService.js';

const integrationRouter = express.Router();
const subscriptionRouter = express.Router();

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

integrationRouter.get('/', async (req, res, next) => {
  try {
    const result = await listIntegrations({
      tenantId: req.tenantId,
      status: req.query.status || null,
      integrationType: req.query.integration_type || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Integrations retrieved');
  } catch (err) {
    return next(err);
  }
});

integrationRouter.post('/', async (req, res, next) => {
  try {
    const row = await createIntegration({
      tenantId: req.tenantId,
      name: req.body?.name,
      description: req.body?.description || null,
      integrationType: req.body?.integration_type,
      config: req.body?.config || {},
      metadata: req.body?.metadata || {},
      createdBy: req.user?.uid || null,
    });
    await writeIntegrationLog({
      tenantId: req.tenantId,
      integrationId: row.id,
      logType: 'config_change',
      severity: 'info',
      message: `Integration created (${row.integration_type})`,
      payload: { name: row.name, integration_type: row.integration_type },
    });
    return success(res, row, 'Integration created', 201);
  } catch (err) {
    return next(err);
  }
});

integrationRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await getIntegration({ tenantId: req.tenantId, id: req.params.id });
    return success(res, row, 'Integration retrieved');
  } catch (err) {
    return next(err);
  }
});

integrationRouter.patch('/:id', async (req, res, next) => {
  try {
    const before = await getIntegration({ tenantId: req.tenantId, id: req.params.id });
    const row = await updateIntegration({
      tenantId: req.tenantId,
      id: req.params.id,
      name: req.body?.name,
      description: req.body?.description,
      integrationType: req.body?.integration_type,
      status: req.body?.status,
      config: req.body?.config,
      metadata: req.body?.metadata,
    });
    await writeIntegrationLog({
      tenantId: req.tenantId,
      integrationId: row.id,
      logType: 'config_change',
      severity: 'info',
      message: 'Integration updated',
      payload: {
        before: { name: before.name, status: before.status },
        after: { name: row.name, status: row.status },
      },
    });
    return success(res, row, 'Integration updated');
  } catch (err) {
    return next(err);
  }
});

integrationRouter.patch('/:id/archive', async (req, res, next) => {
  try {
    const row = await archiveIntegration({ tenantId: req.tenantId, id: req.params.id });
    await writeIntegrationLog({
      tenantId: req.tenantId,
      integrationId: row.id,
      logType: 'config_change',
      severity: 'info',
      message: 'Integration archived',
    });
    return success(res, row, 'Integration archived');
  } catch (err) {
    return next(err);
  }
});

integrationRouter.get('/:id/logs', async (req, res, next) => {
  try {
    const result = await listIntegrationLogs({
      tenantId: req.tenantId,
      integrationId: req.params.id,
      severity: req.query.severity || null,
      logType: req.query.log_type || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Integration logs retrieved');
  } catch (err) {
    return next(err);
  }
});

integrationRouter.get('/:id/subscriptions', async (req, res, next) => {
  try {
    const result = await listSubscriptions({
      tenantId: req.tenantId,
      integrationId: req.params.id,
      eventType: req.query.event_type || null,
      isActive: req.query.is_active != null ? Boolean(req.query.is_active === 'true' || req.query.is_active === true) : null,
      limit: req.query.limit,
    });
    return success(res, result, 'Webhook subscriptions retrieved');
  } catch (err) {
    return next(err);
  }
});

integrationRouter.post('/:id/subscriptions', async (req, res, next) => {
  try {
    const row = await createSubscription({
      tenantId: req.tenantId,
      integrationId: req.params.id,
      eventType: req.body?.event_type,
      endpointUrl: req.body?.endpoint_url,
      eventFilter: req.body?.event_filter || {},
      signingCredentialId: req.body?.signing_credential_id || null,
      signingAlgorithm: req.body?.signing_algorithm || 'hmac-sha256',
      isActive: req.body?.is_active !== false,
      maxConsecutiveFailures: req.body?.max_consecutive_failures,
      metadata: req.body?.metadata || {},
      createdBy: req.user?.uid || null,
    });
    await writeIntegrationLog({
      tenantId: req.tenantId,
      integrationId: row.integration_id,
      logType: 'config_change',
      severity: 'info',
      message: `Webhook subscription created for ${row.event_type}`,
      payload: { subscription_id: row.id, event_type: row.event_type, endpoint_url: row.endpoint_url },
    });
    return success(res, row, 'Webhook subscription created', 201);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Webhook subscriptions (cross-integration view)
// ---------------------------------------------------------------------------

subscriptionRouter.get('/', async (req, res, next) => {
  try {
    const result = await listSubscriptions({
      tenantId: req.tenantId,
      integrationId: req.query.integration_id || null,
      eventType: req.query.event_type || null,
      isActive: req.query.is_active != null ? Boolean(req.query.is_active === 'true' || req.query.is_active === true) : null,
      limit: req.query.limit,
    });
    return success(res, result, 'Webhook subscriptions retrieved');
  } catch (err) {
    return next(err);
  }
});

subscriptionRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await getSubscription({ tenantId: req.tenantId, id: req.params.id });
    return success(res, row, 'Webhook subscription retrieved');
  } catch (err) {
    return next(err);
  }
});

subscriptionRouter.patch('/:id', async (req, res, next) => {
  try {
    const row = await updateSubscription({
      tenantId: req.tenantId,
      id: req.params.id,
      endpointUrl: req.body?.endpoint_url,
      eventFilter: req.body?.event_filter,
      signingCredentialId: req.body?.signing_credential_id,
      signingAlgorithm: req.body?.signing_algorithm,
      isActive: req.body?.is_active,
      maxConsecutiveFailures: req.body?.max_consecutive_failures,
      metadata: req.body?.metadata,
    });
    return success(res, row, 'Webhook subscription updated');
  } catch (err) {
    return next(err);
  }
});

subscriptionRouter.delete('/:id', async (req, res, next) => {
  try {
    const row = await deleteSubscription({ tenantId: req.tenantId, id: req.params.id });
    return success(res, row, 'Webhook subscription deleted');
  } catch (err) {
    return next(err);
  }
});

export { integrationRouter, subscriptionRouter };
export default integrationRouter;

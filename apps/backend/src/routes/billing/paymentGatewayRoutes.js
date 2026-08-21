// src/routes/billing/paymentGatewayRoutes.js
//
// Authenticated online-payment-gateway surface, mounted at
// /api/v1/billing/gateway (behind requireRole + billingPhiAccessLogger).
// Config-gated DEFAULT OFF: writes 403 PAYMENT_GATEWAY_DISABLED until the
// env kill switch + tenant setting + an enabled provider config all hold.
//
// Money-moving POSTs carry requireIdempotencyKey. Order creation persists a
// durable intent before provider I/O and may release a failed HTTP envelope so
// a retry can recover by its provider receipt. Refund initiation retains the
// recorded response because it may move provider money before replying.

import { Router } from 'express';
import { validationResult } from 'express-validator';
import * as gateway from '../../services/billing/paymentGatewayService.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { markRouterDomain } from '../../config/openapiDomain.js';
import { logAudit } from '../../utils/logAudit.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import {
  gatewayOrderCreateValidator,
  gatewayOrderIdValidator,
  gatewayOrderReconcileValidator,
  gatewayRefundReconcileValidator,
  gatewayRefundCreateValidator,
  gatewayConfigUpsertValidator,
} from '../../validators/paymentGatewayValidator.js';

const router = markRouterDomain(Router(), 'payment-gateway');

// Mirrors billingV2Routes: cash-out (provider refund execution) is restricted
// to finance/cashier tiers + admin — segregation of duties from the broader
// billing-staff roster that may create orders.
const GATEWAY_REFUND_ROLES = [
  'ADMIN', 'SUPER_ADMIN',
  'FINANCE_INCHARGE', 'BILLING_INCHARGE', 'BILLING_STAFF', 'CASHIER',
];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return error(res, 'Payment gateway request validation failed', 400, {
      errors: errors.array({ onlyFirstError: true }).map(({ type, path, msg }) => ({
        type,
        path,
        message: msg,
      })),
    });
  }
  next();
};

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      return relayAppError(res, err, 'Payment gateway error');
    }
  };
}

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user?.role)) return error(res, 'Admin role required', 403);
  next();
}

// Order create/read/cancel admits the whole mount roster (billing staff +
// PATIENT): the mount-level requireRole is the roster gate, and the service
// enforces patient ownership (a PATIENT actor only reaches their own
// invoices/links/orders).
function requireGatewayRefundRole(req, res, next) {
  const role = String(req.user?.role || '').trim().toUpperCase();
  if (!GATEWAY_REFUND_ROLES.includes(role)) {
    return error(res, 'Gateway refund execution requires a finance, cashier, or admin role', 403);
  }
  next();
}

async function logGatewayAudit(req, action, context = {}, options = {}) {
  await logAudit(req, action, {
    ...context,
    source: 'payment_gateway',
  }, {
    resource: options.resource || 'payment_gateway_order',
    resourceId: options.resourceId ?? null,
  });
}

// ── Admin config (write-only secrets) ─────────────────────────────────
router.get('/config', requireAdmin, wrap(async (req) =>
  gateway.listGatewayConfigs(tenantOf(req)),
));

router.put('/config', requireAdmin, ...gatewayConfigUpsertValidator, validate, wrap(async (req) => {
  const config = await gateway.upsertGatewayConfig({
    tenantId: tenantOf(req),
    provider: req.body.provider,
    environment: req.body.environment,
    enabled: req.body.enabled,
    display_name: req.body.display_name,
    key_id: req.body.key_id,
    key_secret: req.body.key_secret,
    webhook_secret: req.body.webhook_secret,
    accepted_methods: req.body.accepted_methods,
    created_by: req.user?.uid,
  });
  await logGatewayAudit(req, 'PAYMENT_GATEWAY_CONFIG_UPSERTED', {
    provider: config?.provider ?? req.body?.provider ?? null,
    environment: config?.environment ?? null,
    enabled: config?.enabled === true,
    // Booleans only — never the secret material.
    key_secret_present: Boolean(req.body?.key_secret),
    webhook_secret_present: Boolean(req.body?.webhook_secret),
  }, {
    resource: 'payment_gateway_provider_config',
    resourceId: config?.id ?? null,
  });
  return config;
}));

// ── Orders ────────────────────────────────────────────────────────────
router.post('/orders', requireIdempotencyKey({
  // The durable intent survives a 5xx. Releasing the transport envelope lets
  // the same request key retry and recover the provider order by its receipt.
  required: true, scope: 'payment_gateway_order', retainOnServerError: false,
}), ...gatewayOrderCreateValidator, validate, wrap(async (req) => {
  const order = await gateway.createGatewayOrder({
    tenantId: tenantOf(req),
    invoice_id: req.body.invoice_id,
    payment_link_token: req.body.payment_link_token,
    amount: req.body.amount,
    idempotency_key: req.idempotencyClaim?.requestKey,
    created_by: req.user?.uid,
    actor: { uid: req.user?.uid, role: req.user?.role },
  });
  await logGatewayAudit(req, 'PAYMENT_GATEWAY_ORDER_CREATED', {
    order_id: order?.orderId ?? null,
    invoice_id: order?.invoiceId ?? req.body?.invoice_id ?? null,
    payment_link_id: order?.paymentLinkId ?? null,
    provider: order?.provider ?? null,
    amount: order?.amount ?? null,
  }, {
    resourceId: order?.orderId ?? null,
  });
  return order;
}));

router.get('/orders/:id', ...gatewayOrderIdValidator, validate, wrap(async (req) =>
  gateway.getGatewayOrder({
    tenantId: tenantOf(req),
    id: req.params.id,
    actor: { uid: req.user?.uid, role: req.user?.role },
  }),
));

router.post('/orders/:id/cancel', ...gatewayOrderIdValidator, validate, wrap(async (req) => {
  const order = await gateway.cancelGatewayOrder({
    tenantId: tenantOf(req),
    id: req.params.id,
    actor: { uid: req.user?.uid, role: req.user?.role },
  });
  await logGatewayAudit(req, 'PAYMENT_GATEWAY_ORDER_CANCELLED', {
    order_id: order?.id ?? Number(req.params.id),
    status: order?.status ?? null,
  }, {
    resourceId: order?.id ?? req.params.id,
  });
  return order;
}));

// ── Reconciliation work queue (admin) ─────────────────────────────────
// requires_reconciliation = the provider captured money automation could not
// book (voided invoice, amount drift...). This surface makes those orders
// VISIBLE and lets an operator stamp how the money was manually resolved —
// without it a parked capture sits invisible until someone reads the table
// in psql (adversarial-review MEDIUM finding).
router.get('/reconciliation', requireAdmin, wrap(async (req) =>
  gateway.listReconciliationGatewayOrders({
    tenantId: tenantOf(req),
    include_resolved: String(req.query.include_resolved || '') === 'true',
    limit: req.query.limit,
    offset: req.query.offset,
  }),
));

router.post('/orders/:id/reconcile', requireAdmin, ...gatewayOrderReconcileValidator, validate, wrap(async (req) => {
  const order = await gateway.resolveGatewayOrderReconciliation({
    tenantId: tenantOf(req),
    id: req.params.id,
    note: req.body.note,
    resolved_by: req.user?.uid,
  });
  await logGatewayAudit(req, 'PAYMENT_GATEWAY_ORDER_RECONCILED', {
    order_id: order?.id ?? Number(req.params.id),
    provider_payment_id: order?.provider_payment_id ?? null,
    amount: order?.amount ?? null,
    note: req.body?.note ?? null,
  }, {
    resourceId: order?.id ?? req.params.id,
  });
  return order;
}));

// ── Refund execution leg ──────────────────────────────────────────────
router.get('/refund-reconciliation', requireAdmin, wrap(async (req) =>
  gateway.listReconciliationGatewayRefunds({
    tenantId: tenantOf(req),
    include_resolved: String(req.query.include_resolved || '') === 'true',
    limit: req.query.limit,
    offset: req.query.offset,
  }),
));

router.post('/refunds/:id/reconcile', requireAdmin, ...gatewayRefundReconcileValidator, validate, wrap(async (req) => {
  const refund = await gateway.resolveGatewayRefundReconciliation({
    tenantId: tenantOf(req),
    id: req.params.id,
    note: req.body.note,
    resolved_by: req.user?.uid,
  });
  await logGatewayAudit(req, 'PAYMENT_GATEWAY_REFUND_RECONCILED', {
    gateway_refund_id: refund?.id ?? Number(req.params.id),
    billing_refund_id: refund?.billing_refund_id ?? null,
    provider_refund_id: refund?.provider_refund_id ?? null,
    amount: refund?.amount ?? null,
    note: req.body?.note ?? null,
  }, {
    resource: 'payment_gateway_refund',
    resourceId: refund?.id ?? req.params.id,
  });
  return refund;
}));

router.post('/refunds', requireGatewayRefundRole, requireIdempotencyKey({
  // The provider call is protected by the committed gateway-refund intent and
  // its stable provider idempotency key. Releasing a 5xx transport claim lets
  // an exact retry recover that same intent instead of pinning a lost response.
  required: true, scope: 'payment_gateway_refund', retainOnServerError: false,
}), ...gatewayRefundCreateValidator, validate, wrap(async (req) => {
  const refund = await gateway.initiateGatewayRefund({
    tenantId: tenantOf(req),
    billing_refund_id: req.body.billing_refund_id,
    gateway_order_id: req.body.gateway_order_id,
    initiated_by: req.user?.uid,
  });
  await logGatewayAudit(req, 'PAYMENT_GATEWAY_REFUND_INITIATED', {
    gateway_refund_id: refund?.id ?? null,
    billing_refund_id: refund?.billing_refund_id ?? req.body?.billing_refund_id ?? null,
    gateway_order_id: refund?.gateway_order_id ?? null,
    amount: refund?.amount ?? null,
    provider: refund?.provider ?? null,
  }, {
    resource: 'payment_gateway_refund',
    resourceId: refund?.id ?? null,
  });
  return refund;
}));

export default router;

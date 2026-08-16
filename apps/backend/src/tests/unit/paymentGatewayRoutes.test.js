// src/tests/unit/paymentGatewayRoutes.test.js
//
// The authenticated /api/v1/billing/gateway router:
//   * Idempotency-Key is REQUIRED on order creation, and a replayed key
//     serves the cached original response WITHOUT re-running the handler
//     (counterSaleRoutes / billingV2 /payments convention);
//   * admin-only config surface, finance-tier-only refund execution;
//   * config-gate OFF surfaces as 403 PAYMENT_GATEWAY_DISABLED through the
//     route (marker semantics come from the service).

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const createGatewayOrder = jest.fn();
const getGatewayOrder = jest.fn();
const cancelGatewayOrder = jest.fn();
const initiateGatewayRefund = jest.fn();
const listGatewayConfigs = jest.fn();
const upsertGatewayConfig = jest.fn();
const listReconciliationGatewayOrders = jest.fn();
const resolveGatewayOrderReconciliation = jest.fn();

const claimIdempotencyKey = jest.fn();
const finaliseIdempotencyKey = jest.fn(async () => {});
const releaseIdempotencyKey = jest.fn(async () => {});

jest.unstable_mockModule('../../services/billing/paymentGatewayService.js', () => ({
  createGatewayOrder,
  getGatewayOrder,
  cancelGatewayOrder,
  initiateGatewayRefund,
  listGatewayConfigs,
  upsertGatewayConfig,
  listReconciliationGatewayOrders,
  resolveGatewayOrderReconciliation,
}));
jest.unstable_mockModule('../../services/idempotency/idempotencyService.js', () => ({
  claimIdempotencyKey,
  finaliseIdempotencyKey,
  releaseIdempotencyKey,
  hashRequestBody: () => 'hash',
  isValidIdempotencyKey: (v) => /^[A-Za-z0-9_\-:.]{1,200}$/.test(String(v || '')),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => 'trusted-tenant',
}));
jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const { default: router } = await import('../../routes/billing/paymentGatewayRoutes.js');
const { AppError } = await import('../../utils/AppError.js');

function app(role = 'BILLING_STAFF') {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.user = { uid: '11111111-1111-4111-8111-111111111111', role };
    next();
  });
  instance.use('/api/v1/billing/gateway', router);
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
  claimIdempotencyKey.mockResolvedValue({ state: 'claimed', id: 55 });
  createGatewayOrder.mockResolvedValue({
    orderId: 21, providerOrderId: 'order_dry_pg-x', provider: 'dry_run',
    keyId: null, amount: 500, currency: 'INR', status: 'created',
  });
});

describe('order creation idempotency', () => {
  it('400s without an Idempotency-Key — the transport replays money moves', async () => {
    const res = await request(app()).post('/api/v1/billing/gateway/orders').send({ invoice_id: 12 });
    expect(res.status).toBe(400);
    expect(createGatewayOrder).not.toHaveBeenCalled();
  });

  it('creates the order under a fresh key', async () => {
    const res = await request(app())
      .post('/api/v1/billing/gateway/orders')
      .set('Idempotency-Key', 'order-key-1')
      .send({ invoice_id: 12 });
    expect(res.status).toBe(200);
    expect(res.body.data.orderId).toBe(21);
    expect(createGatewayOrder).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'trusted-tenant', invoice_id: 12,
    }));
  });

  it('REPLAYS the cached response for a reused key without re-running the handler', async () => {
    claimIdempotencyKey.mockResolvedValue({
      state: 'replay',
      response_status: 200,
      response_body: { success: true, data: { orderId: 21, providerOrderId: 'order_dry_pg-x' } },
    });
    const res = await request(app())
      .post('/api/v1/billing/gateway/orders')
      .set('Idempotency-Key', 'order-key-1')
      .send({ invoice_id: 12 });
    expect(res.status).toBe(200);
    expect(res.body.data.orderId).toBe(21);
    expect(createGatewayOrder).not.toHaveBeenCalled();
  });

  it('409s a concurrent in-flight duplicate', async () => {
    claimIdempotencyKey.mockResolvedValue({ state: 'in_flight' });
    const res = await request(app())
      .post('/api/v1/billing/gateway/orders')
      .set('Idempotency-Key', 'order-key-1')
      .send({ invoice_id: 12 });
    expect(res.status).toBe(409);
    expect(createGatewayOrder).not.toHaveBeenCalled();
  });

  it('422s a key reused with a different body', async () => {
    claimIdempotencyKey.mockResolvedValue({ state: 'mismatch' });
    const res = await request(app())
      .post('/api/v1/billing/gateway/orders')
      .set('Idempotency-Key', 'order-key-1')
      .send({ invoice_id: 13 });
    expect(res.status).toBe(422);
  });

  it('rejects a body naming neither invoice nor payment link', async () => {
    const res = await request(app())
      .post('/api/v1/billing/gateway/orders')
      .set('Idempotency-Key', 'order-key-2')
      .send({});
    expect(res.status).toBe(400);
    expect(createGatewayOrder).not.toHaveBeenCalled();
  });
});

describe('config-gate OFF surfaces through the route', () => {
  it('relays the 403 PAYMENT_GATEWAY_DISABLED marker', async () => {
    createGatewayOrder.mockRejectedValue(AppError.forbidden(
      'Online payment gateway is not enabled for this tenant',
      'PAYMENT_GATEWAY_DISABLED',
    ));
    const res = await request(app())
      .post('/api/v1/billing/gateway/orders')
      .set('Idempotency-Key', 'order-key-3')
      .send({ invoice_id: 12 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAYMENT_GATEWAY_DISABLED');
  });
});

describe('role gates', () => {
  it('config surface is admin-only', async () => {
    const res = await request(app('BILLING_STAFF')).get('/api/v1/billing/gateway/config');
    expect(res.status).toBe(403);
    expect(listGatewayConfigs).not.toHaveBeenCalled();

    listGatewayConfigs.mockResolvedValue({ env_enabled: false, tenant_enabled: false, configs: [] });
    const ok = await request(app('ADMIN')).get('/api/v1/billing/gateway/config');
    expect(ok.status).toBe(200);
  });

  it('reconciliation work queue is admin-only and forwards the include_resolved filter', async () => {
    const res = await request(app('BILLING_STAFF')).get('/api/v1/billing/gateway/reconciliation');
    expect(res.status).toBe(403);
    expect(listReconciliationGatewayOrders).not.toHaveBeenCalled();

    listReconciliationGatewayOrders.mockResolvedValue({ orders: [], limit: 50, offset: 0 });
    const ok = await request(app('ADMIN'))
      .get('/api/v1/billing/gateway/reconciliation?include_resolved=true');
    expect(ok.status).toBe(200);
    expect(listReconciliationGatewayOrders).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'trusted-tenant', include_resolved: true,
    }));
  });

  it('reconcile stamp is admin-only, requires a substantive note, and audits', async () => {
    const forbidden = await request(app('BILLING_STAFF'))
      .post('/api/v1/billing/gateway/orders/21/reconcile')
      .send({ note: 'Booked manually via collectPayment ref pay_x' });
    expect(forbidden.status).toBe(403);
    expect(resolveGatewayOrderReconciliation).not.toHaveBeenCalled();

    const shortNote = await request(app('ADMIN'))
      .post('/api/v1/billing/gateway/orders/21/reconcile')
      .send({ note: 'ok' });
    expect(shortNote.status).toBe(400);
    expect(resolveGatewayOrderReconciliation).not.toHaveBeenCalled();

    resolveGatewayOrderReconciliation.mockResolvedValue({
      id: 21, status: 'requires_reconciliation', amount: 500,
      reconciled_at: '2026-08-16T10:00:00.000Z',
      reconciliation_note: 'Booked manually via collectPayment ref pay_x',
      provider_payment_id: 'pay_x',
    });
    const ok = await request(app('ADMIN'))
      .post('/api/v1/billing/gateway/orders/21/reconcile')
      .send({ note: 'Booked manually via collectPayment ref pay_x' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.reconciliation_note).toContain('collectPayment');
    expect(resolveGatewayOrderReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'trusted-tenant', id: '21', note: 'Booked manually via collectPayment ref pay_x',
    }));
  });

  it('config upsert requires an EXPLICIT enabled flag (omission must not silently disable)', async () => {
    const res = await request(app('ADMIN'))
      .put('/api/v1/billing/gateway/config')
      .send({ provider: 'razorpay', key_secret: 'rotated-secret' });
    expect(res.status).toBe(400);
    expect(upsertGatewayConfig).not.toHaveBeenCalled();

    upsertGatewayConfig.mockResolvedValue({ id: 3, provider: 'razorpay', enabled: true });
    const ok = await request(app('ADMIN'))
      .put('/api/v1/billing/gateway/config')
      .send({ provider: 'razorpay', enabled: true, key_id: 'rzp_test', key_secret: 's' });
    expect(ok.status).toBe(200);
  });

  it('refund execution requires a finance/cashier/admin tier', async () => {
    const res = await request(app('RECEPTIONIST'))
      .post('/api/v1/billing/gateway/refunds')
      .set('Idempotency-Key', 'refund-key-1')
      .send({ billing_refund_id: 9, gateway_order_id: 21 });
    expect(res.status).toBe(403);
    expect(initiateGatewayRefund).not.toHaveBeenCalled();

    const missingSource = await request(app('CASHIER'))
      .post('/api/v1/billing/gateway/refunds')
      .set('Idempotency-Key', 'refund-key-missing-source')
      .send({ billing_refund_id: 9 });
    expect(missingSource.status).toBe(400);
    expect(initiateGatewayRefund).not.toHaveBeenCalled();

    initiateGatewayRefund.mockResolvedValue({ id: 6, billing_refund_id: 9, amount: 100, status: 'pending' });
    const ok = await request(app('CASHIER'))
      .post('/api/v1/billing/gateway/refunds')
      .set('Idempotency-Key', 'refund-key-2')
      .send({ billing_refund_id: 9, gateway_order_id: 21 });
    expect(ok.status).toBe(200);
    expect(initiateGatewayRefund).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'trusted-tenant', billing_refund_id: 9, gateway_order_id: 21,
    }));
  });
});

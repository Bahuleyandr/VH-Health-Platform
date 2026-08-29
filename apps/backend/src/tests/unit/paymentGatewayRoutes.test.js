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
const listGatewayRefundCandidates = jest.fn();
const listGatewayConfigs = jest.fn();
const upsertGatewayConfig = jest.fn();
const listReconciliationGatewayOrders = jest.fn();
const resolveGatewayOrderReconciliation = jest.fn();
const listReconciliationGatewayRefunds = jest.fn();
const resolveGatewayRefundReconciliation = jest.fn();
const listGatewayRefundRecovery = jest.fn();
const recoverGatewayRefundNow = jest.fn();
const logAudit = jest.fn(async () => {});

const claimIdempotencyKey = jest.fn();
const finaliseIdempotencyKey = jest.fn(async () => {});
const releaseIdempotencyKey = jest.fn(async () => {});

jest.unstable_mockModule('../../services/billing/paymentGatewayService.js', () => ({
  createGatewayOrder,
  getGatewayOrder,
  cancelGatewayOrder,
  initiateGatewayRefund,
  listGatewayRefundCandidates,
  listGatewayConfigs,
  upsertGatewayConfig,
  listReconciliationGatewayOrders,
  resolveGatewayOrderReconciliation,
  listReconciliationGatewayRefunds,
  resolveGatewayRefundReconciliation,
}));
jest.unstable_mockModule('../../services/billing/gatewayRefundRecoveryService.js', () => ({
  listGatewayRefundRecovery,
  recoverGatewayRefundNow,
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
  logAudit,
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
  listGatewayRefundCandidates.mockResolvedValue([
    { gateway_order_id: 21, refundable_amount: '500.00' },
  ]);
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
      tenantId: 'trusted-tenant', invoice_id: 12, idempotency_key: 'order-key-1',
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

  it('rejects a sub-paisa order amount at the route boundary', async () => {
    const res = await request(app())
      .post('/api/v1/billing/gateway/orders')
      .set('Idempotency-Key', 'order-key-sub-paisa')
      .send({ invoice_id: 12, amount: 100.001 });
    expect(res.status).toBe(400);
    expect(createGatewayOrder).not.toHaveBeenCalled();
  });

  it('accepts an exact two-decimal partial amount at the route boundary', async () => {
    const res = await request(app())
      .post('/api/v1/billing/gateway/orders')
      .set('Idempotency-Key', 'order-key-partial')
      .send({ invoice_id: 12, amount: 100.01 });
    expect(res.status).toBe(200);
    expect(createGatewayOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 100.01 }));
  });

  it('accepts harmless JSON numeric representation dust at the route boundary', async () => {
    const res = await request(app())
      .post('/api/v1/billing/gateway/orders')
      .set('Idempotency-Key', 'order-key-numeric-dust')
      .send({ invoice_id: 12, amount: 0.1 + 0.2 });
    expect(res.status).toBe(200);
    expect(createGatewayOrder).toHaveBeenCalledWith(expect.objectContaining({
      amount: expect.closeTo(0.3, 12),
    }));
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
      resolved_by: '11111111-1111-4111-8111-111111111111',
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

  it('never echoes rejected config secret values in validation errors', async () => {
    const secret = 'provider-signing-material-that-must-not-echo';
    const res = await request(app('ADMIN'))
      .put('/api/v1/billing/gateway/config')
      .send({
        provider: 'not-a-provider',
        enabled: 'not-a-boolean',
        key_secret: secret.repeat(20),
        webhook_secret: secret.repeat(20),
      });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(res.body).not.toHaveProperty('errors');
    expect(res.body.details?.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'provider' }),
    ]));
  });

  it('refund reconciliation queue and structured terminal resolution are admin-only and audited', async () => {
    const forbidden = await request(app('CASHIER'))
      .get('/api/v1/billing/gateway/refund-reconciliation');
    expect(forbidden.status).toBe(403);
    expect(listReconciliationGatewayRefunds).not.toHaveBeenCalled();

    listReconciliationGatewayRefunds.mockResolvedValue({ refunds: [], limit: 50, offset: 0 });
    const listed = await request(app('ADMIN'))
      .get('/api/v1/billing/gateway/refund-reconciliation?include_resolved=true&limit=25&offset=5');
    expect(listed.status).toBe(200);
    expect(listReconciliationGatewayRefunds).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'trusted-tenant', include_resolved: true, limit: '25', offset: '5',
    }));

    const badQueue = await request(app('ADMIN'))
      .get('/api/v1/billing/gateway/refund-reconciliation?limit=all');
    expect(badQueue.status).toBe(400);

    const badId = await request(app('ADMIN'))
      .post('/api/v1/billing/gateway/refunds/not-a-number/reconcile')
      .send({
        disposition: 'provider_failed',
        evidence: {
          source: 'provider_dashboard',
          reference: 'provider-case-7781',
          observed_at: '2026-08-16T10:00:00.000Z',
          provider_status: 'failed',
        },
      });
    expect(badId.status).toBe(400);
    expect(resolveGatewayRefundReconciliation).not.toHaveBeenCalled();

    resolveGatewayRefundReconciliation.mockResolvedValue({
      id: 7,
      status: 'failed',
      amount: 150,
      reconciliation_disposition: 'provider_failed',
    });
    const evidence = {
      source: 'provider_dashboard',
      reference: 'rfnd_provider_failed_7',
      observed_at: '2026-08-16T10:00:00.000Z',
      provider_status: 'failed',
      notes: 'Provider dashboard confirms the terminal failure.',
    };
    const resolved = await request(app('ADMIN'))
      .post('/api/v1/billing/gateway/refunds/7/reconcile')
      .send({ disposition: 'provider_failed', evidence });
    expect(resolved.status).toBe(200);
    expect(resolveGatewayRefundReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'trusted-tenant', id: '7',
      disposition: 'provider_failed', evidence,
      resolved_by: '11111111-1111-4111-8111-111111111111',
    }));
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      'PAYMENT_GATEWAY_REFUND_RECONCILED',
      expect.objectContaining({
        disposition: 'provider_failed',
        evidence_source: 'provider_dashboard',
        evidence_provider_status: 'failed',
      }),
      expect.objectContaining({ resource: 'payment_gateway_refund', resourceId: 7 }),
    );
  });

  it('validates the refund reconciliation evidence and disposition/status pairing before service dispatch', async () => {
    const baseEvidence = {
      source: 'provider_support',
      reference: 'support-case-2026-0007',
      observed_at: '2026-08-16T10:00:00.000Z',
      provider_status: 'pending',
    };

    const missingEvidence = await request(app('ADMIN'))
      .post('/api/v1/billing/gateway/refunds/7/reconcile')
      .send({ disposition: 'provider_pending' });
    expect(missingEvidence.status).toBe(400);

    const legacyNote = await request(app('ADMIN'))
      .post('/api/v1/billing/gateway/refunds/7/reconcile')
      .send({ disposition: 'provider_pending', evidence: baseEvidence, note: 'legacy closure note' });
    expect(legacyNote.status).toBe(400);

    const mismatched = await request(app('ADMIN'))
      .post('/api/v1/billing/gateway/refunds/7/reconcile')
      .send({ disposition: 'provider_processed', evidence: baseEvidence });
    expect(mismatched.status).toBe(400);

    const futureDated = await request(app('ADMIN'))
      .post('/api/v1/billing/gateway/refunds/7/reconcile')
      .send({
        disposition: 'provider_pending',
        evidence: { ...baseEvidence, observed_at: '2999-01-01T00:00:00.000Z' },
      });
    expect(futureDated.status).toBe(400);
    expect(resolveGatewayRefundReconciliation).not.toHaveBeenCalled();
  });

  it('forwards a pollable pending disposition without converting it to a terminal note stamp', async () => {
    resolveGatewayRefundReconciliation.mockResolvedValue({
      id: 7,
      status: 'requires_reconciliation',
      reconciliation_disposition: 'provider_pending',
    });
    const evidence = {
      source: 'bank_statement',
      reference: 'statement-line-0007',
      observed_at: '2026-08-16T10:00:00.000Z',
      provider_status: 'pending',
    };

    const response = await request(app('ADMIN'))
      .post('/api/v1/billing/gateway/refunds/7/reconcile')
      .send({ disposition: 'provider_pending', evidence });

    expect(response.status).toBe(200);
    expect(resolveGatewayRefundReconciliation).toHaveBeenCalledWith({
      tenantId: 'trusted-tenant',
      id: '7',
      disposition: 'provider_pending',
      evidence,
      resolved_by: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('refund execution requires a finance/cashier/admin tier', async () => {
    const deniedCandidates = await request(app('RECEPTIONIST'))
      .get('/api/v1/billing/gateway/refunds/9/candidates');
    expect(deniedCandidates.status).toBe(403);
    expect(listGatewayRefundCandidates).not.toHaveBeenCalled();

    const candidates = await request(app('FINANCE_INCHARGE'))
      .get('/api/v1/billing/gateway/refunds/9/candidates');
    expect(candidates.status).toBe(200);
    expect(candidates.body.data).toEqual([
      { gateway_order_id: 21, refundable_amount: '500.00' },
    ]);
    expect(listGatewayRefundCandidates).toHaveBeenCalledWith({
      tenantId: 'trusted-tenant',
      billing_refund_id: '9',
    });

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

  it('exposes the owned recovery queue and requires an idempotency key for provider polling', async () => {
    const forbidden = await request(app('RECEPTIONIST'))
      .get('/api/v1/billing/gateway/refund-recovery');
    expect(forbidden.status).toBe(403);
    expect(listGatewayRefundRecovery).not.toHaveBeenCalled();

    listGatewayRefundRecovery.mockResolvedValue({ refunds: [], limit: 50, offset: 0 });
    const listed = await request(app('FINANCE_INCHARGE'))
      .get('/api/v1/billing/gateway/refund-recovery?include_terminal=true&limit=25&offset=5');
    expect(listed.status).toBe(200);
    expect(listGatewayRefundRecovery).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'trusted-tenant', include_terminal: true, limit: '25', offset: '5',
    }));

    const missingKey = await request(app('FINANCE_INCHARGE'))
      .post('/api/v1/billing/gateway/refunds/7/recover');
    expect(missingKey.status).toBe(400);
    expect(recoverGatewayRefundNow).not.toHaveBeenCalled();

    recoverGatewayRefundNow.mockResolvedValue({
      id: 7,
      billing_refund_id: 9,
      provider_refund_id: 'rfnd_R7',
      recovery_state: 'provider_pending',
      recovery_attempt_count: 2,
    });
    const recovered = await request(app('FINANCE_INCHARGE'))
      .post('/api/v1/billing/gateway/refunds/7/recover')
      .set('Idempotency-Key', 'refund-recovery-7');
    expect(recovered.status).toBe(200);
    expect(recovered.body.data.recovery_state).toBe('provider_pending');
    expect(recoverGatewayRefundNow).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'trusted-tenant',
      gatewayRefundId: '7',
      actorUid: '11111111-1111-4111-8111-111111111111',
    }));
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      'PAYMENT_GATEWAY_REFUND_RECOVERY_REQUESTED',
      expect.objectContaining({ recovery_state: 'provider_pending' }),
      expect.objectContaining({ resource: 'payment_gateway_refund', resourceId: 7 }),
    );
  });

  it('releases a refund 5xx claim so the same HTTP key reaches durable provider retry', async () => {
    initiateGatewayRefund
      .mockRejectedValueOnce(new AppError(
        'Provider response timed out', 503, 'PAYMENT_GATEWAY_PROVIDER_TIMEOUT',
      ))
      .mockResolvedValueOnce({
        id: 6, billing_refund_id: 9, gateway_order_id: 21,
        amount: 100, status: 'pending', replay: true,
      });

    const first = await request(app('CASHIER'))
      .post('/api/v1/billing/gateway/refunds')
      .set('Idempotency-Key', 'refund-lost-response-key')
      .send({ billing_refund_id: 9, gateway_order_id: 21 });
    expect(first.status).toBe(503);
    expect(releaseIdempotencyKey).toHaveBeenCalledWith(55);

    const retry = await request(app('CASHIER'))
      .post('/api/v1/billing/gateway/refunds')
      .set('Idempotency-Key', 'refund-lost-response-key')
      .send({ billing_refund_id: 9, gateway_order_id: 21 });
    expect(retry.status).toBe(200);
    expect(retry.body.data).toEqual(expect.objectContaining({ id: 6, replay: true }));
    expect(initiateGatewayRefund).toHaveBeenCalledTimes(2);
  });
});

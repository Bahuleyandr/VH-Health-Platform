// src/tests/unit/paymentGatewayWebhook.test.js
//
// The public payment-gateway webhook route (pre-RLS mount, migration 695
// contract), with the service layer mocked:
//   * fail-closed tenant resolution — unknown token writes NOTHING, never a
//     default-tenant row;
//   * HMAC signature verification over the captured RAW body (401 on bad);
//   * replay dedupe — duplicate provider event id → 200 ack, no reprocess;
//     a pending row a crash left behind IS resumed;
//   * replay-store outage → 503 fail-closed;
//   * verified-but-unprocessable → recorded failed, still 200-acked.

import crypto from 'node:crypto';
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const WEBHOOK_SECRET = 'test-webhook-secret-000000000000';
const TENANT = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'test-webhook-route-token-0000000';

const resolveWebhookConfigByToken = jest.fn();
const decryptedWebhookSecret = jest.fn(() => WEBHOOK_SECRET);
const recordWebhookEvent = jest.fn();
const markWebhookEvent = jest.fn(async () => {});
const processWebhookEvent = jest.fn(async () => ({ outcome: 'captured', orderId: 5 }));
const assertSharedReplayOnce = jest.fn(async () => true);

jest.unstable_mockModule('../../services/billing/paymentGatewayService.js', () => ({
  resolveWebhookConfigByToken,
  decryptedWebhookSecret,
  recordWebhookEvent,
  markWebhookEvent,
  processWebhookEvent,
}));

jest.unstable_mockModule('../../utils/signedRequest.js', () => ({
  assertSharedReplayOnce,
  verifySignedRequest: jest.fn(),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const { default: router } = await import('../../routes/billing/paymentGatewayWebhookRoutes.js');

function app() {
  const instance = express();
  // Mirror app.js's raw-body capture for /webhooks/payments/*.
  instance.use(express.json({
    verify: (req, _res, body) => { req.paymentGatewayRawBody = Buffer.from(body); },
  }));
  instance.use('/webhooks/payments', router);
  return instance;
}

const configRow = (overrides = {}) => ({
  id: 3,
  tenant_id: TENANT,
  provider: 'dry_run',
  environment: 'sandbox',
  enabled: true,
  key_id: null,
  webhook_secret_ciphertext: 'enc:v2:something',
  metadata: { webhook_token: TOKEN },
  ...overrides,
});

const payload = {
  event: 'payment.captured',
  created_at: 1765000000,
  payload: { payment: { entity: { id: 'pay_dry_1', order_id: 'order_dry_pg-1', method: 'upi', amount: 50000 } } },
};

function signedPost(body, { eventId = 'evt_1', secret = WEBHOOK_SECRET, signature } = {}) {
  const raw = JSON.stringify(body);
  const sig = signature ?? crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return request(app())
    .post(`/webhooks/payments/${TOKEN}`)
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature', sig)
    .set('x-razorpay-event-id', eventId)
    .send(raw);
}

beforeEach(() => {
  jest.clearAllMocks();
  decryptedWebhookSecret.mockReturnValue(WEBHOOK_SECRET);
  resolveWebhookConfigByToken.mockResolvedValue(configRow());
  recordWebhookEvent.mockResolvedValue({
    duplicate: false,
    event: { id: 10, status: 'pending', event_type: 'payment.captured' },
  });
  processWebhookEvent.mockResolvedValue({ outcome: 'captured', orderId: 5 });
  assertSharedReplayOnce.mockResolvedValue(true);
});

describe('tenant resolution (fail-closed, pre-RLS mount)', () => {
  it('answers 404 for an unknown token and writes NOTHING', async () => {
    resolveWebhookConfigByToken.mockResolvedValue(null);
    const res = await signedPost(payload);
    expect(res.status).toBe(404);
    expect(recordWebhookEvent).not.toHaveBeenCalled();
    expect(processWebhookEvent).not.toHaveBeenCalled();
    expect(markWebhookEvent).not.toHaveBeenCalled();
  });

  it('answers 401 when the config carries no webhook secret — never verifies blind', async () => {
    decryptedWebhookSecret.mockReturnValue(null);
    const res = await signedPost(payload);
    expect(res.status).toBe(401);
    expect(recordWebhookEvent).not.toHaveBeenCalled();
  });
});

describe('signature verification', () => {
  it('accepts a correctly signed delivery and processes it once', async () => {
    const res = await signedPost(payload);
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('captured');
    expect(recordWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      provider: 'dry_run',
      providerEventId: 'evt_1',
      eventType: 'payment.captured',
    }));
    expect(processWebhookEvent).toHaveBeenCalledTimes(1);
    expect(markWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT, eventId: 10, status: 'processed', gatewayOrderId: 5,
    }));
  });

  it('rejects a bad signature with 401 and records nothing', async () => {
    const res = await signedPost(payload, { signature: 'ab'.repeat(32) });
    expect(res.status).toBe(401);
    expect(recordWebhookEvent).not.toHaveBeenCalled();
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects a body signed with a different secret', async () => {
    const res = await signedPost(payload, { secret: 'another-secret-000000000000000000' });
    expect(res.status).toBe(401);
    expect(recordWebhookEvent).not.toHaveBeenCalled();
  });

  it('requires the provider event id header', async () => {
    const res = await signedPost(payload, { eventId: '' });
    expect(res.status).toBe(400);
    expect(recordWebhookEvent).not.toHaveBeenCalled();
  });
});

describe('replay dedupe', () => {
  it('200-acks a duplicate whose row is already processed WITHOUT reprocessing', async () => {
    recordWebhookEvent.mockResolvedValue({
      duplicate: true,
      event: { id: 10, status: 'processed', event_type: 'payment.captured' },
    });
    const res = await signedPost(payload);
    expect(res.status).toBe(200);
    expect(res.body.data.replay).toBe(true);
    expect(processWebhookEvent).not.toHaveBeenCalled();
    expect(markWebhookEvent).not.toHaveBeenCalled();
  });

  it('treats a shared-replay-claim hit the same as a table duplicate (no 401 for redeliveries)', async () => {
    const replayErr = Object.assign(new Error('replay'), { code: 'PAYMENT_GATEWAY_WEBHOOK_REPLAY' });
    assertSharedReplayOnce.mockRejectedValue(replayErr);
    recordWebhookEvent.mockResolvedValue({
      duplicate: true,
      event: { id: 10, status: 'processed', event_type: 'payment.captured' },
    });
    const res = await signedPost(payload);
    expect(res.status).toBe(200);
    expect(res.body.data.replay).toBe(true);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  it('RESUMES a duplicate whose row a crash left pending', async () => {
    recordWebhookEvent.mockResolvedValue({
      duplicate: true,
      event: { id: 10, status: 'pending', event_type: 'payment.captured' },
    });
    const res = await signedPost(payload);
    expect(res.status).toBe(200);
    expect(processWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it('fails closed (503) when the durable replay store is unavailable', async () => {
    const storeErr = Object.assign(new Error('store down'), {
      code: 'PAYMENT_GATEWAY_WEBHOOK_REPLAY_STORE_UNAVAILABLE',
    });
    assertSharedReplayOnce.mockRejectedValue(storeErr);
    const res = await signedPost(payload);
    expect(res.status).toBe(503);
    expect(recordWebhookEvent).not.toHaveBeenCalled();
  });
});

describe('verified-but-unprocessable deliveries', () => {
  it('records the event failed, alerts, and still 200-acks so the provider stops re-delivering', async () => {
    processWebhookEvent.mockRejectedValue(new Error('invoice imploded'));
    const res = await signedPost(payload);
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('failed');
    expect(markWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT, eventId: 10, status: 'failed', failureReason: 'invoice imploded',
    }));
  });

  it('marks unhandled event types ignored', async () => {
    processWebhookEvent.mockResolvedValue({ outcome: 'ignored', reason: 'unhandled event type foo' });
    const res = await signedPost({ ...payload, event: 'foo' });
    expect(res.status).toBe(200);
    expect(markWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'ignored' }));
  });
});

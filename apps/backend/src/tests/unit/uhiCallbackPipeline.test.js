/**
 * UHI webhook pipeline (migration 705) — mocked route-layer unit suite.
 *
 * The callback mount is public and pre-RLS, so its request pipeline is the
 * security boundary. Pinned here (no real DB/crypto — the adapter service,
 * signature verifier, settings accessor and interop resolver are mocked):
 *   1. env kill switch (UHI_ENABLED off) → 404 UHI_DISABLED, ZERO rows written;
 *   2. unknown provider id → 401, nothing stored (fail-closed tenant resolution);
 *   3. tenant setting off → 404 UHI_DISABLED, nothing stored;
 *   4. signature failure → NACK + ONE evidence row with status 'rejected',
 *      signature_verified=false and the failure reason; handler never runs;
 *   5. happy leg → tenant-A attribution on the recorded row, handler runs,
 *      leg marked processed, ACK;
 *   6. duplicate leg (dedupe conflict) → replay-safe ACK without reprocessing.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Mutable config object — tests flip `enabled` between cases.
const UHI_CONFIG = {
  enabled: true,
  gatewayUrl: 'https://gateway.example/api/v1',
  subscriberId: 'hsp.vhhealth',
  signingPrivateKey: '',
  signingKeyId: '',
  gatewayPublicKey: 'env-public-key',
  environment: 'sandbox',
  domain: 'nic2004:85110',
  city: 'std:044',
  country: 'IND',
  ACTIONS: ['search', 'init', 'confirm', 'status', 'cancel'],
};
jest.unstable_mockModule('../../config/uhiConfig.js', () => ({
  UHI_CONFIG,
  default: UHI_CONFIG,
}));

jest.unstable_mockModule('../../middleware/rateLimitMiddleware.js', () => ({
  genericLimiter: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() },
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
}));

const resolveTenantBySender = jest.fn();
const getInteropSecret = jest.fn();
jest.unstable_mockModule('../../services/interop/tenantInteropSecretService.js', () => ({
  resolveTenantBySender,
  getInteropSecret,
  default: { resolveTenantBySender, getInteropSecret },
}));

const getUhiSettings = jest.fn();
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getUhiSettings,
}));

const verifyBecknSignature = jest.fn();
jest.unstable_mockModule('../../utils/uhiSignature.js', () => ({
  verifyBecknSignature,
  default: { verifyBecknSignature },
}));

// The adapter service is mocked wholesale: the pipeline test cares about WHAT
// the route records and dispatches, not how the legs are processed (the deep
// suite covers that against the real DB).
const recordUhiLeg = jest.fn();
const markUhiLeg = jest.fn();
const handleUhiSearch = jest.fn();
const handleUhiInit = jest.fn();
const handleUhiConfirm = jest.fn();
const handleUhiStatus = jest.fn();
const handleUhiCancel = jest.fn();
const UHI_ACTIONS = [
  'search', 'on_search', 'init', 'on_init', 'confirm', 'on_confirm',
  'status', 'on_status', 'cancel', 'on_cancel',
];
function parseUhiContext(body) {
  const context = body?.context;
  if (!context?.transaction_id || !context?.message_id) {
    const err = new Error('UHI message context is required');
    err.statusCode = 400;
    err.code = 'UHI_CONTEXT_REQUIRED';
    err.isOperational = true;
    throw err;
  }
  return {
    transactionId: context.transaction_id,
    messageId: context.message_id,
    action: context.action ?? null,
    providerId: context.bpp_id ?? context.provider_id ?? null,
    consumerId: context.bap_id ?? null,
    consumerUri: context.bap_uri ?? null,
  };
}
jest.unstable_mockModule('../../services/uhi/uhiAdapterService.js', () => ({
  UHI_ACTIONS,
  parseUhiContext,
  recordUhiLeg,
  markUhiLeg,
  handleUhiSearch,
  handleUhiInit,
  handleUhiConfirm,
  handleUhiStatus,
  handleUhiCancel,
  listUhiTransactions: jest.fn(),
  default: {},
}));

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let callbackRouter;

beforeAll(async () => {
  ({ callbackRouter } = await import('../../routes/uhi/uhiRoutes.js'));
});

function buildApp() {
  const app = express();
  app.use(express.json({
    verify: (req, _res, body) => {
      req.uhiRawBody = Buffer.from(body);
    },
  }));
  app.use('/api/v1/uhi', callbackRouter);
  return app;
}

function envelope(action = 'search', providerId = 'hsp.tenant-a') {
  return {
    context: {
      transaction_id: 'txn-100',
      message_id: 'msg-100',
      action,
      bpp_id: providerId,
      bap_id: 'eua.example',
      bap_uri: 'https://eua.example/callback',
    },
    message: { intent: {} },
  };
}

beforeEach(() => {
  UHI_CONFIG.enabled = true;
  resolveTenantBySender.mockReset();
  getInteropSecret.mockReset();
  getUhiSettings.mockReset();
  verifyBecknSignature.mockReset();
  recordUhiLeg.mockReset();
  markUhiLeg.mockReset();
  handleUhiSearch.mockReset();

  resolveTenantBySender.mockResolvedValue(TENANT_A);
  getInteropSecret.mockResolvedValue('tenant-a-public-key');
  getUhiSettings.mockResolvedValue({ enabled: true, environment: 'sandbox' });
  verifyBecknSignature.mockReturnValue({ keyId: 'k', created: 1, expires: 2 });
  recordUhiLeg.mockResolvedValue({ row: { id: 42 }, duplicate: false });
  markUhiLeg.mockResolvedValue(undefined);
  handleUhiSearch.mockResolvedValue({ message: { catalog: {} }, callback: {} });
});

describe('UHI webhook pipeline', () => {
  it('env kill switch: UHI_ENABLED off → 404 UHI_DISABLED with zero rows written', async () => {
    UHI_CONFIG.enabled = false;
    const res = await request(buildApp())
      .post('/api/v1/uhi/search')
      .send(envelope());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('UHI_DISABLED');
    expect(recordUhiLeg).not.toHaveBeenCalled();
    expect(resolveTenantBySender).not.toHaveBeenCalled();
  });

  it('unknown provider id → 401 fail-closed, nothing stored', async () => {
    resolveTenantBySender.mockResolvedValue(null);
    getInteropSecret.mockResolvedValue(null);
    const res = await request(buildApp())
      .post('/api/v1/uhi/search')
      .send(envelope('search', 'hsp.unknown'));
    expect(res.status).toBe(401);
    expect(recordUhiLeg).not.toHaveBeenCalled();
    expect(verifyBecknSignature).not.toHaveBeenCalled();
  });

  it('env-subscriber fallback maps only the configured subscriber id to the default tenant', async () => {
    resolveTenantBySender.mockResolvedValue(null);
    getInteropSecret.mockResolvedValue(null);
    const res = await request(buildApp())
      .post('/api/v1/uhi/search')
      .send(envelope('search', 'hsp.vhhealth'));
    // Resolution succeeded via env fallback — pipeline continues to settings
    // + signature and records under the DEFAULT tenant.
    expect(res.status).toBe(200);
    expect(recordUhiLeg).toHaveBeenCalledTimes(1);
    expect(recordUhiLeg.mock.calls[0][0].tenantId).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('tenant setting off → 404 UHI_DISABLED, nothing stored', async () => {
    getUhiSettings.mockResolvedValue({ enabled: false, environment: 'sandbox' });
    const res = await request(buildApp())
      .post('/api/v1/uhi/search')
      .send(envelope());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('UHI_DISABLED');
    expect(recordUhiLeg).not.toHaveBeenCalled();
    expect(verifyBecknSignature).not.toHaveBeenCalled();
  });

  it('signature failure → NACK 401 + one rejected evidence row with the reason; handler never runs', async () => {
    verifyBecknSignature.mockImplementation(() => {
      const err = new Error('UHI signature is invalid');
      err.statusCode = 401;
      err.code = 'UHI_SIGNATURE_INVALID';
      err.isOperational = true;
      throw err;
    });
    const res = await request(buildApp())
      .post('/api/v1/uhi/search')
      .set('Authorization', 'Signature keyId="x",signature="forged"')
      .send(envelope());
    expect(res.status).toBe(401);
    expect(res.body.message.ack.status).toBe('NACK');
    expect(recordUhiLeg).toHaveBeenCalledTimes(1);
    expect(recordUhiLeg.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT_A,
      action: 'search',
      direction: 'inbound',
      signatureVerified: false,
      verificationFailureReason: 'UHI_SIGNATURE_INVALID',
      status: 'rejected',
      ack: 'NACK',
    });
    expect(handleUhiSearch).not.toHaveBeenCalled();
  });

  it('happy search leg: records under the RESOLVED tenant, runs the handler, marks processed, ACKs', async () => {
    const res = await request(buildApp())
      .post('/api/v1/uhi/search')
      .send(envelope());
    expect(res.status).toBe(200);
    expect(res.body.data.message.ack.status).toBe('ACK');
    // Tenant binding: the message's provider id resolved to tenant A and every
    // recorded row carries that tenant explicitly.
    expect(recordUhiLeg).toHaveBeenCalledTimes(1);
    expect(recordUhiLeg.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT_A,
      environment: 'sandbox',
      transactionId: 'txn-100',
      messageId: 'msg-100',
      action: 'search',
      direction: 'inbound',
      signatureVerified: true,
    });
    expect(handleUhiSearch).toHaveBeenCalledTimes(1);
    expect(handleUhiSearch.mock.calls[0][0].tenantId).toBe(TENANT_A);
    expect(markUhiLeg).toHaveBeenCalledWith(TENANT_A, 42, expect.objectContaining({
      status: 'processed',
      ack: 'ACK',
    }));
  });

  it('duplicate leg → replay-safe ACK without reprocessing', async () => {
    recordUhiLeg.mockResolvedValue({ row: { id: 42, status: 'processed' }, duplicate: true });
    const res = await request(buildApp())
      .post('/api/v1/uhi/search')
      .send(envelope());
    expect(res.status).toBe(200);
    expect(res.body.data.message.ack.status).toBe('ACK');
    expect(res.body.message).toBe('UHI message already received');
    expect(handleUhiSearch).not.toHaveBeenCalled();
    expect(markUhiLeg).not.toHaveBeenCalled();
  });

  it('handler failure marks the leg failed and NACKs without a 500 for operational errors', async () => {
    handleUhiSearch.mockRejectedValue(Object.assign(new Error('bad slot'), {
      statusCode: 400,
      code: 'UHI_ORDER_SLOT_REQUIRED',
      isOperational: true,
    }));
    const res = await request(buildApp())
      .post('/api/v1/uhi/search')
      .send(envelope());
    expect(res.status).toBe(400);
    expect(res.body.message.ack.status).toBe('NACK');
    expect(markUhiLeg).toHaveBeenCalledWith(TENANT_A, 42, expect.objectContaining({
      status: 'failed',
      errorCode: 'UHI_ORDER_SLOT_REQUIRED',
    }));
  });
});

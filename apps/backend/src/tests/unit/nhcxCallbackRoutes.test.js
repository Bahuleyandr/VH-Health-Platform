import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const verifySignedRequest = jest.fn();
const assertSharedReplayOnce = jest.fn();
const resolveTenantByNHCXParticipantCode = jest.fn();
const getInteropSecret = jest.fn();
const processNHCXCallback = jest.fn();

jest.unstable_mockModule('../../config/nhcxConfig.js', () => ({
  NHCX_CONFIG: { enabled: true },
}));

jest.unstable_mockModule('../../middleware/rateLimitMiddleware.js', () => ({
  genericLimiter: (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../../utils/signedRequest.js', () => ({
  verifySignedRequest,
  assertSharedReplayOnce,
}));

jest.unstable_mockModule('../../services/nhcx/nhcxTenantConfigService.js', () => ({
  NHCX_SECRET_KINDS: { callbackSecret: 'nhcx_callback_secret' },
  resolveTenantByNHCXParticipantCode,
}));

jest.unstable_mockModule('../../services/interop/tenantInteropSecretService.js', () => ({
  getInteropSecret,
}));

jest.unstable_mockModule('../../services/nhcx/nhcxInboundCallbackService.js', () => ({
  processNHCXCallback,
}));

const { callbackRouter } = await import('../../routes/nhcx/nhcxCallbackRoutes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(callbackRouter);
  return app;
}

beforeEach(() => {
  verifySignedRequest.mockReset();
  assertSharedReplayOnce.mockReset();
  resolveTenantByNHCXParticipantCode.mockReset();
  getInteropSecret.mockReset();
  processNHCXCallback.mockReset();
  resolveTenantByNHCXParticipantCode.mockResolvedValue(TENANT);
  getInteropSecret.mockResolvedValue('tenant-callback-secret');
  assertSharedReplayOnce.mockResolvedValue(true);
  processNHCXCallback.mockResolvedValue({
    envelope: { id: '30', status: 'processed' },
    duplicate: false,
    processed: true,
  });
});

function postValid(app) {
  return request(app)
    .post('/preauth/on_submit')
    .set('x-hcx-recipient_code', 'VH-NHCX-PROVIDER')
    .set('x-hcx-sender_code', 'PAYER-NHCX-SAMPLE')
    .set('x-nhcx-signature', 'a'.repeat(64))
    .set('x-hcx-timestamp', '1718800000000')
    .set('x-hcx-request-id', 'nhcx-request-1')
    .send({ payload: 'compact-jwe' });
}

describe('NHCX callback router', () => {
  it('authenticates by participant code, HMAC signature, and shared replay guard', async () => {
    const res = await postValid(buildApp());

    expect(res.status).toBe(202);
    expect(resolveTenantByNHCXParticipantCode).toHaveBeenCalledWith('VH-NHCX-PROVIDER');
    expect(getInteropSecret).toHaveBeenCalledWith(TENANT, 'nhcx_callback_secret', {
      senderIdentifier: 'VH-NHCX-PROVIDER',
    });
    expect(verifySignedRequest).toHaveBeenCalledWith(expect.objectContaining({
      secret: 'tenant-callback-secret',
      replayNamespace: 'nhcx-callback',
      codePrefix: 'NHCX_CALLBACK',
    }));
    expect(assertSharedReplayOnce).toHaveBeenCalledWith(expect.objectContaining({
      replayNamespace: 'nhcx-callback',
      requestId: 'nhcx-request-1',
    }));
    expect(processNHCXCallback).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      endpoint: 'preauth/on_submit',
      participantCodeSelf: 'VH-NHCX-PROVIDER',
      signatureVerified: true,
    }));
  });

  it('rejects missing participant code before tenant lookup', async () => {
    const res = await request(buildApp())
      .post('/preauth/on_submit')
      .send({ payload: 'compact-jwe' });

    expect(res.status).toBe(401);
    expect(resolveTenantByNHCXParticipantCode).not.toHaveBeenCalled();
    expect(processNHCXCallback).not.toHaveBeenCalled();
  });

  it('rejects fail-closed when the shared replay guard rejects', async () => {
    assertSharedReplayOnce.mockRejectedValue(Object.assign(new Error('NHCX callback request replay detected'), {
      statusCode: 401,
      code: 'NHCX_CALLBACK_REPLAY',
    }));

    const res = await postValid(buildApp());

    expect(res.status).toBe(401);
    expect(processNHCXCallback).not.toHaveBeenCalled();
  });
});

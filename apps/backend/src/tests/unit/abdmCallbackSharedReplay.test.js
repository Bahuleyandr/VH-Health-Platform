/**
 * ABDM callback cross-replica replay protection (audit §3 / FHIR-interop).
 *
 * The ABDM gateway callback is public-by-mount and self-authenticated via an
 * HMAC signature. verifySignedRequest's same-process replay Map is defeated by
 * the 3-replica cluster / a restart, so a captured (still-fresh) signed callback
 * replayed against a DIFFERENT replica is accepted again. HL7 /receive already
 * closes this with the shared cross-replica store assertSharedReplayOnce
 * (DB interop_replay_guard authority plus a best-effort Redis marker). The
 * ABDM callback must mirror that.
 *
 * Two behaviours under test (no real DB/HMAC — signedRequest + abdmConfig are
 * mocked, the service handler is spied):
 *   1. A valid ABDM callback invokes assertSharedReplayOnce with the request's
 *      replay key (the SAME requestId/timestamp/signature it just HMAC-verified)
 *      under the 'abdm-callback' namespace.
 *   2. When the shared store signals a replay (assertSharedReplayOnce throws,
 *      per HL7's contract), the callback is rejected fail-closed — the service
 *      handler is NOT invoked.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// --- mocks (must precede the dynamic imports) -----------------------------
jest.unstable_mockModule('../../config/abdmConfig.js', () => ({
  ABDM_CONFIG: {
    enabled: true,
    hipId: 'TEST_HIP',
    callbackSecret: 'test-secret',
    PURPOSES: ['CAREMGT'],
  },
}));
// HMAC fast-path passes; shared replay guard is the unit under test.
const verifySignedRequest = jest.fn();
const assertSharedReplayOnce = jest.fn();
const recordAuthenticatedAbdmCallback = jest.fn();
const markAuthenticatedAbdmCallback = jest.fn();
jest.unstable_mockModule('../../utils/signedRequest.js', () => ({
  verifySignedRequest,
  assertSharedReplayOnce,
}));
jest.unstable_mockModule('../../middleware/rateLimitMiddleware.js', () => ({
  genericLimiter: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../services/interop/tenantInteropSecretService.js', () => ({
  resolveInteropCredentialSnapshot: jest.fn().mockResolvedValue(null),
}));
// abdmService pulls these in transitively; the route test spies the handler,
// so stub them to keep the import side-effect-free (no real DB / crypto / SSRF).
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() },
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/abdm/abdmCrypto.js', () => ({
  encryptFhirBundle: jest.fn(),
}));
jest.unstable_mockModule('../../services/abdm/abdmGateway.js', () => ({
  default: {},
}));
jest.unstable_mockModule('../../utils/ssrfGuard.js', () => ({
  assertSafeOutboundUrl: jest.fn(),
}));
jest.unstable_mockModule('../../services/integrations/externalAbdmRecoveryService.js', () => ({
  recordAuthenticatedAbdmCallback,
  markAuthenticatedAbdmCallback,
}));
// The Scan & Share / HIU callback handlers lazy-import their services;
// unstable_mockModule intercepts the dynamic import too, so the whole
// migration-702/703 dependency graph stays out of this suite.
const handlePatientProfileShareCallback = jest.fn();
const handleHiuDataPush = jest.fn();
jest.unstable_mockModule('../../services/abdm/abdmShareIntakeService.js', () => ({
  handlePatientProfileShareCallback,
  default: { handlePatientProfileShareCallback },
}));
jest.unstable_mockModule('../../services/abdm/abdmHiuService.js', () => ({
  handleHiuDataPush,
  handleHiuConsentOnInit: jest.fn(),
  handleHiuConsentNotify: jest.fn(),
  handleHiuHealthInfoOnRequest: jest.fn(),
  default: { handleHiuDataPush },
}));

let abdmService;
let callbackRouter;

beforeAll(async () => {
  abdmService = (await import('../../services/abdm/abdmService.js')).default;
  ({ callbackRouter } = await import('../../routes/abdm/abdmRoutes.js'));
});

beforeEach(() => {
  verifySignedRequest.mockReset();
  assertSharedReplayOnce.mockReset();
  recordAuthenticatedAbdmCallback.mockReset();
  markAuthenticatedAbdmCallback.mockReset();
  handlePatientProfileShareCallback.mockReset();
  handleHiuDataPush.mockReset();
  handlePatientProfileShareCallback.mockResolvedValue({
    intake: { id: 21 }, duplicate: false, tokenNumber: 'T-21',
  });
  handleHiuDataPush.mockResolvedValue({
    duplicate: false, transactionId: 'txn-1', stored: 1, failed: 0,
  });
  recordAuthenticatedAbdmCallback.mockResolvedValue({
    event: { id: '71', external_event_id: 'cr-9', status: 'pending' },
    duplicate: false,
  });
  markAuthenticatedAbdmCallback.mockResolvedValue({ id: '71', status: 'processed' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function buildApp() {
  const app = express();
  app.use(express.json({
    verify: (req, _res, body) => {
      req.abdmRawBody = Buffer.from(body);
    },
  }));
  app.use(callbackRouter);
  return app;
}

const SIGNATURE = 'a'.repeat(64);
const SIGNATURE_VERSION = 'v1';
const TIMESTAMP = '1718800000000';
const REQUEST_ID = 'abdm-req-123';

function postValidCallback(app) {
  return request(app)
    .post('/consent/on-notify')
    .set('x-hip-id', 'TEST_HIP')
    .set('x-abdm-signature', SIGNATURE)
    .set('x-abdm-signature-version', SIGNATURE_VERSION)
    .set('timestamp', TIMESTAMP)
    .set('request-id', REQUEST_ID)
    .send({
      notification: {
        consentRequestId: 'cr-9',
        purpose: { code: 'CAREMGT' },
        patient: { id: 'abha@sbx' },
      },
    });
}

describe('ABDM callback cross-replica replay protection', () => {
  it('fails closed when exact raw-body capture is missing', async () => {
    const app = express();
    app.use(express.json());
    app.use(callbackRouter);
    const res = await postValidCallback(app);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ABDM_RAW_BODY_MISSING');
    expect(verifySignedRequest).not.toHaveBeenCalled();
  });

  it('invokes assertSharedReplayOnce with the abdm-callback replay key on a valid callback', async () => {
    const spy = jest.spyOn(abdmService, 'handleConsentRequest')
      .mockResolvedValue({ consent_id: 'test-consent' });

    const res = await postValidCallback(buildApp());

    expect(res.status).toBe(202);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(Buffer.isBuffer(verifySignedRequest.mock.calls[0][0].payload)).toBe(true);
    expect(verifySignedRequest.mock.calls[0][0]).toMatchObject({
      signatureVersion: SIGNATURE_VERSION,
      method: 'POST',
      canonicalPath: '/api/v1/abdm/consent/on-notify',
    });
    expect(assertSharedReplayOnce).toHaveBeenCalledTimes(1);
    const arg = assertSharedReplayOnce.mock.calls[0][0];
    expect(arg.replayNamespace).toBe('abdm-callback');
    expect(arg.requestId).toBe(REQUEST_ID);
    expect(String(arg.timestamp)).toBe(TIMESTAMP);
    expect(arg.signature).toBe(SIGNATURE);
    expect(arg).toMatchObject({
      signatureVersion: SIGNATURE_VERSION,
      method: 'POST',
      canonicalPath: '/api/v1/abdm/consent/on-notify',
    });
    expect(recordAuthenticatedAbdmCallback).toHaveBeenCalledTimes(1);
    expect(assertSharedReplayOnce.mock.invocationCallOrder[0])
      .toBeLessThan(recordAuthenticatedAbdmCallback.mock.invocationCallOrder[0]);
    const receipt = recordAuthenticatedAbdmCallback.mock.calls[0][0];
    expect(receipt).toMatchObject({
      tenantId: expect.any(String),
      callbackPath: '/consent/on-notify',
      environment: 'sandbox',
      auth: {
        hipId: 'TEST_HIP',
        requestId: REQUEST_ID,
        timestamp: TIMESTAMP,
        signature: SIGNATURE,
      },
    });
    expect(JSON.parse(receipt.rawBody.toString('utf8'))).toEqual({
      notification: {
        consentRequestId: 'cr-9',
        purpose: { code: 'CAREMGT' },
        patient: { id: 'abha@sbx' },
      },
    });
  });

  it('rejects fail-closed and does NOT process the callback when the shared store signals a replay', async () => {
    const spy = jest.spyOn(abdmService, 'handleConsentRequest')
      .mockResolvedValue({ consent_id: 'should-not-happen' });
    // Mirror HL7's contract: a detected replay throws an AppError.
    const replayErr = Object.assign(new Error('ABDM callback request replay detected'), {
      statusCode: 401,
      code: 'ABDM_CALLBACK_REPLAY',
    });
    assertSharedReplayOnce.mockRejectedValue(replayErr);

    const res = await postValidCallback(buildApp());

    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    expect(recordAuthenticatedAbdmCallback).not.toHaveBeenCalled();
  });

  it('runs the Scan & Share path through the SAME replay chain and hands the resolved tenant to the service', async () => {
    const res = await request(buildApp())
      .post('/patients/profile/share')
      .set('x-hip-id', 'TEST_HIP')
      .set('x-abdm-signature', SIGNATURE)
      .set('x-abdm-signature-version', SIGNATURE_VERSION)
      .set('timestamp', TIMESTAMP)
      .set('request-id', REQUEST_ID)
      .send({ requestId: 'req-abc', profile: { patient: { name: 'Asha' } } });

    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({
      acknowledgement: { status: 'SUCCESS' },
      requestId: 'req-abc',
      tokenNumber: 'T-21',
    });
    expect(assertSharedReplayOnce).toHaveBeenCalledTimes(1);
    expect(handlePatientProfileShareCallback).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: expect.any(String),
      environment: 'sandbox',
      body: expect.objectContaining({ requestId: 'req-abc' }),
    }));
  });

  it('a replay on the Scan & Share path is rejected before the service runs', async () => {
    assertSharedReplayOnce.mockRejectedValue(Object.assign(
      new Error('replay'), { statusCode: 401, code: 'ABDM_CALLBACK_REPLAY' },
    ));

    const res = await request(buildApp())
      .post('/patients/profile/share')
      .set('x-hip-id', 'TEST_HIP')
      .set('x-abdm-signature', SIGNATURE)
      .set('x-abdm-signature-version', SIGNATURE_VERSION)
      .set('timestamp', TIMESTAMP)
      .set('request-id', REQUEST_ID)
      .send({ requestId: 'req-abc' });

    expect(res.status).toBe(401);
    expect(handlePatientProfileShareCallback).not.toHaveBeenCalled();
  });

  it('an unrecognized HIP id 401s the new paths (tenant fail-closed)', async () => {
    const res = await request(buildApp())
      .post('/hiu/health-info/push')
      .set('x-hip-id', 'SOMEONE_ELSES_HIP')
      .set('x-abdm-signature', SIGNATURE)
      .set('x-abdm-signature-version', SIGNATURE_VERSION)
      .set('timestamp', TIMESTAMP)
      .set('request-id', REQUEST_ID)
      .send({ transactionId: 'txn-1', entries: [] });

    expect(res.status).toBe(401);
    expect(handleHiuDataPush).not.toHaveBeenCalled();
    expect(assertSharedReplayOnce).not.toHaveBeenCalled();
  });

  it('the HIU data-push path rides the same chain and 202-acks', async () => {
    const res = await request(buildApp())
      .post('/hiu/health-info/push')
      .set('x-hip-id', 'TEST_HIP')
      .set('x-abdm-signature', SIGNATURE)
      .set('x-abdm-signature-version', SIGNATURE_VERSION)
      .set('timestamp', TIMESTAMP)
      .set('request-id', REQUEST_ID)
      .send({ transactionId: 'txn-1', pageNumber: 1, pageCount: 1, entries: [] });

    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ transactionId: 'txn-1', stored: 1 });
    expect(assertSharedReplayOnce).toHaveBeenCalledTimes(1);
    expect(handleHiuDataPush).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: expect.any(String),
      authenticatedHipId: 'TEST_HIP',
    }));
  });

  it('rejects fail-closed when the shared replay store is unavailable (503)', async () => {
    const spy = jest.spyOn(abdmService, 'handleConsentRequest')
      .mockResolvedValue({ consent_id: 'should-not-happen' });
    const storeDown = Object.assign(new Error('ABDM callback replay store is unavailable'), {
      statusCode: 503,
      code: 'ABDM_CALLBACK_REPLAY_STORE_UNAVAILABLE',
    });
    assertSharedReplayOnce.mockRejectedValue(storeDown);

    const res = await postValidCallback(buildApp());

    expect(res.status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
    expect(recordAuthenticatedAbdmCallback).not.toHaveBeenCalled();
  });

  it('derives the canonical application path without query or forwarded proxy prefix', async () => {
    jest.spyOn(abdmService, 'handleConsentRequest')
      .mockResolvedValue({ consent_id: 'test-consent' });

    const res = await request(buildApp())
      .post('/consent/on-notify?admin=true')
      .set('x-forwarded-prefix', '/hospital-edge')
      .set('x-hip-id', 'TEST_HIP')
      .set('x-abdm-signature', SIGNATURE)
      .set('x-abdm-signature-version', SIGNATURE_VERSION)
      .set('timestamp', TIMESTAMP)
      .set('request-id', `${REQUEST_ID}-query`)
      .send({ notification: { consentRequestId: 'cr-query' } });

    expect(res.status).toBe(202);
    expect(verifySignedRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      canonicalPath: '/api/v1/abdm/consent/on-notify',
    }));
  });

  it('rejects an unversioned callback before HMAC or replay work', async () => {
    const res = await request(buildApp())
      .post('/consent/on-notify')
      .set('x-hip-id', 'TEST_HIP')
      .set('x-abdm-signature', SIGNATURE)
      .set('timestamp', TIMESTAMP)
      .set('request-id', `${REQUEST_ID}-unversioned`)
      .send({ notification: { consentRequestId: 'cr-unversioned' } });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ABDM_CALLBACK_SIGNATURE_VERSION_REQUIRED');
    expect(verifySignedRequest).not.toHaveBeenCalled();
    expect(assertSharedReplayOnce).not.toHaveBeenCalled();
  });
});

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the shared relayAppError port
// (mirrors paediatricImmunisationRoutesAppErrorPropagation.test.js).
//
// abdmRoutes.js has three catch shapes this file pins:
//   * the patient-router isOperational guards (R6) whose non-operational tail
//     is `logger.error + next(err)` — a deliberate gateway surface where the
//     global handler / Sentry must keep seeing programming errors (R2);
//   * the consent/on-notify custom details-builder that used to hand-lift
//     `err.code` via `topLevel` — relayAppError must keep code at the envelope
//     root and err.details under `details` (wire-identical);
//   * the validateABDMRequest fail-closed auth catch (R5): AppError-shaped
//     errors relay code+details, while a bare Error keeps the historical
//     raw-message-at-401 wire behaviour exactly.

const TENANT = '00000000-0000-4000-8000-000000000001';

const handleConsentRequestMock = jest.fn();
const getPatientConsentsMock = jest.fn();
const grantConsentMock = jest.fn();
const verifySignedRequestMock = jest.fn();
const assertSharedReplayOnceMock = jest.fn();
const resolveTenantBySenderMock = jest.fn();
const getInteropSecretMock = jest.fn();

jest.unstable_mockModule('../../config/abdmConfig.js', () => ({
  ABDM_CONFIG: { enabled: true, hipId: 'TEST_HIP', callbackSecret: 'test-callback-secret' },
}));

jest.unstable_mockModule('../../middleware/rateLimitMiddleware.js', () => ({
  genericLimiter: (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../../utils/signedRequest.js', () => ({
  verifySignedRequest: verifySignedRequestMock,
  assertSharedReplayOnce: assertSharedReplayOnceMock,
}));

jest.unstable_mockModule('../../services/interop/tenantInteropSecretService.js', () => ({
  resolveTenantBySender: resolveTenantBySenderMock,
  getInteropSecret: getInteropSecretMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: TENANT,
}));

jest.unstable_mockModule('../../services/abdm/abdmService.js', () => ({
  default: {
    handleConsentRequest: handleConsentRequestMock,
    handleDataRequest: jest.fn(),
    registerABHA: jest.fn(),
    getPatientByABHA: jest.fn(),
    getAdminStatus: jest.fn(),
    listConsentRequests: jest.fn(),
    getPatientConsents: getPatientConsentsMock,
    grantConsent: grantConsentMock,
    denyConsent: jest.fn(),
    revokeConsent: jest.fn(),
  },
}));

const { callbackRouter, patientRouter } = await import('../../routes/abdm/abdmRoutes.js');

const globalHandlerSpy = jest.fn();

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'PATIENT' };
  next();
});
app.use('/abdm', callbackRouter);
app.use('/abdm', patientRouter);
// Trailing error middleware standing in for the global handler — the R2 tails
// (`logger.error + next(err)`) must still reach it after the port.
app.use((err, _req, res, _next) => {
  globalHandlerSpy(err);
  res.status(500).json({ success: false, message: 'handled-by-global-error-middleware' });
});

beforeEach(() => {
  handleConsentRequestMock.mockReset();
  getPatientConsentsMock.mockReset();
  grantConsentMock.mockReset();
  verifySignedRequestMock.mockReset();
  assertSharedReplayOnceMock.mockReset();
  resolveTenantBySenderMock.mockReset();
  getInteropSecretMock.mockReset();
  globalHandlerSpy.mockReset();
  // Callback auth defaults: no per-tenant secret row, so the configured
  // global HIP id path (DEFAULT tenant + config secret) authenticates.
  resolveTenantBySenderMock.mockResolvedValue(null);
  getInteropSecretMock.mockResolvedValue(null);
  verifySignedRequestMock.mockReturnValue(undefined);
  assertSharedReplayOnceMock.mockResolvedValue(true);
});

describe('abdmRoutes relays AppError code + details through relayAppError', () => {
  test('patient-router isOperational guard forwards code and details over HTTP', async () => {
    grantConsentMock.mockRejectedValueOnce(AppError.conflict(
      'Consent request is not in a grantable state',
      'ABDM_CONSENT_NOT_GRANTABLE',
      { reason: 'x' },
    ));

    const response = await request(app).post('/abdm/consents/12/grant').send({});

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Consent request is not in a grantable state');
    expect(response.body.code).toBe('ABDM_CONSENT_NOT_GRANTABLE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
    expect(globalHandlerSpy).not.toHaveBeenCalled();
  });

  test('non-AppError keeps the byte-identical logger + next(err) tail (R2 gateway surface)', async () => {
    getPatientConsentsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'consent_id')"),
    );

    const response = await request(app).get('/abdm/consents');

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('handled-by-global-error-middleware');
    expect(JSON.stringify(response.body)).not.toMatch(/consent_id/);
    expect(globalHandlerSpy).toHaveBeenCalledTimes(1);
    expect(globalHandlerSpy.mock.calls[0][0].message)
      .toBe("Cannot read properties of undefined (reading 'consent_id')");
  });

  test('consent/on-notify custom builder stays wire-identical: code at root, details nested', async () => {
    handleConsentRequestMock.mockRejectedValueOnce(AppError.forbidden(
      'Consent artefact does not match the notification wrapper',
      'ABDM_CONSENT_BINDING_MISMATCH',
      { consentId: 'c-1' },
    ));

    const response = await request(app)
      .post('/abdm/consent/on-notify')
      .set('x-hip-id', 'TEST_HIP')
      .send({ notification: { consentRequestId: 'cr-9', patient: { id: 'abha@sbx' } } });

    expect(response.statusCode).toBe(403);
    expect(response.body.code).toBe('ABDM_CONSENT_BINDING_MISMATCH');
    // Pre-port the builder produced exactly this: err.details under `details`
    // with the hand-rolled `topLevel` wrapper lifted out (never serialized).
    expect(response.body.details).toEqual({ consentId: 'c-1' });
    expect(response.body.details).not.toHaveProperty('topLevel');
    expect(globalHandlerSpy).not.toHaveBeenCalled();
  });

  test('R5 auth catch: AppError-shaped rejection relays status + code + details', async () => {
    verifySignedRequestMock.mockImplementationOnce(() => {
      throw new AppError('Signed request timestamp outside freshness window', 401, 'ABDM_CALLBACK_STALE', { skewMs: 999 });
    });

    const response = await request(app)
      .post('/abdm/consent/on-notify')
      .set('x-hip-id', 'TEST_HIP')
      .send({ notification: { consentRequestId: 'cr-9' } });

    expect(response.statusCode).toBe(401);
    expect(response.body.code).toBe('ABDM_CALLBACK_STALE');
    expect(response.body.details).toEqual({ skewMs: 999 });
    expect(handleConsentRequestMock).not.toHaveBeenCalled();
  });

  test('R5 auth catch: bare Error keeps the fail-closed raw-message-at-401 wire behaviour', async () => {
    verifySignedRequestMock.mockImplementationOnce(() => {
      throw new Error('signature digest mismatch for request');
    });

    const response = await request(app)
      .post('/abdm/consent/on-notify')
      .set('x-hip-id', 'TEST_HIP')
      .send({ notification: { consentRequestId: 'cr-9' } });

    expect(response.statusCode).toBe(401);
    expect(response.body.message).toBe('signature digest mismatch for request');
    expect(response.body).not.toHaveProperty('code');
    expect(handleConsentRequestMock).not.toHaveBeenCalled();
  });
});

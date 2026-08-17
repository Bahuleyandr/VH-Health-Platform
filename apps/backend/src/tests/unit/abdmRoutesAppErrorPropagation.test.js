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
//
// GET /my-abha (audit F12) uses the first shape, and is covered here for both
// tails plus the rule that a failed read must emit NO PHI-access record.

const TENANT = '00000000-0000-4000-8000-000000000001';

const handleConsentRequestMock = jest.fn();
const getPatientConsentsMock = jest.fn();
const grantConsentMock = jest.fn();
const getMyAbhaLinkageMock = jest.fn();
const logPhiAccessMock = jest.fn();
const verifySignedRequestMock = jest.fn();
const assertSharedReplayOnceMock = jest.fn();
const resolveInteropCredentialSnapshotMock = jest.fn();
const recordAuthenticatedAbdmCallbackMock = jest.fn();
const markAuthenticatedAbdmCallbackMock = jest.fn();

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
  resolveInteropCredentialSnapshot: resolveInteropCredentialSnapshotMock,
}));

// A module stub must mirror EVERY export the router's import graph reaches, or
// ESM fails the whole graph at load with "does not provide an export named X"
// and the suite reports 0 tests rather than a readable assertion failure.
// `requireTenantId` is reachable via utils/hipaaAudit.js (mocked just below);
// it is kept here so this stub stays faithful to the real module's surface.
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: TENANT,
  requireTenantId: (tenantId) => tenantId || TENANT,
}));

// Route-layer unit: keep the real HIPAA audit sink (Prisma + a setImmediate DB
// write) out of the graph, and make PHI logging observable.
jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: logPhiAccessMock,
}));

jest.unstable_mockModule('../../services/integrations/externalAbdmRecoveryService.js', () => ({
  recordAuthenticatedAbdmCallback: recordAuthenticatedAbdmCallbackMock,
  markAuthenticatedAbdmCallback: markAuthenticatedAbdmCallbackMock,
}));

jest.unstable_mockModule('../../services/abdm/abdmService.js', () => ({
  default: {
    handleConsentRequest: handleConsentRequestMock,
    handleDataRequest: jest.fn(),
    registerABHA: jest.fn(),
    getPatientByABHA: jest.fn(),
    getAdminStatus: jest.fn(),
    listConsentRequests: jest.fn(),
    getMyAbhaLinkage: getMyAbhaLinkageMock,
    getPatientConsents: getPatientConsentsMock,
    grantConsent: grantConsentMock,
    denyConsent: jest.fn(),
    revokeConsent: jest.fn(),
  },
}));

const { callbackRouter, patientRouter } = await import('../../routes/abdm/abdmRoutes.js');

const globalHandlerSpy = jest.fn();

const app = express();
app.use(express.json({ verify: (req, _res, body) => { req.abdmRawBody = Buffer.from(body); } }));
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
  getMyAbhaLinkageMock.mockReset();
  logPhiAccessMock.mockReset();
  verifySignedRequestMock.mockReset();
  assertSharedReplayOnceMock.mockReset();
  resolveInteropCredentialSnapshotMock.mockReset();
  recordAuthenticatedAbdmCallbackMock.mockReset();
  markAuthenticatedAbdmCallbackMock.mockReset();
  globalHandlerSpy.mockReset();
  // Callback auth defaults: no per-tenant secret row, so the configured
  // global HIP id path (DEFAULT tenant + config secret) authenticates.
  resolveInteropCredentialSnapshotMock.mockResolvedValue(null);
  verifySignedRequestMock.mockReturnValue(undefined);
  assertSharedReplayOnceMock.mockResolvedValue(true);
  recordAuthenticatedAbdmCallbackMock.mockResolvedValue({
    event: { id: '71', external_event_id: 'cr-9', status: 'pending' },
    duplicate: false,
  });
  markAuthenticatedAbdmCallbackMock.mockResolvedValue({ id: '71', status: 'processed' });
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

  test('my-abha isOperational guard relays code + details, and logs no PHI access', async () => {
    getMyAbhaLinkageMock.mockRejectedValueOnce(AppError.notFound(
      'Patient not found',
      'PATIENT_NOT_FOUND',
    ));

    const response = await request(app).get('/abdm/my-abha');

    expect(response.statusCode).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('PATIENT_NOT_FOUND');
    expect(globalHandlerSpy).not.toHaveBeenCalled();
    // A read that never returned linkage must not leave a PHI-access record.
    expect(logPhiAccessMock).not.toHaveBeenCalled();
  });

  test('my-abha non-AppError takes the logger + next(err) tail and leaks nothing', async () => {
    getMyAbhaLinkageMock.mockRejectedValueOnce(
      new Error("column users.abha_numberr does not exist"),
    );

    const response = await request(app).get('/abdm/my-abha');

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('handled-by-global-error-middleware');
    expect(JSON.stringify(response.body)).not.toMatch(/abha_numberr/);
    expect(globalHandlerSpy).toHaveBeenCalledTimes(1);
    expect(logPhiAccessMock).not.toHaveBeenCalled();
  });

  test('my-abha success records one PHI access for the caller only', async () => {
    getMyAbhaLinkageMock.mockResolvedValueOnce({
      linked: true,
      abhaNumber: '12345678901234',
      abhaAddress: 'patient@abdm',
    });

    const response = await request(app).get('/abdm/my-abha');

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toEqual({
      linked: true,
      abhaNumber: '12345678901234',
      abhaAddress: 'patient@abdm',
    });
    // Identity comes from the JWT subject — never a request parameter.
    expect(getMyAbhaLinkageMock).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.anything(),
    );
    expect(logPhiAccessMock).toHaveBeenCalledTimes(1);
    expect(logPhiAccessMock.mock.calls[0][0]).toMatchObject({
      userId: '11111111-1111-4111-8111-111111111111',
      patientId: '11111111-1111-4111-8111-111111111111',
      recordType: 'abha_linkage',
      action: 'VIEW',
    });
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
      .set('x-abdm-signature-version', 'v1')
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
      .set('x-abdm-signature-version', 'v1')
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
      .set('x-abdm-signature-version', 'v1')
      .send({ notification: { consentRequestId: 'cr-9' } });

    expect(response.statusCode).toBe(401);
    expect(response.body.message).toBe('signature digest mismatch for request');
    expect(response.body).not.toHaveProperty('code');
    expect(handleConsentRequestMock).not.toHaveBeenCalled();
  });
});

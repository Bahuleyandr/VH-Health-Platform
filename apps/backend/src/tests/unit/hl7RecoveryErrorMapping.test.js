import express from 'express';
import { jest } from '@jest/globals';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const RECOVERY = Object.freeze({ generation: 1 });
let mode = null;
const loggerMock = {
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};
const captureExceptionMock = jest.fn();
const resolveTenantBySender = jest.fn(async () => TENANT_ID);
const getInteropSecret = jest.fn(async () => 'error-map-secret');

const resolveInteropCredentialSnapshot = jest.fn(async () => {
  if (mode === 'credential-store') {
    throw AppError.internal(
      'Interop credential lookup is unavailable',
      'INTEROP_CREDENTIAL_LOOKUP_FAILED',
    );
  }
  return Object.freeze({
    id: '42',
    tenant_id: TENANT_ID,
    secret: 'error-map-secret',
  });
});
const verifySignedRequest = jest.fn(() => {
  if (mode === 'auth-invalid') {
    throw AppError.unauthorized('Invalid signature', 'HL7_INBOUND_SIGNATURE_INVALID');
  }
  return true;
});
const assertSharedReplayOnce = jest.fn(async () => {
  if (mode === 'replay-store') {
    throw new AppError(
      'HL7 inbound message replay store is unavailable',
      503,
      'HL7_INBOUND_REPLAY_STORE_UNAVAILABLE',
    );
  }
  return true;
});
const prepareHl7InboundRecoveryAuthentication = jest.fn(({ body }) => {
  if (mode === 'malformed') {
    throw AppError.badRequest(
      'Recovery request fields do not match the registered schema',
      'HL7_I03_RECOVERY_CONTRACT_INVALID',
    );
  }
  return Object.freeze({
    parsed: Object.freeze({
      msh: Object.freeze({
        messageType: 'ADT^A01',
        messageControlId: 'ERROR-MAP-I03',
        receivingFacility: 'ERROR-MAP-FACILITY',
      }),
    }),
    signedPayload: 'closed-i03-signed-payload',
    signingCredentialId: '42',
    tenantId: TENANT_ID,
    recovery: body.recovery,
    messageFamily: 'adt',
    generation: 1,
  });
});
const submitHl7InboundRecovery = jest.fn(async () => {
  throw new Error('submit must not run in error-mapping tests');
});

jest.unstable_mockModule('../../services/interop/tenantInteropSecretService.js', () => ({
  getInteropSecret,
  resolveInteropCredentialSnapshot,
  resolveTenantBySender,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('@sentry/node', () => ({ captureException: captureExceptionMock }));
jest.unstable_mockModule('../../utils/signedRequest.js', () => ({
  verifySignedRequest,
  assertSharedReplayOnce,
}));
jest.unstable_mockModule(
  '../../services/integrations/externalHl7InboundRecoveryService.js',
  () => ({
    assertEnvBackedHl7InboundLivePathAvailable: jest.fn(),
    assertHl7InboundLivePathAvailable: jest.fn(),
    prepareHl7InboundRecoveryAuthentication,
    submitHl7InboundRecovery,
  }),
);

const { default: hl7Routes } = await import('../../routes/hl7/hl7Routes.js');
const { errorHandlerMiddleware } = await import('../../middleware/errorHandlerMiddleware.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/hl7', hl7Routes);
  return app;
}

describe('I03 route error-to-ACK mapping', () => {
  const app = buildApp();

  beforeEach(() => {
    mode = null;
    resolveTenantBySender.mockClear();
    getInteropSecret.mockClear();
    resolveInteropCredentialSnapshot.mockClear();
    verifySignedRequest.mockClear();
    assertSharedReplayOnce.mockClear();
    prepareHl7InboundRecoveryAuthentication.mockClear();
    submitHl7InboundRecovery.mockClear();
    loggerMock.error.mockClear();
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
    captureExceptionMock.mockClear();
  });

  test.each([
    ['malformed', 400, 'AR'],
    ['auth-invalid', 401, 'AR'],
    ['credential-store', 500, 'AE'],
    ['replay-store', 503, 'AE'],
  ])('maps %s failure to HTTP %i with MSA %s', async (failureMode, status, ackCode) => {
    mode = failureMode;
    const response = await request(app)
      .post('/api/v1/hl7/receive')
      .set({
        'x-hl7-signature': 'sha256=deadbeef',
        'x-hl7-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-hl7-message-id': `error-map-${failureMode}`,
      })
      .send({ message: 'not persisted', recovery: RECOVERY });

    expect(response.status).toBe(status);
    expect(response.headers['content-type']).toContain('application/hl7-v2');
    expect(response.text).toContain(`MSA|${ackCode}`);
    expect(response.text).not.toContain(`MSA|${ackCode === 'AE' ? 'AR' : 'AE'}`);
    expect(submitHl7InboundRecovery).not.toHaveBeenCalled();
  });

  test('keeps legacy 5xx authenticity failures on AR and the baseline credential lookup', async () => {
    mode = 'replay-store';
    const message = 'MSH|^~\\&|EXT|SRC|VH|LEGACY-FACILITY|20260806103045+0530||ADT^A01|LEGACY-ERROR|P|2.5';
    const response = await request(app)
      .post('/api/v1/hl7/receive')
      .set({
        'x-hl7-signature': 'sha256=deadbeef',
        'x-hl7-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-hl7-message-id': 'legacy-error-map',
      })
      .send({ message });

    expect(response.status).toBe(503);
    expect(response.headers['content-type']).toContain('application/hl7-v2');
    expect(response.text).toContain('MSA|AR');
    expect(response.text).not.toContain('MSA|AE');
    expect(resolveTenantBySender).toHaveBeenCalledWith('hl7_inbound', 'LEGACY-FACILITY');
    expect(getInteropSecret).toHaveBeenCalledWith(TENANT_ID, 'hl7_inbound');
    expect(resolveInteropCredentialSnapshot).not.toHaveBeenCalled();
  });

  test.each([
    ['over 200 characters', 'r'.repeat(201)],
    ['embedded control character', 'recovery\tid'],
  ])('rejects a recovery request id with %s before replay or credential access', async (
    _label,
    requestId,
  ) => {
    const response = await request(app)
      .post('/api/v1/hl7/receive')
      .set({
        'x-hl7-signature': 'sha256=deadbeef',
        'x-hl7-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-hl7-message-id': requestId,
      })
      .send({ message: 'not persisted', recovery: RECOVERY });

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/hl7-v2');
    expect(response.text).toContain('MSA|AR');
    expect(resolveInteropCredentialSnapshot).not.toHaveBeenCalled();
    expect(verifySignedRequest).not.toHaveBeenCalled();
    expect(assertSharedReplayOnce).not.toHaveBeenCalled();
    expect(submitHl7InboundRecovery).not.toHaveBeenCalled();
  });

  test('keeps unmarked malformed HL7 on the legacy JSON error path', async () => {
    const sentinel = 'HL7-MALFORMED-PHI-SENTINEL';
    const parserApp = express();
    parserApp.use(express.json());
    parserApp.post('/api/v1/hl7/receive', (_req, res) => res.sendStatus(204));
    parserApp.use(errorHandlerMiddleware);

    const response = await request(parserApp)
      .post(`/api/v1/hl7/receive?patient=${sentinel}`)
      .set('content-type', 'application/json')
      .send(`{"message":"${sentinel}"`);

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toMatchObject({ success: false });
    expect(JSON.stringify(loggerMock.error.mock.calls)).not.toContain(sentinel);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  test('replaces a marked recovery 5xx before logging or sending it to Sentry', async () => {
    const sentinel = 'HL7-5XX-PHI-SENTINEL';
    const parserApp = express();
    parserApp.use('/api/v1/hl7/receive', (req, _res, next) => {
      req.hl7InboundRecoveryRequest = true;
      const error = new Error(`parser internals contained ${sentinel}`);
      error.status = 500;
      error.type = 'entity.parse.failed';
      next(error);
    });
    parserApp.use(errorHandlerMiddleware);

    const response = await request(parserApp)
      .post(`/api/v1/hl7/receive?patient=${sentinel}`)
      .send('ignored');

    expect(response.status).toBe(500);
    expect(response.headers['content-type']).toContain('application/hl7-v2');
    expect(response.text).toContain('MSA|AE');
    expect(JSON.stringify(loggerMock.error.mock.calls)).not.toContain(sentinel);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(captureExceptionMock.mock.calls[0][0].message).toBe('HL7 receive request failed with status 500');
  });
});

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the shared relayAppError port
// (mirrors paediatricImmunisationRoutesAppErrorPropagation.test.js).
//
// nhcxCallbackRoutes.js has two catch shapes this file pins:
//   * handleCallback's isOperational guard (R6) whose non-operational tail is
//     `logger.error + return next(err)` — the global handler / Sentry must
//     keep seeing programming errors on this gateway surface (R2);
//   * validateNHCXRequest's fail-closed auth catch (R5): AppError-shaped
//     errors relay code+details, while a bare Error keeps the historical
//     raw-message-at-401 wire behaviour exactly.

const TENANT = '00000000-0000-4000-8000-000000000001';

const verifySignedRequestMock = jest.fn();
const assertSharedReplayOnceMock = jest.fn();
const resolveTenantByNHCXParticipantCodeMock = jest.fn();
const getInteropSecretMock = jest.fn();
const processNHCXCallbackMock = jest.fn();

jest.unstable_mockModule('../../config/nhcxConfig.js', () => ({
  NHCX_CONFIG: { enabled: true },
}));

jest.unstable_mockModule('../../middleware/rateLimitMiddleware.js', () => ({
  genericLimiter: (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../../utils/signedRequest.js', () => ({
  verifySignedRequest: verifySignedRequestMock,
  assertSharedReplayOnce: assertSharedReplayOnceMock,
}));

jest.unstable_mockModule('../../services/nhcx/nhcxTenantConfigService.js', () => ({
  NHCX_SECRET_KINDS: { callbackSecret: 'nhcx_callback_secret' },
  resolveTenantByNHCXParticipantCode: resolveTenantByNHCXParticipantCodeMock,
}));

jest.unstable_mockModule('../../services/interop/tenantInteropSecretService.js', () => ({
  getInteropSecret: getInteropSecretMock,
}));

jest.unstable_mockModule('../../services/nhcx/nhcxInboundCallbackService.js', () => ({
  processNHCXCallback: processNHCXCallbackMock,
}));

const { callbackRouter } = await import('../../routes/nhcx/nhcxCallbackRoutes.js');

const globalHandlerSpy = jest.fn();

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  next();
});
app.use(callbackRouter);
// Trailing error middleware standing in for the global handler — the R2 tail
// (`logger.error + return next(err)`) must still reach it after the port.
app.use((err, _req, res, _next) => {
  globalHandlerSpy(err);
  res.status(500).json({ success: false, message: 'handled-by-global-error-middleware' });
});

function postCallback() {
  return request(app)
    .post('/preauth/on_submit')
    .set('x-hcx-recipient_code', 'VH-NHCX-PROVIDER')
    .set('x-nhcx-signature', 'a'.repeat(64))
    .set('x-hcx-timestamp', '1718800000000')
    .set('x-hcx-request-id', 'nhcx-request-1')
    .send({ payload: 'compact-jwe' });
}

beforeEach(() => {
  verifySignedRequestMock.mockReset();
  assertSharedReplayOnceMock.mockReset();
  resolveTenantByNHCXParticipantCodeMock.mockReset();
  getInteropSecretMock.mockReset();
  processNHCXCallbackMock.mockReset();
  globalHandlerSpy.mockReset();
  resolveTenantByNHCXParticipantCodeMock.mockResolvedValue(TENANT);
  getInteropSecretMock.mockResolvedValue('tenant-callback-secret');
  verifySignedRequestMock.mockReturnValue(undefined);
  assertSharedReplayOnceMock.mockResolvedValue(true);
});

describe('nhcxCallbackRoutes relays AppError code + details through relayAppError', () => {
  test('handleCallback isOperational guard forwards code and details over HTTP', async () => {
    processNHCXCallbackMock.mockRejectedValueOnce(AppError.conflict(
      'NHCX envelope correlation id already processed',
      'NHCX_DUPLICATE_CORRELATION',
      { reason: 'x' },
    ));

    const response = await postCallback();

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('NHCX envelope correlation id already processed');
    expect(response.body.code).toBe('NHCX_DUPLICATE_CORRELATION');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
    expect(globalHandlerSpy).not.toHaveBeenCalled();
  });

  test('non-AppError keeps the byte-identical logger + next(err) tail (R2 gateway surface)', async () => {
    processNHCXCallbackMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'envelope_id')"),
    );

    const response = await postCallback();

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('handled-by-global-error-middleware');
    expect(JSON.stringify(response.body)).not.toMatch(/envelope_id/);
    expect(globalHandlerSpy).toHaveBeenCalledTimes(1);
    expect(globalHandlerSpy.mock.calls[0][0].message)
      .toBe("Cannot read properties of undefined (reading 'envelope_id')");
  });

  test('R5 auth catch: AppError-shaped rejection relays status + code + details', async () => {
    assertSharedReplayOnceMock.mockRejectedValueOnce(new AppError(
      'NHCX callback request replay detected',
      401,
      'NHCX_CALLBACK_REPLAY',
      { requestId: 'nhcx-request-1' },
    ));

    const response = await postCallback();

    expect(response.statusCode).toBe(401);
    expect(response.body.code).toBe('NHCX_CALLBACK_REPLAY');
    expect(response.body.details).toEqual({ requestId: 'nhcx-request-1' });
    expect(processNHCXCallbackMock).not.toHaveBeenCalled();
  });

  test('R5 auth catch: bare Error keeps the fail-closed raw-message-at-401 wire behaviour', async () => {
    verifySignedRequestMock.mockImplementationOnce(() => {
      throw new Error('signature digest mismatch for request');
    });

    const response = await postCallback();

    expect(response.statusCode).toBe(401);
    expect(response.body.message).toBe('signature digest mismatch for request');
    expect(response.body).not.toHaveProperty('code');
    expect(processNHCXCallbackMock).not.toHaveBeenCalled();
  });
});

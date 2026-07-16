import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port (wrap-sweep).
//
// resuscitationRoutes.js wraps every handler in a local `wrap()` whose catch
// used to call `error(res, err.message, err.statusCode)` with no 4th arg —
// dropping `err.code` and `err.details` from the documented envelope
// { success, message, code, details } (apps/backend/CLAUDE.md). The port
// delegates to responseHelper.relayAppError, preserving this file's generic
// 500 message. These tests drive the endpoints over HTTP (supertest) and
// assert the response body itself.

const createResuscitationEventMock = jest.fn();
const listResuscitationEventsMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/resuscitationEventService.js', () => ({
  createResuscitationEvent: createResuscitationEventMock,
  listResuscitationEvents: listResuscitationEventsMock,
}));

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuardForResource: () => (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: resuscitationRoutes } = await import('../../routes/clinical/resuscitationRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'NURSING_STAFF' };
  next();
});
app.use('/api/v1/resuscitation', resuscitationRoutes);

beforeEach(() => {
  createResuscitationEventMock.mockReset();
  listResuscitationEventsMock.mockReset();
});

describe('resuscitation route wrap() surfaces AppError code + details', () => {
  test('an AppError carrying code + details forwards both (envelope contract)', async () => {
    createResuscitationEventMock.mockRejectedValueOnce(AppError.conflict(
      'An active resuscitation event already exists for this patient',
      'RESUSCITATION_EVENT_ALREADY_ACTIVE',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/resuscitation/events')
      .send({ patient_uid: '22222222-2222-4222-8222-222222222222', reason: 'cardiac arrest' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('An active resuscitation event already exists for this patient');
    expect(response.body.code).toBe('RESUSCITATION_EVENT_ALREADY_ACTIVE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    listResuscitationEventsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'started_at')"),
    );

    const response = await request(app)
      .get('/api/v1/resuscitation/events/recent');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('An internal server error occurred. Please try again later.');
    expect(response.body.message).not.toMatch(/started_at/);
  });
});

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — the staff-messaging member of the
// relayAppError sweep (paediatricImmunisationRoutesAppErrorPropagation twin).
//
// staffMessagingRoutes.js wraps every handler in a local `wrap()` whose catch
// branch used to call `error(res, err.message, err.statusCode)` with no 4th
// arg — dropping `err.code` and `err.details` — and, for non-AppErrors,
// relayed `err.message || 'Messaging error'`, which leaks internals on
// non-prod deployments (sanitize only genericises 5xx in production). The
// wrap is ported to responseHelper.relayAppError; these tests drive the
// endpoints over HTTP (supertest) and assert the response body itself.

const listStaffInboxMock = jest.fn();
const appendMessageMock = jest.fn();

jest.unstable_mockModule('../../services/portal/patientPortalService.js', () => ({
  listStaffInbox: listStaffInboxMock,
  getThread: jest.fn(async () => ({})),
  appendMessage: appendMessageMock,
  assignThread: jest.fn(async () => ({})),
  setThreadStatus: jest.fn(async () => ({})),
  markThreadRead: jest.fn(async () => ({})),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: staffMessagingRoutes } = await import('../../routes/portal/staffMessagingRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  // requireStaffOrAdmin gate: any ALL_STAFF_ROLES member passes.
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'NURSING_STAFF' };
  next();
});
app.use('/api/v1/staff-messaging', staffMessagingRoutes);

beforeEach(() => {
  listStaffInboxMock.mockReset();
  appendMessageMock.mockReset();
});

describe('staff messaging wrap() surfaces AppError code + details', () => {
  test('an AppError carrying code + details forwards both (envelope contract)', async () => {
    appendMessageMock.mockRejectedValueOnce(AppError.conflict(
      'Thread is closed and cannot accept replies',
      'PORTAL_MESSAGE_THREAD_CLOSED',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/staff-messaging/threads/12/reply')
      .send({ body: 'Please re-check the dosage question' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Thread is closed and cannot accept replies');
    // The bug: these assertions FAIL on the unmodified wrap (both dropped).
    expect(response.body.code).toBe('PORTAL_MESSAGE_THREAD_CLOSED');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // The old branch relayed `err.message || 'Messaging error'` — sanitize
    // only genericises 5xx in production, so that leaked on test/staging.
    listStaffInboxMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'thread_rows')"),
    );

    const response = await request(app).get('/api/v1/staff-messaging/inbox');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Messaging error');
    expect(response.body.message).not.toMatch(/thread_rows/);
    expect(response.body).not.toHaveProperty('details');
  });
});

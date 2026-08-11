// src/tests/unit/notificationOutboxRoutes.test.js
//
// F7/F11 + R3 (audit 2026-08-10) — admin recovery surface over
// notification_outbox dead letters and the per-channel delivery cursors.
// Mirrors outboxRecoveryRoutes.test.js: only server-derived tenant / actor /
// request provenance may reach the services; client-supplied identity fields
// are ignored.
import { readFileSync } from 'node:fs';

import express from 'express';
import { jest } from '@jest/globals';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';

const listRowsMock = jest.fn();
const reconcileAttemptMock = jest.fn();
const replayRowMock = jest.fn();
const listCursorsMock = jest.fn();
const resetCursorMock = jest.fn();
const phiAccessMiddlewareMock = jest.fn((_req, _res, next) => next());
const phiAccessLoggerMock = jest.fn(() => phiAccessMiddlewareMock);

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  phiAccessLogger: phiAccessLoggerMock,
}));
jest.unstable_mockModule('../../services/notification/notificationOutboxAdminService.js', () => ({
  listNotificationOutboxRows: listRowsMock,
  reconcileNotificationOutboxAttempt: reconcileAttemptMock,
  replayNotificationOutboxRow: replayRowMock,
}));
jest.unstable_mockModule('../../services/notification/notificationDeliveryLedgerService.js', () => ({
  listChannelCursors: listCursorsMock,
  resetChannelCursor: resetCursorMock,
}));

const { default: notificationOutboxRoutes } = await import('../../routes/admin/notificationOutboxRoutes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT;
    req.user = { uid: ACTOR, role: 'ADMIN', rawRole: 'super_admin' };
    req.id = 'server-request-id';
    next();
  });
  app.use('/notification-outbox', notificationOutboxRoutes);
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ code: error.code, message: error.message });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  listRowsMock.mockResolvedValue([]);
  replayRowMock.mockResolvedValue({ mode: 'retry_reset', row: { id: 7, status: 'FAILED' }, replacement_id: null });
  reconcileAttemptMock.mockResolvedValue({ fully_reconciled: true });
  listCursorsMock.mockResolvedValue([]);
  resetCursorMock.mockResolvedValue({ channel: 'push', state: 'ready' });
});

describe('notification outbox recovery admin routes', () => {
  test('tenant-scopes the dead-letter listing and attaches PHI access logging', async () => {
    const response = await request(buildApp())
      .get('/notification-outbox')
      .query({ status: 'RECONCILIATION_REQUIRED', limit: '25', offset: '5' });
    expect(response.status).toBe(200);
    expect(listRowsMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      status: 'RECONCILIATION_REQUIRED',
      limit: '25',
      offset: '5',
    });
    expect(phiAccessMiddlewareMock).toHaveBeenCalledTimes(1);
    const source = readFileSync(
      new URL('../../routes/admin/notificationOutboxRoutes.js', import.meta.url),
      'utf8',
    );
    expect(source).toContain("phiAccessLogger('NOTIFICATION_OUTBOX')");
  });

  test('replay passes only server-derived tenant, actor, role, and request provenance', async () => {
    const response = await request(buildApp())
      .post('/notification-outbox/41/replay')
      .send({
        reason: 'Reviewed the dead letter',
        actor_uid: '22222222-2222-4222-8222-222222222222',
        actor_role: 'DOCTOR',
        tenant_id: '33333333-3333-4333-8333-333333333333',
      });
    expect(response.status).toBe(200);
    expect(replayRowMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      id: '41',
      reason: 'Reviewed the dead letter',
      actorUid: ACTOR,
      actorRole: 'SUPER_ADMIN',
      requestId: 'server-request-id',
    });
  });

  test('cursor listing is tenant-scoped', async () => {
    const response = await request(buildApp()).get('/notification-outbox/cursors');
    expect(response.status).toBe(200);
    expect(listCursorsMock).toHaveBeenCalledWith({ tenantId: TENANT });
  });

  test('provider acceptance evidence uses the server actor and exact attempt', async () => {
    const response = await request(buildApp())
      .post('/notification-outbox/41/reconcile')
      .send({
        attempt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        provider_reference: 'provider-message-41',
        evidence: { support_case: 'CASE-41' },
        reason: 'Provider confirmed acceptance',
        actor_uid: '22222222-2222-4222-8222-222222222222',
        tenant_id: '33333333-3333-4333-8333-333333333333',
      });
    expect(response.status).toBe(200);
    expect(reconcileAttemptMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      id: '41',
      attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      providerReference: 'provider-message-41',
      evidence: { support_case: 'CASE-41' },
      reason: 'Provider confirmed acceptance',
      actorUid: ACTOR,
      actorRole: 'SUPER_ADMIN',
      requestId: 'server-request-id',
    });
  });

  test('cursor reset threads the required reason and server actor', async () => {
    const response = await request(buildApp())
      .post('/notification-outbox/cursors/push/reset')
      .send({ reason: 'Provider outage resolved' });
    expect(response.status).toBe(200);
    expect(resetCursorMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      channel: 'push',
      reason: 'Provider outage resolved',
      actorUid: ACTOR,
      actorRole: 'SUPER_ADMIN',
      requestId: 'server-request-id',
    });
  });
});

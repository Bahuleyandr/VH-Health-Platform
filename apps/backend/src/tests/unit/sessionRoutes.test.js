import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Route coverage for src/routes/sessionRoutes.js — the self-service session
// list/revoke surface mounted at /api/v1/sessions (app.js). It had ZERO tests
// (audit follow-up P12), which is how DELETE /:jti came to answer 200 for a
// revocation that never persisted.
//
// The service layer is mocked here; sessionManagementRevocation.test.js covers
// the other side of that boundary (real expiry passed to blacklistToken, and a
// refusing store producing a failure instead of a silent no-op).

const SESSION_REVOKE_FAILURE = Object.freeze({
  NOT_FOUND: 'SESSION_NOT_FOUND',
  STORE_UNAVAILABLE: 'REVOCATION_STORE_UNAVAILABLE',
  REGISTRY_INCOMPLETE: 'SESSION_REGISTRY_INCOMPLETE',
});

const listActiveSessionsMock = jest.fn();
const revokeSessionMock = jest.fn();
const revokeAllOtherSessionsMock = jest.fn();

jest.unstable_mockModule('../../services/sessionManagementService.js', () => ({
  listActiveSessions: listActiveSessionsMock,
  revokeSession: revokeSessionMock,
  revokeAllOtherSessions: revokeAllOtherSessionsMock,
  SESSION_REVOKE_FAILURE,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const { default: sessionRoutes } = await import('../../routes/sessionRoutes.js');

const UID = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_UID = '550e8400-e29b-41d4-a716-446655440002';
const JTI = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const TOKEN_EXPIRES_AT = '2026-08-09T12:00:00.000Z';

// Reassigned per test so the same app can exercise authenticated and
// unauthenticated branches. sessionRoutes reads req.user directly — it does
// not mount jwtMiddleware, so there is nothing to stub there.
let currentUser;
let currentActing;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = currentUser;
  req.acting = currentActing;
  next();
});
app.use('/api/v1/sessions', sessionRoutes);

beforeEach(() => {
  currentUser = { uid: UID, role: 'PATIENT', jti: JTI, tokenExpiresAt: TOKEN_EXPIRES_AT };
  currentActing = undefined;
  listActiveSessionsMock.mockReset();
  revokeSessionMock.mockReset();
  revokeAllOtherSessionsMock.mockReset();
});

describe('GET /api/v1/sessions', () => {
  it('returns the caller\'s sessions scoped to their own uid', async () => {
    const sessions = [{ id: 1, jti: JTI, is_active: true }];
    listActiveSessionsMock.mockResolvedValue({
      sessions,
      complete: false,
      coverage: 'current_token_and_latest_registry_row',
    });

    const response = await request(app).get('/api/v1/sessions');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.sessions).toEqual(sessions);
    expect(response.body.data.complete).toBe(false);
    // The uid comes from the verified token, never from user input, and the
    // caller's own token claims ride along so its session is always reportable.
    expect(listActiveSessionsMock).toHaveBeenCalledWith(UID, {
      jti: JTI,
      expiresAt: TOKEN_EXPIRES_AT,
    });
  });

  it('rejects an unauthenticated caller', async () => {
    currentUser = undefined;

    const response = await request(app).get('/api/v1/sessions');

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
    expect(listActiveSessionsMock).not.toHaveBeenCalled();
  });

  it('scopes an acting-as request to the JWT bearer, not the dependent', async () => {
    currentUser = { ...currentUser, uid: OTHER_UID };
    currentActing = { actorUid: UID };
    listActiveSessionsMock.mockResolvedValue({
      sessions: [],
      complete: false,
      coverage: 'current_token_and_latest_registry_row',
    });

    await request(app).get('/api/v1/sessions');

    expect(listActiveSessionsMock).toHaveBeenCalledWith(UID, {
      jti: JTI,
      expiresAt: TOKEN_EXPIRES_AT,
    });
  });

  it('reports a listing failure as an error, not an empty session list', async () => {
    // An empty list is a different CLAIM from a failed read — it says the
    // caller has no sessions. The service throws so this cannot be conflated.
    listActiveSessionsMock.mockRejectedValue(new Error('db down'));

    const response = await request(app).get('/api/v1/sessions');

    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
  });
});

describe('DELETE /api/v1/sessions/:jti', () => {
  it('revokes the caller\'s own session', async () => {
    revokeSessionMock.mockResolvedValue({ success: true, message: 'Session revoked successfully' });

    const response = await request(app).delete(`/api/v1/sessions/${JTI}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(revokeSessionMock).toHaveBeenCalledWith(UID, JTI, {
      jti: JTI,
      expiresAt: TOKEN_EXPIRES_AT,
    });
  });

  it('answers 503 — NOT 200 — when no revocation store accepted the write', async () => {
    // The regression this whole packet exists for: the endpoint used to report
    // success while nothing was persisted, so the token stayed live for its
    // full lifetime after the client had been told it was dead.
    revokeSessionMock.mockResolvedValue({
      success: false,
      code: SESSION_REVOKE_FAILURE.STORE_UNAVAILABLE,
      message: 'Failed to revoke session',
    });

    const response = await request(app).delete(`/api/v1/sessions/${JTI}`);

    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
    expect(response.body.details?.code).toBe(SESSION_REVOKE_FAILURE.STORE_UNAVAILABLE);
  });

  it('answers 404 when the jti is not one of the caller\'s sessions', async () => {
    // Another user's jti is indistinguishable from a nonexistent one by design
    // — the service scopes its lookup by user_id, so this is the IDOR boundary.
    revokeSessionMock.mockResolvedValue({
      success: false,
      code: SESSION_REVOKE_FAILURE.NOT_FOUND,
      message: 'Session not found or access denied',
    });

    const response = await request(app).delete(`/api/v1/sessions/${JTI}`);

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
  });

  it('never reaches the service for an unauthenticated caller', async () => {
    currentUser = {};

    const response = await request(app).delete(`/api/v1/sessions/${JTI}`);

    expect(response.status).toBe(401);
    expect(revokeSessionMock).not.toHaveBeenCalled();
  });

  it('passes the caller uid, not a caller-supplied identity, to the service', async () => {
    revokeSessionMock.mockResolvedValue({ success: true, message: 'ok' });

    await request(app)
      .delete(`/api/v1/sessions/${JTI}`)
      .send({ userId: OTHER_UID });

    expect(revokeSessionMock).toHaveBeenCalledWith(UID, JTI, expect.any(Object));
  });

  it('cannot attribute the bearer token to an acting-as dependent', async () => {
    currentUser = { ...currentUser, uid: OTHER_UID };
    currentActing = { actorUid: UID };
    revokeSessionMock.mockResolvedValue({ success: true, message: 'ok' });

    await request(app).delete(`/api/v1/sessions/${JTI}`);

    expect(revokeSessionMock).toHaveBeenCalledWith(UID, JTI, expect.any(Object));
  });

  it('reports an unexpected service throw as an error', async () => {
    revokeSessionMock.mockRejectedValue(new Error('boom'));

    const response = await request(app).delete(`/api/v1/sessions/${JTI}`);

    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
  });
});

describe('POST /api/v1/sessions/revoke-all', () => {
  it('returns 501 instead of claiming every session was discoverable', async () => {
    revokeAllOtherSessionsMock.mockResolvedValue({
      success: false,
      code: SESSION_REVOKE_FAILURE.REGISTRY_INCOMPLETE,
      revokedCount: 0,
      failedCount: null,
    });

    const response = await request(app).post('/api/v1/sessions/revoke-all');

    expect(response.status).toBe(501);
    expect(response.body.success).toBe(false);
    expect(response.body.details?.code).toBe(SESSION_REVOKE_FAILURE.REGISTRY_INCOMPLETE);
    expect(revokeAllOtherSessionsMock).toHaveBeenCalledWith(UID, JTI);
  });

  it('reports a partial revocation as a failure with the real counts', async () => {
    revokeAllOtherSessionsMock.mockResolvedValue({
      success: false,
      code: SESSION_REVOKE_FAILURE.STORE_UNAVAILABLE,
      revokedCount: 1,
      failedCount: 2,
    });

    const response = await request(app).post('/api/v1/sessions/revoke-all');

    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
    expect(response.body.details?.revokedCount).toBe(1);
    expect(response.body.details?.failedCount).toBe(2);
  });

  it('rejects an unauthenticated caller', async () => {
    currentUser = undefined;

    const response = await request(app).post('/api/v1/sessions/revoke-all');

    expect(response.status).toBe(401);
    expect(revokeAllOtherSessionsMock).not.toHaveBeenCalled();
  });

  it('scopes bulk session handling to the JWT bearer during acting-as', async () => {
    currentUser = { ...currentUser, uid: OTHER_UID };
    currentActing = { actorUid: UID };
    revokeAllOtherSessionsMock.mockResolvedValue({
      success: false,
      code: SESSION_REVOKE_FAILURE.REGISTRY_INCOMPLETE,
      revokedCount: 0,
      failedCount: null,
    });

    await request(app).post('/api/v1/sessions/revoke-all');

    expect(revokeAllOtherSessionsMock).toHaveBeenCalledWith(UID, JTI);
  });
});

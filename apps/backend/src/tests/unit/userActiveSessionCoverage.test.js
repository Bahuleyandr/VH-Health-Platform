// src/tests/unit/userActiveSessionCoverage.test.js
//
// Coverage-focused unit suite for userActiveSession (roadmap B3.2). Companion to
// src/tests/unit/userActiveSession.test.js, which covers the happy claimUserSession
// matrix (normal login, refresh rotation, strict single-session, tablet device).
// This file drives the previously-uncovered surface:
//   - claimUserSession: the required-args guard, the prior-lookup catch, the
//     blacklistToken fail-closed branch, the revocation-push catch, the upsert
//     catch, and the "no prior row" branch.
//   - getUserSessionDeviceType: no-uid short-circuit, row hit, empty result, and
//     the catch branch.
//   - dropUserSession: no-uid short-circuit, success, and the catch branch.
//
// Fully mocked prisma ($queryRawUnsafe + $executeRawUnsafe), tokenBlacklist, and
// wsServer. No DB / network. Mirrors userActiveSession.test.js's mock shape.

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const blacklistTokenMock = jest.fn();
const pushSessionRevokedMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  isSubjectDelegationRevoked: jest.fn().mockResolvedValue(false),
  blacklistToken: blacklistTokenMock,
}));
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  pushSessionRevoked: pushSessionRevokedMock,
}));

const {
  claimUserSession,
  getUserSessionDeviceType,
  dropUserSession,
} = await import('../../services/auth/userActiveSession.js');

const USER_UID = '11111111-1111-4111-8111-111111111111';
const EXPIRES_AT = new Date('2026-05-16T20:00:00.000Z');
const PRIOR = { jti: 'prior-jti', device_type: 'web', expires_at_unix: 1_779_000_000 };

beforeEach(() => {
  delete process.env.AUTH_ENFORCE_SINGLE_ACTIVE_SESSION;
  delete process.env.ENFORCE_SINGLE_ACTIVE_SESSION;
  queryRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockReset();
  blacklistTokenMock.mockReset();
  pushSessionRevokedMock.mockReset();
  queryRawUnsafeMock.mockResolvedValue([PRIOR]);
  executeRawUnsafeMock.mockResolvedValue(1);
});

// =====================================================================
// claimUserSession — guards + degraded branches
// =====================================================================
describe('claimUserSession — required-args guard', () => {
  it('throws when a required arg is missing', async () => {
    await expect(claimUserSession({ userUid: USER_UID, jti: 'j', deviceType: 'web' }))
      .rejects.toThrow(/userUid, jti, deviceType, expiresAt are required/);
  });
});

describe('claimUserSession — degraded branches', () => {
  it('fails closed when refresh rotation cannot inspect the prior session', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('read failed'));
    await expect(claimUserSession({
      userUid: USER_UID, jti: 'new-jti', deviceType: 'web', expiresAt: EXPIRES_AT, pushRevoked: false,
    })).rejects.toThrow('read failed');
    expect(blacklistTokenMock).not.toHaveBeenCalled();
    expect(pushSessionRevokedMock).not.toHaveBeenCalled();
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('fails closed when strict login cannot inspect the prior session', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('read failed'));
    await expect(claimUserSession({
      userUid: USER_UID,
      jti: 'new-jti',
      deviceType: 'web',
      expiresAt: EXPIRES_AT,
      pushRevoked: true,
      enforceSingleSession: true,
    })).rejects.toThrow('read failed');
    expect(blacklistTokenMock).not.toHaveBeenCalled();
    expect(pushSessionRevokedMock).not.toHaveBeenCalled();
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('preserves non-strict normal-login availability when the prior lookup fails', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('read failed'));
    const result = await claimUserSession({
      userUid: USER_UID,
      jti: 'new-jti',
      deviceType: 'web',
      expiresAt: EXPIRES_AT,
      pushRevoked: true,
      enforceSingleSession: false,
    });
    expect(result.revokedPrior).toBe(false);
    expect(result.priorDeviceType).toBeNull();
    expect(executeRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('does not revoke when there is no prior session row', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]); // no prior
    const result = await claimUserSession({
      userUid: USER_UID, jti: 'new-jti', deviceType: 'web', expiresAt: EXPIRES_AT, pushRevoked: false,
    });
    expect(result.revokedPrior).toBe(false);
    expect(blacklistTokenMock).not.toHaveBeenCalled();
  });

  it('fails closed before publishing or claiming the new session when durable revocation fails', async () => {
    blacklistTokenMock.mockRejectedValueOnce(new Error('redis and database down'));
    await expect(claimUserSession({
      userUid: USER_UID, jti: 'strict-jti', deviceType: 'web', expiresAt: EXPIRES_AT,
      pushRevoked: true, enforceSingleSession: true,
    })).rejects.toThrow('redis and database down');
    expect(blacklistTokenMock).toHaveBeenCalledWith(
      'prior-jti',
      PRIOR.expires_at_unix,
      'replaced_by_new_login',
      expect.objectContaining({ requireEvidence: true, userId: USER_UID }),
    );
    expect(pushSessionRevokedMock).not.toHaveBeenCalled();
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('swallows a pushSessionRevoked failure after durable strict-session revocation', async () => {
    process.env.AUTH_ENFORCE_SINGLE_ACTIVE_SESSION = 'true';
    pushSessionRevokedMock.mockImplementationOnce(() => { throw new Error('ws closed'); });
    const result = await claimUserSession({
      userUid: USER_UID, jti: 'strict-jti', deviceType: 'mobile', expiresAt: EXPIRES_AT, pushRevoked: true,
    });
    expect(result.revokedPrior).toBe(true);
    expect(blacklistTokenMock).toHaveBeenCalledWith(
      'prior-jti',
      PRIOR.expires_at_unix,
      'replaced_by_new_login',
      expect.objectContaining({ requireEvidence: true, userId: USER_UID }),
    );
    expect(pushSessionRevokedMock).toHaveBeenCalled();
  });

  it('logs but does not throw when the session upsert fails', async () => {
    executeRawUnsafeMock.mockRejectedValueOnce(new Error('insert failed'));
    const result = await claimUserSession({
      userUid: USER_UID, jti: 'new-jti', deviceType: 'web', expiresAt: EXPIRES_AT, pushRevoked: true,
    });
    // Upsert failure is non-fatal; the call still resolves with the revoke verdict.
    expect(result.revokedPrior).toBe(false);
  });
});

// =====================================================================
// getUserSessionDeviceType
// =====================================================================
describe('getUserSessionDeviceType', () => {
  it('returns null immediately when no uid is given', async () => {
    expect(await getUserSessionDeviceType(null)).toBeNull();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('returns the recorded device_type when a row exists', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ device_type: 'tablet' }]);
    expect(await getUserSessionDeviceType(USER_UID)).toBe('tablet');
  });

  it('returns null when the row has a null device_type', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ device_type: null }]);
    expect(await getUserSessionDeviceType(USER_UID)).toBeNull();
  });

  it('returns null when no row matches', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    expect(await getUserSessionDeviceType(USER_UID)).toBeNull();
  });

  it('returns null and swallows a DB error', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('db down'));
    expect(await getUserSessionDeviceType(USER_UID)).toBeNull();
  });
});

// =====================================================================
// dropUserSession
// =====================================================================
describe('dropUserSession', () => {
  it('no-ops when no uid is given', async () => {
    await dropUserSession(null);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('deletes the active-session row for the uid', async () => {
    await dropUserSession(USER_UID);
    expect(executeRawUnsafeMock).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM user_active_sessions'),
      USER_UID,
    );
  });

  it('swallows a DB error (never throws)', async () => {
    executeRawUnsafeMock.mockRejectedValueOnce(new Error('delete failed'));
    await expect(dropUserSession(USER_UID)).resolves.toBeUndefined();
  });
});

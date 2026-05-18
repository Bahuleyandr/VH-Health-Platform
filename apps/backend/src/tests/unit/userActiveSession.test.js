import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const blacklistTokenMock = jest.fn();
const sendToUserMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
    $executeRawUnsafe: executeRawUnsafeMock,
  },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  blacklistToken: blacklistTokenMock,
}));
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  sendToUser: sendToUserMock,
}));

const { claimUserSession } = await import('../../services/auth/userActiveSession.js');

const USER_UID = '11111111-1111-4111-8111-111111111111';
const EXPIRES_AT = new Date('2026-05-16T20:00:00.000Z');
const PRIOR = {
  jti: 'prior-jti',
  device_type: 'web',
  expires_at_unix: 1_779_000_000,
};

beforeEach(() => {
  delete process.env.AUTH_ENFORCE_SINGLE_ACTIVE_SESSION;
  delete process.env.ENFORCE_SINGLE_ACTIVE_SESSION;
  queryRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockReset();
  blacklistTokenMock.mockReset();
  sendToUserMock.mockReset();
  queryRawUnsafeMock.mockResolvedValue([PRIOR]);
  executeRawUnsafeMock.mockResolvedValue(1);
});

describe('claimUserSession', () => {
  it('tracks normal new logins without revoking the prior access token by default', async () => {
    const result = await claimUserSession({
      userUid: USER_UID,
      jti: 'new-jti',
      deviceType: 'web',
      expiresAt: EXPIRES_AT,
      pushRevoked: true,
    });

    expect(result.revokedPrior).toBe(false);
    expect(blacklistTokenMock).not.toHaveBeenCalled();
    expect(sendToUserMock).not.toHaveBeenCalled();
    expect(executeRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('still blacklists the prior token during refresh-token rotation', async () => {
    const result = await claimUserSession({
      userUid: USER_UID,
      jti: 'refresh-jti',
      deviceType: 'web',
      expiresAt: EXPIRES_AT,
      pushRevoked: false,
    });

    expect(result.revokedPrior).toBe(true);
    expect(blacklistTokenMock).toHaveBeenCalledWith('prior-jti', PRIOR.expires_at_unix, 'refresh_rotation');
    expect(sendToUserMock).not.toHaveBeenCalled();
  });

  it('can enforce strict single-session revocation when explicitly configured', async () => {
    process.env.AUTH_ENFORCE_SINGLE_ACTIVE_SESSION = 'true';

    const result = await claimUserSession({
      userUid: USER_UID,
      jti: 'strict-jti',
      deviceType: 'mobile',
      expiresAt: EXPIRES_AT,
      pushRevoked: true,
    });

    expect(result.revokedPrior).toBe(true);
    expect(blacklistTokenMock).toHaveBeenCalledWith('prior-jti', PRIOR.expires_at_unix, 'replaced_by_new_login');
    expect(sendToUserMock).toHaveBeenCalledWith(USER_UID, 'session:revoked', expect.objectContaining({
      reason: 'new_login_elsewhere',
      newDeviceType: 'mobile',
      priorDeviceType: 'web',
    }));
  });
});

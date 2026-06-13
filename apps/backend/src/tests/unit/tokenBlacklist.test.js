import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const cacheGetMock = jest.fn();
const cacheSetMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryRawUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));
jest.unstable_mockModule('../../lib/redis.js', () => ({
  cacheGet: cacheGetMock,
  cacheSet: cacheSetMock,
  isRedisConnected: () => false,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { isUserTokensRevoked, revokeAllUserTokens } = await import('../../utils/tokenBlacklist.js');

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  cacheGetMock.mockReset();
  cacheSetMock.mockReset();
});

describe('tokenBlacklist revoke-all fallback', () => {
  it('checks the DB revoke marker against the token iat watermark', async () => {
    cacheGetMock.mockResolvedValueOnce(null);
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    const revoked = await isUserTokensRevoked('42', 1234);

    expect(revoked).toBe(false);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/created_at\s*>\s*to_timestamp\(\$2\)/);
    expect(queryRawUnsafeMock.mock.calls[0][1]).toBe('user:42');
    expect(queryRawUnsafeMock.mock.calls[0][2]).toBe(1234);
  });

  it('treats a DB marker newer than token iat as revoked', async () => {
    cacheGetMock.mockResolvedValueOnce(null);
    queryRawUnsafeMock.mockResolvedValueOnce([{ '?column?': 1 }]);

    await expect(isUserTokensRevoked('42', 1234)).resolves.toBe(true);
  });

  it('refreshes the persistent revoke-all watermark on repeated revokes', async () => {
    const originalSetImmediate = global.setImmediate;
    global.setImmediate = (callback) => {
      callback();
      return null;
    };
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    try {
      await revokeAllUserTokens('42');
    } finally {
      global.setImmediate = originalSetImmediate;
    }

    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/created_at\s*=\s*EXCLUDED\.created_at/);
  });
});

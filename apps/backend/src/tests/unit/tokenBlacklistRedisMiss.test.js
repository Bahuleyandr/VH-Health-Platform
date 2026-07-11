// Regression guard for Sol Ultra audit #29: with Redis connected, a cache MISS
// on the per-token blacklist key returned false immediately — treating absence
// in Redis as proof the token is not revoked. A key that was evicted or lost to
// a Redis flush, while the durable invalidated_tokens row still stood, therefore
// let a revoked token authenticate. Redis must be a positive cache only: a miss
// must fall through to the authoritative Postgres query.
import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const cacheGetMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryRawUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_t, fn) => fn(__prismaDefaultMock),
  setTenant: async (_t, fn) => fn(__prismaDefaultMock),
}));
jest.unstable_mockModule('../../lib/redis.js', () => ({
  cacheGet: cacheGetMock,
  cacheSet: jest.fn(),
  isRedisConnected: () => true, // Redis is UP for these cases
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { isTokenBlacklisted } = await import('../../utils/tokenBlacklist.js');

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  cacheGetMock.mockReset();
});

describe('isTokenBlacklisted Redis-miss fall-through (Sol Ultra #29)', () => {
  it('a Redis MISS falls through to the DB and rejects a DB-revoked token', async () => {
    cacheGetMock.mockResolvedValueOnce(null);          // Redis: no key (miss)
    queryRawUnsafeMock.mockResolvedValueOnce([{ '?column?': 1 }]); // DB: revoked row present

    await expect(isTokenBlacklisted('jti-evicted')).resolves.toBe(true);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1); // DB WAS consulted
  });

  it('a Redis HIT short-circuits without a DB query', async () => {
    cacheGetMock.mockResolvedValueOnce({ reason: 'logout' }); // Redis: present
    await expect(isTokenBlacklisted('jti-hit')).resolves.toBe(true);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('a Redis MISS with no DB row accepts the token', async () => {
    cacheGetMock.mockResolvedValueOnce(null);
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await expect(isTokenBlacklisted('jti-clean')).resolves.toBe(false);
  });
});

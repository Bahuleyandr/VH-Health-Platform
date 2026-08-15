// Redis-loss posture for the revocation path (2026-08-15 failover drill).
//
// Pins what the drill in scripts/drills/ proved by execution against a real
// Postgres with Redis pointed at a closed port:
//
//   * a revoked token is STILL rejected when Redis is gone (DB fallback engages)
//   * both stores failing means deny, not accept (fail closed)
//   * BOTH isTokenBlacklisted and isUserTokensRevoked now skip Redis entirely
//     once the connection is down (the drill found only the former guarded;
//     the missing guard on the latter was fixed with the drill remediation).
//
// Both functions run on EVERY authenticated request (jwtMiddleware.js:124,138),
// so the once-missing guard was a per-request latency cost during a Redis
// outage: measured 1.3s rising to ~15-20s per call as ioredis's retry backoff
// matured, versus 0-2ms for the guarded sibling in the same process.
import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const cacheGetMock = jest.fn();
let redisConnected = false;

const __prismaDefaultMock = { $queryRawUnsafe: queryRawUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_t, fn) => fn(__prismaDefaultMock),
  setTenant: async (_t, fn) => fn(__prismaDefaultMock),
}));
jest.unstable_mockModule('../../lib/redis.js', () => ({
  cacheGet: cacheGetMock,
  cacheSet: jest.fn(),
  isRedisConnected: () => redisConnected,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const {
  isTokenBlacklisted,
  isUserTokensRevoked,
  RevocationCheckUnavailableError,
} = await import('../../utils/tokenBlacklist.js');

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  cacheGetMock.mockReset();
  redisConnected = false; // Redis is DOWN for every case in this file
});

describe('token revocation with Redis unreachable', () => {
  it('still rejects a revoked token via the durable store', async () => {
    queryRawUnsafeMock.mockResolvedValue([{ '?column?': 1 }]);

    await expect(isTokenBlacklisted('revoked-jti')).resolves.toBe(true);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('still accepts a token that was never revoked', async () => {
    queryRawUnsafeMock.mockResolvedValue([]);

    await expect(isTokenBlacklisted('clean-jti')).resolves.toBe(false);
  });

  it('does not consult Redis at all once the connection is down', async () => {
    queryRawUnsafeMock.mockResolvedValue([]);

    await isTokenBlacklisted('clean-jti');

    // The isRedisConnected() guard at tokenBlacklist.js:167 is what keeps this
    // check at ~1ms during an outage instead of blocking on ioredis retries.
    expect(cacheGetMock).not.toHaveBeenCalled();
  });

  it('fails CLOSED when neither store can answer', async () => {
    queryRawUnsafeMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(isTokenBlacklisted('unknown-jti'))
      .rejects.toBeInstanceOf(RevocationCheckUnavailableError);
  });

  it('fails CLOSED on the revoke-all path when the durable store is unreachable', async () => {
    cacheGetMock.mockResolvedValue(null);
    queryRawUnsafeMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(isUserTokensRevoked('11111111-1111-4111-8111-111111111111', 1))
      .rejects.toBeInstanceOf(RevocationCheckUnavailableError);
  });

  // FIXED (was the drill's open DEFECT): isUserTokensRevoked used to call
  // cacheGet unconditionally with no isRedisConnected() guard, unlike its
  // sibling isTokenBlacklisted. With the client disconnected the command sat in
  // ioredis's offline queue until maxRetriesPerRequest (3) was exhausted, so
  // every authenticated request blocked for seconds (1.3s fresh, ~15s deep into
  // an outage) before falling through to Postgres. The guard now skips Redis
  // entirely once the connection is down.
  it('skips Redis on the revoke-all path when disconnected', async () => {
    queryRawUnsafeMock.mockResolvedValue([]);

    await isUserTokensRevoked('11111111-1111-4111-8111-111111111111', 1);

    expect(cacheGetMock).not.toHaveBeenCalled();
  });
});

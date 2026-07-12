// Regression tests for audit finding M2 (2026-06-10) — token revocation
// previously FAILED OPEN: when Redis and the DB both errored,
// isTokenBlacklisted/isUserTokensRevoked returned `false` (accept), so a
// revoked or force-logged-out token was honoured during any store blip.
//
// Proves:
//   1. Both stores erroring ⇒ RevocationCheckUnavailableError (deny), not
//      silent acceptance.
//   2. A working store still answers normally (legitimate path intact).
//   3. A clean Redis miss remains authoritative for revoke-all when only
//      the DB errors (availability preserved when safe).

import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

const redisMock = {
  cacheGet: jest.fn(),
  cacheSet: jest.fn(),
  isRedisConnected: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));
jest.unstable_mockModule('../../lib/redis.js', () => redisMock);
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const {
  isTokenBlacklisted,
  isUserTokensRevoked,
  RevocationCheckUnavailableError,
} = await import('../../utils/tokenBlacklist.js');

afterEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
  redisMock.cacheGet.mockReset();
  redisMock.isRedisConnected.mockReset();
});

describe('M2 — isTokenBlacklisted fails closed', () => {
  test('Redis down + DB error ⇒ throws RevocationCheckUnavailableError', async () => {
    redisMock.isRedisConnected.mockReturnValue(false);
    prismaMock.$queryRawUnsafe.mockRejectedValue(new Error('connection refused'));

    await expect(isTokenBlacklisted('some-jti')).rejects.toBeInstanceOf(
      RevocationCheckUnavailableError,
    );
  });

  test('Redis read error + DB error ⇒ throws (no silent acceptance)', async () => {
    redisMock.isRedisConnected.mockReturnValue(true);
    redisMock.cacheGet.mockRejectedValue(new Error('redis timeout'));
    prismaMock.$queryRawUnsafe.mockRejectedValue(new Error('db down'));

    await expect(isTokenBlacklisted('some-jti')).rejects.toBeInstanceOf(
      RevocationCheckUnavailableError,
    );
  });

  test('legitimate path: Redis answers "blacklisted" ⇒ true', async () => {
    redisMock.isRedisConnected.mockReturnValue(true);
    redisMock.cacheGet.mockResolvedValue({ reason: 'logout' });
    await expect(isTokenBlacklisted('some-jti')).resolves.toBe(true);
  });

  // Sol Ultra #29: Redis is a POSITIVE cache only — a clean miss is not proof
  // of absence (eviction/flush loses revocations), so it falls through to the
  // authoritative invalidated_tokens query. The old contract ("miss ⇒ trusted,
  // no DB hit") was the vulnerability.
  test('legitimate path: Redis clean miss ⇒ DB consulted; clean DB ⇒ false', async () => {
    redisMock.isRedisConnected.mockReturnValue(true);
    redisMock.cacheGet.mockResolvedValue(null);
    prismaMock.$queryRawUnsafe.mockResolvedValue([]);
    await expect(isTokenBlacklisted('some-jti')).resolves.toBe(false);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalled();
  });

  test('Redis clean miss but DB row stands ⇒ true (revocation survives eviction)', async () => {
    redisMock.isRedisConnected.mockReturnValue(true);
    redisMock.cacheGet.mockResolvedValue(null);
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    await expect(isTokenBlacklisted('some-jti')).resolves.toBe(true);
  });

  test('legitimate path: Redis down, DB answers ⇒ DB result honoured', async () => {
    redisMock.isRedisConnected.mockReturnValue(false);
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    await expect(isTokenBlacklisted('some-jti')).resolves.toBe(true);
  });
});

describe('M2 — isUserTokensRevoked fails closed', () => {
  test('Redis error + DB error ⇒ throws RevocationCheckUnavailableError', async () => {
    redisMock.cacheGet.mockRejectedValue(new Error('redis down'));
    redisMock.isRedisConnected.mockReturnValue(false);
    prismaMock.$queryRawUnsafe.mockRejectedValue(new Error('db down'));

    await expect(isUserTokensRevoked('user-1', 1000)).rejects.toBeInstanceOf(
      RevocationCheckUnavailableError,
    );
  });

  test('clean Redis miss + DB error ⇒ false (Redis answer is authoritative)', async () => {
    redisMock.cacheGet.mockResolvedValue(null);
    redisMock.isRedisConnected.mockReturnValue(true);
    prismaMock.$queryRawUnsafe.mockRejectedValue(new Error('db blip'));

    await expect(isUserTokensRevoked('user-1', 1000)).resolves.toBe(false);
  });

  test('legitimate path: Redis revoked-after-iat ⇒ true', async () => {
    redisMock.cacheGet.mockResolvedValue({ revokedAt: 2000 });
    redisMock.isRedisConnected.mockReturnValue(true);
    await expect(isUserTokensRevoked('user-1', 1000)).resolves.toBe(true);
  });

  test('legitimate path: DB says revoked ⇒ true', async () => {
    redisMock.cacheGet.mockResolvedValue(null);
    redisMock.isRedisConnected.mockReturnValue(true);
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ '?column?': 1 }]);
    await expect(isUserTokensRevoked('user-1', 1000)).resolves.toBe(true);
  });
});

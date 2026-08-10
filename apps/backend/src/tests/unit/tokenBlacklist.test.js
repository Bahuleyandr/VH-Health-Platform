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

const pushSessionRevokedMock = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  pushSessionRevoked: pushSessionRevokedMock,
  sendToUser: jest.fn(),
  broadcast: jest.fn(),
}));

const {
  isUserTokensRevoked,
  revokeAllUserTokens,
  blacklistToken,
  getCurrentTokenEpoch,
} = await import('../../utils/tokenBlacklist.js');

const UUID_USER = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  cacheGetMock.mockReset();
  cacheSetMock.mockReset();
  pushSessionRevokedMock.mockReset();
});

describe('tokenBlacklist revoke-all fallback', () => {
  it('checks the DB revoke marker inclusively against the token iat watermark', async () => {
    cacheGetMock.mockResolvedValueOnce(null);
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    const revoked = await isUserTokensRevoked('42', 1234);

    expect(revoked).toBe(false);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/created_at\s*>=\s*to_timestamp\(\$2\)/);
    expect(queryRawUnsafeMock.mock.calls[0][1]).toBe('user:42');
    expect(queryRawUnsafeMock.mock.calls[0][2]).toBe(1234);
  });

  it('treats a DB marker newer than token iat as revoked', async () => {
    cacheGetMock.mockResolvedValueOnce(null);
    queryRawUnsafeMock.mockResolvedValueOnce([{ '?column?': 1 }]);

    await expect(isUserTokensRevoked('42', 1234)).resolves.toBe(true);
  });

  it('treats a Redis marker from the same second as token iat as revoked', async () => {
    cacheGetMock.mockResolvedValueOnce({ revokedAt: 1234 });

    await expect(isUserTokensRevoked('42', 1234)).resolves.toBe(true);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('rejects an access token minted under an older durable identity epoch', async () => {
    cacheGetMock.mockResolvedValueOnce(null);
    queryRawUnsafeMock.mockResolvedValueOnce([{ '?column?': 1 }]);

    await expect(isUserTokensRevoked(UUID_USER, 2000, 4)).resolves.toBe(true);

    const [sql, marker, issuedAt, uid, hasTokenEpoch, tokenEpoch] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/SELECT token_epoch FROM users/);
    expect(sql).toMatch(/SELECT token_epoch FROM admins/);
    expect(marker).toBe(`user:${UUID_USER}`);
    expect(issuedAt).toBe(2000);
    expect(uid).toBe(UUID_USER);
    expect(hasTokenEpoch).toBe(true);
    expect(tokenEpoch).toBe(4);
  });

  it('does not let a same-second watermark revoke a token stamped with the current epoch', async () => {
    cacheGetMock.mockResolvedValueOnce({ revokedAt: 2000.75 });
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(isUserTokensRevoked(UUID_USER, 2000, 5)).resolves.toBe(false);

    const [sql, marker, issuedAt, uid, hasTokenEpoch, tokenEpoch] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/\$4::boolean = FALSE/);
    expect(marker).toBe(`user:${UUID_USER}`);
    expect(issuedAt).toBe(2000);
    expect(uid).toBe(UUID_USER);
    expect(hasTokenEpoch).toBe(true);
    expect(tokenEpoch).toBe(5);
  });

  it('R12: a Redis clean miss is never a negative answer — DB failure fails CLOSED', async () => {
    cacheGetMock.mockResolvedValueOnce(null); // clean miss (evictable under allkeys-lru)
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(isUserTokensRevoked('42', 1234)).rejects.toMatchObject({
      code: 'REVOCATION_CHECK_UNAVAILABLE',
    });
  });

  it('refreshes the persistent revoke-all watermark on repeated revokes', async () => {
    cacheSetMock.mockResolvedValueOnce(true);
    queryRawUnsafeMock.mockResolvedValueOnce([{ revoked_at: 2000 }]);

    const evidence = await revokeAllUserTokens('42');

    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/created_at\s*=\s*EXCLUDED\.created_at/);
    expect(queryRawUnsafeMock.mock.invocationCallOrder[0]).toBeLessThan(cacheSetMock.mock.invocationCallOrder[0]);
    expect(cacheSetMock).toHaveBeenCalledWith(
      expect.stringContaining('user:42'),
      { revokedAt: 2000 },
      expect.any(Number),
    );
    expect(evidence).toMatchObject({
      redis: { persisted: true },
      database: { persisted: true },
    });
  });

  it('R12: the durable DB write is REQUIRED — revoke-all fails closed when the DB write fails, in every mode', async () => {
    cacheSetMock.mockResolvedValue(true); // Redis accepting is NOT enough evidence
    queryRawUnsafeMock.mockRejectedValue(new Error('database unavailable'));

    await expect(revokeAllUserTokens('42')).rejects.toMatchObject({
      code: 'REVOCATION_WRITE_UNAVAILABLE',
    });
    await expect(
      revokeAllUserTokens('42', { requireEvidence: true }),
    ).rejects.toMatchObject({ code: 'REVOCATION_WRITE_UNAVAILABLE' });
    // No session:revoked push may fire for a revocation with no durable evidence.
    expect(pushSessionRevokedMock).not.toHaveBeenCalled();
  });

  it('R1: bumps the identity token_epoch atomically with the watermark for uuid identities', async () => {
    cacheSetMock.mockResolvedValueOnce(true);
    queryRawUnsafeMock.mockResolvedValueOnce([{ revoked_at: 2000, epoch_rows: 1 }]);

    await revokeAllUserTokens(UUID_USER, { reason: 'logout' });

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/token_epoch = token_epoch \+ 1/);
    expect(sql).toMatch(/token_epoch_bumped_at = NOW\(\)/);
    expect(sql).toMatch(/UPDATE users/);
    expect(sql).toMatch(/UPDATE admins/);
    expect(sql).toMatch(/INSERT INTO invalidated_tokens/);
    expect(params[0]).toBe(`user:${UUID_USER}`);
    expect(params[1]).toBe('logout');
    expect(params[2]).toBe(UUID_USER);
  });

  it('R14: pushes session:revoked to the identity WebSockets after a durable revoke-all', async () => {
    cacheSetMock.mockResolvedValueOnce(true);
    queryRawUnsafeMock.mockResolvedValueOnce([{ revoked_at: 2000, epoch_rows: 1 }]);

    await revokeAllUserTokens(UUID_USER, { reason: 'scim_deprovision' });

    expect(pushSessionRevokedMock).toHaveBeenCalledWith(
      UUID_USER,
      expect.objectContaining({ reason: 'scim_deprovision' }),
    );
  });

  it('legacy non-uuid identities keep watermark-only semantics (no ::uuid cast in SQL)', async () => {
    cacheSetMock.mockResolvedValueOnce(true);
    queryRawUnsafeMock.mockResolvedValueOnce([{ revoked_at: 2000 }]);

    await revokeAllUserTokens('42');

    const [sql] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).not.toMatch(/token_epoch/);
    expect(sql).not.toMatch(/::uuid/);
  });
});

describe('getCurrentTokenEpoch (R1 issuance gate input)', () => {
  it('reads the durable epoch for a uuid identity (users OR admins realm)', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ token_epoch: 3 }]);

    await expect(getCurrentTokenEpoch(UUID_USER)).resolves.toBe(3);
    const [sql, param] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/FROM users WHERE uid = \$1::uuid/);
    expect(sql).toMatch(/FROM admins WHERE uid = \$1::uuid/);
    expect(param).toBe(UUID_USER);
  });

  it('returns 0 for unknown identities and non-uuid legacy keys without touching the DB for the latter', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await expect(getCurrentTokenEpoch(UUID_USER)).resolves.toBe(0);

    queryRawUnsafeMock.mockClear();
    await expect(getCurrentTokenEpoch('42')).resolves.toBe(0);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the durable store cannot answer', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(getCurrentTokenEpoch(UUID_USER)).rejects.toMatchObject({
      code: 'REVOCATION_CHECK_UNAVAILABLE',
    });
  });
});

describe('tokenBlacklist blacklistToken (single-token revoke, audit F10)', () => {
  const future = Math.floor(Date.now() / 1000) + 3600;

  it('ordinary callers stay best-effort: resolves even when both stores fail', async () => {
    cacheSetMock.mockResolvedValue(false);
    queryRawUnsafeMock.mockRejectedValue(new Error('database unavailable'));

    await expect(blacklistToken('jti-1', future, 'logout')).resolves.toBeUndefined();
  });

  it('fails closed when evidence is required and both Redis and DB writes fail', async () => {
    cacheSetMock.mockResolvedValue(false);
    queryRawUnsafeMock.mockRejectedValue(new Error('database unavailable'));

    await expect(
      blacklistToken('jti-1', future, 'logout', { requireEvidence: true }),
    ).rejects.toMatchObject({ code: 'REVOCATION_WRITE_UNAVAILABLE' });
  });

  it('R12: evidence mode fails closed when only Redis persisted — a Redis-only entry is evictable (allkeys-lru), not durable evidence', async () => {
    cacheSetMock.mockResolvedValueOnce(true);
    queryRawUnsafeMock.mockRejectedValue(new Error('database unavailable'));

    await expect(
      blacklistToken('jti-1', future, 'logout', { requireEvidence: true }),
    ).rejects.toMatchObject({ code: 'REVOCATION_WRITE_UNAVAILABLE' });
  });

  it('evidence mode resolves normally when the DB persists even if Redis fails', async () => {
    cacheSetMock.mockResolvedValueOnce(false);
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(
      blacklistToken('jti-1', future, 'logout', { requireEvidence: true }),
    ).resolves.toMatchObject({ database: { persisted: true } });
  });
});

import { jest } from '@jest/globals';

// The other half of the sessionRoutes contract (audit follow-up P12).
//
// `tokenBlacklist` is deliberately NOT mocked here: the whole defect was that
// sessionManagementService called `blacklistToken(jti)` with no `expiresAt`, so
// the INSERT bound NULL into the NOT NULL `invalidated_tokens.expires_at` and
// failed — inside a fire-and-forget `setImmediate`, where nothing could observe
// it. Asserting at a `blacklistToken` mock boundary would re-hide exactly that.
// So we mock the two STORES instead and assert the durable write itself.

const queryRawUnsafeMock = jest.fn();
const cacheSetMock = jest.fn();

const prismaMock = { $queryRawUnsafe: queryRawUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));

jest.unstable_mockModule('../../lib/redis.js', () => ({
  cacheGet: jest.fn(async () => null),
  cacheSet: cacheSetMock,
  isRedisConnected: () => false,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const { SECURITY_CONFIG } = await import('../../config/securityConfig.js');
const { revokeSession, revokeAllOtherSessions, SESSION_REVOKE_FAILURE } =
  await import('../../services/sessionManagementService.js');

const UID = '550e8400-e29b-41d4-a716-446655440001';
const JTI = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const LOGIN_AT = new Date('2026-08-01T10:00:00.000Z');

const isBlacklistInsert = (sql) => /INSERT INTO invalidated_tokens/i.test(sql);
const isAuthLogSelect = (sql) => /FROM auth_logs/i.test(sql);

/** Every blacklist INSERT issued during the test, as `[jti, expiresAt, reason]`. */
const blacklistInserts = () =>
  queryRawUnsafeMock.mock.calls
    .filter(([sql]) => isBlacklistInsert(sql))
    .map(([, ...params]) => params);

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  cacheSetMock.mockReset();
  // No Redis in this harness, so the DB is the only store that can persist.
  cacheSetMock.mockResolvedValue(false);
});

describe('revokeSession', () => {
  it('persists the revocation with a real, finite expiry', async () => {
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (isAuthLogSelect(sql)) return [{ id: 7, user_id: UID, created_at: LOGIN_AT }];
      return [];
    });

    const result = await revokeSession(UID, JTI);

    expect(result.success).toBe(true);

    const inserts = blacklistInserts();
    expect(inserts).toHaveLength(1);
    const [jti, expiresAt, reason] = inserts[0];
    expect(jti).toBe(JTI);
    expect(reason).toBe('session_revoked');

    // THE regression pin. Before the fix this argument was `undefined`, which
    // `to_timestamp($2)` turned into NULL against a NOT NULL column.
    expect(Number.isFinite(expiresAt)).toBe(true);
    expect(expiresAt).toBe(
      Math.floor(
        (LOGIN_AT.getTime() + SECURITY_CONFIG.blacklist.maxTokenLifetimeDays * 86400000) / 1000,
      ),
    );
    // The blacklist row must outlive the token it revokes, or the revocation
    // silently lapses while the token is still usable.
    expect(expiresAt * 1000).toBeGreaterThan(Date.now());
  });

  it('reports failure when no store accepted the write', async () => {
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (isAuthLogSelect(sql)) return [{ id: 7, user_id: UID, created_at: LOGIN_AT }];
      throw new Error('invalidated_tokens unavailable');
    });

    const result = await revokeSession(UID, JTI);

    expect(result.success).toBe(false);
    expect(result.code).toBe(SESSION_REVOKE_FAILURE.STORE_UNAVAILABLE);
  });

  it('succeeds on the Redis fast path alone when the DB write fails', async () => {
    cacheSetMock.mockResolvedValue(true);
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (isAuthLogSelect(sql)) return [{ id: 7, user_id: UID, created_at: LOGIN_AT }];
      throw new Error('db down');
    });

    const result = await revokeSession(UID, JTI);

    // One store is enough to make the revocation real, so this is honest.
    expect(result.success).toBe(true);
  });

  it('does not attempt a revocation for a jti that is not the caller\'s', async () => {
    queryRawUnsafeMock.mockResolvedValue([]);

    const result = await revokeSession(UID, JTI);

    expect(result.success).toBe(false);
    expect(result.code).toBe(SESSION_REVOKE_FAILURE.NOT_FOUND);
    expect(blacklistInserts()).toHaveLength(0);
  });

  it('scopes the session lookup by the caller uid', async () => {
    queryRawUnsafeMock.mockResolvedValue([]);

    await revokeSession(UID, JTI);

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/user_id = \$2/);
    expect(params).toEqual([JTI, UID]);
  });
});

describe('revokeAllOtherSessions', () => {
  const twoSessions = [
    { jti: 'jti-a', created_at: LOGIN_AT },
    { jti: 'jti-b', created_at: LOGIN_AT },
  ];

  it('revokes each remaining session with its own real expiry', async () => {
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (isAuthLogSelect(sql)) return twoSessions;
      return [];
    });

    const result = await revokeAllOtherSessions(UID, JTI);

    expect(result).toMatchObject({ success: true, revokedCount: 2, failedCount: 0 });
    const inserts = blacklistInserts();
    expect(inserts.map(([jti]) => jti)).toEqual(['jti-a', 'jti-b']);
    expect(inserts.every(([, expiresAt]) => Number.isFinite(expiresAt))).toBe(true);
  });

  it('keeps going after a failed revocation and reports the real counts', async () => {
    // A store failure on one session must not silently abandon the ones after
    // it, and must not be summarised as a green "N session(s) revoked".
    let insertAttempts = 0;
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (isAuthLogSelect(sql)) return twoSessions;
      insertAttempts += 1;
      if (insertAttempts === 1) throw new Error('db down');
      return [];
    });

    const result = await revokeAllOtherSessions(UID, JTI);

    expect(result.success).toBe(false);
    expect(result.code).toBe(SESSION_REVOKE_FAILURE.STORE_UNAVAILABLE);
    expect(result.revokedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(insertAttempts).toBe(2);
  });

  it('reports a listing failure instead of an empty success', async () => {
    queryRawUnsafeMock.mockRejectedValue(new Error('db down'));

    const result = await revokeAllOtherSessions(UID, JTI);

    expect(result.success).toBe(false);
    expect(result.code).toBe(SESSION_REVOKE_FAILURE.STORE_UNAVAILABLE);
  });
});

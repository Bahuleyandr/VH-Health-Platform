import { jest } from '@jest/globals';

// Service-level contract for the session surface (audit P12 + P15).
//
// `tokenBlacklist` is deliberately NOT mocked: the P12 defect was that
// sessionManagementService called `blacklistToken(jti)` with no `expiresAt`, so
// the INSERT bound NULL into the NOT NULL `invalidated_tokens.expires_at` and
// failed inside a fire-and-forget `setImmediate` where nothing could observe
// it. Asserting at a `blacklistToken` mock boundary would re-hide exactly that.
// So we mock the two STORES instead and assert the durable write itself.

const queryRawUnsafeMock = jest.fn();
const cacheSetMock = jest.fn();
const pushSessionRevokedMock = jest.fn();

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
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  pushSessionRevoked: pushSessionRevokedMock,
}));

const {
  listActiveSessions,
  revokeSession,
  revokeAllOtherSessions,
  SESSION_REVOKE_FAILURE,
  SESSION_SOURCE,
} = await import('../../services/sessionManagementService.js');

const UID = '550e8400-e29b-41d4-a716-446655440001';
const JTI = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const SESSION_FAMILY_ID = '47a2ba35-56f3-4f66-91a2-a351aa25fa84';
const STABLE_DEVICE_ID = 'be6f7df2-227d-4d16-b90e-96f7c9904712';
const EXPIRES_AT = new Date(Date.now() + 60 * 60 * 1000); // 1h out, like a real access token
const ISSUED_AT = new Date(Date.now() - 5 * 60 * 1000);

const isRegistrySelect = (sql) => /FROM user_active_sessions/i.test(sql);
const isBlacklistInsert = (sql) => /INSERT INTO invalidated_tokens/i.test(sql);

const registryRow = (overrides = {}) => ({
  jti: JTI,
  device_type: 'mobile',
  device_label: 'Pixel 8',
  ip_address: '10.0.0.9',
  user_agent: 'jest',
  issued_at: ISSUED_AT,
  expires_at: EXPIRES_AT,
  session_family_id: SESSION_FAMILY_ID,
  stable_device_id: STABLE_DEVICE_ID,
  ...overrides,
});

/** Every blacklist INSERT issued during the test, as `[jti, expiresAt, reason]`. */
const blacklistInserts = () =>
  queryRawUnsafeMock.mock.calls
    .filter(([sql]) => isBlacklistInsert(sql))
    .map(([, ...params]) => params);

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  cacheSetMock.mockReset();
  pushSessionRevokedMock.mockReset();
  // No Redis in this harness, so the DB is the only store that can persist.
  cacheSetMock.mockResolvedValue(false);
});

describe('listActiveSessions', () => {
  it('reads the session registry, not the auth_logs login journal', async () => {
    // THE P15 regression pin. The old query filtered
    // `auth_logs WHERE action = 'login_success'` — a value no code in this repo
    // has ever written — so it returned [] for every user, forever.
    queryRawUnsafeMock.mockResolvedValue([registryRow()]);

    await listActiveSessions(UID, {});

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/FROM user_active_sessions/);
    expect(sql).not.toMatch(/auth_logs/);
    expect(sql).not.toMatch(/login_success/);
    expect(params).toEqual([UID]);
  });

  it('excludes sessions the API would itself reject', async () => {
    // Liveness must mirror jwtMiddleware exactly: unexpired, not blacklisted by
    // jti, and not covered by a newer revoke-all marker.
    queryRawUnsafeMock.mockResolvedValue([]);

    const sessions = await listActiveSessions(UID, {});

    const [sql] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/s\.expires_at > NOW\(\)/);
    expect(sql).toMatch(/invalidated_tokens/);
    expect(sql).toMatch(/'user:' \|\| s\.user_uid/);
    expect(sessions).toMatchObject({
      sessions: [],
      complete: false,
      coverage: 'current_token_and_latest_registry_row',
    });
  });

  it('marks the caller\'s own registry row as current', async () => {
    queryRawUnsafeMock.mockResolvedValue([registryRow()]);

    const sessions = await listActiveSessions(UID, { jti: JTI, expiresAt: EXPIRES_AT });

    expect(sessions.complete).toBe(false);
    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0]).toMatchObject({
      jti: JTI,
      is_current: true,
      source: SESSION_SOURCE.REGISTRY,
      device_label: 'Pixel 8',
      session_family_id: SESSION_FAMILY_ID,
      stable_device_id: STABLE_DEVICE_ID,
    });
  });

  it('still reports the caller\'s session when no registry row exists', async () => {
    // Admin logins mint tokens via generateToken() without claimUserSession, so
    // a registry-only answer would tell a signed-in admin they have no sessions.
    queryRawUnsafeMock.mockResolvedValue([]);

    const sessions = await listActiveSessions(UID, { jti: JTI, expiresAt: EXPIRES_AT });

    expect(sessions.complete).toBe(false);
    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0]).toMatchObject({
      jti: JTI,
      is_current: true,
      source: SESSION_SOURCE.ACCESS_TOKEN,
    });
  });

  it('does not double-count the caller when the registry already has it', async () => {
    queryRawUnsafeMock.mockResolvedValue([registryRow()]);

    const sessions = await listActiveSessions(UID, { jti: JTI, expiresAt: EXPIRES_AT });

    expect(sessions.sessions.filter((s) => s.jti === JTI)).toHaveLength(1);
  });

  it('throws on a registry read failure rather than returning an empty list', async () => {
    // "[]" is a different claim from "I could not tell you" — it says the
    // caller has no sessions.
    queryRawUnsafeMock.mockRejectedValue(new Error('db down'));

    await expect(listActiveSessions(UID, {})).rejects.toThrow('db down');
  });
});

describe('revokeSession', () => {
  it('blacklists using the session\'s own real expiry', async () => {
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (isRegistrySelect(sql)) return [registryRow()];
      return [];
    });

    const result = await revokeSession(UID, JTI, {});

    expect(result.success).toBe(true);
    const inserts = blacklistInserts();
    expect(inserts).toHaveLength(1);
    const [jti, expiresAt, reason] = inserts[0];
    expect(jti).toBe(JTI);
    expect(reason).toBe('session_revoked');
    // The registry carries a true expiry, so no conservative 30-day ceiling is
    // needed any more — but it must still be finite and outlive now.
    expect(Number.isFinite(expiresAt)).toBe(true);
    expect(expiresAt).toBe(Math.floor(EXPIRES_AT.getTime() / 1000));
    expect(expiresAt * 1000).toBeGreaterThan(Date.now());
  });

  it('publishes the listed remote session selectors instead of the caller selectors', async () => {
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (isRegistrySelect(sql)) return [registryRow()];
      return [];
    });

    const result = await revokeSession(UID, JTI, {
      jti: 'caller-jti',
      expiresAt: EXPIRES_AT,
      sessionFamilyId: 'caller-family',
      stableDeviceId: '0ecce6b6-b8b2-4589-91e6-f5d02a35c157',
    });

    expect(result.success).toBe(true);
    expect(pushSessionRevokedMock).toHaveBeenCalledWith(UID, expect.objectContaining({
      jti: JTI,
      sessionFamilyId: SESSION_FAMILY_ID,
      stableDeviceId: STABLE_DEVICE_ID,
    }));
  });

  it('publishes the access jti for a remote legacy row whose selectors are null', async () => {
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (isRegistrySelect(sql)) {
        return [registryRow({ session_family_id: null, stable_device_id: null })];
      }
      return [];
    });

    const result = await revokeSession(UID, JTI, {
      jti: 'caller-jti',
      expiresAt: EXPIRES_AT,
      sessionFamilyId: 'caller-family',
      stableDeviceId: '0ecce6b6-b8b2-4589-91e6-f5d02a35c157',
    });

    expect(result.success).toBe(true);
    expect(pushSessionRevokedMock).toHaveBeenCalledWith(UID, {
      reason: 'session_revoked',
      jti: JTI,
      at: expect.any(String),
    });
  });

  it('scopes the lookup to the caller uid', async () => {
    queryRawUnsafeMock.mockResolvedValue([]);

    await revokeSession(UID, JTI, {});

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/user_uid = \$1::uuid AND jti = \$2/);
    expect(params).toEqual([UID, JTI]);
  });

  it('revokes the caller\'s own token even with no registry row', async () => {
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (isRegistrySelect(sql)) return [];
      return [];
    });

    const result = await revokeSession(UID, JTI, { jti: JTI, expiresAt: EXPIRES_AT });

    expect(result.success).toBe(true);
    expect(blacklistInserts()).toHaveLength(1);
  });

  it('404s for a jti that is neither in the registry nor the caller\'s own', async () => {
    queryRawUnsafeMock.mockResolvedValue([]);

    const result = await revokeSession(UID, JTI, { jti: 'someone-elses', expiresAt: EXPIRES_AT });

    expect(result.success).toBe(false);
    expect(result.code).toBe(SESSION_REVOKE_FAILURE.NOT_FOUND);
    expect(blacklistInserts()).toHaveLength(0);
  });

  it('reports failure when no store accepted the write', async () => {
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (isRegistrySelect(sql)) return [registryRow()];
      throw new Error('invalidated_tokens unavailable');
    });

    const result = await revokeSession(UID, JTI, {});

    expect(result.success).toBe(false);
    expect(result.code).toBe(SESSION_REVOKE_FAILURE.STORE_UNAVAILABLE);
  });

  it('fails closed when the DB write fails, even if Redis accepted it', async () => {
    cacheSetMock.mockResolvedValue(true);
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (isRegistrySelect(sql)) return [registryRow()];
      throw new Error('db down');
    });

    const result = await revokeSession(UID, JTI, {});

    // R12: Postgres is the AUTHORITATIVE revocation store. The committed Redis
    // manifest runs allkeys-lru, so a Redis-only blacklist entry can be evicted
    // and the "successful" revocation silently un-revoked. A revocation with no
    // durable evidence must therefore report failure, not success.
    expect(result.success).toBe(false);
    expect(result.code).toBe(SESSION_REVOKE_FAILURE.STORE_UNAVAILABLE);
  });
});

describe('revokeAllOtherSessions', () => {
  it('refuses to claim success from a latest-row-only registry', async () => {
    const result = await revokeAllOtherSessions(UID, JTI);

    expect(result.success).toBe(false);
    expect(result.code).toBe(SESSION_REVOKE_FAILURE.REGISTRY_INCOMPLETE);
    expect(result.revokedCount).toBe(0);
    expect(result.failedCount).toBeNull();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(blacklistInserts()).toHaveLength(0);
  });
});

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const advisoryLockMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const cacheGetMock = jest.fn();
const cacheSetMock = jest.fn();

const transactionQueryRawUnsafeMock = jest.fn((sql, ...params) => {
  if (String(sql).includes('pg_advisory_xact_lock')) {
    advisoryLockMock(sql, ...params);
    return Promise.resolve([]);
  }
  return queryRawUnsafeMock(sql, ...params);
});
const __transactionClientMock = {
  $executeRawUnsafe: executeRawUnsafeMock,
  $queryRawUnsafe: transactionQueryRawUnsafeMock,
};
const __prismaDefaultMock = {
  $executeRawUnsafe: executeRawUnsafeMock,
  $queryRawUnsafe: queryRawUnsafeMock,
  $transaction: (fn) => fn(__transactionClientMock),
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));
// Controllable: the revoke-all Redis positive cache is consulted ONLY while
// the connection is live (isRedisConnected guard, added with the 2026-08-15
// Redis-loss drill remediation — mirrors isTokenBlacklisted). Tests of the
// Redis-hit path flip this to true; everything else runs disconnected.
let redisConnected = false;
jest.unstable_mockModule('../../lib/redis.js', () => ({
  cacheGet: cacheGetMock,
  cacheSet: cacheSetMock,
  isRedisConnected: () => redisConnected,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const pushSessionRevokedMock = jest.fn();
const pushDelegatedSessionRevokedMock = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  pushDelegatedSessionRevoked: pushDelegatedSessionRevokedMock,
  pushSessionRevoked: pushSessionRevokedMock,
  sendToUser: jest.fn(),
  broadcast: jest.fn(),
}));

const {
  authRevocationLockKeys,
  isDelegatedTupleRevoked,
  isSubjectDelegationRevoked,
  isUserTokensRevoked,
  persistRevokeDelegatedTuple,
  publishRevokeDelegatedTuple,
  revokeAllUserTokens,
  blacklistToken,
  getCurrentTokenEpoch,
  withAuthIdentityLifecycleLocks,
} = await import('../../utils/tokenBlacklist.js');

const UUID_USER = '11111111-2222-4333-8444-555555555555';

describe('auth revocation transaction locks', () => {
  it('derives stable, normalized, deadlock-safe lock order', () => {
    expect(authRevocationLockKeys({
      identityUids: ['USER-B', 'user-a', 'USER-B'],
      jtis: ['jti-b', 'jti-a'],
      tupleKeys: ['Guardian:Dependent'],
    })).toEqual([
      'vh:auth:identity:user-a',
      'vh:auth:identity:user-b',
      'vh:auth:jti:jti-a',
      'vh:auth:jti:jti-b',
      'vh:auth:tuple:guardian:dependent',
    ]);
  });

  it('holds owner and jti locks before an evidence blacklist becomes durable', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    cacheSetMock.mockResolvedValueOnce(true);
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await blacklistToken('session-jti', future, 'logout', {
      requireEvidence: true,
      userId: UUID_USER,
    });

    expect(advisoryLockMock.mock.calls.map(([, key]) => key)).toEqual([
      `vh:auth:identity:${UUID_USER}`,
      'vh:auth:jti:session-jti',
    ]);
    expect(advisoryLockMock.mock.invocationCallOrder.at(-1))
      .toBeLessThan(queryRawUnsafeMock.mock.invocationCallOrder[0]);
  });

  it('serializes lifecycle writers on normalized identity keys before their callback runs', async () => {
    const mutate = jest.fn(() => 'updated');

    await expect(withAuthIdentityLifecycleLocks(
      __transactionClientMock,
      ['USER-B', 'user-a', 'USER-B'],
      mutate,
    )).resolves.toBe('updated');

    expect(advisoryLockMock.mock.calls.map(([, key]) => key)).toEqual([
      'vh:auth:identity:user-a',
      'vh:auth:identity:user-b',
    ]);
    expect(advisoryLockMock.mock.invocationCallOrder.at(-1))
      .toBeLessThan(mutate.mock.invocationCallOrder[0]);
    expect(mutate).toHaveBeenCalledWith(__transactionClientMock);
  });
});

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  transactionQueryRawUnsafeMock.mockClear();
  advisoryLockMock.mockReset();
  executeRawUnsafeMock.mockReset().mockResolvedValue(0);
  cacheGetMock.mockReset();
  cacheSetMock.mockReset();
  pushSessionRevokedMock.mockReset();
  pushDelegatedSessionRevokedMock.mockReset();
  redisConnected = false;
});

describe('delegated tuple revocation', () => {
  const guardianUid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const dependentUid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('checks a guardian-dependent watermark without bumping either identity epoch', async () => {
    cacheGetMock.mockResolvedValueOnce(null);
    queryRawUnsafeMock.mockResolvedValueOnce([{ '?column?': 1 }]);

    await expect(isDelegatedTupleRevoked(guardianUid, dependentUid, 1234)).resolves.toBe(true);

    const [sql, marker, issuedAt] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).not.toMatch(/token_epoch/);
    expect(marker).toBe(`user:delegated:${guardianUid}:${dependentUid}`);
    expect(issuedAt).toBe(1234);
  });

  it('persists before publishing a tuple-scoped socket close', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ revoked_at: 2000 }]);
    cacheSetMock.mockResolvedValueOnce(true);

    const revokedAt = await persistRevokeDelegatedTuple(guardianUid, dependentUid, {
      reason: 'dependent_unlinked',
    });
    await publishRevokeDelegatedTuple(guardianUid, dependentUid, revokedAt, {
      reason: 'dependent_unlinked',
    });

    expect(queryRawUnsafeMock.mock.invocationCallOrder[0])
      .toBeLessThan(pushDelegatedSessionRevokedMock.mock.invocationCallOrder[0]);
    expect(advisoryLockMock).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      `vh:auth:tuple:delegated:${guardianUid}:${dependentUid}`,
    );
    expect(pushDelegatedSessionRevokedMock).toHaveBeenCalledWith(
      guardianUid,
      dependentUid,
      expect.objectContaining({ reason: 'dependent_unlinked' }),
    );
  });
});

describe('isSubjectDelegationRevoked (delegated subject, recoverable timestamp predicate)', () => {
  const subjectUid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  it('is timestamp-only: no epoch-counter arm, so an old bump cannot deny forever', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(isSubjectDelegationRevoked(subjectUid, 5000)).resolves.toBe(false);

    const [sql, marker, issuedAt, uid] = queryRawUnsafeMock.mock.calls[0];
    // The predicate compares the epoch BUMP TIMESTAMP against the bearer iat;
    // the bare `token_epoch > N` counter arm (which never clears) must not
    // appear — that arm is what made delegated denial permanent.
    expect(sql).toMatch(/token_epoch_bumped_at > to_timestamp/);
    expect(sql).not.toMatch(/token_epoch >/);
    expect(marker).toBe(`user:${subjectUid}`);
    expect(issuedAt).toBe(5000);
    expect(uid).toBe(subjectUid);
  });

  it('returns true when the durable predicate matches (revoke-all after the bearer mint)', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(isSubjectDelegationRevoked(subjectUid, 5000)).resolves.toBe(true);
  });

  it('returns false for a non-UUID identity without touching the store', async () => {
    await expect(isSubjectDelegationRevoked('not-a-uuid', 5000)).resolves.toBe(false);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the durable store is unreachable', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('db down'));
    await expect(isSubjectDelegationRevoked(subjectUid, 5000)).rejects.toThrow(
      /Subject delegation revocation store unreachable/,
    );
  });
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
    redisConnected = true; // the positive cache is only consulted while live
    cacheGetMock.mockResolvedValueOnce({ revokedAt: 1234 });

    await expect(isUserTokensRevoked('42', 1234)).resolves.toBe(true);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('rejects an access token minted under an older durable identity epoch', async () => {
    cacheGetMock.mockResolvedValueOnce(null);
    queryRawUnsafeMock.mockResolvedValueOnce([{ '?column?': 1 }]);

    await expect(isUserTokensRevoked(UUID_USER, 2000, 4)).resolves.toBe(true);

    const [sql, marker, issuedAt, uid, hasTokenEpoch, tokenEpoch] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/FROM users\s+WHERE uid = \$3::uuid/);
    expect(sql).toMatch(/FROM admins\s+WHERE uid = \$3::uuid/);
    expect(marker).toBe(`user:${UUID_USER}`);
    expect(issuedAt).toBe(2000);
    expect(uid).toBe(UUID_USER);
    expect(hasTokenEpoch).toBe(true);
    expect(tokenEpoch).toBe(4);
  });

  // A uid absent from BOTH realms still denies — but only when the probe can
  // prove it is not blind. jwtMiddleware runs BEFORE app.js mounts the tenant
  // middleware, so app.current_tenant_id is unset, and public.users carries the
  // RESTRICTIVE explicit_tenant_context_753 policy (migration 758) which hides
  // every row from a role subject to RLS. Measured against a live database as a
  // NOSUPERUSER role: GUC unset -> 0 rows visible, GUC 'bypass' -> 0 rows (the
  // predicate excludes that marker), GUC <tenant uuid> -> all rows. Without the
  // oracle, "identity_rows = 0" would 401 every live bearer in such a
  // deployment, and CI cannot catch it — its Postgres user is a superuser and
  // bypasses RLS.
  it('denies a uuid token absent from both realms, but only when not blind', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ '?column?': 1 }]);

    await expect(isUserTokensRevoked(UUID_USER, 2000, 0)).resolves.toBe(true);

    const [sql] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/COUNT\(\*\)::int AS identity_rows/);
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM users LIMIT 1\) AS users_visible/);
    // Absent uid denies only together with the visibility proof.
    expect(sql).toMatch(
      /identity\.identity_rows = 0 AND visibility\.users_visible/,
    );
    // Ambiguous, and visible-but-not-live, still deny on their own.
    expect(sql).toMatch(/identity\.identity_rows > 1/);
    expect(sql).toMatch(
      /identity\.identity_rows = 1 AND identity\.live_identity_rows <> 1/,
    );
    // The unconditional invisibility-means-revoked predicate must be gone.
    expect(sql).not.toMatch(/identity\.identity_rows <> 1\s/);
  });

  it('keeps uuid identity liveness fail closed for user and admin lifecycle states', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ '?column?': 1 }]);

    await expect(isUserTokensRevoked(UUID_USER, 2000, 0)).resolves.toBe(true);

    const [sql] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE state\.is_live\)::int AS live_identity_rows/);
    expect(sql).toMatch(/is_active = TRUE[\s\S]*LOWER\(COALESCE\(status, ''\)\) = 'active'/);
    expect(sql).toMatch(/COALESCE\(is_deleted, FALSE\) = FALSE/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(sql).toMatch(/merged_into_uid IS NULL/);
    expect(sql).toMatch(/identity\.live_identity_rows <> 1/);
  });

  it('keeps the durable watermark predicate for epoch-stamped tokens', async () => {
    cacheGetMock.mockResolvedValueOnce({ revokedAt: 2000.75 });
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(isUserTokensRevoked(UUID_USER, 2000, 5)).resolves.toBe(false);

    const [sql, marker, issuedAt, uid, hasTokenEpoch, tokenEpoch] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).not.toMatch(/\$4::boolean = FALSE/);
    expect(sql).toMatch(/created_at\s*>=/);
    expect(sql).toMatch(/created_at\s*>\s*COALESCE\(identity\.token_epoch_bumped_at/);
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

  it('R1: atomically bumps the identity epoch and clears both notification-token projections', async () => {
    cacheSetMock.mockResolvedValueOnce(true);
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ revoke_notification_authority: 2 }])
      .mockResolvedValueOnce([{ revoked_at: 2000, epoch_rows: 1 }]);

    await revokeAllUserTokens(UUID_USER, {
      reason: 'logout',
      notificationTenantId: '00000000-0000-4000-8000-000000000001',
    });

    expect(advisoryLockMock).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      `vh:auth:identity:${UUID_USER}`,
    );
    expect(queryRawUnsafeMock.mock.calls[0]).toEqual([
      expect.stringContaining('revoke_notification_authority'),
      '00000000-0000-4000-8000-000000000001',
      UUID_USER,
    ]);
    const [sql, ...params] = queryRawUnsafeMock.mock.calls[1];
    expect(sql).toMatch(/token_epoch = COALESCE\(token_epoch, 0\) \+ 1/);
    expect(sql).toMatch(/token_epoch_bumped_at = NOW\(\)/);
    expect(sql).toMatch(/UPDATE users/);
    expect(sql).toMatch(/device_token\s*=\s*CASE[\s\S]*ELSE NULL END/);
    expect(sql).toMatch(/UPDATE admins/);
    expect(sql).toMatch(/INSERT INTO invalidated_tokens/);
    expect(params[0]).toBe(`user:${UUID_USER}`);
    expect(params[1]).toBe('logout');
    expect(params[2]).toBe(UUID_USER);
    expect(params[3]).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('rejects a uuid revoke-all when no identity epoch row was bumped', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(
      revokeAllUserTokens(UUID_USER, { reason: 'logout' }),
    ).rejects.toMatchObject({ code: 'REVOCATION_WRITE_UNAVAILABLE' });
    expect(cacheSetMock).not.toHaveBeenCalled();
    expect(pushSessionRevokedMock).not.toHaveBeenCalled();
    const [sql] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/identity_count AS MATERIALIZED/);
    expect(sql).toMatch(/AND \(SELECT identity_rows FROM identity_count\) = 1/);
    expect(sql).toMatch(/INSERT INTO invalidated_tokens[\s\S]*FROM epoch_count[\s\S]*WHERE epoch_rows = 1/);
  });

  it('rejects an ambiguous uuid revoke-all without publishing a marker', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ revoked_at: 2000, epoch_rows: 2 }]);

    await expect(
      revokeAllUserTokens(UUID_USER, { reason: 'logout' }),
    ).rejects.toMatchObject({ code: 'REVOCATION_WRITE_UNAVAILABLE' });
    expect(cacheSetMock).not.toHaveBeenCalled();
    expect(pushSessionRevokedMock).not.toHaveBeenCalled();

    const [sql] = queryRawUnsafeMock.mock.calls[0];
    expect(sql.match(/\(SELECT identity_rows FROM identity_count\) = 1/g)).toHaveLength(2);
    expect(sql.match(/WHERE epoch_rows = 1/g)).toHaveLength(2);
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
    queryRawUnsafeMock.mockResolvedValueOnce([{
      identity_rows: 1,
      live_identity_rows: 1,
      token_epoch: 3,
      users_visible: true,
    }]);

    await expect(getCurrentTokenEpoch(UUID_USER)).resolves.toBe(3);
    const [sql, param] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/FROM users\s+WHERE uid = \$1::uuid/);
    expect(sql).toMatch(/FROM admins\s+WHERE uid = \$1::uuid/);
    expect(sql).toMatch(/COUNT\(\*\)::int AS identity_rows/);
    expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE identity\.is_live\)::int AS live_identity_rows/);
    expect(param).toBe(UUID_USER);
  });

  it.each([
    ['missing', { identity_rows: 0, live_identity_rows: 0, token_epoch: 0, users_visible: true }],
    ['inactive', { identity_rows: 1, live_identity_rows: 0, token_epoch: 0, users_visible: true }],
    ['ambiguous', { identity_rows: 2, live_identity_rows: 1, token_epoch: 0, users_visible: true }],
  ])('fails closed for a %s uuid identity', async (_state, row) => {
    queryRawUnsafeMock.mockResolvedValueOnce([row]);
    await expect(getCurrentTokenEpoch(UUID_USER)).rejects.toMatchObject({
      code: 'REVOCATION_CHECK_UNAVAILABLE',
    });
  });

  // Issuance runs on /api/v1/auth, mounted before the tenant middleware, so an
  // RLS-subject role sees zero rows for a perfectly live identity (see the
  // isUserTokensRevoked note above). Denying here would 500 every login while
  // CI, running as a superuser, stays green. Nothing outside tests hard-deletes
  // a users row, so zero rows carries no retirement signal.
  it('treats a BLIND probe as inconclusive rather than retired', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([
      { identity_rows: 0, live_identity_rows: 0, token_epoch: 0, users_visible: false },
    ]);
    await expect(getCurrentTokenEpoch(UUID_USER)).resolves.toBe(0);

    const [sql] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM users LIMIT 1\)\) AS users_visible/);
  });

  it('returns 0 for a non-uuid legacy key without touching the DB', async () => {
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

  it('pushes a jti-scoped session revocation after a durable single-token blacklist', async () => {
    cacheSetMock.mockResolvedValueOnce(true);
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await blacklistToken('jti-1', future, 'logout', {
      requireEvidence: true,
      userId: UUID_USER,
      sessionFamilyId: 'session-family-1',
      stableDeviceId: 'device-1',
    });

    expect(pushSessionRevokedMock).toHaveBeenCalledWith(
      UUID_USER,
      expect.objectContaining({
        reason: 'logout',
        jti: 'jti-1',
        sessionFamilyId: 'session-family-1',
        stableDeviceId: 'device-1',
      }),
    );
  });

  it('allows a caller to publish only after its own post-commit session decision', async () => {
    cacheSetMock.mockResolvedValueOnce(true);
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await blacklistToken('jti-1', future, 'refresh_rotation', {
      requireEvidence: true,
      userId: UUID_USER,
      notifySession: false,
    });

    expect(pushSessionRevokedMock).not.toHaveBeenCalled();
  });
});

// src/tests/unit/jwtMiddlewareCoverage.test.js
//
// Coverage-focused unit suite for jwtMiddleware (roadmap B3.2). Companion to
// src/tests/unit/jwtMiddleware.test.js, which locks in the happy req.user shape
// (uid/role/id + normalisation + uid→id fallback) using real jwt + real DB.
// This file fully mocks jwtUtils + tokenBlacklist + prisma so it can exercise
// the previously-uncovered control flow that the DB-backed suite cannot:
//   - jti blacklist hit → 401 TOKEN_REVOKED
//   - all-user-tokens-revoked → 401 TOKEN_REVOKED
//   - RevocationCheckUnavailableError → 503 fail-closed
//   - a non-revocation error rethrown out of the blacklist try
//   - expired-token branch (verifyToken.lastError = 'TokenExpiredError') → 401 TOKEN_EXPIRED
//   - Hasura custom-claims path (uid + roles + role from x-hasura-*)
//   - mfa_setup narrow-scope token (scope preserved)
//   - the requireSetupScope / enforceFullScope route guards
//   - the full applyActingAsHop delegation matrix (scope block, malformed uid,
//     self no-op, lookup throw, not-found, non-minor, wrong-role, tenant
//     mismatch, success).
//
// Fully mocked — no DB / network. The verifyToken mock is a function carrying a
// settable `.lastError` to mirror the real jwtUtils contract.

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const verifyTokenMock = jest.fn();
verifyTokenMock.lastError = null;
const isTokenBlacklistedMock = jest.fn();
const isUserTokensRevokedMock = jest.fn();
const isDelegatedTupleRevokedMock = jest.fn();
const isSubjectDelegationRevokedMock = jest.fn();

// Re-create the real RevocationCheckUnavailableError so `instanceof` works.
class RevocationCheckUnavailableError extends Error {
  constructor(message = 'Revocation check unavailable') {
    super(message);
    this.name = 'RevocationCheckUnavailableError';
  }
}

const __prismaDefaultMock = { $queryRawUnsafe: queryRawUnsafeMock };
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
jest.unstable_mockModule('../../utils/jwtUtils.js', () => ({
  verifyToken: verifyTokenMock,
}));
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  isTokenBlacklisted: isTokenBlacklistedMock,
  isUserTokensRevoked: isUserTokensRevokedMock,
  isDelegatedTupleRevoked: isDelegatedTupleRevokedMock,
  isSubjectDelegationRevoked: isSubjectDelegationRevokedMock,
  RevocationCheckUnavailableError,
}));

const jwtMiddleware = (await import('../../middleware/jwtMiddleware.js')).default;
const { requireSetupScope, enforceFullScope } = await import('../../middleware/jwtMiddleware.js');

const UID = 'a0000000-0000-4000-8000-000000000abc';

function makeReq(extraHeaders = {}) {
  return {
    headers: { authorization: 'Bearer faketoken', ...extraHeaders },
    connection: { remoteAddress: '127.0.0.1' },
  };
}
function makeRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  queryRawUnsafeMock.mockResolvedValue([]);
  verifyTokenMock.mockReset();
  verifyTokenMock.lastError = null;
  isTokenBlacklistedMock.mockReset();
  isUserTokensRevokedMock.mockReset();
  isDelegatedTupleRevokedMock.mockReset();
  isSubjectDelegationRevokedMock.mockReset();
  isTokenBlacklistedMock.mockResolvedValue(false);
  isUserTokensRevokedMock.mockResolvedValue(false);
  isDelegatedTupleRevokedMock.mockResolvedValue(false);
  isSubjectDelegationRevokedMock.mockResolvedValue(false);
});

// =====================================================================
// Token verification + revocation control flow
// =====================================================================
describe('jwtMiddleware — revocation control flow', () => {
  it('rejects an expired token with 401 TOKEN_EXPIRED', async () => {
    verifyTokenMock.mockReturnValue(null);
    verifyTokenMock.lastError = 'TokenExpiredError';
    const req = makeReq(); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  it('rejects an invalid-signature token with 401 TOKEN_INVALID', async () => {
    verifyTokenMock.mockReturnValue(null);
    verifyTokenMock.lastError = 'JsonWebTokenError';
    const req = makeReq(); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('rejects a blacklisted jti with 401 TOKEN_REVOKED', async () => {
    verifyTokenMock.mockReturnValue({ uid: UID, role: 'PATIENT', jti: 'bad-jti', iat: 1000 });
    isTokenBlacklistedMock.mockResolvedValue(true);
    const req = makeReq(); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_REVOKED');
    expect(isTokenBlacklistedMock).toHaveBeenCalledWith('bad-jti');
  });

  it('rejects when all user tokens were revoked (force-logout) with 401', async () => {
    verifyTokenMock.mockReturnValue({ uid: UID, role: 'PATIENT', jti: 'ok-jti', iat: 1000, token_epoch: 7 });
    isUserTokensRevokedMock.mockResolvedValue(true);
    const req = makeReq(); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_REVOKED');
    expect(isUserTokensRevokedMock).toHaveBeenCalledWith(String(UID), 1000, 7);
  });

  it('fails closed with 503 when the revocation store is unreachable', async () => {
    verifyTokenMock.mockReturnValue({ uid: UID, role: 'PATIENT', jti: 'j', iat: 1000 });
    isTokenBlacklistedMock.mockRejectedValue(new RevocationCheckUnavailableError('redis + db down'));
    const req = makeReq(); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('REVOCATION_CHECK_UNAVAILABLE');
  });

  it('rethrows a non-revocation error out of the blacklist try', async () => {
    verifyTokenMock.mockReturnValue({ uid: UID, role: 'PATIENT', jti: 'j', iat: 1000 });
    isTokenBlacklistedMock.mockRejectedValue(new Error('unexpected boom'));
    const req = makeReq(); const res = makeRes();
    await expect(jwtMiddleware(req, res, () => {})).rejects.toThrow('unexpected boom');
  });

  it('checks identity liveness even when the token carries no jti/iat', async () => {
    verifyTokenMock.mockReturnValue({ uid: UID, role: 'DOCTOR' });
    let nextCalled = false;
    const req = makeReq(); const res = makeRes();
    await jwtMiddleware(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(isTokenBlacklistedMock).not.toHaveBeenCalled();
    expect(isUserTokensRevokedMock).toHaveBeenCalledWith(String(UID), undefined, undefined);
  });

  it('denies a no-iat token when its identity is missing or inactive', async () => {
    verifyTokenMock.mockReturnValue({ uid: UID, role: 'DOCTOR' });
    isUserTokensRevokedMock.mockResolvedValue(true);
    const req = makeReq(); const res = makeRes();

    await jwtMiddleware(req, res, () => {});

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_REVOKED');
    expect(isUserTokensRevokedMock).toHaveBeenCalledWith(String(UID), undefined, undefined);
  });

  it('includes a Hasura-only identity claim in revoke-all enforcement', async () => {
    verifyTokenMock.mockReturnValue({
      iat: 1000,
      token_epoch: 0,
      'https://hasura.io/jwt/claims': {
        'x-hasura-user-id': UID,
        'x-hasura-default-role': 'doctor',
      },
    });
    isUserTokensRevokedMock.mockResolvedValue(true);
    const req = makeReq(); const res = makeRes();

    await jwtMiddleware(req, res, () => {});

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_REVOKED');
    expect(isUserTokensRevokedMock).toHaveBeenCalledWith(String(UID), 1000, 0);
  });

  it('uses the Hasura app identity instead of a generic provider subject', async () => {
    verifyTokenMock.mockReturnValue({
      sub: 'oidc-provider-subject',
      userId: 77,
      iat: 1000,
      token_epoch: 0,
      'https://hasura.io/jwt/claims': {
        'x-hasura-user-id': UID,
        'x-hasura-default-role': 'doctor',
        'x-hasura-user-int-id': '77',
      },
    });
    let nextCalled = false;
    const req = makeReq(); const res = makeRes();

    await jwtMiddleware(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(isUserTokensRevokedMock).toHaveBeenCalledWith(String(UID), 1000, 0);
    expect(req.user.uid).toBe(UID);
    expect(req.user.id).toBe(77);
  });

  it.each([
    ['Hasura', { 'https://hasura.io/jwt/claims': { 'x-hasura-user-id': 'b0000000-0000-4000-8000-000000000abc' } }],
    ['user_id', { user_id: 'different-app-identity' }],
    ['userId', { userId: 'different-app-identity' }],
  ])('fails closed when uid conflicts with the %s app identity alias', async (_label, extra) => {
    verifyTokenMock.mockReturnValue({ uid: UID, role: 'PATIENT', ...extra });
    let nextCalled = false;
    const req = makeReq(); const res = makeRes();

    await jwtMiddleware(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
    expect(isUserTokensRevokedMock).not.toHaveBeenCalled();
  });

  it('accepts case-only UUID aliases and signed numeric DB-ID projections', async () => {
    verifyTokenMock.mockReturnValue({
      uid: UID.toUpperCase(),
      user_id: UID,
      userId: 77,
      id: 77,
      role: 'DOCTOR',
      'https://hasura.io/jwt/claims': { 'x-hasura-user-id': UID },
    });
    let nextCalled = false;
    const req = makeReq(); const res = makeRes();

    await jwtMiddleware(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(req.user.uid).toBe(UID);
    expect(req.user.id).toBe(77);
    expect(isUserTokensRevokedMock).toHaveBeenCalledWith(UID, undefined, undefined);
  });
});

// =====================================================================
// Claim derivation: Hasura claims, mfa_setup scope, optional fields
// =====================================================================
describe('jwtMiddleware — claim derivation', () => {
  it('surfaces the stable session and device selectors for logout and WS tickets', async () => {
    verifyTokenMock.mockReturnValue({
      uid: UID,
      role: 'PATIENT',
      id: 42,
      sessionFamilyId: 'session-family-1',
      stableDeviceId: 'device-1',
    });
    const req = makeReq();
    const res = makeRes();

    await jwtMiddleware(req, res, () => {});

    expect(req.user).toMatchObject({
      sessionFamilyId: 'session-family-1',
      stableDeviceId: 'device-1',
    });
  });

  it('does not authenticate a uid-only token when the users.id lookup fails', async () => {
    const uncachedUid = 'a0000000-0000-4000-8000-00000000f001';
    verifyTokenMock.mockReturnValue({ uid: uncachedUid, role: 'DOCTOR' });
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('identity database unavailable'));
    let nextCalled = false;

    await expect(jwtMiddleware(makeReq(), makeRes(), () => { nextCalled = true; }))
      .rejects.toThrow('identity database unavailable');
    expect(nextCalled).toBe(false);
  });

  it('derives uid/role/roles from Hasura custom claims', async () => {
    verifyTokenMock.mockReturnValue({
      'https://hasura.io/jwt/claims': {
        'x-hasura-user-id': UID,
        'x-hasura-default-role': 'nurse',
        'x-hasura-allowed-roles': ['nurse', 'doctor'],
        'x-hasura-user-int-id': '77',
      },
    });
    let nextCalled = false;
    const req = makeReq(); const res = makeRes();
    await jwtMiddleware(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(req.user.uid).toBe(UID);
    expect(req.user.role).toBe('NURSING_STAFF');           // normalised
    expect(req.user.roles).toEqual(['NURSING_STAFF', 'DOCTOR']);
    expect(req.user.id).toBe(77);                            // x-hasura-user-int-id
  });

  it('preserves a narrow mfa_setup scope + rawRole', async () => {
    verifyTokenMock.mockReturnValue({ uid: UID, role: 'SUPER_ADMIN', id: 3, scope: 'mfa_setup' });
    const req = makeReq(); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(req.user.scope).toBe('mfa_setup');
    expect(req.user.rawRole).toBe('SUPER_ADMIN');
    expect(req.user.role).toBe('ADMIN');
  });

  it('returns 400 when no uid-like claim is present', async () => {
    verifyTokenMock.mockReturnValue({ role: 'PATIENT' });
    const req = makeReq(); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Missing or invalid UID/);
  });

  it('defaults role to PATIENT and carries deviceType + phone + email when present', async () => {
    verifyTokenMock.mockReturnValue({
      uid: UID, id: 5, phone: '+919000000000', email: 'p@test.local', deviceType: 'mobile',
    });
    const req = makeReq(); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(req.user.role).toBe('PATIENT');
    expect(req.user.deviceType).toBe('mobile');
    expect(req.user.phone).toBe('+919000000000');
    expect(req.user.email).toBe('p@test.local');
  });

  it('rejects a missing Authorization header with 401', async () => {
    const req = { headers: {}, connection: {} }; const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });
});

// =====================================================================
// requireSetupScope / enforceFullScope route guards
// =====================================================================
describe('requireSetupScope', () => {
  it('passes a mfa_setup-scoped request', () => {
    const req = { user: { scope: 'mfa_setup' } }; const res = makeRes();
    let nextCalled = false;
    requireSetupScope(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
  it('rejects a full-scope request with 403', () => {
    const req = { user: { scope: 'full' } }; const res = makeRes();
    requireSetupScope(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('SETUP_SCOPE_REQUIRED');
  });
});

describe('enforceFullScope', () => {
  it('passes a full-scope request', () => {
    const req = { user: { scope: 'full' } }; const res = makeRes();
    let nextCalled = false;
    enforceFullScope(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
  it('passes through when scope is unset', () => {
    const req = { user: {} }; const res = makeRes();
    let nextCalled = false;
    enforceFullScope(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
  it('rejects a narrow-scope request with 403 INSUFFICIENT_SCOPE', () => {
    const req = { user: { scope: 'mfa_setup' } }; const res = makeRes();
    enforceFullScope(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
  });
});

// =====================================================================
// applyActingAsHop — full delegation matrix
// =====================================================================
describe('jwtMiddleware — acting-as delegation', () => {
  const GUARDIAN_UID = 'b0000000-0000-4000-8000-000000000001';
  const DEP_UID = 'c0000000-0000-4000-8000-000000000002';

  function guardianToken(extra = {}) {
    return { uid: GUARDIAN_UID, id: 10, role: 'PATIENT', scope: 'full', ...extra };
  }

  function liveDelegationRow(overrides = {}) {
    return {
      dep_id: 20, dep_uid: DEP_UID, dep_phone: '+919111111111', dep_email: 'kid@test.local',
      dep_role: 'PATIENT', dep_is_minor: true, dep_is_minor_now: true,
      dep_tenant_id: 'tenant-A',
      dep_is_active: true, dep_status: 'active', dep_is_deleted: false,
      dep_deleted_at: null, dep_merged_into_uid: null,
      g_id: 10, g_uid: GUARDIAN_UID, g_role: 'PATIENT', g_tenant_id: 'tenant-A',
      g_is_active: true, g_status: 'active', g_is_deleted: false,
      g_deleted_at: null, g_merged_into_uid: null,
      ...overrides,
    };
  }

  it('blocks acting-as for a narrow-scope token with 403', async () => {
    verifyTokenMock.mockReturnValue(guardianToken({ scope: 'mfa_setup' }));
    const req = makeReq({ 'x-acting-as-uid': DEP_UID }); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('NOT_AUTHORISED_TO_ACT_AS');
  });

  it('rejects a malformed X-Acting-As-Uid with 403', async () => {
    verifyTokenMock.mockReturnValue(guardianToken());
    const req = makeReq({ 'x-acting-as-uid': 'not-a-uuid' }); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  it('is a no-op when acting-as points at the bearer themselves', async () => {
    verifyTokenMock.mockReturnValue(guardianToken());
    let nextCalled = false;
    const req = makeReq({ 'x-acting-as-uid': GUARDIAN_UID }); const res = makeRes();
    await jwtMiddleware(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(req.user.uid).toBe(GUARDIAN_UID);
    expect(req.acting).toBeUndefined();
    // No guardian-link query should be issued for the self case.
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('denies with 403 when the guardian-link lookup throws', async () => {
    verifyTokenMock.mockReturnValue(guardianToken());
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('db down'));
    const req = makeReq({ 'x-acting-as-uid': DEP_UID }); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  it('denies with 403 when no guardian link exists', async () => {
    verifyTokenMock.mockReturnValue(guardianToken());
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    const req = makeReq({ 'x-acting-as-uid': DEP_UID }); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  it('denies when the dependent is not a minor', async () => {
    verifyTokenMock.mockReturnValue(guardianToken());
    queryRawUnsafeMock.mockResolvedValueOnce([{
      dep_id: 20, dep_uid: DEP_UID, dep_role: 'PATIENT', dep_is_minor: false,
      dep_tenant_id: 't1', g_tenant_id: 't1',
    }]);
    const req = makeReq({ 'x-acting-as-uid': DEP_UID }); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  it('denies when the dependent is not a PATIENT', async () => {
    verifyTokenMock.mockReturnValue(guardianToken());
    queryRawUnsafeMock.mockResolvedValueOnce([{
      dep_id: 20, dep_uid: DEP_UID, dep_role: 'DOCTOR', dep_is_minor: true,
      dep_tenant_id: 't1', g_tenant_id: 't1',
    }]);
    const req = makeReq({ 'x-acting-as-uid': DEP_UID }); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  it('denies on a tenant mismatch between guardian and dependent', async () => {
    verifyTokenMock.mockReturnValue(guardianToken());
    queryRawUnsafeMock.mockResolvedValueOnce([{
      dep_id: 20, dep_uid: DEP_UID, dep_role: 'PATIENT', dep_is_minor: true,
      dep_tenant_id: 'tenant-B', g_tenant_id: 'tenant-A',
    }]);
    const req = makeReq({ 'x-acting-as-uid': DEP_UID }); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  it.each([
    ['inactive', { g_is_active: false }],
    ['deleted', { g_is_deleted: true, g_deleted_at: new Date().toISOString() }],
    ['merged', { g_merged_into_uid: 'd0000000-0000-4000-8000-000000000003' }],
    ['wrong-role', { g_role: 'NURSING_STAFF' }],
  ])('denies when the guardian is %s', async (_label, lifecycle) => {
    verifyTokenMock.mockReturnValue(guardianToken());
    queryRawUnsafeMock.mockResolvedValueOnce([liveDelegationRow(lifecycle)]);
    const req = makeReq({ 'x-acting-as-uid': DEP_UID }); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  // Subject-side revocation gate (audit MEDIUM "REST acting-as revocation"):
  // the bearer checks cover only the guardian's identity; a delegated request
  // must additionally fail when the DEPENDENT's sessions or the delegated
  // guardian↔dependent tuple are revoked — mirroring the WS handshake.

  it('denies with 403 when the dependent subject\'s sessions are revoked', async () => {
    verifyTokenMock.mockReturnValue(guardianToken({ iat: 1000 }));
    isSubjectDelegationRevokedMock.mockResolvedValue(true);
    queryRawUnsafeMock.mockResolvedValueOnce([liveDelegationRow()]);
    const req = makeReq({ 'x-acting-as-uid': DEP_UID }); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('NOT_AUTHORISED_TO_ACT_AS');
    // Subject check ran against the DEPENDENT with the bearer's iat via the
    // recoverable timestamp-only predicate (the guardian's epoch is
    // meaningless for the dependent, and the subject's epoch COUNTER must not
    // deny forever — only its bump timestamp vs the bearer's iat matters).
    expect(isSubjectDelegationRevokedMock).toHaveBeenCalledWith(DEP_UID, 1000);
  });

  it('denies with 403 when the delegated guardian↔dependent tuple is revoked', async () => {
    verifyTokenMock.mockReturnValue(guardianToken({ iat: 1000 }));
    isDelegatedTupleRevokedMock.mockResolvedValue(true);
    queryRawUnsafeMock.mockResolvedValueOnce([liveDelegationRow()]);
    const req = makeReq({ 'x-acting-as-uid': DEP_UID }); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('NOT_AUTHORISED_TO_ACT_AS');
    expect(isDelegatedTupleRevokedMock).toHaveBeenCalledWith(GUARDIAN_UID, DEP_UID, 1000);
  });

  it('denies a no-iat delegated token when the dependent subject is revoked', async () => {
    verifyTokenMock.mockReturnValue(guardianToken());
    isSubjectDelegationRevokedMock.mockResolvedValue(true);
    queryRawUnsafeMock.mockResolvedValueOnce([liveDelegationRow()]);
    const req = makeReq({ 'x-acting-as-uid': DEP_UID }); const res = makeRes();

    await jwtMiddleware(req, res, () => {});

    expect(res.statusCode).toBe(403);
    expect(isSubjectDelegationRevokedMock).toHaveBeenCalledWith(DEP_UID, null);
    expect(isDelegatedTupleRevokedMock).not.toHaveBeenCalled();
  });

  it('denies a no-iat delegated token when its guardian-dependent tuple is revoked', async () => {
    verifyTokenMock.mockReturnValue(guardianToken());
    isDelegatedTupleRevokedMock.mockResolvedValue(true);
    queryRawUnsafeMock.mockResolvedValueOnce([liveDelegationRow()]);
    const req = makeReq({ 'x-acting-as-uid': DEP_UID }); const res = makeRes();

    await jwtMiddleware(req, res, () => {});

    expect(res.statusCode).toBe(403);
    expect(isSubjectDelegationRevokedMock).toHaveBeenCalledWith(DEP_UID, null);
    expect(isDelegatedTupleRevokedMock).toHaveBeenCalledWith(GUARDIAN_UID, DEP_UID, null);
  });

  it('fails CLOSED with 503 when the subject revocation store is unreachable', async () => {
    verifyTokenMock.mockReturnValue(guardianToken({ iat: 1000 }));
    isSubjectDelegationRevokedMock
      .mockRejectedValueOnce(new RevocationCheckUnavailableError());
    queryRawUnsafeMock.mockResolvedValueOnce([liveDelegationRow()]);
    const req = makeReq({ 'x-acting-as-uid': DEP_UID }); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('REVOCATION_CHECK_UNAVAILABLE');
  });

  it('denies when the dependent has turned 18 since is_minor was stamped', async () => {
    verifyTokenMock.mockReturnValue(guardianToken());
    // Stale flag: is_minor still TRUE, but the check-time DOB recompute says
    // the dependent is an adult now — delegation must end at 18.
    queryRawUnsafeMock.mockResolvedValueOnce([
      liveDelegationRow({ dep_is_minor_now: false }),
    ]);
    const req = makeReq({ 'x-acting-as-uid': DEP_UID }); const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('NOT_AUTHORISED_TO_ACT_AS');
  });

  it('rewrites req.user to the dependent and records req.acting on success', async () => {
    verifyTokenMock.mockReturnValue(guardianToken({
      sessionFamilyId: 'guardian-session-family',
      stableDeviceId: 'guardian-device',
    }));
    queryRawUnsafeMock.mockResolvedValueOnce([liveDelegationRow()]);
    let nextCalled = false;
    const req = makeReq({ 'x-acting-as-uid': DEP_UID }); const res = makeRes();
    await jwtMiddleware(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(req.user.uid).toBe(DEP_UID);
    expect(req.user.id).toBe(20);
    expect(req.user.role).toBe('PATIENT');
    expect(req.user.tenant_id).toBe('tenant-A');
    expect(req.user.sessionFamilyId).toBe('guardian-session-family');
    expect(req.user.stableDeviceId).toBe('guardian-device');
    expect(req.acting).toMatchObject({ actorUid: GUARDIAN_UID, actorId: 10 });
  });
});

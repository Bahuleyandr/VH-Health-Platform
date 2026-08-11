import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn()
};

const verifyIdTokenMock = jest.fn();
const issueAccessTokenAndClaimSessionMock = jest.fn();
const generateRefreshTokenMock = jest.fn();
const ensureHospitalNumberMock = jest.fn();
const revokeAllUserTokensMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

jest.unstable_mockModule('../../utils/firebaseAdmin.js', () => ({
  default: {
    auth: () => ({
      verifyIdToken: verifyIdTokenMock
    })
  }
}));

jest.unstable_mockModule('../../utils/phoneUtils.js', () => ({
  normalizePhone: phone => {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits.length === 10 ? `+91${digits}` : `+${digits}`;
  }
}));

jest.unstable_mockModule('../../services/patient/patientIdentifierService.js', () => ({
  ensureHospitalNumber: ensureHospitalNumberMock
}));

jest.unstable_mockModule('../../services/auth/loginSessionHelper.js', () => ({
  issueAccessTokenAndClaimSession: issueAccessTokenAndClaimSessionMock,
  generateRefreshToken: generateRefreshTokenMock
}));

jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  revokeAllUserTokens: revokeAllUserTokensMock
}));

const { authenticateWithFirebase } = await import('../../services/auth/firebaseAuthService.js');

describe('firebaseAuthService.authenticateWithFirebase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    verifyIdTokenMock.mockResolvedValue({
      uid: 'firebase-uid-123',
      phone_number: '+91 98765 43210',
      email: 'patient@example.com',
      email_verified: true
    });
    issueAccessTokenAndClaimSessionMock.mockResolvedValue({
      accessToken: 'vh-jwt-token',
      sessionFamilyId: 'firebase-session-family'
    });
    generateRefreshTokenMock.mockReturnValue('vh-refresh-token');
    ensureHospitalNumberMock.mockResolvedValue('VH-000123');
    prismaMock.$executeRawUnsafe.mockResolvedValue(undefined);
  });

  it('returns isNewUser for a new Firebase OTP patient login', async () => {
    const insertedUser = {
      id: 42,
      uid: '11111111-1111-4111-8111-111111111111',
      tenant_id: '00000000-0000-4000-8000-000000000001',
      name: null,
      phone: '+919876543210',
      email: 'patient@example.com',
      role: 'PATIENT',
      firebase_uid: 'firebase-uid-123',
      gender: null,
      email_verified: true,
      is_active: true,
      last_login: new Date('2026-06-08T00:00:00.000Z')
    };

    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([insertedUser]);

    const result = await authenticateWithFirebase(
      'firebase-id-token',
      null,
      {
        headers: { 'user-agent': 'jest' },
        connection: { remoteAddress: '127.0.0.1' }
      },
      { deviceType: 'mobile' }
    );

    expect(verifyIdTokenMock).toHaveBeenCalledWith('firebase-id-token', true);
    expect(issueAccessTokenAndClaimSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userUid: insertedUser.uid,
        deviceType: 'mobile',
        tokenPayload: expect.objectContaining({
          uid: insertedUser.uid,
          id: insertedUser.id,
          phone: insertedUser.phone,
          role: 'PATIENT',
          firebaseUid: 'firebase-uid-123'
        })
      })
    );
    // C-9 companion (audit 2026-06-18): the PRIMARY patient login path must
    // mint a SEPARATE type:'refresh' token, else the access token is the only
    // credential and the bearer-rotation it used to rely on now 401s at
    // /refresh-token. Mirror the identity AuthService._generateRefreshToken uses.
    expect(generateRefreshTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: insertedUser.uid,
        id: insertedUser.id,
        phone: insertedUser.phone,
        role: 'PATIENT',
        sessionFamilyId: 'firebase-session-family'
      })
    );
    expect(result).toMatchObject({
      accessToken: 'vh-jwt-token',
      refreshToken: 'vh-refresh-token',
      isNewUser: true,
      user: {
        uid: insertedUser.uid,
        id: insertedUser.id,
        phone: '+919876543210',
        hospital_number: 'VH-000123',
        isNewUser: true,
        profileComplete: false
      }
    });
  });

  // SEC-5: identity must be resolved WITHIN a tenant, never across tenants.
  const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';

  it('SEC-5: scopes the user lookup by the default tenant when no tenant signal is present', async () => {
    const existingUser = {
      id: 7,
      uid: '33333333-3333-4333-8333-333333333333',
      tenant_id: DEFAULT_TENANT,
      name: 'Existing',
      phone: '+919876543210',
      email: 'e@example.com',
      role: 'PATIENT',
      firebase_uid: 'firebase-uid-123',
      gender: 'OTHER',
      email_verified: true,
      is_active: true,
      last_login: new Date('2026-06-08T00:00:00.000Z')
    };
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([existingUser]);

    await authenticateWithFirebase(
      'firebase-id-token',
      null,
      { headers: { 'user-agent': 'jest' }, connection: { remoteAddress: '127.0.0.1' } },
      { deviceType: 'mobile' }
    );

    // First $queryRawUnsafe call is the SELECT — it must be tenant-scoped and
    // bind the default tenant as the first parameter.
    const [sql, ...params] = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1::uuid/i);
    expect(sql).not.toMatch(/WHERE\s+phone\s*=\s*\$1\s+OR\s+firebase_uid/i);
    expect(params[0]).toBe(DEFAULT_TENANT);
  });

  it('SEC-5: sets tenant_id explicitly on the registration INSERT', async () => {
    const insertedUser = {
      id: 99,
      uid: '44444444-4444-4444-8444-444444444444',
      tenant_id: DEFAULT_TENANT,
      name: null,
      phone: '+919876543210',
      email: null,
      role: 'PATIENT',
      firebase_uid: 'firebase-uid-123',
      gender: null,
      email_verified: false,
      is_active: true,
      last_login: new Date('2026-06-08T00:00:00.000Z')
    };
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([]) // SELECT → no existing user
      .mockResolvedValueOnce([insertedUser]); // INSERT ... RETURNING

    await authenticateWithFirebase(
      'firebase-id-token',
      null,
      { headers: { 'user-agent': 'jest' }, connection: { remoteAddress: '127.0.0.1' } },
      { deviceType: 'mobile' }
    );

    const [insertSql, ...insertParams] = prismaMock.$queryRawUnsafe.mock.calls[1];
    expect(insertSql).toMatch(/INSERT INTO users\s*\(\s*tenant_id\b/i);
    expect(insertParams[0]).toBe(DEFAULT_TENANT);
  });

  it('rejects a tombstoned user and does not mint a VH session', async () => {
    const deletedUser = {
      id: 77,
      uid: '77777777-7777-4777-8777-777777777777',
      tenant_id: DEFAULT_TENANT,
      name: null,
      phone: null,
      email: null,
      role: 'PATIENT',
      firebase_uid: 'firebase-uid-123',
      gender: null,
      email_verified: false,
      is_active: false,
      status: 'deleted',
      is_deleted: true,
      deleted_at: new Date('2026-07-03T00:00:00.000Z'),
      last_login: null
    };
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([deletedUser]);

    await expect(
      authenticateWithFirebase(
        'firebase-id-token',
        null,
        { headers: { 'user-agent': 'jest' }, connection: { remoteAddress: '127.0.0.1' } },
        { deviceType: 'mobile' }
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'ACCOUNT_DELETED'
    });

    expect(issueAccessTokenAndClaimSessionMock).not.toHaveBeenCalled();
    expect(generateRefreshTokenMock).not.toHaveBeenCalled();
  });

  it('rejects a merged-away patient record and does not mint a VH session', async () => {
    const mergedUser = {
      id: 88,
      uid: '88888888-8888-4888-8888-888888888888',
      tenant_id: DEFAULT_TENANT,
      name: null,
      phone: '+919876543210',
      email: null,
      role: 'PATIENT',
      firebase_uid: 'firebase-uid-123',
      gender: null,
      email_verified: false,
      is_active: false,
      status: 'merged',
      merged_into_uid: '99999999-9999-4999-8999-999999999999',
      is_deleted: false,
      deleted_at: null,
      last_login: null
    };
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([mergedUser]);

    await expect(
      authenticateWithFirebase(
        'firebase-id-token',
        null,
        { headers: { 'user-agent': 'jest' }, connection: { remoteAddress: '127.0.0.1' } },
        { deviceType: 'mobile' }
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'ACCOUNT_MERGED'
    });

    // The lookup itself must sort merged records last so a shared phone
    // resolves to the survivor when one exists.
    const [lookupSql] = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(lookupSql).toMatch(/ORDER BY CASE WHEN merged_into_uid IS NOT NULL OR status = 'merged' THEN 1 ELSE 0 END/);
    expect(issueAccessTokenAndClaimSessionMock).not.toHaveBeenCalled();
    expect(generateRefreshTokenMock).not.toHaveBeenCalled();
  });

  // R1 — retained-Firebase-session laundering. After logout/revoke-all bumps
  // the identity's token_epoch (stamping token_epoch_bumped_at), a Firebase ID
  // token whose auth_time predates the bump is a PRE-revocation authentication
  // and must NOT mint fresh VH tokens — otherwise a device that kept its
  // Firebase session silently resurrects access the revocation was supposed
  // to end. A fresh OTP produces a new auth_time and passes.
  describe('R1: Firebase re-login under an old epoch is refused', () => {
    const baseUser = {
      id: 7,
      uid: '33333333-3333-4333-8333-333333333333',
      tenant_id: DEFAULT_TENANT,
      name: 'Existing',
      phone: '+919876543210',
      email: 'e@example.com',
      role: 'PATIENT',
      firebase_uid: 'firebase-uid-123',
      gender: 'OTHER',
      email_verified: true,
      is_active: true,
      last_login: new Date('2026-06-08T00:00:00.000Z')
    };
    const req = {
      headers: { 'user-agent': 'jest' },
      connection: { remoteAddress: '127.0.0.1' }
    };

    it('refuses an ID token whose auth_time predates token_epoch_bumped_at', async () => {
      const bumpedAt = new Date('2026-08-10T12:00:00.000Z');
      // Firebase authentication (the OTP) happened an hour BEFORE the revoke-all.
      verifyIdTokenMock.mockResolvedValue({
        uid: 'firebase-uid-123',
        phone_number: '+91 98765 43210',
        auth_time: Math.floor(new Date('2026-08-10T11:00:00.000Z').getTime() / 1000)
      });
      prismaMock.$queryRawUnsafe.mockResolvedValueOnce([
        { ...baseUser, token_epoch_bumped_at: bumpedAt }
      ]);

      await expect(
        authenticateWithFirebase('firebase-id-token', null, req, { deviceType: 'mobile' })
      ).rejects.toMatchObject({
        statusCode: 401,
        code: 'FIREBASE_REAUTH_REQUIRED'
      });

      // No VH credential of any kind may be minted for the stale session.
      expect(issueAccessTokenAndClaimSessionMock).not.toHaveBeenCalled();
      expect(generateRefreshTokenMock).not.toHaveBeenCalled();
    });

    it('refuses a bumped identity when Firebase omits auth_time', async () => {
      verifyIdTokenMock.mockResolvedValue({
        uid: 'firebase-uid-123',
        phone_number: '+91 98765 43210'
      });
      prismaMock.$queryRawUnsafe.mockResolvedValueOnce([
        { ...baseUser, token_epoch: 2, token_epoch_bumped_at: new Date('2026-08-10T12:00:00.000Z') }
      ]);

      await expect(
        authenticateWithFirebase('firebase-id-token', null, req, { deviceType: 'mobile' })
      ).rejects.toMatchObject({ code: 'FIREBASE_REAUTH_REQUIRED' });
      expect(issueAccessTokenAndClaimSessionMock).not.toHaveBeenCalled();
    });

    it('accepts an ID token whose auth_time is AFTER the bump (fresh OTP re-login)', async () => {
      const bumpedAt = new Date('2026-08-10T12:00:00.000Z');
      verifyIdTokenMock.mockResolvedValue({
        uid: 'firebase-uid-123',
        phone_number: '+91 98765 43210',
        auth_time: Math.floor(new Date('2026-08-10T12:05:00.000Z').getTime() / 1000)
      });
      prismaMock.$queryRawUnsafe
        .mockResolvedValueOnce([{ ...baseUser, token_epoch_bumped_at: bumpedAt }]);

      const result = await authenticateWithFirebase(
        'firebase-id-token', null, req, { deviceType: 'mobile' }
      );

      expect(result.accessToken).toBe('vh-jwt-token');
      expect(issueAccessTokenAndClaimSessionMock).toHaveBeenCalled();
    });

    it('accepts a never-revoked identity (token_epoch_bumped_at null) regardless of auth_time', async () => {
      verifyIdTokenMock.mockResolvedValue({
        uid: 'firebase-uid-123',
        phone_number: '+91 98765 43210',
        auth_time: Math.floor(new Date('2026-01-01T00:00:00.000Z').getTime() / 1000)
      });
      prismaMock.$queryRawUnsafe
        .mockResolvedValueOnce([{ ...baseUser, token_epoch_bumped_at: null }]);

      const result = await authenticateWithFirebase(
        'firebase-id-token', null, req, { deviceType: 'mobile' }
      );

      expect(result.accessToken).toBe('vh-jwt-token');
    });

    it('the user lookup SELECT carries token_epoch_bumped_at so the gate has its input', async () => {
      prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ ...baseUser, token_epoch_bumped_at: null }]);
      await authenticateWithFirebase('firebase-id-token', null, req, { deviceType: 'mobile' });
      const [lookupSql] = prismaMock.$queryRawUnsafe.mock.calls[0];
      expect(lookupSql).toMatch(/token_epoch_bumped_at/);
    });
  });

  it('SEC-5/W4: honours the per-tenant subdomain (SaaS path)', async () => {
    const SAAS_TENANT = '55555555-5555-4555-8555-555555555555';
    const req = {
      // W4: the tenant comes from the Host subdomain (flat <slug>-api), not a header.
      hostname: 'saas-api.localhost',
      headers: { 'user-agent': 'jest' },
      connection: { remoteAddress: '127.0.0.1' }
    };

    // resolveTenantForRequest → tenantFromHost resolves the 'saas' subdomain via
    // getTenantBySlug → prisma.$queryRawUnsafe. Return an active tenant, then the
    // user-lookup SELECT (empty), then the INSERT RETURNING row.
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: SAAS_TENANT, status: 'active' }]) // getTenantBySlug
      .mockResolvedValueOnce([]) // user SELECT (scoped)
      .mockResolvedValueOnce([
        {
          id: 1,
          uid: '66666666-6666-4666-8666-666666666666',
          tenant_id: SAAS_TENANT,
          name: null,
          phone: '+919876543210',
          email: null,
          role: 'PATIENT',
          firebase_uid: 'firebase-uid-123',
          gender: null,
          email_verified: false,
          is_active: true,
          last_login: new Date()
        }
      ]);

    await authenticateWithFirebase('firebase-id-token', null, req, { deviceType: 'mobile' });

    // The user-lookup SELECT (2nd call) must bind the SaaS tenant, not default.
    const selectParams = prismaMock.$queryRawUnsafe.mock.calls[1];
    expect(selectParams[1]).toBe(SAAS_TENANT);
    // And the INSERT (3rd call) must persist the SaaS tenant.
    const insertParams = prismaMock.$queryRawUnsafe.mock.calls[2];
    expect(insertParams[1]).toBe(SAAS_TENANT);
  });
});

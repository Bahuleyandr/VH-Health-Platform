import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

const verifyIdTokenMock = jest.fn();
const issueAccessTokenAndClaimSessionMock = jest.fn();
const ensureHospitalNumberMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../../utils/firebaseAdmin.js', () => ({
  default: {
    auth: () => ({
      verifyIdToken: verifyIdTokenMock,
    }),
  },
}));

jest.unstable_mockModule('../../utils/phoneUtils.js', () => ({
  normalizePhone: (phone) => {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits.length === 10 ? `+91${digits}` : `+${digits}`;
  },
}));

jest.unstable_mockModule('../../services/patient/patientIdentifierService.js', () => ({
  ensureHospitalNumber: ensureHospitalNumberMock,
}));

jest.unstable_mockModule('../../services/auth/loginSessionHelper.js', () => ({
  issueAccessTokenAndClaimSession: issueAccessTokenAndClaimSessionMock,
}));

const { authenticateWithFirebase } = await import(
  '../../services/auth/firebaseAuthService.js'
);

describe('firebaseAuthService.authenticateWithFirebase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    verifyIdTokenMock.mockResolvedValue({
      uid: 'firebase-uid-123',
      phone_number: '+91 98765 43210',
      email: 'patient@example.com',
      email_verified: true,
    });
    issueAccessTokenAndClaimSessionMock.mockResolvedValue({
      accessToken: 'vh-jwt-token',
    });
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
      last_login: new Date('2026-06-08T00:00:00.000Z'),
    };

    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([insertedUser]);

    const result = await authenticateWithFirebase(
      'firebase-id-token',
      null,
      {
        headers: { 'user-agent': 'jest' },
        connection: { remoteAddress: '127.0.0.1' },
      },
      { deviceType: 'mobile' },
    );

    expect(verifyIdTokenMock).toHaveBeenCalledWith('firebase-id-token');
    expect(issueAccessTokenAndClaimSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userUid: insertedUser.uid,
        deviceType: 'mobile',
        tokenPayload: expect.objectContaining({
          uid: insertedUser.uid,
          id: insertedUser.id,
          phone: insertedUser.phone,
          role: 'PATIENT',
          firebaseUid: 'firebase-uid-123',
        }),
      }),
    );
    expect(result).toMatchObject({
      accessToken: 'vh-jwt-token',
      isNewUser: true,
      user: {
        uid: insertedUser.uid,
        id: insertedUser.id,
        phone: '+919876543210',
        hospital_number: 'VH-000123',
        isNewUser: true,
        profileComplete: false,
      },
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
      last_login: new Date('2026-06-08T00:00:00.000Z'),
    };
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([existingUser]);

    await authenticateWithFirebase(
      'firebase-id-token',
      null,
      { headers: { 'user-agent': 'jest' }, connection: { remoteAddress: '127.0.0.1' } },
      { deviceType: 'mobile' },
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
      last_login: new Date('2026-06-08T00:00:00.000Z'),
    };
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([]) // SELECT → no existing user
      .mockResolvedValueOnce([insertedUser]); // INSERT ... RETURNING

    await authenticateWithFirebase(
      'firebase-id-token',
      null,
      { headers: { 'user-agent': 'jest' }, connection: { remoteAddress: '127.0.0.1' } },
      { deviceType: 'mobile' },
    );

    const [insertSql, ...insertParams] = prismaMock.$queryRawUnsafe.mock.calls[1];
    expect(insertSql).toMatch(/INSERT INTO users\s*\(\s*tenant_id\b/i);
    expect(insertParams[0]).toBe(DEFAULT_TENANT);
  });

  it('SEC-5: honours an explicit x-tenant-id header (SaaS path)', async () => {
    const SAAS_TENANT = '55555555-5555-4555-8555-555555555555';
    const req = {
      headers: { 'user-agent': 'jest', 'x-tenant-id': SAAS_TENANT },
      connection: { remoteAddress: '127.0.0.1' },
    };

    // resolveTenantForRequest validates the header tenant against the tenants
    // table (getTenantById → prisma.$queryRawUnsafe). Return an active tenant,
    // then the user-lookup SELECT (empty), then the INSERT RETURNING row.
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: SAAS_TENANT, status: 'active' }]) // getTenantById
      .mockResolvedValueOnce([]) // user SELECT (scoped)
      .mockResolvedValueOnce([{
        id: 1, uid: '66666666-6666-4666-8666-666666666666', tenant_id: SAAS_TENANT,
        name: null, phone: '+919876543210', email: null, role: 'PATIENT',
        firebase_uid: 'firebase-uid-123', gender: null, email_verified: false,
        is_active: true, last_login: new Date(),
      }]);

    await authenticateWithFirebase(
      'firebase-id-token', null, req, { deviceType: 'mobile' },
    );

    // The user-lookup SELECT (2nd call) must bind the SaaS tenant, not default.
    const selectParams = prismaMock.$queryRawUnsafe.mock.calls[1];
    expect(selectParams[1]).toBe(SAAS_TENANT);
    // And the INSERT (3rd call) must persist the SaaS tenant.
    const insertParams = prismaMock.$queryRawUnsafe.mock.calls[2];
    expect(insertParams[1]).toBe(SAAS_TENANT);
  });
});

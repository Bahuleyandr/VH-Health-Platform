// src/tests/unit/firebaseAuthServiceCoverage.test.js
//
// Roadmap B3.2 coverage lift for src/services/auth/firebaseAuthService.js.
//
// The sibling firebaseAuthService.test.js already exercises the SEC-5
// tenant-scoping happy path of authenticateWithFirebase. This file is a
// SEPARATE Coverage suite (does not edit/collide with that one) that drives
// every other export + the error / validation / catch branches:
//   - authenticateWithFirebase: existing-user update paths, no-phone reject,
//     PATIENT hospital-number attach, storeDeviceInfo + logFirebaseAuth catch
//   - completeUserProfile: req vs no-req tenant path, not-found, attach
//   - linkFirebaseAccount: missing args, OTP-invalid, not-found, success
//   - updateFcmToken: validation + success
//   - revokeFirebaseSession: validation + success
//   - verifyTokenStatus: user-exists + no-user
//   - getHealthStatus
//   - legacyRegisterUser: conflict + success
//
// All external deps are mocked per the repo convention
// (jest.unstable_mockModule). tenantService + otpService + firebaseAdmin +
// loginSessionHelper + patientIdentifierService are stubbed so the suite is
// deterministic, parallel-safe, and needs no live DB.

import { jest } from '@jest/globals';

// ── prisma singleton (raw-SQL shim target) ──────────────────────────
const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
  $transaction: jest.fn(async (fn) => fn(prismaMock)),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  // setTenantTx must delegate its callback to the per-call client when code
  // wraps writes (kept for parity with the repo mock convention even though
  // firebaseAuthService talks to the local `query` shim directly).
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

// firebase-admin facade used by the service.
const verifyIdTokenMock = jest.fn();
const revokeRefreshTokensMock = jest.fn();
const listUsersMock = jest.fn();
jest.unstable_mockModule('../../utils/firebaseAdmin.js', () => ({
  default: {
    auth: () => ({
      verifyIdToken: verifyIdTokenMock,
      revokeRefreshTokens: revokeRefreshTokensMock,
      listUsers: listUsersMock,
    }),
  },
}));

jest.unstable_mockModule('../../utils/phoneUtils.js', () => ({
  normalizePhone: (phone) => {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits.length === 10 ? `+91${digits}` : `+${digits}`;
  },
}));

jest.unstable_mockModule('../../utils/logMasking.js', () => ({
  maskPhoneForLog: (p) => `masked(${p})`,
}));

const ensureHospitalNumberMock = jest.fn();
jest.unstable_mockModule('../../services/patient/patientIdentifierService.js', () => ({
  ensureHospitalNumber: ensureHospitalNumberMock,
}));

const issueAccessTokenAndClaimSessionMock = jest.fn();
const generateRefreshTokenMock = jest.fn();
jest.unstable_mockModule('../../services/auth/loginSessionHelper.js', () => ({
  issueAccessTokenAndClaimSession: issueAccessTokenAndClaimSessionMock,
  generateRefreshToken: generateRefreshTokenMock,
}));

const revokeAllUserTokensMock = jest.fn();
const lifecycleLockMock = jest.fn(async (_tx, _uids, fn) => fn());
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  isSubjectDelegationRevoked: jest.fn().mockResolvedValue(false),
  revokeAllUserTokens: revokeAllUserTokensMock,
  withAuthIdentityLifecycleLocks: lifecycleLockMock,
}));

const registerNotificationDeviceMock = jest.fn();
jest.unstable_mockModule('../../services/notification/deviceRegistrationService.js', () => ({
  registerNotificationDevice: registerNotificationDeviceMock,
}));

const verifyOTPMock = jest.fn();
jest.unstable_mockModule('../../services/otpService.js', () => ({
  OTPService: {
    verifyOTP: verifyOTPMock,
  },
}));

// Stub tenant resolution so identity lookups are deterministic and we don't
// have to feed getTenantById rows through the prisma mock on every test.
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const resolveTenantForRequestMock = jest.fn();
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID,
  resolveTenantForRequest: resolveTenantForRequestMock,
  resolveTenantOrThrow: (req) => req?.tenantId || DEFAULT_TENANT_ID,
  requireTenantId: (tenantId) => tenantId || DEFAULT_TENANT_ID,
}));

const {
  authenticateWithFirebase,
  completeUserProfile,
  linkFirebaseAccount,
  updateFcmToken,
  revokeFirebaseSession,
  revokeOwnFirebaseSession,
  verifyTokenStatus,
  getHealthStatus,
  legacyRegisterUser,
} = await import('../../services/auth/firebaseAuthService.js');

// A request object shaped enough for logFirebaseAuth to read headers/ip.
const makeReq = (headers = {}) => ({
  headers: { 'user-agent': 'jest', ...headers },
  connection: { remoteAddress: '10.0.0.9' },
});

beforeEach(() => {
  jest.clearAllMocks();
  resolveTenantForRequestMock.mockResolvedValue(DEFAULT_TENANT_ID);
  issueAccessTokenAndClaimSessionMock.mockResolvedValue({ accessToken: 'vh-jwt' });
  generateRefreshTokenMock.mockReturnValue('vh-refresh');
  ensureHospitalNumberMock.mockResolvedValue('VH-000777');
  revokeAllUserTokensMock.mockResolvedValue({ database: { persisted: true } });
  registerNotificationDeviceMock.mockResolvedValue({
    id: 1,
    device_name: null,
    is_new_registration: true,
  });
  prismaMock.$executeRawUnsafe.mockResolvedValue(undefined);
});

// ───────────────────────── authenticateWithFirebase ─────────────────

describe('authenticateWithFirebase', () => {
  const baseToken = {
    uid: 'fb-uid-1',
    phone_number: '+91 90000 00001',
    email: 'p@example.com',
    email_verified: true,
    name: 'Token Name',
  };

  it('throws BAD_REQUEST when the Firebase token has no phone number', async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: 'fb-uid-x' }); // no phone_number

    await expect(
      authenticateWithFirebase('id-token', null, makeReq(), {}),
    ).rejects.toMatchObject({ statusCode: 400 });
    // Never reached identity lookup.
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('new PATIENT: inserts the user, marks isNewUser, and uses the FIREBASE_REGISTER auth action', async () => {
    verifyIdTokenMock.mockResolvedValue(baseToken);
    const inserted = {
      id: 100,
      uid: 'user-uuid-100',
      tenant_id: DEFAULT_TENANT_ID,
      name: 'Token Name',
      phone: '+919000000001',
      email: 'p@example.com',
      role: 'PATIENT',
      firebase_uid: 'fb-uid-1',
      gender: null,
      email_verified: true,
      is_active: true,
      last_login: new Date('2026-06-11T00:00:00.000Z'),
    };
    // 1st $queryRawUnsafe = SELECT (none), 2nd = INSERT ... RETURNING (inserted)
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([inserted]);

    const result = await authenticateWithFirebase('id-token', null, makeReq(), {
      deviceType: 'mobile',
    });

    // INSERT carried the decoded name/email/email_verified through.
    const insertCall = prismaMock.$queryRawUnsafe.mock.calls[1];
    expect(insertCall[0]).toMatch(/INSERT INTO users/i);
    expect(insertCall[1]).toBe(DEFAULT_TENANT_ID); // tenant_id $1
    expect(insertCall).toContain('Token Name'); // decodedToken.name
    expect(insertCall).toContain('p@example.com'); // decodedToken.email

    // auth_logs row uses the REGISTER action (success path) for a new user.
    const authLog = prismaMock.$executeRawUnsafe.mock.calls.find((c) =>
      /INSERT INTO auth_logs/i.test(c[0]),
    );
    expect(authLog).toBeTruthy();
    expect(authLog).toContain('firebase_register');

    expect(result).toMatchObject({
      accessToken: 'vh-jwt',
      refreshToken: 'vh-refresh',
      isNewUser: true,
      user: {
        uid: 'user-uuid-100',
        id: 100,
        hospital_number: 'VH-000777',
        isNewUser: true,
        profileComplete: false, // gender null
        emailVerified: true,
      },
    });
  });

  it('new user with no name/email/email_verified in the token binds null/false fallbacks (and default options arg)', async () => {
    // Token missing name/email/email_verified → exercises the `|| null` / `|| false` branches.
    verifyIdTokenMock.mockResolvedValue({ uid: 'fb-uid-min', phone_number: '+91 90000 00099' });
    const inserted = {
      id: 101,
      uid: 'user-uuid-101',
      tenant_id: DEFAULT_TENANT_ID,
      name: null,
      phone: '+919000000099',
      email: null,
      role: 'PATIENT',
      firebase_uid: 'fb-uid-min',
      gender: null,
      email_verified: false,
      is_active: true,
      last_login: new Date(),
    };
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([inserted]);

    // Called WITHOUT the 4th options arg → exercises `{ deviceType } = {}` default.
    const result = await authenticateWithFirebase('id-token', null, makeReq());

    const insertCall = prismaMock.$queryRawUnsafe.mock.calls[1];
    // name ($5), email ($6) → null; email_verified ($7) → false.
    expect(insertCall[5]).toBeNull();
    expect(insertCall[6]).toBeNull();
    expect(insertCall[7]).toBe(false);
    expect(result.isNewUser).toBe(true);
    expect(result.user.emailVerified).toBe(false);
  });

  it('existing PATIENT WITHOUT firebase_uid: backfills uid, attaches hospital number, stores device, logs', async () => {
    verifyIdTokenMock.mockResolvedValue(baseToken);
    const existing = {
      id: 5,
      uid: 'user-uuid-5',
      tenant_id: DEFAULT_TENANT_ID,
      name: 'Existing',
      phone: '+919000000001',
      email: 'p@example.com',
      role: 'PATIENT',
      firebase_uid: null, // triggers the backfill UPDATE branch
      gender: 'MALE',
      email_verified: true,
      is_active: true,
      last_login: new Date('2026-06-10T00:00:00.000Z'),
    };
    // SELECT existing user → array with one row (read query via $queryRawUnsafe)
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([existing]);

    const deviceInfo = {
      deviceId: 'dev-1',
      deviceName: 'Pixel',
      platform: 'android',
      appVersion: '1.0.0',
      fcmToken: 'fcm-xyz',
    };

    const result = await authenticateWithFirebase(
      'id-token',
      deviceInfo,
      makeReq({ 'x-forwarded-for': '203.0.113.7' }),
      { deviceType: 'mobile' },
    );

    // backfill UPDATE used the firebase_uid-missing branch (UPDATE ... firebase_uid = $1)
    const updateCall = prismaMock.$executeRawUnsafe.mock.calls.find((c) =>
      /UPDATE users SET firebase_uid = \$1/i.test(c[0]),
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall[1]).toBe('fb-uid-1');

    expect(registerNotificationDeviceMock).toHaveBeenCalledWith({
      tenantId: DEFAULT_TENANT_ID,
      userUid: 'user-uuid-5',
      deviceId: 'dev-1',
      fcmToken: 'fcm-xyz',
      deviceName: 'Pixel',
      platform: 'android',
      appVersion: '1.0.0',
      osVersion: undefined,
    });

    // auth_logs row written (logFirebaseAuth)
    const authLog = prismaMock.$executeRawUnsafe.mock.calls.find((c) =>
      /INSERT INTO auth_logs/i.test(c[0]),
    );
    expect(authLog).toBeTruthy();

    expect(ensureHospitalNumberMock).toHaveBeenCalledWith(
      expect.objectContaining({ patientUid: 'user-uuid-5', tenantId: DEFAULT_TENANT_ID }),
    );
    expect(result).toMatchObject({
      accessToken: 'vh-jwt',
      isNewUser: false,
      user: {
        uid: 'user-uuid-5',
        hospital_number: 'VH-000777',
        profileComplete: true, // name && gender present
        isNewUser: false,
      },
    });
  });

  it('existing user WITH firebase_uid: uses the last_sign_in-only UPDATE branch and skips device store', async () => {
    verifyIdTokenMock.mockResolvedValue({ ...baseToken, uid: 'fb-uid-2' });
    const existing = {
      id: 6,
      uid: 'user-uuid-6',
      tenant_id: DEFAULT_TENANT_ID,
      name: 'Has FB',
      phone: '+919000000001',
      email: 'p@example.com',
      role: 'DOCTOR', // non-PATIENT → attachHospitalNumber is a no-op
      firebase_uid: 'fb-uid-2', // already linked → else branch
      gender: null,
      email_verified: false,
      is_active: true,
      last_login: new Date(),
    };
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([existing]);

    const result = await authenticateWithFirebase('id-token', null, makeReq(), {});

    // else-branch UPDATE (no firebase_uid in the SET list)
    const touchCall = prismaMock.$executeRawUnsafe.mock.calls.find((c) =>
      /UPDATE users SET last_sign_in_at = NOW\(\), updated_at = NOW\(\) WHERE uid = \$1/i.test(c[0]),
    );
    expect(touchCall).toBeTruthy();
    expect(touchCall[1]).toBe('user-uuid-6');

    // non-PATIENT → ensureHospitalNumber not called, hospital_number null
    expect(ensureHospitalNumberMock).not.toHaveBeenCalled();
    expect(registerNotificationDeviceMock).not.toHaveBeenCalled();

    expect(result.user.hospital_number).toBeNull();
    expect(result.user.role).toBe('DOCTOR');
    expect(result.isNewUser).toBe(false);
  });

  it('swallows storeDeviceInfo + logFirebaseAuth failures (best-effort catch paths)', async () => {
    verifyIdTokenMock.mockResolvedValue({ ...baseToken, uid: 'fb-uid-3' });
    const existing = {
      id: 7,
      uid: 'user-uuid-7',
      tenant_id: DEFAULT_TENANT_ID,
      name: 'X',
      phone: '+919000000001',
      email: null,
      role: 'PATIENT',
      firebase_uid: 'fb-uid-3',
      gender: 'OTHER',
      email_verified: false,
      is_active: true,
      last_login: new Date(),
    };
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([existing]);

    // Make every WRITE (executeRawUnsafe) throw: the last_sign_in UPDATE is NOT
    // wrapped, so it would normally propagate — but storeDeviceInfo and
    // logFirebaseAuth swallow. To exercise the swallow paths without the
    // unwrapped UPDATE bubbling, resolve the UPDATE but reject the device +
    // auth_logs inserts specifically.
    prismaMock.$executeRawUnsafe.mockImplementation(async (sql) => {
      if (/INSERT INTO auth_logs/i.test(sql)) {
        throw new Error('boom');
      }
      return undefined;
    });
    registerNotificationDeviceMock.mockRejectedValueOnce(new Error('boom'));

    const deviceInfo = { deviceId: 'd', deviceName: 'n', platform: 'ios', appVersion: '2', fcmToken: 'f' };

    // Should resolve despite the best-effort writes throwing.
    const result = await authenticateWithFirebase('id-token', deviceInfo, makeReq(), {});
    expect(result.accessToken).toBe('vh-jwt');
    expect(result.isNewUser).toBe(false);
  });
});

// ───────────────────────── completeUserProfile ──────────────────────

describe('completeUserProfile', () => {
  it('updates the profile and returns profileComplete (req present → resolves tenant)', async () => {
    const updated = {
      id: 11,
      uid: 'user-uuid-11',
      tenant_id: DEFAULT_TENANT_ID,
      name: 'Complete Name',
      phone: '+919000000002',
      email: 'c@example.com',
      role: 'PATIENT',
      gender: 'FEMALE',
      is_active: true,
    };
    // UPDATE ... RETURNING → treated as read by the shim → $queryRawUnsafe
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([updated]);

    const result = await completeUserProfile(
      {
        phone: '9000000002',
        name: 'Complete Name',
        gender: 'FEMALE',
        email: 'c@example.com',
        birthday: '1990-01-01',
        anniversary: null,
        address: 'Addr',
        emergency_contact: '9111111111',
      },
      makeReq(),
    );

    expect(resolveTenantForRequestMock).toHaveBeenCalled();
    const [sql, ...params] = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/UPDATE users SET/i);
    // tenant + phone bound at the documented positions ($8 tenant, $9 phone)
    expect(params[7]).toBe(DEFAULT_TENANT_ID);
    expect(params[8]).toBe('+919000000002');
    expect(result.user).toMatchObject({
      uid: 'user-uuid-11',
      hospital_number: 'VH-000777',
      profileComplete: true,
      gender: 'FEMALE',
    });
  });

  it('falls back to DEFAULT_TENANT_ID when no req is supplied (null branch)', async () => {
    const updated = {
      id: 12,
      uid: 'user-uuid-12',
      tenant_id: DEFAULT_TENANT_ID,
      name: 'NoReq',
      phone: '+919000000003',
      email: null,
      role: 'DOCTOR', // non-PATIENT → no hospital number
      gender: 'MALE',
      is_active: true,
    };
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([updated]);

    const result = await completeUserProfile({
      phone: '9000000003',
      name: 'NoReq',
      gender: 'MALE',
    }); // no req arg → defaults to null → DEFAULT_TENANT_ID

    expect(resolveTenantForRequestMock).not.toHaveBeenCalled();
    const params = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(params[8]).toBe(DEFAULT_TENANT_ID); // $8 position (sql is calls[0][0])
    expect(result.user.hospital_number).toBeNull();
  });

  it('throws NOT_FOUND when no row is updated', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]); // nothing updated

    await expect(
      completeUserProfile({ phone: '9000000004', name: 'X', gender: 'OTHER' }, makeReq()),
    ).rejects.toMatchObject({ statusCode: 404, message: 'User not found' });
  });
});

// ───────────────────────── linkFirebaseAccount ──────────────────────

describe('linkFirebaseAccount', () => {
  it('throws BAD_REQUEST when idToken or otp is missing', async () => {
    await expect(
      linkFirebaseAccount('9000000005', null, '123456', makeReq(), {}),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      linkFirebaseAccount('9000000005', 'id-token', null, makeReq(), {}),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Bailed before verifying the token / hitting the DB.
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it('throws BAD_REQUEST when the OTP is invalid', async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: 'fb-link-1' });
    verifyOTPMock.mockResolvedValue({ valid: false, message: 'Bad OTP' });

    await expect(
      linkFirebaseAccount('9000000005', 'id-token', '000000', makeReq(), {}),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Bad OTP' });

    expect(verifyOTPMock).toHaveBeenCalledWith('+919000000005', '000000', 'account_linking');
  });

  it('throws BAD_REQUEST with default message when OTP invalid and no message provided', async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: 'fb-link-1b' });
    verifyOTPMock.mockResolvedValue({ valid: false }); // no message → default branch

    await expect(
      linkFirebaseAccount('9000000005', 'id-token', '000000', makeReq(), {}),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Invalid or expired OTP' });
  });

  it('throws NOT_FOUND when no user matches the phone in the tenant', async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: 'fb-link-2' });
    verifyOTPMock.mockResolvedValue({ valid: true });
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]); // user SELECT → none

    await expect(
      linkFirebaseAccount('9000000006', 'id-token', '111111', makeReq(), {}),
    ).rejects.toMatchObject({ statusCode: 404, message: 'User not found' });
  });

  it('links the firebase uid, issues a token, and returns linkedToFirebase', async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: 'fb-link-3' });
    verifyOTPMock.mockResolvedValue({ valid: true });
    const user = {
      id: 21,
      uid: 'user-uuid-21',
      tenant_id: DEFAULT_TENANT_ID,
      name: 'Linker',
      phone: '+919000000007',
      email: 'l@example.com',
      role: 'PATIENT',
      firebase_uid: null,
      is_active: true,
    };
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([user]); // SELECT user

    const result = await linkFirebaseAccount('9000000007', 'id-token', '222222', makeReq(), {
      deviceType: 'mobile',
    });

    // UPDATE users SET firebase_uid = $1 ... WHERE uid = $2 (write → executeRawUnsafe)
    const linkUpdate = prismaMock.$executeRawUnsafe.mock.calls.find((c) =>
      /UPDATE users SET firebase_uid = \$1, updated_at = NOW\(\) WHERE uid = \$2/i.test(c[0]),
    );
    expect(linkUpdate).toBeTruthy();
    expect(linkUpdate[1]).toBe('fb-link-3');
    expect(linkUpdate[2]).toBe('user-uuid-21');

    expect(issueAccessTokenAndClaimSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userUid: 'user-uuid-21',
        deviceType: 'mobile',
        tokenPayload: expect.objectContaining({ firebaseUid: 'fb-link-3' }),
      }),
    );
    expect(result).toMatchObject({
      accessToken: 'vh-jwt',
      refreshToken: 'vh-refresh',
      user: { uid: 'user-uuid-21', hospital_number: 'VH-000777', linkedToFirebase: true },
    });
    expect(generateRefreshTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'user-uuid-21', id: 21, role: 'PATIENT' }),
    );
  });

  it('non-PATIENT link returns hospital_number null and works with the default options arg', async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: 'fb-link-4' });
    verifyOTPMock.mockResolvedValue({ valid: true });
    const user = {
      id: 22,
      uid: 'user-uuid-22',
      tenant_id: DEFAULT_TENANT_ID,
      name: 'Nurse',
      phone: '+919000000077',
      email: 'nurse@example.com',
      role: 'NURSE', // non-PATIENT → no hospital number → `|| null` fallback
      firebase_uid: null,
      is_active: true,
    };
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([user]);

    // No 5th options arg → exercises `{ deviceType } = {}` default on linkFirebaseAccount.
    const result = await linkFirebaseAccount('9000000077', 'id-token', '333333', makeReq());

    expect(ensureHospitalNumberMock).not.toHaveBeenCalled();
    expect(result.user.hospital_number).toBeNull();
    expect(result.user.linkedToFirebase).toBe(true);
  });
});

// ───────────────────────── updateFcmToken ───────────────────────────

describe('updateFcmToken', () => {
  it('throws BAD_REQUEST when phone or fcmToken is missing', async () => {
    await expect(updateFcmToken(null, 'tok')).rejects.toMatchObject({ statusCode: 400 });
    await expect(updateFcmToken('9000000008', null)).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('upserts the FCM token and returns a redacted token (default deviceId branch)', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ uid: 'user-fcm-1' }]);
    const result = await updateFcmToken('9000000008', 'abcdefghijKLMNOP');

    expect(registerNotificationDeviceMock).toHaveBeenCalledWith({
      tenantId: DEFAULT_TENANT_ID,
      userUid: 'user-fcm-1',
      deviceId: 'default',
      fcmToken: 'abcdefghijKLMNOP',
    });
    expect(result).toMatchObject({
      phone: '+919000000008',
      fcmToken: 'abcdefghij...[REDACTED]',
      deviceId: undefined,
    });
  });

  it('passes an explicit deviceId through when supplied', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ uid: 'user-fcm-2' }]);
    const result = await updateFcmToken('9000000008', 'tok1234567890', 'device-42');
    expect(registerNotificationDeviceMock).toHaveBeenCalledWith(expect.objectContaining({
      userUid: 'user-fcm-2',
      deviceId: 'device-42',
    }));
    expect(result.deviceId).toBe('device-42');
  });
});

// ───────────────────────── revokeFirebaseSession ────────────────────

describe('revokeFirebaseSession', () => {
  it('throws BAD_REQUEST when firebaseUid is missing', async () => {
    await expect(revokeFirebaseSession(null)).rejects.toMatchObject({ statusCode: 400 });
    expect(revokeRefreshTokensMock).not.toHaveBeenCalled();
  });

  it('revokes Firebase tokens, records the revocation, and returns metadata', async () => {
    revokeRefreshTokensMock.mockResolvedValue(undefined);
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ uid: 'user-revoke-1' }]);

    const result = await revokeFirebaseSession('fb-revoke-1');

    expect(revokeAllUserTokensMock).toHaveBeenCalledWith('user-revoke-1', {
      requireEvidence: true,
      reason: 'firebase_force_revoke',
    });
    expect(revokeRefreshTokensMock).toHaveBeenCalledWith('fb-revoke-1');
    const upd = prismaMock.$executeRawUnsafe.mock.calls.find((c) =>
      /UPDATE users SET firebase_tokens_revoked_at = NOW\(\)/i.test(c[0]),
    );
    expect(upd).toBeTruthy();
    expect(upd[1]).toBe('fb-revoke-1');
    expect(result.firebaseUid).toBe('fb-revoke-1');
    expect(result.localSessionsRevoked).toBe(true);
    expect(typeof result.revokedAt).toBe('string');
  });
});

// ───────────────────────── revokeOwnFirebaseSession ─────────────────

describe('revokeOwnFirebaseSession', () => {
  it('throws BAD_REQUEST when the caller uid is missing', async () => {
    await expect(revokeOwnFirebaseSession(null)).rejects.toMatchObject({ statusCode: 400 });
    expect(revokeRefreshTokensMock).not.toHaveBeenCalled();
  });

  it('resolves the caller OWN firebase_uid from the users row and revokes that', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ firebase_uid: 'fb-owned-by-caller' }]);
    revokeRefreshTokensMock.mockResolvedValue(undefined);

    const result = await revokeOwnFirebaseSession('550e8400-e29b-41d4-a716-446655440001');

    // The lookup is keyed by the JWT subject — the ONLY identity input.
    const lookup = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(lookup[0]).toMatch(/SELECT firebase_uid\s+FROM users/i);
    expect(lookup[1]).toBe('550e8400-e29b-41d4-a716-446655440001');

    expect(revokeRefreshTokensMock).toHaveBeenCalledWith('fb-owned-by-caller');
    expect(revokeAllUserTokensMock).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440001',
      { requireEvidence: true, reason: 'firebase_self_revoke' },
    );
    expect(result.revoked).toBe(true);
    expect(result.firebaseUid).toBe('fb-owned-by-caller');
  });

  it('reports revoked=false without calling Firebase when the user has no linked Firebase UID', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ firebase_uid: null }]);

    const result = await revokeOwnFirebaseSession('550e8400-e29b-41d4-a716-446655440009');

    expect(revokeRefreshTokensMock).not.toHaveBeenCalled();
    expect(result.revoked).toBe(false);
    // Honest, not a fake success: the caller can tell nothing was revoked.
    expect(result.reason).toBe('NO_FIREBASE_SESSION');
  });

  it('reports revoked=false when no users row matches the caller uid', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);

    const result = await revokeOwnFirebaseSession('550e8400-e29b-41d4-a716-446655440010');

    expect(revokeRefreshTokensMock).not.toHaveBeenCalled();
    expect(result.revoked).toBe(false);
    expect(result.reason).toBe('NO_FIREBASE_SESSION');
  });
});

// ───────────────────────── verifyTokenStatus ────────────────────────

describe('verifyTokenStatus', () => {
  it('returns userExists=true with the matched user', async () => {
    const now = Math.floor(Date.now() / 1000);
    verifyIdTokenMock.mockResolvedValue({
      uid: 'fb-vt-1',
      phone_number: '+919000000009',
      email: 'v@example.com',
      email_verified: true,
      iat: now,
      exp: now + 3600,
    });
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([
      { uid: 'user-uuid-30', phone: '+919000000009', name: 'V', role: 'PATIENT' },
    ]);

    const result = await verifyTokenStatus('id-token');

    expect(verifyIdTokenMock).toHaveBeenCalledWith('id-token', true);
    expect(result.valid).toBe(true);
    expect(result.userExists).toBe(true);
    expect(result.user).toMatchObject({ uid: 'user-uuid-30' });
    expect(result.tokenInfo).toMatchObject({ uid: 'fb-vt-1', email: 'v@example.com' });
    expect(result.tokenInfo.issuedAt).toBeInstanceOf(Date);
    expect(result.tokenInfo.expiresAt).toBeInstanceOf(Date);
  });

  it('returns userExists=false and user=null when no row matches', async () => {
    const now = Math.floor(Date.now() / 1000);
    verifyIdTokenMock.mockResolvedValue({
      uid: 'fb-vt-2',
      phone_number: null,
      email: null,
      email_verified: false,
      iat: now,
      exp: now + 60,
    });
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]); // no user

    const result = await verifyTokenStatus('id-token');
    expect(result.userExists).toBe(false);
    expect(result.user).toBeNull();
  });
});

// ───────────────────────── getHealthStatus ──────────────────────────

describe('getHealthStatus', () => {
  it('reports constant public liveness without fleet statistics or tenant fan-out', async () => {
    listUsersMock.mockResolvedValue({ users: [] });

    const result = await getHealthStatus();

    expect(listUsersMock).toHaveBeenCalledWith(1);
    expect(result).toEqual({
      status: 'healthy',
      firebaseConnection: 'connected',
      timestamp: expect.any(String),
    });
    expect(result).not.toHaveProperty('statistics');
    expect(result).not.toHaveProperty('deviceStatistics');
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

// ───────────────────────── legacyRegisterUser ───────────────────────

describe('legacyRegisterUser', () => {
  it('throws CONFLICT when a user already exists in the tenant', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([
      { id: 1, uid: 'existing', phone: '+919000000010' },
    ]); // existence SELECT → found

    // Called without the 3rd options arg → exercises `{ deviceType } = {}` default.
    await expect(
      legacyRegisterUser({ phone: '9000000010', name: 'Dup' }, makeReq()),
    ).rejects.toMatchObject({ statusCode: 409, message: 'User already exists' });
  });

  it('creates a new user, issues a token, and returns the token + user', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([]) // existence SELECT → none
      .mockResolvedValueOnce([
        {
          id: 50,
          uid: 'user-uuid-50',
          name: 'New Legacy',
          phone: '+919000000011',
          email: 'n@example.com',
          role: 'PATIENT',
          is_active: true,
        },
      ]); // INSERT ... RETURNING

    const result = await legacyRegisterUser(
      {
        phone: '9000000011',
        name: 'New Legacy',
        gender: 'MALE',
        email: 'n@example.com',
        birthday: '1991-02-02',
        anniversary: null,
        address: 'Somewhere',
      },
      makeReq(),
      { deviceType: 'web' },
    );

    const insertCall = prismaMock.$queryRawUnsafe.mock.calls[1];
    expect(insertCall[0]).toMatch(/INSERT INTO users/i);
    expect(insertCall[1]).toBe(DEFAULT_TENANT_ID); // tenant_id bound first

    expect(issueAccessTokenAndClaimSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userUid: 'user-uuid-50',
        deviceType: 'web',
        tokenPayload: expect.objectContaining({ uid: 'user-uuid-50', id: 50 }),
      }),
    );
    expect(result).toMatchObject({
      token: 'vh-jwt',
      refreshToken: 'vh-refresh',
      user: { uid: 'user-uuid-50', id: 50, name: 'New Legacy', role: 'PATIENT' },
    });
    expect(generateRefreshTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'user-uuid-50', id: 50, role: 'PATIENT' }),
    );
  });
});

// src/tests/unit/authServiceCoverage.test.js
//
// Coverage-focused unit tests for AuthService (roadmap B3.2). This file is a
// SEPARATE companion to src/tests/unit/authService.test.js and
// src/tests/unit/adminPasswordResetOtp.test.js — it deliberately exercises the
// previously-uncovered surface area: the admin MFA/TOTP login branches, staff
// PIN auth (login / change / reset), admin CRUD + profile, token
// refresh-rotation + blacklist, logout + auth-log, revokeAllTokens, the legacy
// phone-auth gates, the OTP-direct paths, and every health/stats reporter
// (including their degraded catch branches).
//
// Everything external is mocked (prisma, jwt, bcrypt, otp, firebase, redis
// blacklist, session helper, anomaly detector, security audit, totp, compat
// gates). No DB / network is touched, so the suite is deterministic and
// parallel-safe. A local prisma mock is used (not the shared __mocks__/prisma.js)
// so this file can add the `staff` model + `$queryRawUnsafe` without mutating a
// shared fixture other suites depend on.

import { jest } from '@jest/globals';

// ── Local prisma mock (self-contained for this file) ─────────────────
// phone/firebase_uid are unique per-tenant now (mig 333); code reads via
// findFirst where it used findUnique. Alias both to one fn so existing
// findUnique mocks transparently drive findFirst too.
const usersFind = jest.fn();
const staffFind = jest.fn();
const mockPrisma = {
  users: { findFirst: usersFind, findUnique: usersFind, upsert: jest.fn(), update: jest.fn(), create: jest.fn(), count: jest.fn() },
  admins: {
    findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(),
    updateMany: jest.fn(), count: jest.fn(), create: jest.fn(), findMany: jest.fn(),
  },
  staff: { findFirst: staffFind, findUnique: staffFind, update: jest.fn() },
  otp_sessions: { count: jest.fn() },
  auth_logs: { create: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  password_reset_otps: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  identity_audit_events: { create: jest.fn() },
  user_sessions: { count: jest.fn() },
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
  $queryRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenantTx: async (_tenantId, fn) => fn(mockPrisma),
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));

// Silence logger
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// jwtUtils
const mockGenerateToken = jest.fn().mockReturnValue('mock-jwt-token');
const mockVerifyToken = jest.fn();
const mockVerifyTokenAllowExpired = jest.fn();
const mockIssueSetupToken = jest.fn().mockReturnValue('mock-setup-token');
jest.unstable_mockModule('../../utils/jwtUtils.js', () => ({
  generateToken: mockGenerateToken,
  verifyToken: mockVerifyToken,
  verifyTokenAllowExpired: mockVerifyTokenAllowExpired,
  issueSetupToken: mockIssueSetupToken,
}));

// phoneUtils — deterministic pass-through normalizer
jest.unstable_mockModule('../../utils/phoneUtils.js', () => ({
  normalizePhone: (phone) => {
    if (!phone) return null;
    let n = String(phone).replace(/[^\d+]/g, '');
    if (n.length === 10 && !n.startsWith('+')) n = '+91' + n;
    else if (n.startsWith('91') && n.length === 12) n = '+' + n;
    else if (!n.startsWith('+') && n.length > 10) n = '+' + n;
    return n;
  },
}));

// bcrypt
const mockBcryptCompare = jest.fn();
const mockBcryptHash = jest.fn().mockResolvedValue('hashed-value');
jest.unstable_mockModule('bcrypt', () => ({
  default: { compare: mockBcryptCompare, hash: mockBcryptHash },
}));

// otpService
const mockOtpVerify = jest.fn();
const mockOtpRequest = jest.fn();
jest.unstable_mockModule('../../services/auth/otpService.js', () => ({
  requestOtp: mockOtpRequest,
  verifyOtp: mockOtpVerify,
}));

// firebaseAuthService — pass-through targets so the static wrappers can be
// exercised; each returns a sentinel so we can assert delegation.
const mockFb = {
  authenticateWithFirebase: jest.fn().mockResolvedValue('fb-auth'),
  completeUserProfile: jest.fn().mockResolvedValue('fb-profile'),
  linkFirebaseAccount: jest.fn().mockResolvedValue('fb-link'),
  updateFcmToken: jest.fn().mockResolvedValue('fb-fcm'),
  revokeFirebaseSession: jest.fn().mockResolvedValue('fb-revoke'),
  verifyTokenStatus: jest.fn().mockResolvedValue('fb-status'),
  getHealthStatus: jest.fn().mockResolvedValue('fb-health'),
};
jest.unstable_mockModule('../../services/auth/firebaseAuthService.js', () => ({ ...mockFb }));

// loginSessionHelper — issues access token + claims single active session.
// generateRefreshToken is the SHARED refresh-token minter AuthService now
// delegates to (dedup of the old inline _generateRefreshToken). Mirror the real
// helper here — stamp type:'refresh' and forward to generateToken — so the C-9
// assertions below (refresh token minted with type:'refresh') still hold.
const mockIssueSession = jest.fn().mockResolvedValue({
  accessToken: 'session-access-token',
  sessionFamilyId: 'session-family-1',
});
const mockGenerateRefreshToken = jest.fn((payload) => mockGenerateToken({ ...payload, type: 'refresh' }, '30d'));
jest.unstable_mockModule('../../services/auth/loginSessionHelper.js', () => ({
  issueAccessTokenAndClaimSession: mockIssueSession,
  generateRefreshToken: mockGenerateRefreshToken,
  // W4 C5: authService's OTP/staff/register mints now stamp tenant_id via this.
  resolveTenantIdForUid: jest.fn().mockResolvedValue('00000000-0000-4000-8000-000000000001'),
}));

// tokenBlacklist (redis fast-path + DB fallback)
const mockBlacklistToken = jest.fn().mockResolvedValue(undefined);
const mockIsTokenBlacklisted = jest.fn().mockResolvedValue(false);
const mockRevokeAllUserTokens = jest.fn().mockResolvedValue(undefined);
const mockPersistRevokeAllUserTokens = jest.fn().mockResolvedValue(1_700_000_000);
const mockPublishRevokeAllUserTokens = jest.fn().mockResolvedValue({ database: { persisted: true } });
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  isSubjectDelegationRevoked: jest.fn().mockResolvedValue(false),
  getCurrentTokenEpoch: jest.fn().mockResolvedValue(0),
  blacklistToken: mockBlacklistToken,
  isTokenBlacklisted: mockIsTokenBlacklisted,
  persistRevokeAllUserTokens: mockPersistRevokeAllUserTokens,
  publishRevokeAllUserTokens: mockPublishRevokeAllUserTokens,
  revokeAllUserTokens: mockRevokeAllUserTokens,
}));

// totpUtils — only generateChallengeToken is used by authService
const mockGenerateChallengeToken = jest.fn();
jest.unstable_mockModule('../../utils/totpUtils.js', () => ({
  generateChallengeToken: mockGenerateChallengeToken,
}));

// loginAnomalyDetector
const mockTrackFailedLogin = jest.fn();
jest.unstable_mockModule('../../utils/loginAnomalyDetector.js', () => ({
  trackFailedLogin: mockTrackFailedLogin,
}));

// securityAuditLogger
const mockLogSecurityEvent = jest.fn();
jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({
  logSecurityEvent: mockLogSecurityEvent,
}));

// authCompatibilityGates — legacy phone auth gate (default: disabled)
const mockIsLegacyPhoneAuthAllowed = jest.fn().mockReturnValue(false);
jest.unstable_mockModule('../../utils/authCompatibilityGates.js', () => ({
  isLegacyPhoneAuthAllowed: mockIsLegacyPhoneAuthAllowed,
}));

// listQuery — used by listAdmins
const mockParseListQuery = jest.fn();
const mockBuildPagination = jest.fn().mockReturnValue({ page: 1, limit: 20, total: 0, totalPages: 0 });
jest.unstable_mockModule('../../utils/listQuery.js', () => ({
  parseListQuery: mockParseListQuery,
  buildPagination: mockBuildPagination,
}));

// logMasking
jest.unstable_mockModule('../../utils/logMasking.js', () => ({
  maskPhoneForLog: (p) => `masked:${p}`,
}));

// dateUtils
jest.unstable_mockModule('../../utils/dateUtils.js', () => ({
  formatDateDDMMYYYY: jest.fn((d) => (d ? 'dd-mm-yyyy' : null)),
}));

// securityConfig
jest.unstable_mockModule('../../config/securityConfig.js', () => ({
  SECURITY_CONFIG: {
    admin: { maxFailedAttempts: 5, lockoutDurationMinutes: 15 },
    otp: { maxAttemptsPerPhone: 5, expiryMinutes: 10, codeLength: 6 },
    jwt: { defaultExpiry: '7d', refreshExpiry: '30d', adminExpiry: '4h' },
    deviceTrust: { maxDaysWithoutExpiry: 90 },
    session: { inactivityTimeoutMinutes: 30 },
  },
}));

// responseCodes
jest.unstable_mockModule('../../config/responseCodes.js', () => ({
  HTTP_STATUS: { BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, TOO_MANY_REQUESTS: 429 },
}));

// ── Import service under test (after all mocks) ──────────────────────
const { AuthService, default: AuthServiceDefault } = await import('../../services/auth/authService.js');

beforeEach(() => {
  jest.clearAllMocks();
  // Re-establish stable default behaviours cleared by clearAllMocks.
  mockGenerateToken.mockReturnValue('mock-jwt-token');
  mockIssueSetupToken.mockReturnValue('mock-setup-token');
  mockIssueSession.mockResolvedValue({
    accessToken: 'session-access-token',
    sessionFamilyId: 'session-family-1',
  });
  mockBcryptHash.mockResolvedValue('hashed-value');
  mockIsTokenBlacklisted.mockResolvedValue(false);
  mockIsLegacyPhoneAuthAllowed.mockReturnValue(false);
  mockBuildPagination.mockReturnValue({ page: 1, limit: 20, total: 0, totalPages: 0 });
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
});

// ====================================================================
// Firebase pass-through wrappers
// ====================================================================
describe('AuthService — Firebase pass-through wrappers', () => {
  it('delegates every firebase wrapper to firebaseAuthService', async () => {
    expect(await AuthService.authenticateWithFirebase('idt', { d: 1 }, {}, { o: 1 })).toBe('fb-auth');
    expect(mockFb.authenticateWithFirebase).toHaveBeenCalledWith('idt', { d: 1 }, {}, { o: 1 });

    expect(await AuthService.completeUserProfile({ name: 'X' })).toBe('fb-profile');
    expect(mockFb.completeUserProfile).toHaveBeenCalledWith({ name: 'X' });

    expect(await AuthService.linkFirebaseAccount('+91', 'idt', '123456')).toBe('fb-link');
    expect(await AuthService.linkFirebaseToPhone('+91', 'idt', '123456')).toBe('fb-link');
    expect(mockFb.linkFirebaseAccount).toHaveBeenCalledTimes(2);

    expect(await AuthService.updateFcmToken('+91', 'fcm', 'dev')).toBe('fb-fcm');
    expect(mockFb.updateFcmToken).toHaveBeenCalledWith('+91', 'fcm', 'dev');

    expect(await AuthService.revokeFirebaseSession('uid')).toBe('fb-revoke');
    expect(mockFb.revokeFirebaseSession).toHaveBeenCalledWith('uid');

    expect(await AuthService.verifyFirebaseTokenStatus('idt')).toBe('fb-status');
    expect(mockFb.verifyTokenStatus).toHaveBeenCalledWith('idt');

    expect(await AuthService.getFirebaseHealthStatus()).toBe('fb-health');
    expect(mockFb.getHealthStatus).toHaveBeenCalled();
  });

  it('exposes AuthService as the default export', () => {
    expect(AuthServiceDefault).toBe(AuthService);
  });
});

// ====================================================================
// requestOtp
// ====================================================================
describe('AuthService.requestOtp', () => {
  it('returns userExists=true when the phone already has a user', async () => {
    mockPrisma.users.findUnique.mockResolvedValue({ uid: 'u1', name: 'A', role: 'PATIENT' });
    mockOtpRequest.mockResolvedValue({ expiresIn: 600, sid: 'otp-1' });

    const res = await AuthService.requestOtp('9876543210', 'login', {});

    expect(res).toMatchObject({ phone: '+919876543210', userExists: true, otpSent: true, sid: 'otp-1' });
    expect(mockOtpRequest).toHaveBeenCalledWith('+919876543210', 'login', null, {});
  });

  it('returns userExists=false for an unknown phone and defaults purpose to login', async () => {
    mockPrisma.users.findUnique.mockResolvedValue(null);
    mockOtpRequest.mockResolvedValue({ expiresIn: 600 });

    const res = await AuthService.requestOtp('9876543210');

    expect(res.userExists).toBe(false);
    expect(mockOtpRequest).toHaveBeenCalledWith('+919876543210', 'login', null, undefined);
  });

  it('rethrows and logs when the OTP service fails (catch branch)', async () => {
    mockPrisma.users.findUnique.mockResolvedValue(null);
    mockOtpRequest.mockRejectedValue(new Error('sms gateway down'));

    await expect(AuthService.requestOtp('9876543210')).rejects.toThrow('sms gateway down');
  });
});

// ====================================================================
// directOtpLogin
// ====================================================================
describe('AuthService.directOtpLogin', () => {
  it('claims the direct OTP session for an existing user', async () => {
    mockPrisma.users.findUnique.mockResolvedValue({
      uid: 'u1', id: 5, phone: '+919876543210', name: 'Alice', role: 'PATIENT',
    });
    const req = { ip: '203.0.113.10', headers: { 'user-agent': 'otp-quick-test' } };

    const res = await AuthService.directOtpLogin('9876543210', req, { deviceType: 'mobile' });

    expect(res.token).toBe('session-access-token');
    expect(res.user).toMatchObject({ uid: 'u1', id: 5, role: 'PATIENT' });
    expect(mockIssueSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userUid: 'u1',
        tokenPayload: expect.objectContaining({ uid: 'u1', id: 5, phone: '+919876543210', role: 'PATIENT' }),
        req,
        deviceType: 'mobile',
      }),
    );
  });

  it('throws 404 when the user does not exist', async () => {
    mockPrisma.users.findUnique.mockResolvedValue(null);

    await expect(AuthService.directOtpLogin('0000000000')).rejects.toMatchObject({
      message: 'User not found',
      statusCode: 404,
    });
  });
});

// ====================================================================
// adminLogin — MFA setup + TOTP challenge branches (not covered elsewhere)
// ====================================================================
describe('AuthService.adminLogin — MFA / TOTP branches', () => {
  const baseAdmin = {
    uid: 'admin-uid-1',
    username: 'root',
    email: 'root@test.local',
    role: 'SUPER_ADMIN',
    status: 'active',
    failed_login_attempts: 0,
    last_failed_login: null,
    password_hash: '$2b$10$hash',
    totp_enabled: false,
    updated_at: new Date(),
  };

  it('returns a setup token when a SUPER_ADMIN without TOTP logs in and MFA is required', async () => {
    const prev = process.env.REQUIRE_MFA_FOR_SUPER_ADMIN;
    process.env.REQUIRE_MFA_FOR_SUPER_ADMIN = 'true';
    try {
      mockPrisma.admins.findFirst.mockResolvedValue({ ...baseAdmin });
      mockBcryptCompare.mockResolvedValue(true);
      mockPrisma.admins.update.mockResolvedValue({});

      const res = await AuthService.adminLogin('root', 'pw');

      expect(res).toMatchObject({
        requiresMfaSetup: true,
        setupToken: 'mock-setup-token',
        expiresIn: 600,
        admin: { uid: 'admin-uid-1', username: 'root' },
      });
      expect(mockIssueSetupToken).toHaveBeenCalled();
      expect(mockLogSecurityEvent).toHaveBeenCalledWith('MFA_SETUP_REQUIRED', expect.any(Object));
    } finally {
      process.env.REQUIRE_MFA_FOR_SUPER_ADMIN = prev;
    }
  });

  it('returns a 2FA challenge when TOTP is enabled (challenge row persisted)', async () => {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    mockGenerateChallengeToken.mockReturnValue({ challengeToken: 'chal-1', expiresAt });
    mockPrisma.admins.findFirst.mockResolvedValue({ ...baseAdmin, role: 'ADMIN', totp_enabled: true });
    mockBcryptCompare.mockResolvedValue(true);
    mockPrisma.admins.update.mockResolvedValue({});
    mockPrisma.$queryRawUnsafe.mockResolvedValue(undefined);

    const res = await AuthService.adminLogin('root', 'pw');

    expect(res).toMatchObject({
      requiresTwoFactor: true,
      challengeToken: 'chal-1',
      expiresAt: expiresAt.toISOString(),
      admin: { uid: 'admin-uid-1', username: 'root' },
    });
    // expires_at is computed server-side (NOW() + INTERVAL), NOT bound as a JS
    // Date — a bound Date was reinterpreted across the Node/DB timezone gap and
    // stored in the past, so every challenge read back as already-expired and
    // login-time 2FA could never complete. (audit 2026-06-18 follow-up)
    const insertCall = mockPrisma.$queryRawUnsafe.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO totp_challenges'),
    );
    expect(insertCall).toBeTruthy();
    expect(insertCall[0]).toMatch(/NOW\(\)\s*\+\s*INTERVAL/i);
    expect(insertCall.slice(1)).toEqual(['admin-uid-1', 'chal-1']);
  });

  it('FAILS CLOSED (503, no JWT) when the totp_challenges insert throws (audit 2026-06-18 §3)', async () => {
    // A 2FA-enabled admin must NEVER be downgraded to a full JWT because the
    // challenge could not be persisted. The login must abort with an error and
    // issue no token of any kind.
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    mockGenerateChallengeToken.mockReturnValue({ challengeToken: 'chal-2', expiresAt });
    mockPrisma.admins.findFirst.mockResolvedValue({ ...baseAdmin, role: 'ADMIN', totp_enabled: true });
    mockBcryptCompare.mockResolvedValue(true);
    mockPrisma.admins.update.mockResolvedValue({});
    mockPrisma.$queryRawUnsafe.mockRejectedValue(new Error('relation "totp_challenges" does not exist'));

    await expect(AuthService.adminLogin('root', 'pw')).rejects.toMatchObject({
      statusCode: 503,
      code: 'MFA_UNAVAILABLE',
    });
    // Crucially: no full-access JWT was ever minted via the session helper.
    expect(mockIssueSession).not.toHaveBeenCalled();
    expect(mockLogSecurityEvent).toHaveBeenCalledWith('MFA_CHALLENGE_STORE_FAILED', expect.any(Object));
  });

  it('issues a full admin JWT via the session helper when MFA is off and no TOTP', async () => {
    const prev = process.env.REQUIRE_MFA_FOR_SUPER_ADMIN;
    process.env.REQUIRE_MFA_FOR_SUPER_ADMIN = 'false';
    try {
      mockPrisma.admins.findFirst.mockResolvedValue({ ...baseAdmin, role: 'ADMIN' });
      mockBcryptCompare.mockResolvedValue(true);
      mockPrisma.admins.update.mockResolvedValue({});

      const res = await AuthService.adminLogin('root', 'pw', { ip: '1.2.3.4' }, { deviceType: 'web' });

      expect(res.token).toBe('session-access-token');
      // C-9: a separate refresh token must accompany the admin access token.
      expect(res.refreshToken).toBe('mock-jwt-token');
      expect(mockGenerateToken).toHaveBeenCalledWith(
        expect.objectContaining({ uid: 'admin-uid-1', role: 'ADMIN', type: 'refresh' }),
        '30d',
      );
      expect(res.admin).toMatchObject({ uid: 'admin-uid-1', username: 'root', role: 'ADMIN' });
      expect(mockIssueSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userUid: 'admin-uid-1',
          deviceType: 'web',
          tokenPayload: expect.objectContaining({ uid: 'admin-uid-1', role: 'ADMIN' }),
        }),
      );
    } finally {
      process.env.REQUIRE_MFA_FOR_SUPER_ADMIN = prev;
    }
  });

  it('logs ACCOUNT_LOCKED and throws when still within the lockout window', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue({
      ...baseAdmin, role: 'ADMIN', failed_login_attempts: 5, last_failed_login: new Date(),
    });

    await expect(AuthService.adminLogin('root', 'pw')).rejects.toThrow(/Account temporarily locked/);
    expect(mockLogSecurityEvent).toHaveBeenCalledWith('ACCOUNT_LOCKED', expect.any(Object));
  });

  it('tracks the failed login + logs LOGIN_FAILED on a wrong password', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue({ ...baseAdmin, role: 'ADMIN' });
    mockBcryptCompare.mockResolvedValue(false);
    mockPrisma.admins.update.mockResolvedValue({});

    await expect(AuthService.adminLogin('root', 'wrong')).rejects.toThrow('Invalid credentials');
    expect(mockLogSecurityEvent).toHaveBeenCalledWith('LOGIN_FAILED', expect.any(Object));
    expect(mockTrackFailedLogin).toHaveBeenCalledWith(null, 'root');
  });

  it('uses updated_at as the lockout anchor when last_failed_login is null', async () => {
    // failed_login_attempts at cap but last_failed_login null → falls back to
    // updated_at; set updated_at well in the past so the window has expired and
    // the counter resets, then login succeeds.
    mockPrisma.admins.findFirst.mockResolvedValue({
      ...baseAdmin,
      role: 'ADMIN',
      failed_login_attempts: 5,
      last_failed_login: null,
      updated_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    mockBcryptCompare.mockResolvedValue(true);
    mockPrisma.admins.update.mockResolvedValue({});

    const res = await AuthService.adminLogin('root', 'pw', {}, {});
    expect(res.token).toBe('session-access-token');
    expect(mockPrisma.admins.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { failed_login_attempts: 0 } }),
    );
  });
});

describe('AuthService.adminLogin — deactivated branch', () => {
  it('throws when the admin status is not active', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue({
      uid: 'a1', username: 'root', email: 'r@x', role: 'ADMIN', status: 'inactive',
      failed_login_attempts: 0, last_failed_login: null, password_hash: '$2b$10$h',
      totp_enabled: false, updated_at: new Date(),
    });
    await expect(AuthService.adminLogin('root', 'pw')).rejects.toThrow('Account is deactivated');
  });
});

// ====================================================================
// verifyOtp (login OTP → upsert user → JWT)
// ====================================================================
describe('AuthService.verifyOtp', () => {
  it('creates a new user and claims the OTP session on first login', async () => {
    mockOtpVerify.mockResolvedValue({ valid: true });
    mockPrisma.users.findFirst.mockResolvedValue(null);
    mockPrisma.users.create.mockResolvedValue({ uid: 'new', id: 1, name: null, phone: '+919876543210', role: 'PATIENT' });
    const req = { ip: '203.0.113.11', headers: { 'user-agent': 'otp-test' } };

    const res = await AuthService.verifyOtp('9876543210', '123456', req, { deviceType: 'web' });
    expect(res.user.isNewUser).toBe(true);
    expect(res.token).toBe('session-access-token');
    expect(mockPrisma.users.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ phone: '+919876543210' }) }),
    );
    expect(mockIssueSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userUid: 'new',
        tokenPayload: expect.objectContaining({ uid: 'new', id: 1, role: 'PATIENT' }),
        req,
        deviceType: 'web',
      }),
    );
  });

  it('returns isNewUser false for an existing user', async () => {
    mockOtpVerify.mockResolvedValue({ valid: true });
    mockPrisma.users.findFirst.mockResolvedValue({ uid: 'existing' });
    mockPrisma.users.update.mockResolvedValue({ uid: 'existing', id: 2, name: 'Bob', phone: '+919876543210', role: 'PATIENT' });

    const res = await AuthService.verifyOtp('9876543210', '123456', {});
    expect(res.user.isNewUser).toBe(false);
  });

  it('throws when OTP verification fails (uses reason)', async () => {
    mockOtpVerify.mockResolvedValue({ valid: false, reason: 'OTP has expired' });
    await expect(AuthService.verifyOtp('9876543210', '000000', {})).rejects.toThrow('OTP has expired');
  });

  it('throws a generic message when verification fails with no reason', async () => {
    mockOtpVerify.mockResolvedValue({ valid: false });
    await expect(AuthService.verifyOtp('9876543210', '000000', {})).rejects.toThrow('Invalid OTP');
  });
});

// ====================================================================
// adminForgotPassword / adminResetPassword
// ====================================================================
describe('AuthService.adminForgotPassword', () => {
  it('creates a hashed OTP row and returns a generic message', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue({ uid: 'a1', username: 'root', email: 'r@x' });
    mockPrisma.password_reset_otps.create.mockResolvedValue({ id: 1 });

    const res = await AuthService.adminForgotPassword('root');
    expect(res.message).toMatch(/OTP sent/);
    // Non-development NODE_ENV (test) must NOT leak the plaintext OTP.
    expect(res.otp).toBeUndefined();
    expect(mockPrisma.password_reset_otps.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ user_id: 'a1', otp: 'hashed-value' }) }),
    );
  });

  it('throws when the admin does not exist', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue(null);
    await expect(AuthService.adminForgotPassword('ghost')).rejects.toThrow('Admin not found');
  });
});

describe('AuthService.adminResetPassword', () => {
  it('resets the password atomically when the hashed OTP matches', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue({ uid: 'a1' });
    mockPrisma.password_reset_otps.findFirst.mockResolvedValue({ id: 77, otp: '$2b$10$storedhash', attempts: 0 });
    mockBcryptCompare.mockResolvedValue(true);
    mockPrisma.password_reset_otps.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.admins.update.mockResolvedValue({});

    const res = await AuthService.adminResetPassword('root', '246813', 'NewPass1!');
    expect(res).toEqual({ message: 'Password reset successfully' });
    expect(mockPrisma.password_reset_otps.updateMany).toHaveBeenCalledWith({
      where: { id: 77, used: false }, data: { used: true },
    });
    expect(mockPersistRevokeAllUserTokens).toHaveBeenCalledWith('a1', {
      client: mockPrisma,
      requireEvidence: true,
      reason: 'password_reset',
    });
    expect(mockPublishRevokeAllUserTokens).toHaveBeenCalledWith(
      'a1', 1_700_000_000, { reason: 'password_reset' },
    );
  });

  it('does not report reset success when durable session revocation fails', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue({ uid: 'a1' });
    mockPrisma.password_reset_otps.findFirst.mockResolvedValue({
      id: 77,
      otp: '$2b$10$storedhash',
      attempts: 0,
    });
    mockBcryptCompare.mockResolvedValue(true);
    let otpBurnCommitted = false;
    let passwordCommitted = false;
    mockPrisma.$transaction.mockImplementationOnce(async (callback) => {
      let stagedOtpBurn = false;
      let stagedPassword = false;
      const tx = {
        ...mockPrisma,
        password_reset_otps: {
          ...mockPrisma.password_reset_otps,
          updateMany: jest.fn(async () => { stagedOtpBurn = true; return { count: 1 }; }),
        },
        admins: {
          ...mockPrisma.admins,
          update: jest.fn(async () => { stagedPassword = true; return {}; }),
        },
      };
      const result = await callback(tx);
      otpBurnCommitted = stagedOtpBurn;
      passwordCommitted = stagedPassword;
      return result;
    });
    mockPersistRevokeAllUserTokens.mockRejectedValueOnce(new Error('durable store unavailable'));

    await expect(AuthService.adminResetPassword('root', '246813', 'NewPass1!'))
      .rejects.toThrow('durable store unavailable');
    expect(otpBurnCommitted).toBe(false);
    expect(passwordCommitted).toBe(false);
    expect(mockPublishRevokeAllUserTokens).not.toHaveBeenCalled();
  });

  it('accepts a legacy plaintext OTP row (=== fallback)', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue({ uid: 'a1' });
    mockPrisma.password_reset_otps.findFirst.mockResolvedValue({ id: 88, otp: '246813', attempts: 0 });
    mockPrisma.password_reset_otps.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.admins.update.mockResolvedValue({});

    const res = await AuthService.adminResetPassword('root', '246813', 'NewPass1!');
    expect(res).toEqual({ message: 'Password reset successfully' });
  });

  it('increments attempts on a wrong OTP (not yet locked)', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue({ uid: 'a1' });
    mockPrisma.password_reset_otps.findFirst.mockResolvedValue({ id: 77, otp: '$2b$10$h', attempts: 0 });
    mockBcryptCompare.mockResolvedValue(false);
    mockPrisma.password_reset_otps.update.mockResolvedValue({});

    await expect(AuthService.adminResetPassword('root', '999999', 'NewPass1!')).rejects.toThrow('Invalid or expired OTP');
    expect(mockPrisma.password_reset_otps.update).toHaveBeenCalledWith({ where: { id: 77 }, data: { attempts: 1 } });
  });

  it('locks the OTP (marks used) on the final failed attempt', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue({ uid: 'a1' });
    mockPrisma.password_reset_otps.findFirst.mockResolvedValue({ id: 77, otp: '$2b$10$h', attempts: 4 });
    mockBcryptCompare.mockResolvedValue(false);
    mockPrisma.password_reset_otps.update.mockResolvedValue({});

    await expect(AuthService.adminResetPassword('root', '111111', 'NewPass1!')).rejects.toThrow(/Too many invalid attempts/);
    expect(mockPrisma.password_reset_otps.update).toHaveBeenCalledWith({ where: { id: 77 }, data: { attempts: 5, used: true } });
  });

  it('throws when the burn loses the concurrency race (count 0)', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue({ uid: 'a1' });
    mockPrisma.password_reset_otps.findFirst.mockResolvedValue({ id: 77, otp: '$2b$10$h', attempts: 0 });
    mockBcryptCompare.mockResolvedValue(true);
    mockPrisma.password_reset_otps.updateMany.mockResolvedValue({ count: 0 });

    await expect(AuthService.adminResetPassword('root', '246813', 'NewPass1!')).rejects.toThrow('Invalid or expired OTP');
    expect(mockPrisma.admins.update).not.toHaveBeenCalled();
  });

  it('throws when the admin is not found', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue(null);
    await expect(AuthService.adminResetPassword('ghost', '246813', 'NewPass1!')).rejects.toThrow('Admin not found');
  });

  it('throws when there is no live OTP row', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue({ uid: 'a1' });
    mockPrisma.password_reset_otps.findFirst.mockResolvedValue(null);
    await expect(AuthService.adminResetPassword('root', '246813', 'NewPass1!')).rejects.toThrow('Invalid or expired OTP');
  });
});

// ====================================================================
// changeAdminPassword
// ====================================================================
describe('AuthService.changeAdminPassword', () => {
  it('hashes + persists the new password when current password matches', async () => {
    mockPrisma.admins.findUnique.mockResolvedValue({ password_hash: '$2b$10$old' });
    mockBcryptCompare.mockResolvedValue(true);
    mockPrisma.admins.update.mockResolvedValue({});
    let transactionCommitted = false;
    mockPrisma.$transaction.mockImplementationOnce(async (callback) => {
      const result = await callback(mockPrisma);
      transactionCommitted = true;
      return result;
    });
    mockPublishRevokeAllUserTokens.mockImplementationOnce(async () => {
      expect(transactionCommitted).toBe(true);
      return { database: { persisted: true } };
    });

    const res = await AuthService.changeAdminPassword('admin-1', 'old', 'new');

    expect(res).toEqual({ message: 'Password changed successfully' });
    expect(mockBcryptHash).toHaveBeenCalledWith('new', 10);
    expect(mockPrisma.admins.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ password_hash: 'hashed-value' }) }),
    );
    expect(mockPersistRevokeAllUserTokens).toHaveBeenCalledWith('admin-1', {
      client: mockPrisma,
      requireEvidence: true,
      reason: 'password_changed',
    });
    expect(mockPublishRevokeAllUserTokens).toHaveBeenCalledWith(
      'admin-1', 1_700_000_000, { reason: 'password_changed' },
    );
  });

  it('does not report password-change success when durable revocation fails', async () => {
    mockPrisma.admins.findUnique.mockResolvedValue({ password_hash: '$2b$10$old' });
    mockBcryptCompare.mockResolvedValue(true);
    let passwordCommitted = false;
    mockPrisma.$transaction.mockImplementationOnce(async (callback) => {
      let stagedPassword = false;
      const tx = {
        ...mockPrisma,
        admins: {
          ...mockPrisma.admins,
          update: jest.fn(async () => { stagedPassword = true; return {}; }),
        },
      };
      const result = await callback(tx);
      passwordCommitted = stagedPassword;
      return result;
    });
    mockPersistRevokeAllUserTokens.mockRejectedValueOnce(new Error('durable store unavailable'));

    await expect(AuthService.changeAdminPassword('admin-1', 'old', 'new'))
      .rejects.toThrow('durable store unavailable');
    expect(passwordCommitted).toBe(false);
    expect(mockPublishRevokeAllUserTokens).not.toHaveBeenCalled();
  });

  it('throws when the admin is not found', async () => {
    mockPrisma.admins.findUnique.mockResolvedValue(null);
    await expect(AuthService.changeAdminPassword('x', 'a', 'b')).rejects.toThrow('Admin not found');
  });

  it('throws when the current password is incorrect', async () => {
    mockPrisma.admins.findUnique.mockResolvedValue({ password_hash: '$2b$10$old' });
    mockBcryptCompare.mockResolvedValue(false);
    await expect(AuthService.changeAdminPassword('x', 'bad', 'b')).rejects.toThrow('Current password is incorrect');
  });
});

// ====================================================================
// Staff auth (PIN): login / changeStaffPin / resetStaffPin
// ====================================================================
describe('AuthService.staffLogin', () => {
  const staff = {
    id: 7, uid: 'staff-uid-1', employee_id: 'EMP1', pin_hash: '$2b$10$pin',
    name: 'Nurse Joy', role: 'nurse', is_active: true, phone: '+919998887776',
  };

  it('claims the PIN session, stamps last_login, and returns staff identity on success', async () => {
    mockPrisma.staff.findUnique.mockResolvedValue({ ...staff });
    mockBcryptCompare.mockResolvedValue(true);
    mockPrisma.staff.update.mockResolvedValue({});
    const req = { ip: '203.0.113.12', headers: { 'user-agent': 'staff-pin-test' } };

    const res = await AuthService.staffLogin('EMP1', '1234', req, { deviceType: 'tablet' });

    expect(res.token).toBe('session-access-token');
    expect(res.staff).toEqual({ uid: 'staff-uid-1', employeeId: 'EMP1', name: 'Nurse Joy', role: 'nurse' });
    expect(mockIssueSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userUid: 'staff-uid-1',
        tokenPayload: expect.objectContaining({ uid: 'staff-uid-1', role: 'NURSE', sub: 'staff-uid-1' }),
        req,
        deviceType: 'tablet',
      }),
    );
    expect(mockPrisma.staff.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 }, data: { last_login: expect.any(Date) } }),
    );
  });

  it('throws when the staff member is not found', async () => {
    mockPrisma.staff.findUnique.mockResolvedValue(null);
    await expect(AuthService.staffLogin('NOPE', '1234')).rejects.toThrow('Staff member not found');
  });

  it('throws when the staff account is deactivated', async () => {
    mockPrisma.staff.findUnique.mockResolvedValue({ ...staff, is_active: false });
    await expect(AuthService.staffLogin('EMP1', '1234')).rejects.toThrow('Account is deactivated');
  });

  it('throws on a wrong PIN', async () => {
    mockPrisma.staff.findUnique.mockResolvedValue({ ...staff });
    mockBcryptCompare.mockResolvedValue(false);
    await expect(AuthService.staffLogin('EMP1', '0000')).rejects.toThrow('Invalid credentials');
  });
});

describe('AuthService.changeStaffPin', () => {
  it('hashes + persists the new PIN when the current PIN matches', async () => {
    mockPrisma.staff.findFirst.mockResolvedValue({ id: 9, pin_hash: '$2b$10$pin' });
    mockBcryptCompare.mockResolvedValue(true);
    mockPrisma.staff.update.mockResolvedValue({});

    const res = await AuthService.changeStaffPin('staff-uid-1', '1111', '2222');

    expect(res).toEqual({ message: 'PIN changed successfully' });
    expect(mockPrisma.staff.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 9 }, data: expect.objectContaining({ pin_hash: 'hashed-value' }) }),
    );
  });

  it('throws when the staff member is not found', async () => {
    mockPrisma.staff.findFirst.mockResolvedValue(null);
    await expect(AuthService.changeStaffPin('x', '1', '2')).rejects.toThrow('Staff member not found');
  });

  it('throws when the current PIN is incorrect', async () => {
    mockPrisma.staff.findFirst.mockResolvedValue({ id: 9, pin_hash: '$2b$10$pin' });
    mockBcryptCompare.mockResolvedValue(false);
    await expect(AuthService.changeStaffPin('x', 'bad', '2')).rejects.toThrow('Current PIN is incorrect');
  });
});

describe('AuthService.resetStaffPin', () => {
  it('resets the PIN and records the resetting admin', async () => {
    mockPrisma.staff.findUnique.mockResolvedValue({ id: 9 });
    mockPrisma.staff.update.mockResolvedValue({});

    const res = await AuthService.resetStaffPin('EMP1', '4321', 'admin-1');

    expect(res).toEqual({ message: 'Staff PIN reset successfully' });
    expect(mockPrisma.staff.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 9 },
        data: expect.objectContaining({ pin_hash: 'hashed-value', pin_reset_by: 'admin-1' }),
      }),
    );
  });

  it('throws when the staff member is not found', async () => {
    mockPrisma.staff.findUnique.mockResolvedValue(null);
    await expect(AuthService.resetStaffPin('NOPE', '4321', 'admin-1')).rejects.toThrow('Staff member not found');
  });
});

// ====================================================================
// Admin CRUD / profile
// ====================================================================
describe('AuthService.createAdmin', () => {
  it('creates a new admin when the username is free', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue(null);
    mockPrisma.admins.create.mockResolvedValue({ uid: 'new-admin', username: 'jdoe', email: 'j@x', name: 'J Doe' });

    const res = await AuthService.createAdmin({ username: 'jdoe', password: 'pw', email: 'j@x', name: 'J Doe', createdBy: 'root' });

    expect(res.admin).toMatchObject({ uid: 'new-admin', username: 'jdoe' });
    expect(mockBcryptHash).toHaveBeenCalledWith('pw', 10);
    expect(mockPrisma.admins.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: 'ADMIN', status: 'active', created_by: 'root' }) }),
    );
  });

  it('throws when the username already exists', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue({ uid: 'existing' });
    await expect(AuthService.createAdmin({ username: 'taken', password: 'pw' })).rejects.toThrow('Username already exists');
  });

  it('defaults created_by to null when omitted', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue(null);
    mockPrisma.admins.create.mockResolvedValue({ uid: 'a2', username: 'noby' });

    await AuthService.createAdmin({ username: 'noby', password: 'pw' });
    expect(mockPrisma.admins.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ created_by: null }) }),
    );
  });
});

describe('AuthService.listAdmins', () => {
  it('applies search + role + status filters and returns pagination', async () => {
    mockParseListQuery.mockReturnValue({
      search: 'jane', sortBy: 'created_at', sortOrder: 'DESC', offset: 0, limit: 20, page: 1,
    });
    mockPrisma.admins.findMany.mockResolvedValue([{ uid: 'a1', username: 'jane' }]);
    mockPrisma.admins.count.mockResolvedValue(1);

    const res = await AuthService.listAdmins({ role: 'admin', status: 'ACTIVE', search: 'jane' });

    expect(res.admins).toHaveLength(1);
    expect(res.filters).toMatchObject({ search: 'jane', role: 'admin', status: 'ACTIVE' });
    const whereArg = mockPrisma.admins.findMany.mock.calls[0][0].where;
    expect(whereArg.role).toBe('ADMIN');     // uppercased
    expect(whereArg.status).toBe('active');  // lowercased
    expect(whereArg.OR).toEqual(expect.arrayContaining([expect.objectContaining({ name: expect.any(Object) })]));
  });

  it('omits the search OR clause and filter echoes when no filters supplied', async () => {
    mockParseListQuery.mockReturnValue({
      search: null, sortBy: 'created_at', sortOrder: 'ASC', offset: 0, limit: 20, page: 1,
    });
    mockPrisma.admins.findMany.mockResolvedValue([]);
    mockPrisma.admins.count.mockResolvedValue(0);

    const res = await AuthService.listAdmins({});

    expect(mockPrisma.admins.findMany.mock.calls[0][0].where).toEqual({});
    expect(res.filters).toMatchObject({ search: null, role: null, status: null });
  });

  it('rethrows when the query fails (catch branch)', async () => {
    mockParseListQuery.mockReturnValue({
      search: null, sortBy: 'created_at', sortOrder: 'DESC', offset: 0, limit: 20, page: 1,
    });
    mockPrisma.admins.findMany.mockRejectedValue(new Error('db down'));
    mockPrisma.admins.count.mockResolvedValue(0);
    await expect(AuthService.listAdmins({})).rejects.toThrow('db down');
  });
});

describe('AuthService.deactivateAdmin', () => {
  it('atomically deactivates and durably revokes before publishing after commit', async () => {
    mockPrisma.admins.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.admins.findUnique
      .mockResolvedValueOnce({
        uid: 'a1',
        tenant_id: '00000000-0000-4000-8000-000000000001',
        username: 'jane',
        identity_source: 'local',
        scim_provider_id: null,
        status: 'active',
      })
      .mockResolvedValueOnce({ uid: 'a1', username: 'jane' });

    const res = await AuthService.deactivateAdmin('a1', 'left company', 'root');

    expect(res).toMatchObject({ message: 'Admin account deactivated', admin: { uid: 'a1', username: 'jane' } });
    expect(mockPrisma.admins.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { uid: 'a1', status: 'active' } }),
    );
    expect(mockPersistRevokeAllUserTokens).toHaveBeenCalledWith('a1', {
      client: mockPrisma,
      requireEvidence: true,
      reason: 'admin_deactivated',
    });
    expect(mockPublishRevokeAllUserTokens).toHaveBeenCalledWith(
      'a1',
      1_700_000_000,
      { reason: 'admin_deactivated' },
    );
    expect(mockPrisma.$transaction.mock.invocationCallOrder[0])
      .toBeLessThan(mockPublishRevokeAllUserTokens.mock.invocationCallOrder[0]);
    expect(mockPersistRevokeAllUserTokens.mock.invocationCallOrder[0])
      .toBeLessThan(mockPublishRevokeAllUserTokens.mock.invocationCallOrder[0]);
  });

  it('throws when no active admin matched', async () => {
    mockPrisma.admins.findUnique.mockResolvedValueOnce({
      uid: 'a1',
      identity_source: 'local',
      status: 'active',
    });
    mockPrisma.admins.updateMany.mockResolvedValue({ count: 0 });
    await expect(AuthService.deactivateAdmin('a1')).rejects.toThrow('Admin not found or already deactivated');
    expect(mockPersistRevokeAllUserTokens).not.toHaveBeenCalled();
    expect(mockPublishRevokeAllUserTokens).not.toHaveBeenCalled();
  });

  it('does not publish when durable revocation fails inside the transaction', async () => {
    mockPrisma.admins.findUnique.mockResolvedValueOnce({
      uid: 'a1',
      identity_source: 'local',
      status: 'active',
    });
    mockPrisma.admins.updateMany.mockResolvedValue({ count: 1 });
    mockPersistRevokeAllUserTokens.mockRejectedValueOnce(new Error('durable store down'));

    await expect(AuthService.deactivateAdmin('a1')).rejects.toThrow('durable store down');

    expect(mockPublishRevokeAllUserTokens).not.toHaveBeenCalled();
  });

  it('keeps the SCIM override audit in the same revocation transaction', async () => {
    mockPrisma.admins.findUnique
      .mockResolvedValueOnce({
        uid: 'a1',
        tenant_id: '00000000-0000-4000-8000-000000000001',
        username: 'jane',
        identity_source: 'scim',
        scim_provider_id: 7n,
        status: 'active',
      })
      .mockResolvedValueOnce({ uid: 'a1', username: 'jane' });
    mockPrisma.admins.updateMany.mockResolvedValue({ count: 1 });

    await AuthService.deactivateAdmin('a1', 'owner approved override', 'root');

    expect(mockPrisma.identity_audit_events.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        event_type: 'SCIM_LOCAL_OVERRIDE',
        local_uid: 'a1',
        details: expect.objectContaining({ action: 'deactivate' }),
      }),
    });
    expect(mockPersistRevokeAllUserTokens).toHaveBeenCalledWith(
      'a1',
      expect.objectContaining({ client: mockPrisma, reason: 'admin_deactivated' }),
    );
  });
});

describe('AuthService.reactivateAdmin', () => {
  it('reactivates an inactive admin', async () => {
    mockPrisma.admins.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.admins.findUnique.mockResolvedValue({ uid: 'a1', username: 'jane' });

    const res = await AuthService.reactivateAdmin('a1');
    expect(res).toMatchObject({ message: 'Admin account reactivated', admin: { uid: 'a1', username: 'jane' } });
  });

  it('throws when no inactive admin matched', async () => {
    mockPrisma.admins.updateMany.mockResolvedValue({ count: 0 });
    await expect(AuthService.reactivateAdmin('a1')).rejects.toThrow('Admin not found or already active');
  });
});

describe('AuthService.updateAdminPermissions', () => {
  it('updates permissions and returns them', async () => {
    mockPrisma.admins.update.mockResolvedValue({ uid: 'a1', username: 'jane', permissions: ['userManagement'] });

    const res = await AuthService.updateAdminPermissions('a1', ['userManagement'], 'root');
    expect(res).toMatchObject({ message: 'Permissions updated', admin: { uid: 'a1', permissions: ['userManagement'] } });
  });

  it('defaults permissions to [] when null is passed', async () => {
    mockPrisma.admins.update.mockResolvedValue({ uid: 'a1', username: 'jane', permissions: [] });
    await AuthService.updateAdminPermissions('a1', null, 'root');
    expect(mockPrisma.admins.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { permissions: [] } }),
    );
  });

  it('rejects unknown permission strings fail-closed before any DB write', async () => {
    await expect(AuthService.updateAdminPermissions('a1', ['x'], 'root'))
      .rejects.toMatchObject({ statusCode: 400, code: 'ADMIN_PERMISSIONS_UNKNOWN_KEY' });
    expect(mockPrisma.admins.update).not.toHaveBeenCalled();
  });

  it('rejects the proxy platformSuperAdmin sentinel by name', async () => {
    await expect(AuthService.updateAdminPermissions('a1', ['platformSuperAdmin'], 'root'))
      .rejects.toMatchObject({ statusCode: 400, code: 'ADMIN_PERMISSIONS_SENTINEL_REJECTED' });
    expect(mockPrisma.admins.update).not.toHaveBeenCalled();
  });

  it('rethrows when the update fails (catch branch)', async () => {
    mockPrisma.admins.update.mockRejectedValue(new Error('db down'));
    await expect(AuthService.updateAdminPermissions('a1', ['userManagement'], 'root')).rejects.toThrow('db down');
  });
});

describe('AuthService.getAdminProfile', () => {
  it('formats dates and returns the profile', async () => {
    mockPrisma.admins.findUnique.mockResolvedValue({
      uid: 'a1', username: 'jane', email: 'j@x', name: 'Jane', role: 'ADMIN',
      status: 'active', created_at: new Date(), last_login: new Date(), permissions: [],
    });

    const res = await AuthService.getAdminProfile('a1');
    expect(res.admin).toMatchObject({ uid: 'a1', created_at: 'dd-mm-yyyy', last_login: 'dd-mm-yyyy' });
  });

  it('returns null formatted dates when timestamps are absent', async () => {
    mockPrisma.admins.findUnique.mockResolvedValue({
      uid: 'a1', username: 'jane', email: null, name: null, role: 'ADMIN',
      status: 'active', created_at: null, last_login: null, permissions: [],
    });

    const res = await AuthService.getAdminProfile('a1');
    expect(res.admin.created_at).toBeNull();
    expect(res.admin.last_login).toBeNull();
  });

  it('throws a typed 404 when the admin is not found', async () => {
    // A missing admins row (offboarded admin, or a non-admin token on this
    // route) is caller state — it used to surface as a bare Error the
    // controller mapped to 500 (2026-08-22 audit).
    mockPrisma.admins.findUnique.mockResolvedValue(null);
    await expect(AuthService.getAdminProfile('ghost')).rejects.toMatchObject({
      message: 'Admin profile not found',
      statusCode: 404,
    });
  });
});

// ====================================================================
// Tokens / sessions: refreshToken rotation+blacklist, logout, revokeAllTokens
// ====================================================================
describe('AuthService.refreshToken — rotation + blacklist + type guard', () => {
  it('C-9: rejects an ACCESS token (no type:refresh claim) presented at refresh', async () => {
    // The whole point of C-9: an access token must NOT be rotatable into a
    // fresh session. verifyToken returns a valid-but-typeless payload.
    mockVerifyToken.mockReturnValue({ uid: 'u1', jti: 'jti-1', exp: 9999999999 });

    await expect(AuthService.refreshToken('access-tok')).rejects.toMatchObject({
      statusCode: 401,
      code: 'TOKEN_INVALID',
    });
    // Must reject BEFORE touching the blacklist / DB / session helper.
    expect(mockIsTokenBlacklisted).not.toHaveBeenCalled();
    expect(mockIssueSession).not.toHaveBeenCalled();
  });

  it('C-9: rejects a token explicitly typed as something other than refresh', async () => {
    mockVerifyToken.mockReturnValue({ uid: 'u1', jti: 'j', exp: 9999999999, type: 'access' });
    await expect(AuthService.refreshToken('tok')).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    expect(mockIssueSession).not.toHaveBeenCalled();
  });

  it('rejects a refresh token whose jti is already blacklisted (replay protection)', async () => {
    mockVerifyToken.mockReturnValue({ uid: 'u1', jti: 'jti-1', exp: 9999999999, type: 'refresh' });
    mockIsTokenBlacklisted.mockResolvedValue(true);

    await expect(AuthService.refreshToken('tok')).rejects.toMatchObject({ code: 'TOKEN_REVOKED' });
    expect(mockIsTokenBlacklisted).toHaveBeenCalledWith('jti-1');
  });

  it('accepts a type:refresh token: blacklists its jti, mints new access + refresh tokens', async () => {
    mockVerifyToken.mockReturnValue({
      uid: 'u1',
      jti: 'jti-1',
      exp: 9999999999,
      deviceType: 'ios',
      type: 'refresh',
      sessionFamilyId: 'session-family-1',
    });
    mockIsTokenBlacklisted.mockResolvedValue(false);
    mockPrisma.users.findUnique.mockResolvedValue({ uid: 'u1', id: 7, phone: '+91', name: 'A', role: 'PATIENT' });

    const res = await AuthService.refreshToken('tok', { ip: '1.1.1.1' });

    expect(mockBlacklistToken).toHaveBeenCalledWith('jti-1', 9999999999, 'refresh_rotation', {
      requireEvidence: true,
    });
    expect(mockIssueSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userUid: 'u1',
        deviceType: 'ios',
        pushRevoked: false,
        sessionFamilyId: 'session-family-1',
      }),
    );
    expect(res.token).toBe('session-access-token');
    // A rotated refresh token (type:'refresh', 30d) is returned to the client.
    expect(res.refreshToken).toBe('mock-jwt-token');
    expect(mockGenerateToken).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: 'u1',
        role: 'PATIENT',
        type: 'refresh',
        sessionFamilyId: 'session-family-1',
      }),
      '30d',
    );
    expect(res.user).toMatchObject({ uid: 'u1', id: 7, role: 'PATIENT' });
  });

  it('does not mint rotated credentials when durable refresh revocation fails', async () => {
    mockVerifyToken.mockReturnValue({
      uid: 'u1',
      jti: 'jti-1',
      exp: 9999999999,
      type: 'refresh',
    });
    mockIsTokenBlacklisted.mockResolvedValue(false);
    mockPrisma.users.findUnique.mockResolvedValue({
      uid: 'u1',
      id: 7,
      phone: '+91',
      name: 'A',
      role: 'PATIENT',
    });
    mockBlacklistToken.mockRejectedValueOnce(new Error('durable store unavailable'));

    await expect(AuthService.refreshToken('tok', { body: {} }))
      .rejects.toThrow('durable store unavailable');
    expect(mockIssueSession).not.toHaveBeenCalled();
    expect(mockGenerateRefreshToken).not.toHaveBeenCalled();
  });

  it('rotates an admin-realm refresh token against admins and preserves admin claims', async () => {
    const adminUid = '550e8400-e29b-41d4-a716-446655440001';
    mockVerifyToken.mockReturnValue({
      sub: adminUid,
      jti: 'admin-refresh-jti',
      exp: 9999999999,
      type: 'refresh',
      realm: 'admin',
      role: 'ADMIN',
      // Legacy refresh tokens minted before P9 carried this indefinitely.
      mfa: true,
      token_epoch: 0,
      deviceType: 'web',
    });
    mockPrisma.admins.findUnique.mockResolvedValue({
      uid: adminUid,
      tenant_id: '00000000-0000-4000-8000-000000000001',
      username: 'root',
      email: 'root@example.com',
      name: 'Root Admin',
      role: 'ADMIN',
      status: 'active',
      is_active: true,
    });

    const res = await AuthService.refreshToken('admin-refresh', { ip: '1.1.1.1' });

    expect(mockPrisma.users.findUnique).not.toHaveBeenCalled();
    expect(mockIssueSession).toHaveBeenCalledWith(expect.objectContaining({
      userUid: adminUid,
      expiresIn: '4h',
      tokenEpoch: 0,
      tokenPayload: expect.objectContaining({
        aud: 'vh-health-admin',
        iss: 'vh-health-backend',
        role: 'ADMIN',
      }),
    }));
    expect(mockIssueSession.mock.calls.at(-1)[0].tokenPayload.mfa).toBeUndefined();
    expect(mockGenerateRefreshToken).toHaveBeenCalledWith(expect.objectContaining({
      uid: adminUid,
      realm: 'admin',
      tokenEpoch: 0,
    }));
    expect(mockGenerateRefreshToken.mock.calls.at(-1)[0].mfa).toBeUndefined();
    expect(res.admin).toMatchObject({ uid: adminUid, username: 'root', role: 'ADMIN' });
    expect(res.user).toBeUndefined();
  });

  it('does not blacklist when the refresh token has no jti/exp', async () => {
    mockVerifyToken.mockReturnValue({ uid: 'u1', type: 'refresh' });
    mockPrisma.users.findUnique.mockResolvedValue({ uid: 'u1', id: 7, phone: '+91', name: 'A', role: 'PATIENT' });

    await AuthService.refreshToken('tok');
    expect(mockBlacklistToken).not.toHaveBeenCalled();
  });

  it('throws on an invalid/expired signature (verifyToken returns null)', async () => {
    mockVerifyToken.mockReturnValue(null);
    await expect(AuthService.refreshToken('bad')).rejects.toMatchObject({
      statusCode: 401,
      code: 'TOKEN_INVALID',
    });
  });

  it('throws when the user no longer exists', async () => {
    mockVerifyToken.mockReturnValue({ uid: 'gone', jti: 'j', exp: 9999999999, type: 'refresh' });
    mockPrisma.users.findUnique.mockResolvedValue(null);
    mockPrisma.admins.findUnique.mockResolvedValue(null);
    await expect(AuthService.refreshToken('tok')).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });
});

describe('AuthService.logout', () => {
  it('blacklists the token, revokes the whole user session, and writes a logout auth_log', async () => {
    mockVerifyToken.mockReturnValue({ uid: 'u1', phone: '+919998887776', jti: 'jti-1', exp: 9999999999 });
    mockPrisma.auth_logs.create.mockResolvedValue({});

    const res = await AuthService.logout('tok');

    expect(res).toEqual({ phone: '+919998887776' });
    // Audit F10: revocation calls opt into requireEvidence so a silent
    // write failure can no longer be mistaken for a successful logout.
    expect(mockBlacklistToken).toHaveBeenCalledWith('jti-1', 9999999999, 'logout', { requireEvidence: true });
    // Sol Ultra #19: login mints an access + a sibling refresh JWT with no shared
    // session-family id, so blacklisting only the presented token leaves the
    // sibling usable. Logout must revoke every token for this identity.
    expect(mockRevokeAllUserTokens).toHaveBeenCalledWith('u1', { requireEvidence: true, reason: 'logout' });
    expect(mockPrisma.auth_logs.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'logout', success: true }) }),
    );
  });

  it('revokes the canonical Hasura app UUID rather than the provider subject', async () => {
    const appUid = 'a0000000-0000-4000-8000-000000000abc';
    mockVerifyToken.mockReturnValue({
      sub: 'oidc-provider-subject',
      jti: 'hasura-jti',
      exp: 9999999999,
      'https://hasura.io/jwt/claims': {
        'x-hasura-user-id': appUid.toUpperCase(),
      },
    });
    mockPrisma.auth_logs.create.mockResolvedValue({});

    await AuthService.logout('tok');

    expect(mockRevokeAllUserTokens).toHaveBeenCalledWith(appUid, {
      requireEvidence: true,
      reason: 'logout',
    });
    expect(mockPrisma.auth_logs.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ user_id: appUid, action: 'logout' }),
    }));
  });

  it('fails closed before any revocation write when strong identity aliases conflict', async () => {
    mockVerifyToken.mockReturnValue({
      uid: 'a0000000-0000-4000-8000-000000000abc',
      user_id: 'different-app-identity',
      jti: 'conflict-jti',
      exp: 9999999999,
    });

    await expect(AuthService.logout('tok')).rejects.toMatchObject({
      statusCode: 401,
      code: 'TOKEN_INVALID',
    });
    expect(mockBlacklistToken).not.toHaveBeenCalled();
    expect(mockRevokeAllUserTokens).not.toHaveBeenCalled();
  });

  it('returns {} when the token cannot be verified', async () => {
    mockVerifyToken.mockReturnValue(null);
    const res = await AuthService.logout('bad');
    expect(res).toEqual({});
    expect(mockBlacklistToken).not.toHaveBeenCalled();
  });

  // Audit F10 (2026-08-09): a silent revocation-store failure used to be
  // swallowed here and reported to the client as a successful logout, even
  // though the JWT (patient tokens live 7 days) was never actually revoked.
  // Revocation failures must now propagate so the controller can return an
  // honest error instead of "Logged out successfully".
  it('throws when the token blacklist write fails (revocation, not just audit, must be provably done)', async () => {
    mockVerifyToken.mockReturnValue({ uid: 'u1', phone: '+91', jti: 'j', exp: 9999999999 });
    mockBlacklistToken.mockRejectedValueOnce(
      Object.assign(new Error('No token revocation store accepted the blacklist entry'), {
        code: 'REVOCATION_WRITE_UNAVAILABLE',
      }),
    );

    await expect(AuthService.logout('tok')).rejects.toMatchObject({ code: 'REVOCATION_WRITE_UNAVAILABLE' });
    expect(mockPrisma.auth_logs.create).not.toHaveBeenCalled();
  });

  it('throws when revokeAllUserTokens fails, even though the presented-token blacklist write succeeded', async () => {
    mockVerifyToken.mockReturnValue({ uid: 'u1', phone: '+91', jti: 'j', exp: 9999999999 });
    mockRevokeAllUserTokens.mockRejectedValueOnce(
      Object.assign(new Error('No token revocation store accepted the revoke-all marker'), {
        code: 'REVOCATION_WRITE_UNAVAILABLE',
      }),
    );

    await expect(AuthService.logout('tok')).rejects.toMatchObject({ code: 'REVOCATION_WRITE_UNAVAILABLE' });
  });

  it('an audit-log write failure does not undo an otherwise-successful revocation', async () => {
    mockVerifyToken.mockReturnValue({ uid: 'u1', phone: '+91', jti: 'j', exp: 9999999999 });
    mockPrisma.auth_logs.create.mockRejectedValue(new Error('db down'));

    const res = await AuthService.logout('tok');
    expect(res).toEqual({ phone: '+91' });
    expect(mockBlacklistToken).toHaveBeenCalled();
    expect(mockRevokeAllUserTokens).toHaveBeenCalled();
  });

  it('does not blacklist when the decoded token lacks jti/exp', async () => {
    mockVerifyToken.mockReturnValue({ uid: 'u1', phone: '+91' });
    mockPrisma.auth_logs.create.mockResolvedValue({});

    const res = await AuthService.logout('tok');
    expect(res).toEqual({ phone: '+91' });
    expect(mockBlacklistToken).not.toHaveBeenCalled();
  });
});

describe('AuthService.revokeAllTokens', () => {
  it('delegates to revokeAllUserTokens and reports success', async () => {
    const res = await AuthService.revokeAllTokens('u1');
    expect(mockRevokeAllUserTokens).toHaveBeenCalledWith('u1');
    expect(res).toEqual({ revoked: true });
  });
});

// ====================================================================
// getUserByPhone catch branch
// ====================================================================
describe('AuthService.getUserByPhone — error path', () => {
  it('rethrows when prisma fails', async () => {
    mockPrisma.users.findUnique.mockRejectedValue(new Error('db down'));
    await expect(AuthService.getUserByPhone('9876543210')).rejects.toThrow('db down');
  });
});

// ====================================================================
// Legacy phone auth (gate-protected)
// ====================================================================
describe('AuthService legacy phone auth gate', () => {
  it('_assertLegacyPhoneAuthAllowed throws FORBIDDEN when disabled', () => {
    mockIsLegacyPhoneAuthAllowed.mockReturnValue(false);
    expect(() => AuthService._assertLegacyPhoneAuthAllowed('login')).toThrow(/Phone-only login is disabled/);
    try {
      AuthService._assertLegacyPhoneAuthAllowed('login');
    } catch (e) {
      expect(e.statusCode).toBe(403);
      expect(e.code).toBe('PHONE_AUTH_DISABLED');
    }
  });

  it('legacyLogin is blocked when the gate is closed', async () => {
    mockIsLegacyPhoneAuthAllowed.mockReturnValue(false);
    await expect(AuthService.legacyLogin('9876543210', {})).rejects.toMatchObject({ code: 'PHONE_AUTH_DISABLED' });
  });

  it('legacyLogin delegates to directOtpLogin when the gate is open', async () => {
    mockIsLegacyPhoneAuthAllowed.mockReturnValue(true);
    mockPrisma.users.findUnique.mockResolvedValue({ uid: 'u1', id: 1, phone: '+91', name: 'A', role: 'PATIENT' });
    const req = { ip: '203.0.113.15', headers: { 'user-agent': 'legacy-login-test' } };

    const res = await AuthService.legacyLogin('9876543210', req, { deviceType: 'desktop' });
    expect(res.token).toBe('session-access-token');
    expect(mockIssueSession).toHaveBeenCalledWith(
      expect.objectContaining({ userUid: 'u1', req, deviceType: 'desktop' }),
    );
  });

  it('legacyRegister is blocked when the gate is closed', async () => {
    mockIsLegacyPhoneAuthAllowed.mockReturnValue(false);
    await expect(AuthService.legacyRegister('9876543210', {})).rejects.toMatchObject({ code: 'PHONE_AUTH_DISABLED' });
  });

  it('legacyRegister creates a new user when the gate is open', async () => {
    mockIsLegacyPhoneAuthAllowed.mockReturnValue(true);
    mockPrisma.users.findUnique.mockResolvedValue(null);
    mockPrisma.users.create.mockResolvedValue({ uid: 'new', id: 2, phone: '+919876543210', role: 'PATIENT' });
    const req = { ip: '203.0.113.13', headers: { 'user-agent': 'legacy-register-test' } };

    const res = await AuthService.legacyRegister('9876543210', req, { deviceType: 'desktop' });
    expect(res.token).toBe('session-access-token');
    expect(res.user).toMatchObject({ uid: 'new', role: 'PATIENT' });
    expect(mockIssueSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userUid: 'new',
        tokenPayload: expect.objectContaining({ uid: 'new', id: 2, role: 'PATIENT' }),
        req,
        deviceType: 'desktop',
      }),
    );
  });

  it('legacyRegister throws CONFLICT when the user already exists', async () => {
    mockIsLegacyPhoneAuthAllowed.mockReturnValue(true);
    mockPrisma.users.findUnique.mockResolvedValue({ uid: 'existing' });

    await expect(AuthService.legacyRegister('9876543210', {})).rejects.toMatchObject({
      message: 'User already exists',
      statusCode: 409,
    });
  });
});

// ====================================================================
// Health / stats reporters (happy path + degraded catch branch)
// ====================================================================
describe('AuthService.getAdminAuthHealth', () => {
  it('reports healthy with statistics', async () => {
    mockPrisma.admins.count
      .mockResolvedValueOnce(10)   // totalAdmins
      .mockResolvedValueOnce(8);   // activeAdmins
    mockPrisma.auth_logs.count.mockResolvedValue(3);

    const res = await AuthService.getAdminAuthHealth();
    expect(res).toMatchObject({
      status: 'healthy',
      statistics: { totalAdmins: 10, activeAdmins: 8, recentLogins24h: 3 },
    });
  });

  it('returns degraded when a query throws (catch branch)', async () => {
    mockPrisma.admins.count.mockRejectedValue(new Error('db down'));
    const res = await AuthService.getAdminAuthHealth();
    expect(res.status).toBe('degraded');
  });
});

describe('AuthService.getAdminActivityLogs', () => {
  it('returns formatted logs + pagination', async () => {
    mockPrisma.auth_logs.findMany.mockResolvedValue([
      { action: 'admin_login', success: true, ip_address: '1.1.1.1', user_agent: 'UA', created_at: new Date() },
    ]);
    mockPrisma.auth_logs.count.mockResolvedValue(1);

    const res = await AuthService.getAdminActivityLogs('a1', { page: 1, limit: 10 });
    expect(res.logs).toHaveLength(1);
    expect(res.logs[0].created_at).toBe('dd-mm-yyyy');
    expect(mockBuildPagination).toHaveBeenCalledWith(1, 1, 10);
  });

  it('rethrows when the query fails (catch branch)', async () => {
    mockPrisma.auth_logs.findMany.mockRejectedValue(new Error('db down'));
    await expect(AuthService.getAdminActivityLogs('a1', { page: 1, limit: 10 })).rejects.toThrow('db down');
  });
});

describe('AuthService.getHealthStatus', () => {
  it('reports healthy with user / otp / session statistics', async () => {
    mockPrisma.users.count
      .mockResolvedValueOnce(100)  // totalUsers
      .mockResolvedValueOnce(20)   // active24h
      .mockResolvedValueOnce(5);   // newUsers7d
    mockPrisma.otp_sessions.count
      .mockResolvedValueOnce(50)   // total otps 24h
      .mockResolvedValueOnce(40)   // verified 24h
      .mockResolvedValueOnce(7);   // recent 1h
    mockPrisma.user_sessions.count.mockResolvedValue(12);

    const res = await AuthService.getHealthStatus();
    expect(res.status).toBe('healthy');
    expect(res.statistics.users).toMatchObject({ total_users: 100, active_24h: 20, new_users_7d: 5 });
    expect(res.statistics.otps).toMatchObject({ total_otps: 50, verified_otps: 40, recent_otps: 7 });
    expect(res.statistics.sessions).toEqual({ active_sessions: 12 });
  });

  it('returns degraded when a query throws (catch branch)', async () => {
    mockPrisma.users.count.mockRejectedValue(new Error('db down'));
    const res = await AuthService.getHealthStatus();
    expect(res.status).toBe('degraded');
  });
});

describe('AuthService.getPublicStats', () => {
  it('aggregates registered users, 24h logins and 7d new users', async () => {
    mockPrisma.auth_logs.groupBy.mockResolvedValue([{ phone: 'a' }, { phone: 'b' }]);
    mockPrisma.auth_logs.count
      .mockResolvedValueOnce(15)   // logins 24h
      .mockResolvedValueOnce(4);   // new users 7d

    const res = await AuthService.getPublicStats();
    expect(res).toMatchObject({ registered_users: 2, logins_24h: 15, new_users_7d: 4 });
    expect(res.lastUpdated).toBeInstanceOf(Date);
  });

  it('rethrows when aggregation fails (catch branch)', async () => {
    mockPrisma.auth_logs.groupBy.mockRejectedValue(new Error('db down'));
    await expect(AuthService.getPublicStats()).rejects.toThrow('db down');
  });
});

// ====================================================================
// verifyOtpAndAuthenticate (separate from verifyOtp)
// ====================================================================
describe('AuthService.verifyOtpAndAuthenticate', () => {
  it('creates a new user and claims the routed OTP session', async () => {
    mockOtpVerify.mockResolvedValue({ valid: true });
    mockPrisma.users.findFirst.mockResolvedValue(null);
    mockPrisma.users.create.mockResolvedValue({ uid: 'new', id: 1, name: null, phone: '+919876543210', role: 'PATIENT' });
    const req = { ip: '203.0.113.14', headers: { 'user-agent': 'otp-route-test' } };

    const res = await AuthService.verifyOtpAndAuthenticate('9876543210', '123456', req, { deviceType: 'mobile' });
    expect(res.user.isNewUser).toBe(true);
    expect(res.token).toBe('session-access-token');
    expect(mockIssueSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userUid: 'new',
        tokenPayload: expect.objectContaining({ uid: 'new', id: 1, role: 'PATIENT' }),
        req,
        deviceType: 'mobile',
      }),
    );
  });

  it('returns isNewUser false for an existing user', async () => {
    mockOtpVerify.mockResolvedValue({ valid: true });
    mockPrisma.users.findFirst.mockResolvedValue({ uid: 'existing' });
    mockPrisma.users.update.mockResolvedValue({ uid: 'existing', id: 2, name: 'Bob', phone: '+919876543210', role: 'PATIENT' });

    const res = await AuthService.verifyOtpAndAuthenticate('9876543210', '123456', {});
    expect(res.user.isNewUser).toBe(false);
  });

  it('throws a 400 AppError-shaped error when the OTP is invalid', async () => {
    mockOtpVerify.mockResolvedValue({ valid: false, reason: 'OTP expired' });

    await expect(AuthService.verifyOtpAndAuthenticate('9876543210', '000000', {})).rejects.toMatchObject({
      message: 'OTP expired',
      statusCode: 400,
    });
  });
});

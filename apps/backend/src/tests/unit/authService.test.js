// src/tests/unit/authService.test.js
// Unit tests for AuthService — all external deps mocked

import { jest } from '@jest/globals';

// ── Mocks (must be set up before importing the service) ──────────────

// Mock prisma
import mockPrisma from '../__mocks__/prisma.js';
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: mockPrisma,
  setTenantTx: async (_tenantId, fn) => fn(mockPrisma),
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));

// Mock logger (silence output)
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Mock jwtUtils
const mockGenerateToken = jest.fn().mockReturnValue('mock-jwt-token');
const mockVerifyToken = jest.fn();
const mockIssueSetupToken = jest.fn().mockReturnValue('mock-setup-token');
jest.unstable_mockModule('../../utils/jwtUtils.js', () => ({
  generateToken: mockGenerateToken,
  verifyToken: mockVerifyToken,
  verifyTokenAllowExpired: mockVerifyToken,
  issueSetupToken: mockIssueSetupToken,
}));

// Mock phoneUtils — pass-through normalizePhone for predictability
jest.unstable_mockModule('../../utils/phoneUtils.js', () => ({
  normalizePhone: (phone) => {
    if (!phone) return null;
    let n = phone.replace(/[^\d+]/g, '');
    if (n.length === 10 && !n.startsWith('+')) n = '+91' + n;
    else if (n.startsWith('91') && n.length === 12) n = '+' + n;
    else if (!n.startsWith('+') && n.length > 10) n = '+' + n;
    return n;
  },
}));

// Mock bcrypt
const mockBcryptCompare = jest.fn();
jest.unstable_mockModule('bcrypt', () => ({
  default: { compare: mockBcryptCompare, hash: jest.fn().mockResolvedValue('hashed') },
}));

// Mock otpService
const mockOtpVerify = jest.fn();
jest.unstable_mockModule('../../services/auth/otpService.js', () => ({
  requestOtp: jest.fn(),
  verifyOtp: mockOtpVerify,
}));

// Mock firebaseAuthService (not tested here, just needs to exist)
jest.unstable_mockModule('../../services/auth/firebaseAuthService.js', () => ({
  authenticateWithFirebase: jest.fn(),
  completeUserProfile: jest.fn(),
  linkFirebaseAccount: jest.fn(),
  updateFcmToken: jest.fn(),
  revokeFirebaseSession: jest.fn(),
  verifyTokenStatus: jest.fn(),
  getHealthStatus: jest.fn(),
}));

// Mock securityConfig
jest.unstable_mockModule('../../config/securityConfig.js', () => ({
  SECURITY_CONFIG: {
    admin: { maxFailedAttempts: 5, lockoutDurationMinutes: 15 },
    otp: { maxAttemptsPerPhone: 5, expiryMinutes: 10, codeLength: 6 },
    jwt: { defaultExpiry: '7d', refreshExpiry: '30d' },
    deviceTrust: { maxDaysWithoutExpiry: 90 },
    session: { inactivityTimeoutMinutes: 30 },
  },
}));

// Mock responseCodes
jest.unstable_mockModule('../../config/responseCodes.js', () => ({
  HTTP_STATUS: { BAD_REQUEST: 400, UNAUTHORIZED: 401, NOT_FOUND: 404, TOO_MANY_REQUESTS: 429 },
}));

// Mock dateUtils
jest.unstable_mockModule('../../utils/dateUtils.js', () => ({
  formatDateDDMMYYYY: jest.fn((d) => d?.toISOString?.() ?? d),
}));

// ── Import the service under test (after mocks) ─────────────────────
const { AuthService } = await import('../../services/auth/authService.js');

// ── Test suites ──────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------- getUserByPhone ----------
describe('AuthService.getUserByPhone', () => {
  it('returns the user when found', async () => {
    const fakeUser = { uid: 'u1', phone: '+919876543210', name: 'Alice', role: 'PATIENT' };
    mockPrisma.users.findUnique.mockResolvedValue(fakeUser);

    const result = await AuthService.getUserByPhone('9876543210');

    expect(mockPrisma.users.findUnique).toHaveBeenCalledWith({
      where: { phone: '+919876543210' },
      select: { uid: true, id: true, phone: true, name: true, role: true },
    });
    expect(result).toEqual(fakeUser);
  });

  it('returns null when user does not exist', async () => {
    mockPrisma.users.findUnique.mockResolvedValue(null);

    const result = await AuthService.getUserByPhone('0000000000');
    expect(result).toBeNull();
  });
});

// ---------- adminLogin ----------
describe('AuthService.adminLogin', () => {
  const validAdmin = {
    id: 1,
    uid: '550e8400-e29b-41d4-a716-446655440001',
    username: 'admin1',
    email: 'admin1@test.com',
    role: 'ADMIN',
    status: 'active',
    failed_login_attempts: 0,
    last_failed_login: null,
    password_hash: '$2b$10$hashed',
    updated_at: new Date(),
  };

  it('rejects when admin not found (invalid credentials)', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue(null);

    await expect(AuthService.adminLogin('nobody', 'pass')).rejects.toThrow('Invalid credentials');
  });

  it('rejects when account is deactivated', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue({ ...validAdmin, status: 'inactive' });

    await expect(AuthService.adminLogin('admin1', 'pass')).rejects.toThrow('Account is deactivated');
  });

  it('enforces lockout after max failed attempts', async () => {
    const lockedAdmin = {
      ...validAdmin,
      failed_login_attempts: 5,
      last_failed_login: new Date(), // just now — still within lockout window
    };
    mockPrisma.admins.findFirst.mockResolvedValue(lockedAdmin);

    await expect(AuthService.adminLogin('admin1', 'pass')).rejects.toThrow(
      /Account temporarily locked/
    );
  });

  it('resets lockout counter when lockout period has expired', async () => {
    const expiredLockAdmin = {
      ...validAdmin,
      failed_login_attempts: 5,
      last_failed_login: new Date(Date.now() - 20 * 60 * 1000), // 20 min ago — past 15-min lockout
    };
    mockPrisma.admins.findFirst.mockResolvedValue(expiredLockAdmin);
    mockPrisma.admins.update.mockResolvedValue({});
    mockBcryptCompare.mockResolvedValue(true);

    const result = await AuthService.adminLogin('admin1', 'correctPassword');

    // Should have reset the counter first, then updated on successful login
    expect(mockPrisma.admins.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uid: '550e8400-e29b-41d4-a716-446655440001' },
        data: { failed_login_attempts: 0 },
      })
    );
    expect(result).toHaveProperty('token', 'mock-jwt-token');
  });

  it('increments failed_login_attempts on wrong password', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue(validAdmin);
    mockBcryptCompare.mockResolvedValue(false);
    mockPrisma.admins.update.mockResolvedValue({});

    await expect(AuthService.adminLogin('admin1', 'wrong')).rejects.toThrow('Invalid credentials');

    expect(mockPrisma.admins.update).toHaveBeenCalledWith({
      where: { uid: '550e8400-e29b-41d4-a716-446655440001' },
      data: {
        failed_login_attempts: { increment: 1 },
        last_failed_login: expect.any(Date),
      },
    });
  });

  it('succeeds with valid credentials and returns token + admin', async () => {
    mockPrisma.admins.findFirst.mockResolvedValue(validAdmin);
    mockBcryptCompare.mockResolvedValue(true);
    mockPrisma.admins.update.mockResolvedValue({});

    const result = await AuthService.adminLogin('admin1', 'correctPassword');

    expect(result.token).toBe('mock-jwt-token');
    expect(result.admin).toEqual({
      uid: '550e8400-e29b-41d4-a716-446655440001',
      username: 'admin1',
      email: 'admin1@test.com',
      role: 'ADMIN',
    });
    // Should reset failed_login_attempts on success
    expect(mockPrisma.admins.update).toHaveBeenCalledWith({
      where: { uid: '550e8400-e29b-41d4-a716-446655440001' },
      data: { last_login: expect.any(Date), failed_login_attempts: 0 },
    });
  });
});

// ---------- verifyOtp ----------
describe('AuthService.verifyOtp', () => {
  it('creates a new user on first login (upsert) and sets isNewUser true', async () => {
    mockOtpVerify.mockResolvedValue({ valid: true });
    // No existing user (findFirst — phone is unique per-tenant now, mig 333)
    mockPrisma.users.findFirst.mockResolvedValue(null);
    // create returns the newly created user
    mockPrisma.users.create.mockResolvedValue({
      uid: 'new-uid',
      id: 1,
      name: null,
      phone: '+919876543210',
      role: 'PATIENT',
    });

    const result = await AuthService.verifyOtp('9876543210', '123456', {});

    expect(mockPrisma.users.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phone: '+919876543210', role: 'PATIENT' }),
      })
    );
    expect(result.user.isNewUser).toBe(true);
    expect(result.token).toBe('mock-jwt-token');
  });

  it('returns isNewUser false for existing user', async () => {
    mockOtpVerify.mockResolvedValue({ valid: true });
    mockPrisma.users.findFirst.mockResolvedValue({ uid: 'existing-uid' });
    mockPrisma.users.update.mockResolvedValue({
      uid: 'existing-uid',
      id: 2,
      name: 'Bob',
      phone: '+919876543210',
      role: 'PATIENT',
    });

    const result = await AuthService.verifyOtp('9876543210', '123456', {});

    expect(result.user.isNewUser).toBe(false);
  });

  it('throws when OTP verification fails', async () => {
    mockOtpVerify.mockResolvedValue({ valid: false, reason: 'OTP has expired' });

    await expect(AuthService.verifyOtp('9876543210', '000000', {})).rejects.toThrow('OTP has expired');
  });
});

// ---------- refreshToken ----------
describe('AuthService.refreshToken', () => {
  it('returns a new access + refresh token for a valid type:refresh token', async () => {
    mockVerifyToken.mockReturnValue({ uid: 'u1', phone: '+919876543210', role: 'PATIENT', type: 'refresh' });
    mockPrisma.users.findUnique.mockResolvedValue({
      uid: 'u1',
      phone: '+919876543210',
      name: 'Alice',
      role: 'PATIENT',
    });

    const result = await AuthService.refreshToken('old-refresh-token');

    expect(mockVerifyToken).toHaveBeenCalledWith('old-refresh-token');
    expect(result.token).toBe('mock-jwt-token');
    expect(result.refreshToken).toBe('mock-jwt-token');
    expect(result.user.uid).toBe('u1');
  });

  it('C-9: rejects an access token (no type:refresh) at the refresh endpoint', async () => {
    mockVerifyToken.mockReturnValue({ uid: 'u1', phone: '+919876543210', role: 'PATIENT' });

    await expect(AuthService.refreshToken('access-token')).rejects.toMatchObject({
      statusCode: 401,
      code: 'TOKEN_INVALID',
    });
  });

  it('throws when token is invalid/expired', async () => {
    mockVerifyToken.mockReturnValue(null);

    await expect(AuthService.refreshToken('bad-token')).rejects.toMatchObject({
      statusCode: 401,
      code: 'TOKEN_INVALID',
    });
  });

  it('throws when user no longer exists', async () => {
    mockVerifyToken.mockReturnValue({ uid: 'deleted-uid', type: 'refresh' });
    mockPrisma.users.findUnique.mockResolvedValue(null);

    await expect(AuthService.refreshToken('valid-token-deleted-user')).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });
});

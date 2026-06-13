// src/tests/unit/otpService.test.js
// Unit tests for OTP service — prisma and crypto mocked

import { jest } from '@jest/globals';

// ── Mocks ────────────────────────────────────────────────────────────

import mockPrisma from '../__mocks__/prisma.js';
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenantTx: async (_tenantId, fn) => fn(mockPrisma),
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Mock phoneUtils — simple pass-through
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

// Mock otpConfig with test-friendly values
jest.unstable_mockModule('../../config/otpConfig.js', () => ({
  OTP_CONFIG: {
    length: 6,
    expirationMinutes: 5,
    maxAttempts: 3,
    resendCooldownMinutes: 1,
    dailyLimit: 10,
    devMode: false,
    purposes: {
      LOGIN: 'login',
      REGISTER: 'register',
      RESET_PASSWORD: 'reset_password',
      VERIFY_PHONE: 'verify_phone',
      GENERAL: 'general',
      ADMIN_OVERRIDE: 'admin_override',
    },
  },
  OTP_ERRORS: {
    EXPIRED: 'OTP has expired',
    INVALID: 'Invalid OTP',
    MAX_ATTEMPTS: 'Maximum verification attempts exceeded',
    NOT_FOUND: 'OTP not found or already used',
    DAILY_LIMIT: 'Daily OTP limit exceeded',
    COOLDOWN: 'Please wait before requesting another OTP',
  },
}));

jest.unstable_mockModule('../../config/responseCodes.js', () => ({
  HTTP_STATUS: { BAD_REQUEST: 400, TOO_MANY_REQUESTS: 429 },
}));

// ── Import the service under test ────────────────────────────────────
const {
  generateOTP,
  checkDailyLimit,
  checkResendCooldown,
  verifyOtp,
} = await import('../../services/auth/otpService.js');

// ── Helpers ──────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
});

// ---------- generateOTP ----------
describe('generateOTP', () => {
  it('returns a 6-digit string', () => {
    const otp = generateOTP();
    expect(typeof otp).toBe('string');
    expect(otp).toMatch(/^\d{6}$/);
  });

  it('returns different values on successive calls (non-deterministic)', () => {
    // Generate several OTPs — at least two should differ (probabilistic but near-certain with 6 digits)
    const otps = new Set(Array.from({ length: 20 }, () => generateOTP()));
    expect(otps.size).toBeGreaterThan(1);
  });
});

// ---------- checkDailyLimit ----------
describe('checkDailyLimit', () => {
  it('returns true when under the daily limit', async () => {
    mockPrisma.otp_logs.count.mockResolvedValue(5); // under 10

    const result = await checkDailyLimit('+919876543210');

    expect(result).toBe(true);
    expect(mockPrisma.otp_logs.count).toHaveBeenCalledWith({
      where: {
        phone: '+919876543210',
        action: 'request',
        created_at: { gt: expect.any(Date) },
      },
    });
  });

  it('returns false when limit is reached', async () => {
    mockPrisma.otp_logs.count.mockResolvedValue(10); // equal to limit

    const result = await checkDailyLimit('+919876543210');
    expect(result).toBe(false);
  });

  it('returns false when limit is exceeded', async () => {
    mockPrisma.otp_logs.count.mockResolvedValue(15);

    const result = await checkDailyLimit('+919876543210');
    expect(result).toBe(false);
  });
});

// ---------- checkResendCooldown ----------
describe('checkResendCooldown', () => {
  it('returns true (allowed) when no recent session exists', async () => {
    mockPrisma.otp_sessions.findFirst.mockResolvedValue(null);

    const result = await checkResendCooldown('+919876543210', 'login');
    expect(result).toBe(true);
  });

  it('returns false (blocked) when a session is within cooldown window', async () => {
    // findFirst returns a recent session — means cooldown is active
    mockPrisma.otp_sessions.findFirst.mockResolvedValue({ created_at: new Date() });

    const result = await checkResendCooldown('+919876543210', 'login');
    expect(result).toBe(false);
  });
});

// ---------- verifyOtp ----------
describe('verifyOtp', () => {
  const phone = '+919876543210';
  const purpose = 'login';

  it('returns invalid when no OTP session is found', async () => {
    mockPrisma.otp_sessions.findFirst.mockResolvedValue(null);
    mockPrisma.otp_logs.create.mockResolvedValue({});

    const result = await verifyOtp(phone, '123456', purpose, {});

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('OTP not found or already used');
  });

  it('returns invalid for an expired OTP', async () => {
    mockPrisma.otp_sessions.findFirst.mockResolvedValue({
      id: 1,
      otp: '123456',
      expires_at: new Date(Date.now() - 60 * 1000), // expired 1 minute ago
      attempts: 0,
      user_id: null,
    });
    mockPrisma.otp_logs.create.mockResolvedValue({});

    const result = await verifyOtp(phone, '123456', purpose, {});

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('OTP has expired');
  });

  it('returns invalid after max attempts exceeded', async () => {
    mockPrisma.otp_sessions.findFirst.mockResolvedValue({
      id: 2,
      otp: '123456',
      expires_at: new Date(Date.now() + 5 * 60 * 1000), // still valid
      attempts: 3, // maxAttempts is 3, so >= 3 triggers rejection
      user_id: null,
    });
    mockPrisma.otp_logs.create.mockResolvedValue({});

    const result = await verifyOtp(phone, '123456', purpose, {});

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Maximum verification attempts exceeded');
    expect(result.attemptsLeft).toBe(0);
  });

  it('returns invalid for wrong OTP code and decrements remaining attempts', async () => {
    mockPrisma.otp_sessions.findFirst.mockResolvedValue({
      id: 3,
      otp: '654321',
      expires_at: new Date(Date.now() + 5 * 60 * 1000),
      attempts: 1,
      user_id: null,
    });
    mockPrisma.otp_sessions.update.mockResolvedValue({});
    mockPrisma.otp_logs.create.mockResolvedValue({});

    const result = await verifyOtp(phone, '000000', purpose, {});

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Invalid OTP');
    // attempts was 1, incremented to 2, so attemptsLeft = 3 - 1 - 1 = 1
    expect(result.attemptsLeft).toBe(1);
    // Should have incremented attempts
    expect(mockPrisma.otp_sessions.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { attempts: { increment: 1 } },
    });
  });

  it('succeeds with correct OTP and marks session as verified', async () => {
    mockPrisma.otp_sessions.findFirst.mockResolvedValue({
      id: 4,
      otp: '123456',
      expires_at: new Date(Date.now() + 5 * 60 * 1000),
      attempts: 0,
      user_id: 'user-42',
    });
    mockPrisma.otp_sessions.update.mockResolvedValue({});
    mockPrisma.otp_logs.create.mockResolvedValue({});

    const result = await verifyOtp(phone, '123456', purpose, {});

    expect(result.valid).toBe(true);
    expect(result.sessionId).toBe(4);
    expect(result.userId).toBe('user-42');
    expect(result.phone).toBe(phone);
    expect(result.purpose).toBe(purpose);
    expect(result.verifiedAt).toBeDefined();

    // Should have incremented attempts, then marked verified
    expect(mockPrisma.otp_sessions.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { attempts: { increment: 1 } },
    });
    expect(mockPrisma.otp_sessions.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { verified: true },
    });
  });
});

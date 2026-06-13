// SEC-7: OTPService.verifyOTP (patient/Firebase-linking variant) hardening.
//   1. The session lookup carries an `expires_at > now()` predicate so an
//      expired row can't be walked into the compare path.
//   2. A per-phone cross-session failed-verify counter (otp_logs) caps brute
//      force that sidesteps the per-session attempts counter by requesting a
//      fresh OTP each burst.

import { jest } from '@jest/globals';

import mockPrisma from '../__mocks__/prisma.js';
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: mockPrisma }));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../config/otpConfig.js', () => ({
  OTP_CONFIG: {
    length: 6,
    expirationMinutes: 5,
    maxAttempts: 3,
    resendCooldownMinutes: 1,
    dailyLimit: 10,
    devMode: false,
  },
  OTP_ERRORS: {},
}));

jest.unstable_mockModule('../../config/securityConfig.js', () => ({
  SECURITY_CONFIG: { otp: { maxAttemptsPerPhone: 5 } },
  default: { otp: { maxAttemptsPerPhone: 5 } },
}));

const { OTPService } = await import('../../services/otpService.js');

const PHONE = '+919876543210';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.otp_logs.count.mockResolvedValue(0); // not locked by default
  mockPrisma.otp_logs.create.mockResolvedValue({});
  mockPrisma.otp_sessions.update.mockResolvedValue({});
});

describe('OTPService.verifyOTP expiry predicate (SEC-7)', () => {
  it('includes expires_at > now() in the session lookup', async () => {
    mockPrisma.otp_sessions.findFirst.mockResolvedValue(null);

    await OTPService.verifyOTP(PHONE, '123456', 'login');

    expect(mockPrisma.otp_sessions.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          phone: PHONE,
          purpose: 'login',
          verified: false,
          expires_at: { gt: expect.any(Date) },
        }),
      }),
    );
  });

  it('treats an expired/absent row as not-found (lookup excludes it)', async () => {
    // With the expiry predicate the query simply returns null for an expired row.
    mockPrisma.otp_sessions.findFirst.mockResolvedValue(null);

    const result = await OTPService.verifyOTP(PHONE, '123456', 'login');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not found or expired/i);
  });
});

describe('OTPService cross-session failed-verify cap (SEC-7)', () => {
  it('locks the phone once failed verifies across sessions hit the cap', async () => {
    mockPrisma.otp_logs.count.mockResolvedValue(5); // == maxAttemptsPerPhone

    const result = await OTPService.verifyOTP(PHONE, '123456', 'login');

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Too many attempts');
    // Must short-circuit before touching the session row.
    expect(mockPrisma.otp_sessions.findFirst).not.toHaveBeenCalled();
    // Counts failed verify logs for this phone within the OTP window.
    expect(mockPrisma.otp_logs.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          phone: PHONE,
          action: 'verify',
          success: false,
          created_at: { gte: expect.any(Date) },
        }),
      }),
    );
  });

  it('records a failed verify (for the cross-session counter) on a wrong OTP', async () => {
    mockPrisma.otp_logs.count.mockResolvedValue(0);
    mockPrisma.otp_sessions.findFirst.mockResolvedValue({
      id: 10,
      otp: '654321', // plaintext legacy row → direct compare
      expires_at: new Date(Date.now() + 5 * 60 * 1000),
      attempts: 0,
      user_id: null,
    });

    const result = await OTPService.verifyOTP(PHONE, '000000', 'login');

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Invalid OTP');
    // A failed-verify audit row must be written so the counter accumulates.
    expect(mockPrisma.otp_logs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phone: PHONE,
          action: 'verify',
          success: false,
        }),
      }),
    );
  });

  it('succeeds with the correct OTP when under the cross-session cap', async () => {
    mockPrisma.otp_logs.count.mockResolvedValue(2);
    mockPrisma.otp_sessions.findFirst.mockResolvedValue({
      id: 11,
      otp: '123456',
      expires_at: new Date(Date.now() + 5 * 60 * 1000),
      attempts: 0,
      user_id: 'user-77',
    });

    const result = await OTPService.verifyOTP(PHONE, '123456', 'login');

    expect(result.valid).toBe(true);
    expect(result.sessionId).toBe(11);
    expect(result.userId).toBe('user-77');
    expect(mockPrisma.otp_sessions.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { verified: true },
    });
  });
});

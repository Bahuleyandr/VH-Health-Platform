import { jest } from '@jest/globals';

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

jest.unstable_mockModule('../../config/otpConfig.js', () => ({
  OTP_CONFIG: {
    length: 6,
    expirationMinutes: 5,
    maxAttempts: 3,
    resendCooldownMinutes: 1,
    dailyLimit: 10,
    devMode: false,
  },
}));

const { OTPService } = await import('../../services/otpService.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('root OTPService verification hardening', () => {
  it('fails closed on OTP store errors instead of accepting the legacy 123456 code', async () => {
    mockPrisma.otp_sessions.findFirst.mockRejectedValueOnce(new Error('database unavailable'));

    const result = await OTPService.verifyOTP('+919876543210', '123456', 'account_linking');

    expect(result).toEqual({
      valid: false,
      reason: 'OTP verification temporarily unavailable',
    });
    expect(mockPrisma.otp_sessions.update).not.toHaveBeenCalled();
  });

  it('does not bypass the cross-session verify cap when its counter is unavailable', async () => {
    mockPrisma.otp_logs.count.mockRejectedValueOnce(new Error('counter unavailable'));

    const result = await OTPService.verifyOTP('+919876543210', '123456', 'account_linking');

    expect(result).toEqual({
      valid: false,
      reason: 'OTP verification temporarily unavailable',
    });
    expect(mockPrisma.otp_sessions.findFirst).not.toHaveBeenCalled();
  });

  it('does not approve a daily request when its counter is unavailable', async () => {
    mockPrisma.otp_logs.count.mockRejectedValueOnce(new Error('counter unavailable'));

    await expect(OTPService.checkDailyLimit('+919876543210')).rejects.toThrow('counter unavailable');
  });

  it('does not approve a resend when its cooldown record is unavailable', async () => {
    mockPrisma.otp_sessions.findFirst.mockRejectedValueOnce(new Error('session unavailable'));

    await expect(OTPService.checkResendCooldown('+919876543210', 'login')).rejects.toThrow('session unavailable');
  });
});

// Audit F10 companion (2026-08-09 VH Health full audit): a failed
// otp_sessions insert used to be swallowed and answered with a fabricated
// `mock_<timestamp>` sessionId, so the caller believed an OTP session existed
// when nothing was persisted — verification would then fail mysteriously
// later, masking a DB outage as a user-side OTP failure. Local override (not
// the shared __mocks__/prisma.js) so this file doesn't widen a fixture other
// suites depend on: storeOTP calls otp_sessions.deleteMany before create,
// which the shared mock doesn't define.
describe('OTPService.storeOTP (audit F10 companion — session-insert honesty)', () => {
  beforeEach(() => {
    mockPrisma.otp_sessions.deleteMany = jest.fn().mockResolvedValue({ count: 0 });
  });

  it('throws a 503 instead of returning a fabricated mock_ sessionId when the DB insert fails', async () => {
    mockPrisma.otp_sessions.create.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(OTPService.storeOTP('+919876543210', 'login')).rejects.toMatchObject({
      statusCode: 503,
      code: 'OTP_SESSION_UNAVAILABLE',
    });
  });

  it('happy path is unaffected: still returns the real DB session id', async () => {
    mockPrisma.otp_sessions.create.mockResolvedValueOnce({ id: 77, expires_at: new Date() });

    const result = await OTPService.storeOTP('+919876543210', 'login');
    expect(result.sessionId).toBe(77);
  });
});

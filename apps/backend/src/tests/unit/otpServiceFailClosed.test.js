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
});

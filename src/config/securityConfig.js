/**
 * Consolidated security configuration.
 * All security-related constants in one place instead of scattered across services.
 */
export const SECURITY_CONFIG = {
  // Admin login lockout
  admin: {
    maxFailedAttempts: parseInt(process.env.ADMIN_MAX_FAILED_ATTEMPTS || '5'),
    lockoutDurationMinutes: parseInt(process.env.ADMIN_LOCKOUT_MINUTES || '15'),
  },

  // OTP settings
  otp: {
    maxAttemptsPerPhone: 5,
    expiryMinutes: 10,
    codeLength: 6,
  },

  // JWT settings
  jwt: {
    defaultExpiry: process.env.JWT_EXPIRES_IN || '7d',
    refreshExpiry: '30d',
  },

  // Device trust
  deviceTrust: {
    maxDaysWithoutExpiry: 90,
  },

  // Session
  session: {
    inactivityTimeoutMinutes: 30,
  },
};

export default SECURITY_CONFIG;

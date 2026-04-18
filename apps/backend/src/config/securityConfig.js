/**
 * Consolidated security configuration.
 * ALL security-related constants live here — never hardcoded in services.
 * Each section maps to a security domain and is configurable via environment variables.
 */
export const SECURITY_CONFIG = {
  // Admin login lockout
  admin: {
    maxFailedAttempts: parseInt(process.env.ADMIN_MAX_FAILED_ATTEMPTS || '5'),
    lockoutDurationMinutes: parseInt(process.env.ADMIN_LOCKOUT_MINUTES || '15'),
  },

  // Staff login lockout
  staff: {
    maxFailedAttempts: parseInt(process.env.STAFF_MAX_FAILED_ATTEMPTS || '5'),
    lockoutDurationMinutes: parseInt(process.env.STAFF_LOCKOUT_MINUTES || '15'),
    maxDevicesPerStaff: parseInt(process.env.MAX_DEVICES_PER_STAFF || '5'),
    maxConcurrentSessions: parseInt(process.env.MAX_STAFF_SESSIONS || '3'),
  },

  // OTP settings
  otp: {
    maxAttemptsPerPhone: 5,
    expiryMinutes: 10,
    codeLength: 6,
    hashRounds: 6,
    dailyLimit: parseInt(process.env.OTP_DAILY_LIMIT || '20'),
    resendCooldownMinutes: parseInt(process.env.OTP_RESEND_COOLDOWN || '1'),
  },

  // JWT settings — role-specific expiry for principle of least privilege
  jwt: {
    defaultExpiry: process.env.JWT_EXPIRES_IN || '7d',            // Patient tokens (mobile app)
    adminExpiry: process.env.JWT_ADMIN_EXPIRES_IN || '4h',        // Admin portal tokens
    staffAccessExpiry: process.env.JWT_STAFF_EXPIRES_IN || '8h',  // Staff app access tokens
    refreshExpiry: '30d',
  },

  // Device trust
  deviceTrust: {
    maxDaysWithoutExpiry: parseInt(process.env.DEVICE_TRUST_DAYS || '90'),
  },

  // Session
  session: {
    inactivityTimeoutMinutes: 30,
  },

  // Token blacklist
  blacklist: {
    maxTokenLifetimeDays: 30,  // Longest any token can live (for blacklist TTL)
  },

  // Password policy
  password: {
    minLength: 8,
    requireUppercase: true,
    requireLowercase: true,
    requireNumbers: true,
    requireSpecialChars: true,
  },
};

export default SECURITY_CONFIG;

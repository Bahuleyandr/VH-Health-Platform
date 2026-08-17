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
    // Cross-session / per-phone failed-verify cap. This is the single source of
    // truth for the per-phone OTP attempt ceiling: it backs the SEC-7
    // cross-session lock (services/otpService.js#isPhoneVerifyLocked) AND the
    // admin password-reset OTP lock (services/auth/authService.js). It is
    // intentionally distinct from — and looser than — the per-SESSION verify
    // cap in config/otpConfig.js (`maxAttempts`, default 3), which counts
    // attempts on a single otp_sessions row. The two are layered defences, not
    // duplicates: do not collapse them into one value.
    maxAttemptsPerPhone: 5,
    expiryMinutes: 10,
    codeLength: 6,
    hashRounds: 6,
    dailyLimit: parseInt(process.env.OTP_DAILY_LIMIT || '20'),
    resendCooldownMinutes: parseInt(process.env.OTP_RESEND_COOLDOWN || '1'),
  },

  // Login 2FA (TOTP) challenge settings.
  mfa: {
    // Per-challenge verify cap (M3). A single totp_challenges token may be tried
    // at most this many times before it is burned and the admin must re-login —
    // bounds brute-force of the 6-digit TOTP within the challenge's expiry window.
    challengeMaxAttempts: parseInt(process.env.MFA_CHALLENGE_MAX_ATTEMPTS || '5'),
  },

  // JWT settings — role-specific expiry for principle of least privilege.
  // Audit finding L1 (2026-06-10): patient access tokens defaulted to 7d and
  // staff to 8h — a stolen token outlived any shift. Access tokens are now
  // short; clients refresh transparently via the existing rotation
  // (VHHttpClient single-flight refresh).
  jwt: {
    defaultExpiry: process.env.JWT_EXPIRES_IN || '1h',            // Patient tokens (mobile app)
    adminExpiry: process.env.JWT_ADMIN_EXPIRES_IN || '4h',        // Admin portal tokens
    staffAccessExpiry: process.env.JWT_STAFF_EXPIRES_IN || '1h',  // Staff app access tokens
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

  controlledDispenseWitness: {
    approvalTtlMinutes: parseInt(process.env.CONTROLLED_DISPENSE_WITNESS_APPROVAL_TTL_MINUTES || '5'),
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

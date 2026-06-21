// src/config/otpConfig.js - OTP Configuration

// Dev-OTP bypass (generateOTP() returns the fixed '123456'). Hardened so it
// cannot activate by accident: it now requires an EXPLICIT opt-in
// (ALLOW_DEV_OTP=true) ON TOP OF a non-production NODE_ENV. It can NEVER be
// true under NODE_ENV=production, regardless of the flag. Previously a bare
// NODE_ENV==='development' was enough, so any environment that happened to run
// with that value handed out a guessable OTP.
const isDevOtpAllowed = () => {
  if (String(process.env.NODE_ENV).toLowerCase() === 'production') return false;
  return String(process.env.ALLOW_DEV_OTP).toLowerCase() === 'true';
};

export const OTP_CONFIG = {
  length: parseInt(process.env.OTP_LENGTH) || 6,
  expirationMinutes: parseInt(process.env.OTP_EXPIRATION_MINUTES) || 5,
  maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS) || 3,
  resendCooldownMinutes: parseInt(process.env.OTP_RESEND_COOLDOWN) || 1,
  dailyLimit: parseInt(process.env.OTP_DAILY_LIMIT) || 10,
  devMode: isDevOtpAllowed(),
  
  // OTP purposes
  purposes: {
    LOGIN: 'login',
    REGISTER: 'register',
    RESET_PASSWORD: 'reset_password',
    VERIFY_PHONE: 'verify_phone',
    GENERAL: 'general',
    ADMIN_OVERRIDE: 'admin_override'
  }
};

export const OTP_ERRORS = {
  EXPIRED: 'OTP has expired',
  INVALID: 'Invalid OTP',
  MAX_ATTEMPTS: 'Maximum verification attempts exceeded',
  NOT_FOUND: 'OTP not found or already used',
  DAILY_LIMIT: 'Daily OTP limit exceeded',
  COOLDOWN: 'Please wait before requesting another OTP'
};
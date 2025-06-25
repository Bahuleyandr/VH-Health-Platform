// src/config/otpConfig.js - OTP Configuration

export const OTP_CONFIG = {
  length: 6,
  expirationMinutes: parseInt(process.env.OTP_EXPIRATION_MINUTES) || 5,
  maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS) || 3,
  resendCooldownMinutes: parseInt(process.env.OTP_RESEND_COOLDOWN) || 1,
  dailyLimit: parseInt(process.env.OTP_DAILY_LIMIT) || 10,
  devMode: process.env.NODE_ENV === 'development'
};

export const OTP_PURPOSES = [
  'login', 'register', 'reset_password', 'verify_phone', 'general'
];

export const OTP_ACTIONS = {
  REQUEST: 'request',
  VERIFY: 'verify',
  RESEND: 'resend'
};
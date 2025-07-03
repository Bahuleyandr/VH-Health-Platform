// src/config/otpConfig.js - OTP Configuration

export const OTP_CONFIG = {
  length: parseInt(process.env.OTP_LENGTH) || 6,
  expirationMinutes: parseInt(process.env.OTP_EXPIRATION_MINUTES) || 5,
  maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS) || 3,
  resendCooldownMinutes: parseInt(process.env.OTP_RESEND_COOLDOWN) || 1,
  dailyLimit: parseInt(process.env.OTP_DAILY_LIMIT) || 10,
  devMode: process.env.NODE_ENV === 'development',
  
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
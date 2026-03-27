// src/config/rateLimitProfiles.js

export const RATE_LIMIT_PROFILES = {
  patient: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per window
    message: 'Too many requests from this patient. Please try again later.'
  },
  staff: {
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: 'Too many requests from staff. Please try again later.'
  },
  admin: {
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this admin. Please try again later.'
  },
  default: {
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: 'Too many requests. Please try again later.'
  },

  // P0: Per-phone OTP rate limiting — max 3 OTP requests per phone per 10 minutes
  otp: {
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 3,
    message: 'Too many OTP requests for this phone number. Please try again later.'
  },

  // Data export rate limiting — max 5 exports per user per hour
  dataExport: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    message: 'Too many data export requests. Please try again later.'
  },

  // P2: SOS rate limiting — max 3 alerts per user per hour
  sos: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3,
    message: 'Too many emergency alerts. If this is a real emergency, please call emergency services directly.'
  }
};

// src/config/rateLimitProfiles.js

export const RATE_LIMIT_PROFILES = {
  patient: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per window
    message: 'Too many requests from this patient. Please try again later.',
  },
  staff: {
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: 'Too many requests from staff. Please try again later.',
  },
  admin: {
    windowMs: 15 * 60 * 1000,
    max: Infinity,
    message: '',
  },
  default: {
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: 'Too many requests. Please try again later.',
  },
};

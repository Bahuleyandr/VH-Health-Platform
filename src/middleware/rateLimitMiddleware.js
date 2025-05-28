// src/middleware/rateLimitMiddleware.js

import rateLimit from 'express-rate-limit';
import { RATE_LIMIT_PROFILES } from '../config/rateLimitProfiles.js';

/**
 * ✅ Generate rate limiter based on profile name
 */
export const getRateLimiter = (profileName = 'default') => {
  const profile =
    RATE_LIMIT_PROFILES[profileName] || RATE_LIMIT_PROFILES.default;

  return rateLimit({
    windowMs: profile.windowMs,
    max: profile.max,
    message: profile.message,
    standardHeaders: true,
    legacyHeaders: false,
  });
};

/**
 * ✅ Pre-configured Limiters
 */
export const genericLimiter = getRateLimiter('default');
export const patientRateLimiter = getRateLimiter('patient');
export const staffRateLimiter = getRateLimiter('staff');
export const adminRateLimiter = getRateLimiter('admin');

/**
 * ✅ No Limiter (Pass-through)
 */
export const noRateLimiter = (req, res, next) => next();

/**
 * ✅ Dynamically apply rate limiter based on user role
 */
export const dynamicRoleRateLimiter = (req, res, next) => {
  const role = req.user?.role?.toUpperCase?.();

  if (role === 'ADMIN') {
    return adminRateLimiter(req, res, next); // No limit for ADMIN
  }

  if (
    [
      'DOCTOR',
      'NURSING_STAFF',
      'PHARMACY_STAFF',
      'LAB_STAFF',
      'HR_STAFF',
      'GENERAL_STAFF',
    ].includes(role)
  ) {
    return staffRateLimiter(req, res, next); // Higher limit for staff
  }

  if (role === 'PATIENT') {
    return patientRateLimiter(req, res, next); // Strict limit for patients
  }

  return genericLimiter(req, res, next); // Fallback
};

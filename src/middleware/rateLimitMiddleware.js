// src/middleware/rateLimitMiddleware.js
import rateLimit from 'express-rate-limit';
import { RATE_LIMIT_PROFILES } from '../config/rateLimitProfiles.js';

/**
 * Prefer keying by API key, then authenticated UID, else IP.
 * This avoids throttling multiple users behind one proxy.
 */
const defaultKeyGenerator = (req) => {
  const apiKey = req.header('x-api-key');
  const uid = req.user?.uid || req.user?.id;
  return apiKey || uid || req.ip;
};

/**
 * Uniform JSON 429 response.
 */
const defaultHandler = (req, res, _next, options) => {
  const retrySecs = Math.ceil((options.windowMs ?? 0) / 1000);
  res.status(429).json({
    success: false,
    code: 'RATE_LIMITED',
    message: options.message || 'Too many requests, please try again later.',
    retryAfterSeconds: retrySecs
  });
};

/**
 * ✅ Generate a rate limiter from a named profile.
 * Profiles live in ../config/rateLimitProfiles.js
 */
export const getRateLimiter = (profileName = 'default') => {
  const profile = RATE_LIMIT_PROFILES[profileName] || RATE_LIMIT_PROFILES.default;

  return rateLimit({
    windowMs: profile.windowMs,
    max: profile.max,
    message: profile.message,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: profile.keyGenerator || defaultKeyGenerator,
    handler: profile.handler || defaultHandler,
    // Skip low-value routes by default; can be overridden per profile
    skip: profile.skip || ((req) => {
      const p = req.path || '';
      return (
        p === '/' ||
        p.startsWith('/api-docs') ||
        p.startsWith('/health') ||
        p.startsWith('/api/v1/health')
      );
    })
  });
};

/**
 * ✅ Pre-configured Limiters (from profiles)
 */
export const genericLimiter = getRateLimiter('default');
export const patientRateLimiter = getRateLimiter('patient');
export const staffRateLimiter = getRateLimiter('staff');
export const adminRateLimiter = getRateLimiter('admin'); // Less restrictive, not unlimited

/**
 * ✅ No Limiter (pass-through)
 */
export const noRateLimiter = (req, res, next) => next();

/**
 * ✅ Dynamically apply a limiter based on authenticated role.
 * ADMIN uses the admin profile (less strict) rather than “no limit”.
 */
export const dynamicRoleRateLimiter = (req, res, next) => {
  const role = req.user?.role?.toUpperCase?.();

  if (role === 'ADMIN') {
    return adminRateLimiter(req, res, next);
  }

  if (
    [
      'DOCTOR',
      'NURSING_STAFF',
      'PHARMACY_STAFF',
      'LAB_STAFF',
      'HR_STAFF',
      'GENERAL_STAFF'
    ].includes(role)
  ) {
    return staffRateLimiter(req, res, next);
  }

  if (role === 'PATIENT') {
    return patientRateLimiter(req, res, next);
  }

  return genericLimiter(req, res, next);
};

// src/middleware/rateLimitMiddleware.js
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { RATE_LIMIT_PROFILES } from '../config/rateLimitProfiles.js';

/**
 * Prefer keying by API key, then authenticated UID, else IP (IPv6-safe).
 * Uses ipKeyGenerator(req) to satisfy express-rate-limit's IPv6 validation.
 */
const defaultKeyGenerator = (req) => {
  const apiKey =
    req.headers['x-api-key'] ||
    req.get?.('x-api-key') ||
    req.header?.('x-api-key');

  const uid = req.user?.uid || req.user?.id;

  if (apiKey) return `k:${String(apiKey)}`;
  if (uid) return `u:${String(uid)}`;

  // Fallback MUST use ipKeyGenerator for IPv6 safety
  return ipKeyGenerator(req);
};

/** Uniform JSON 429 response */
const defaultHandler = (req, res, _next, options) => {
  const retrySecs = Math.ceil((options.windowMs ?? 0) / 1000);
  // Optionally tell clients when to retry
  res.set('Retry-After', String(retrySecs));
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
 * Ensures IPv6 compliance by providing both keyGenerator and keyGeneratorIpFallback.
 */
export const getRateLimiter = (profileName = 'default') => {
  const profile = RATE_LIMIT_PROFILES[profileName] || RATE_LIMIT_PROFILES.default;

  const keyGen =
    typeof profile.keyGenerator === 'function'
      ? profile.keyGenerator
      : defaultKeyGenerator;

  const handlerFn = typeof profile.handler === 'function'
    ? profile.handler
    : defaultHandler;

  const skipFn = typeof profile.skip === 'function'
    ? profile.skip
    : (req) => {
        const p = req.path || '';
        return (
          p === '/' ||
          p.startsWith('/api-docs') ||
          p.startsWith('/health') ||
          p.startsWith('/api/v1/health')
        );
      };

  return rateLimit({
    windowMs: profile.windowMs,
    max: profile.max,
    message: profile.message,
    standardHeaders: true,
    legacyHeaders: false,

    // IMPORTANT: IPv6-safe config
    keyGenerator: keyGen,
    keyGeneratorIpFallback: ipKeyGenerator,

    handler: handlerFn,
    skip: skipFn
  });
};

/** ✅ Pre-configured Limiters (from profiles) */
export const genericLimiter = getRateLimiter('default');
export const patientRateLimiter = getRateLimiter('patient');
export const staffRateLimiter = getRateLimiter('staff');
export const adminRateLimiter = getRateLimiter('admin'); // Less restrictive, not unlimited

/** ✅ No Limiter (pass-through) */
export const noRateLimiter = (req, res, next) => next();

/**
 * ✅ Dynamically apply a limiter based on authenticated role.
 * SUPER_ADMIN & ADMIN use the admin profile (less strict).
 */
export const dynamicRoleRateLimiter = (req, res, next) => {
  const role = req.user?.role?.toUpperCase?.();

  if (role === 'ADMIN' || role === 'SUPER_ADMIN') {
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

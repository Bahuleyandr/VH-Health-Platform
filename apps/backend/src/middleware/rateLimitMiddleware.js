// src/middleware/rateLimitMiddleware.js
import expressRateLimit, { ipKeyGenerator } from 'express-rate-limit';
import crypto from 'crypto';
import { RATE_LIMIT_PROFILES } from '../config/rateLimitProfiles.js';

/**
 * Prefer keying by authenticated UID, then per-account identity for login-
 * shaped requests, then API key, else IP (IPv6-safe).
 *
 * Mobile and admin clients share app-level API keys; once JWT auth has run,
 * the user identity is the right bucket to avoid cross-user throttling.
 * For pre-auth login-shaped requests (which carry employeeId/email/username
 * in the body), key by IP+account so one staff member's failed attempts do
 * not throttle a different staff member from the same API key — the bug
 * surfaced during the ER reassessment role-switch in finding
 * 2026-05-10-emergency-walk-in-doctor-staff-login-global-rate-limit.
 *
 * Uses ipKeyGenerator(req) to satisfy express-rate-limit's IPv6 validation.
 */
const defaultKeyGenerator = (req) => {
  const apiKey =
    req.headers['x-api-key'] ||
    req.get?.('x-api-key') ||
    req.header?.('x-api-key');

  const uid = req.user?.uid || req.user?.id;
  if (uid) return `u:${String(uid)}`;

  // Pre-auth account identifier from login payload — keeps EMP-1004's
  // login attempts from sharing a bucket with EMP-1007 at the umbrella
  // limiter wrapping /api/v1/auth.
  const account =
    req.body?.employeeId ||
    req.body?.employee_id ||
    req.body?.username ||
    req.body?.email;
  if (account) return `acct:${ipKeyGenerator(req)}:${String(account).toLowerCase()}`;

  const authorization =
    req.headers?.authorization ||
    req.get?.('authorization') ||
    req.header?.('authorization');
  const bearerMatch = typeof authorization === 'string'
    ? authorization.match(/^Bearer\s+(.+)$/i)
    : null;
  if (bearerMatch?.[1]) {
    const tokenHash = crypto
      .createHash('sha256')
      .update(bearerMatch[1])
      .digest('hex')
      .slice(0, 24);
    return `jwt:${tokenHash}`;
  }

  if (apiKey) return `k:${String(apiKey)}`;

  // Fallback MUST use ipKeyGenerator for IPv6 safety
  return ipKeyGenerator(req);
};

const authKeyGenerator = (req) => {
  const ip = ipKeyGenerator(req);
  // Extract account identifier from request body (login endpoints).
  const account = req.body?.username || req.body?.email || req.body?.employeeId || req.body?.phone || '';
  if (account) return `auth:${ip}:${String(account).toLowerCase()}`;
  return `auth:${ip}`;
};

const isRateLimitingDisabled = () =>
  String(process.env.DISABLE_RATE_LIMITING || '').toLowerCase() === 'true' ||
  String(process.env.RATE_LIMIT_DISABLED || '').toLowerCase() === 'true';

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

  const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
  const skipFn = typeof profile.skip === 'function'
    ? profile.skip
    : (req) => {
        if (isRateLimitingDisabled()) return true;
        if (isTestEnv) return true;
        const p = req.path || '';
        return (
          p === '/' ||
          p.startsWith('/api-docs') ||
          p.startsWith('/health') ||
          p.startsWith('/api/v1/health')
        );
      };

  return expressRateLimit({
    windowMs: profile.windowMs,
    max: profile.max,
    message: profile.message,
    standardHeaders: true,
    legacyHeaders: false,

    // IMPORTANT: IPv6-safe config
    keyGenerator: keyGen,

    handler: handlerFn,
    skip: skipFn
  });
};

/** ✅ Pre-configured Limiters (from profiles) */
export const genericLimiter = getRateLimiter('default');
export const patientRateLimiter = getRateLimiter('patient');
export const staffRateLimiter = getRateLimiter('staff');
export const adminRateLimiter = getRateLimiter('admin'); // Less restrictive, not unlimited

/**
 * ✅ Auth login rate limiter — 5 attempts per 15 minutes.
 * Compound key: IP + username/employeeId/email from request body.
 * Prevents both single-IP brute force AND distributed attacks targeting one account.
 */
const authRateLimiterConfig = {
  windowMs: RATE_LIMIT_PROFILES.auth.windowMs,
  max: RATE_LIMIT_PROFILES.auth.max,
  message: RATE_LIMIT_PROFILES.auth.message,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: authKeyGenerator,
  handler: defaultHandler,
  // Count failed credential attempts, not normal successful re-auth. The
  // lockout service still tracks failed attempts per staff account in
  // auth_logs; this limiter is the fast pre-auth brute-force guard.
  skipSuccessfulRequests: true,
  skip: isRateLimitingDisabled
};

export const __testing__ = { defaultKeyGenerator, authKeyGenerator, authRateLimiterConfig };

export const authRateLimiter = expressRateLimit(authRateLimiterConfig);

/**
 * ✅ OTP rate limiter — keys by phone number extracted from request body.
 * Max 3 OTP requests per phone number per 10 minutes with exponential cooldown.
 */
export const otpRateLimiter = expressRateLimit({
  windowMs: RATE_LIMIT_PROFILES.otp.windowMs,
  max: RATE_LIMIT_PROFILES.otp.max,
  message: RATE_LIMIT_PROFILES.otp.message,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Key by phone number from request body (Firebase login sends idToken,
    // but we also want to catch repeated requests from the same IP)
    const phone = req.body?.phone || req.body?.phoneNumber || '';
    if (phone) return `otp:phone:${String(phone)}`;
    // Fallback to IP if no phone
    return `otp:${ipKeyGenerator(req)}`;
  },
  handler: defaultHandler,
  skip: isRateLimitingDisabled
});

/**
 * ✅ SOS rate limiter — keys by authenticated user UID.
 * Max 3 alerts per user per hour to prevent false alarm flooding.
 */
export const sosRateLimiter = expressRateLimit({
  windowMs: RATE_LIMIT_PROFILES.sos.windowMs,
  max: RATE_LIMIT_PROFILES.sos.max,
  message: RATE_LIMIT_PROFILES.sos.message,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const uid = req.user?.uid || req.user?.id;
    if (uid) return `sos:u:${String(uid)}`;
    return `sos:${ipKeyGenerator(req)}`;
  },
  handler: defaultHandler,
  skip: isRateLimitingDisabled
});

/** ✅ Data export rate limiter — strict: 5 requests per hour */
export const dataExportRateLimiter = getRateLimiter('dataExport');

/** ✅ Dashboard rate limiter — 10/min per IP to limit phone enumeration */
export const dashboardRateLimiter = getRateLimiter('dashboard');

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

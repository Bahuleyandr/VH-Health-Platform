// src/middleware/rateLimitMiddleware.js
import expressRateLimit, { ipKeyGenerator } from 'express-rate-limit';
import crypto from 'crypto';
import os from 'os';
import { RedisStore } from 'rate-limit-redis';
import { RATE_LIMIT_PROFILES } from '../config/rateLimitProfiles.js';
import { storeLossPostureFor } from '../config/rateLimitStoreLossPolicy.js';
import { initRedis, isRedisConfigured } from '../lib/redis.js';
import { ResilientRateLimitStore } from './rateLimitStoreHealth.js';
import { getRateLimitOverride } from '../services/tenant/tenantSettingsService.js';
import { normalizePhone } from '../utils/phoneUtils.js';

function hashRateLimitIdentity(value, { lowercase = false } = {}) {
  const normalized = lowercase ? String(value).toLowerCase() : String(value);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Prefer keying by authenticated UID, then per-account identity for login-
 * shaped requests, then API key, else IP (IPv6-safe).
 *
 * Mobile and admin clients share app-level API keys; once JWT auth has run,
 * the user identity is the right bucket to avoid cross-user throttling.
 * For pre-auth login-shaped requests (which carry employeeId/email/username,
 * a patient phone, or a Firebase idToken in the body), key by IP+account so
 * one user's failed attempts do not throttle a different user from the same
 * API key — the bug surfaced during the ER reassessment role-switch in
 * finding 2026-05-10-emergency-walk-in-doctor-staff-login-global-rate-limit,
 * and again fleet-wide for patients in finding 2026-08-14 P1.
 *
 * Uses ipKeyGenerator(req.ip) to satisfy express-rate-limit's IPv6 validation.
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
  if (account) {
    return `acct:${ipKeyGenerator(req.ip)}:${hashRateLimitIdentity(account, { lowercase: true })}`;
  }

  // Patient pre-auth flows (/api/v1/auth request-otp / verify-otp / legacy
  // DB-OTP login, /api/v1/otp) identify the account by phone, not
  // employeeId/email. Without this branch every logged-out patient fell
  // through to the shared app API key below — one global bucket for the
  // whole fleet (same bug class as the staff-login fix above, finding
  // 2026-08-14 P1). Normalize first so "98765 43210" and "+919876543210"
  // share one bucket; hash so the store never holds the raw phone.
  const rawPhone = req.body?.phone || req.body?.phoneNumber;
  if (rawPhone) {
    const phone = normalizePhone(String(rawPhone)) || String(rawPhone);
    return `acct:${ipKeyGenerator(req.ip)}:${hashRateLimitIdentity(phone)}`;
  }

  // Firebase exchange (/auth/firebase/firebase-login) carries only
  // { idToken } — no phone, no account field. The idToken maps 1:1 to a
  // single Firebase identity, so IP + a hash of the token gives each
  // logging-in patient their own bucket (mirrors the challengeToken
  // pattern in authKeyGenerator). Hash so the limiter store never holds
  // the raw credential.
  const idToken = req.body?.idToken;
  if (typeof idToken === 'string' && idToken.length > 0) {
    return `acct:${ipKeyGenerator(req.ip)}:idt:${hashRateLimitIdentity(idToken)}`;
  }

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

  if (apiKey) return `k:${hashRateLimitIdentity(apiKey)}`;

  // Fallback MUST use ipKeyGenerator for IPv6 safety
  return ipKeyGenerator(req.ip);
};

// W3 (multi-tenancy): every rate-limit bucket is tenant-scoped so one hospital's
// traffic can never exhaust another's quota. Wraps the rich key precedence above
// with a `t:<tenantId>:` prefix; pre-auth / no-resolved-tenant requests bucket
// under `t:default:` (behaviour-identical for the single existing tenant).
const tenantPrefix = (req) => `t:${req?.tenantId || 'default'}:`;
export const tenantKeyGenerator = (req) => `${tenantPrefix(req)}${defaultKeyGenerator(req)}`;
const ipOnlyKeyGenerator = (req) => ipKeyGenerator(req.ip);

/**
 * Per-instance bucket scoping (opt-in via `instanceScoped`).
 *
 * With the shared Redis store every replica increments the SAME key, so a
 * bucket keyed only by the caller's credential silently becomes a function of
 * replica count: the per-pod share is `max / replicas`, and it shrinks exactly
 * when the HPA scales up — i.e. during an incident. That is fine for user API
 * traffic (a fleet-wide quota is the point) and wrong for surfaces whose load
 * is inherently per-instance. Prometheus scrapes pod endpoints directly via
 * EndpointSlice discovery, so each backend pod always observes its own
 * constant scrape rate no matter how many replicas exist; prefixing the pod
 * identity makes the probe budget invariant to replica count, which is the
 * only way a static number can stay correct under an autoscaler.
 *
 * POD_NAME is injected by the downward API
 * (infra/kubernetes/apps/backend/deployment.yaml:97-100). HOSTNAME is the
 * container-runtime fallback and os.hostname() the local/dev one.
 * RATE_LIMIT_INSTANCE_ID is an explicit override (tests, non-k8s deploys).
 * Resolved per call but memoized on the raw env value, so a redeploy or a test
 * that repoints the identity is picked up without an import-time snapshot.
 */
let instanceIdSource = null;
let instanceIdResolved = null;
const resolveInstanceId = () => {
  const raw = String(
    process.env.RATE_LIMIT_INSTANCE_ID ||
      process.env.POD_NAME ||
      process.env.HOSTNAME ||
      ''
  );
  if (raw !== instanceIdSource) {
    instanceIdSource = raw;
    instanceIdResolved = raw || os.hostname();
  }
  return instanceIdResolved;
};
const instancePrefix = () => `i:${resolveInstanceId()}:`;

// W3: replica-safe counters via a shared Redis store. Returns undefined (the
// express-rate-limit default per-process MemoryStore) when Redis is unset,
// preserving single-node correctness + the local-test path. sendCommand resolves
// the client lazily per request, so a limiter built at import time (before
// initRedis()) still works once Redis connects.
export const selectStore = (prefix = 'rl:') => {
  if (!isRedisConfigured()) return undefined;
  return new RedisStore({
    prefix,
    sendCommand: async (...args) => {
      const client = await initRedis();
      if (!client) throw new Error('rate-limit: redis client unavailable');
      return client.call(...args);
    },
  });
};

// Redis-loss drill 2026-08-15 (HIGH): a store error must never reach the
// Express error chain — express-rate-limit@8 turns it into an undifferentiated
// 500 per request (`passOnStoreError` defaults false and was never a decision
// here). Every Redis-backed store is therefore wrapped so that store loss
// resolves to the profile's DECLARED posture from rateLimitStoreLossPolicy.js:
// fail-closed profiles answer an honest 429 + short Retry-After, fail-open
// profiles pass unmetered — and once the store is known-down, requests
// short-circuit instead of paying a store round-trip (measured 1.2s fresh /
// 15.2s sustained per request before this). MemoryStore (Redis unset) cannot
// fail and is never wrapped.
const resilientStore = (profileName, prefix) => {
  const inner = selectStore(prefix);
  if (!inner) return undefined;
  return new ResilientRateLimitStore({
    inner,
    profileName,
    posture: storeLossPostureFor(profileName),
  });
};

const authKeyGenerator = (req) => {
  const uid = req.user?.uid || req.user?.id;
  if (uid) return `auth:u:${String(uid)}`;

  const ip = ipKeyGenerator(req.ip);
  // Extract account identifier from request body (login endpoints).
  const account = req.body?.username || req.body?.email || req.body?.employeeId || req.body?.phone || '';
  if (account) return `auth:${ip}:acct:${hashRateLimitIdentity(account, { lowercase: true })}`;

  // MFA challenge verify (/auth/admin/mfa/challenge/verify) carries no
  // username/email — only an opaque `challengeToken` that maps 1:1 to a single
  // admin account (persisted in totp_challenges by AuthService.adminLogin). Key
  // by IP + a hash of that token so brute-forcing one admin's 2FA code shares a
  // bucket regardless of source IP (defeats IP rotation), AND so many admins
  // behind one NAT each get their own bucket (each holds a distinct challenge).
  // Without this the limiter degraded to IP-only for the 2FA step. Hash the
  // token so the limiter store never holds the raw challenge secret.
  const challengeToken = req.body?.challengeToken;
  if (challengeToken) {
    const challengeHash = crypto
      .createHash('sha256')
      .update(String(challengeToken))
      .digest('hex')
      .slice(0, 24);
    return `auth:${ip}:chal:${challengeHash}`;
  }

  return `auth:${ip}`;
};

const isRateLimitingDisabled = () =>
  String(process.env.DISABLE_RATE_LIMITING || '').toLowerCase() === 'true' ||
  String(process.env.RATE_LIMIT_DISABLED || '').toLowerCase() === 'true';

/** Uniform JSON 429 response */
const defaultHandler = (req, res, _next, options) => {
  let retrySecs = Math.ceil((options.windowMs ?? 0) / 1000);
  // Prefer the store's actual reset time when it is sooner than the full
  // window: a client throttled at minute 14 of a 15-minute window should hear
  // "60s", not "900s" — and a store-loss denial (ResilientRateLimitStore sets
  // resetTime to the short RATE_LIMIT_STORE_LOSS_RETRY_AFTER_SECONDS) must say
  // "temporarily throttled, retry shortly", not "come back in an hour".
  const resetTime = req.rateLimit?.resetTime;
  if (resetTime instanceof Date) {
    const secsUntilReset = Math.ceil((resetTime.getTime() - Date.now()) / 1000);
    if (secsUntilReset > 0 && secsUntilReset < retrySecs) retrySecs = secsUntilReset;
  }
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
 *
 * THROWS on an unknown profile name (873-F8). It used to fall back silently to
 * the generic `default` profile, which meant a typo'd name swapped the intended
 * limiter for a fail-OPEN bucket while storeLossPostureFor() simultaneously
 * promised unknown ⇒ fail_closed — two opposite postures for the same mistake.
 * Every call site passes a literal name, so a typo now fails at boot instead
 * of shipping the wrong posture.
 */
export const getRateLimiter = (profileName = 'default', {
  keyMode = 'default',
  tenantScoped = true,
  instanceScoped = false,
  storePrefix = null,
  enforceOnMatchedPath = false,
} = {}) => {
  const profile = RATE_LIMIT_PROFILES[profileName];
  if (!profile) {
    throw new Error(
      `Unknown rate-limit profile "${profileName}" — add it to RATE_LIMIT_PROFILES `
        + 'and declare its store-loss posture in rateLimitStoreLossPolicy.js'
    );
  }

  const baseKeyGen =
    keyMode === 'ip'
      ? ipOnlyKeyGenerator
      : typeof profile.keyGenerator === 'function'
      ? profile.keyGenerator
      : defaultKeyGenerator;
  const scopedKeyGen = instanceScoped
    ? (req) => `${instancePrefix()}${baseKeyGen(req)}`
    : baseKeyGen;
  const keyGen = tenantScoped
    ? (req) => `${tenantPrefix(req)}${scopedKeyGen(req)}`
    : scopedKeyGen;

  const handlerFn = typeof profile.handler === 'function'
    ? profile.handler
    : defaultHandler;

  const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
  const skipFn = typeof profile.skip === 'function'
    ? profile.skip
    : (req) => {
        if (isRateLimitingDisabled()) return true;
        if (isTestEnv && profile.enforceInTest !== true) return true;
        if (enforceOnMatchedPath) return false;
        if (profile.enforceOnHealthRoutes === true) return false;
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
    // W3: per-tenant quota override from tenants.settings.rateLimits[profile],
    // falling back to the hardcoded profile max. Reads the 60s tenant cache;
    // when no tenant is resolved yet, the override is null → profile default.
    max: async (req) => {
      const override = await getRateLimitOverride(req?.tenantId, profileName);
      const max = override?.max;
      return Number.isFinite(max) && max > 0 ? max : profile.max;
    },
    message: profile.message,
    standardHeaders: true,
    legacyHeaders: false,

    // IMPORTANT: IPv6-safe config + W3 tenant-scoped bucket
    keyGenerator: keyGen,

    // W3: replica-safe shared counter (per-profile namespace); MemoryStore when
    // Redis is unset. Wrapped with the declared store-loss posture — see
    // resilientStore above.
    store: resilientStore(profileName, storePrefix || `rl:${profileName}:`),

    handler: handlerFn,
    skip: skipFn
  });
};

/**
 * Kubernetes probe paths under the `/health` mount, MOUNT-RELATIVE.
 *
 * TRAP (finding 2026-08-15, P1 873-F1): Express strips the mount prefix for
 * `app.use('/health', ...)` middleware, so inside a limiter mounted there the
 * probes read `req.path === '/ready'` / `'/live'` — the default profile's
 * built-in skip list (`startsWith('/health')`) matches NOTHING, and the k8s
 * probes (loopback exec readiness + kubelet httpGet liveness,
 * infra/kubernetes/apps/backend/deployment.yaml) were metered in the shared
 * `t:default:127.0.0.1` bucket: 3 replicas x 12 hits/min against prod's
 * 100/15min cap saturated the window in ~3 minutes, turning every pod
 * NotReady for ~12 of every 15 minutes once synced. These entries are
 * consumed by healthMountRateLimiter below, which routes them through the
 * per-pod fail-open `probe` profile instead.
 */
export const HEALTH_MOUNT_PROBE_PATHS = Object.freeze(['/ready', '/live']);

/**
 * Limiter selector for the `/health` mount: k8s probe paths go through the
 * given probe limiter (per-pod `probe` profile — bounded, fail-open under
 * store loss), everything else stays on the general limiter. Deliberately NOT
 * a skip: the probe surfaces remain metered, just in the bucket whose sizing
 * (rateLimitProfiles.js `probe`) actually accounts for probe cadence. The
 * non-probe /health surfaces (/metrics, /deep, /version, /ping) keep their
 * existing metering unchanged.
 */
export const healthMountRateLimiter = (probeLimiterMw, generalLimiterMw) =>
  (req, res, next) => (
    HEALTH_MOUNT_PROBE_PATHS.includes(req.path)
      ? probeLimiterMw(req, res, next)
      : generalLimiterMw(req, res, next)
  );

/** ✅ Pre-configured Limiters (from profiles) */
export const genericLimiter = getRateLimiter('default');
export const patientRateLimiter = getRateLimiter('patient');
export const patientInvestigationRateLimiter = getRateLimiter('patientInvestigation');
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
  // W3: replica-safe brute-force counter. fail_closed under store loss —
  // credential guessing must never be unmetered (rateLimitStoreLossPolicy.js).
  store: resilientStore('auth', 'rl:auth:'),
  handler: defaultHandler,
  // Count failed credential attempts, not normal successful re-auth. The
  // lockout service still tracks failed attempts per staff account in
  // auth_logs; this limiter is the fast pre-auth brute-force guard.
  skipSuccessfulRequests: true,
  skip: isRateLimitingDisabled
};

export const authRateLimiter = expressRateLimit(authRateLimiterConfig);

/**
 * ✅ Logout rate limiter — POST /auth/logout self-revocation (873-F5).
 * Runs after jwtAuth, so defaultKeyGenerator buckets per uid. Split from
 * authRateLimiter because logout is DB-authoritative (tokenBlacklist.js R12)
 * and must stay available under rate-limit store loss: the `logout` profile
 * is fail_open_unmetered where `auth` is fail_closed — see
 * rateLimitStoreLossPolicy.js. Login/refresh keep the fail-closed auth
 * limiter untouched.
 */
export const logoutRateLimiter = getRateLimiter('logout');

const otpKeyGenerator = (req) => {
  // Hash the contact identifier so a persistent Redis key never exposes the
  // raw phone number while equivalent requests still share one bucket.
  const phone = req.body?.phone || req.body?.phoneNumber || '';
  if (phone) return `otp:phone:${hashRateLimitIdentity(phone)}`;
  return `otp:${ipKeyGenerator(req.ip)}`;
};

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
  keyGenerator: otpKeyGenerator,
  // W3: replica-safe OTP counter. fail_closed under store loss — OTP floods
  // must never be unmetered (rateLimitStoreLossPolicy.js).
  store: resilientStore('otp', 'rl:otp:'),
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
    return `sos:${ipKeyGenerator(req.ip)}`;
  },
  // W3: replica-safe SOS counter. fail_closed under store loss — the message
  // already directs real emergencies to call emergency services directly
  // (rateLimitStoreLossPolicy.js).
  store: resilientStore('sos', 'rl:sos:'),
  handler: defaultHandler,
  skip: isRateLimitingDisabled
});

export const __testing__ = {
  defaultKeyGenerator,
  ipOnlyKeyGenerator,
  authKeyGenerator,
  authRateLimiterConfig,
  hashRateLimitIdentity,
  otpKeyGenerator,
  resolveInstanceId,
  instancePrefix,
};

/** ✅ Data export rate limiter — strict: 5 requests per hour */
export const dataExportRateLimiter = getRateLimiter('dataExport');

/** ✅ Dashboard rate limiter — 10/min per IP to limit phone enumeration */
export const dashboardRateLimiter = getRateLimiter('dashboard');

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

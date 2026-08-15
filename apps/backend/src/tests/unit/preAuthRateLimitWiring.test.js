// src/tests/unit/preAuthRateLimitWiring.test.js
//
// 873-F3/F4/F5: the pre-auth mounts that used to ride the fail-open `default`
// profile against the policy's own doctrine now carry per-surface decisions.
// This suite pins:
//   * SCIM keying — guesses rotating the bearer from ONE IP share ONE bucket.
//     The old defaultKeyGenerator bucketed per sha256(presented token), so a
//     brute-forcer minted a fresh bucket per guess and the limiter never
//     fired. Behavioural: the 4th rotated-bearer guess 429s.
//   * the app.js mount wiring for SCIM, interface-engine and downtime-static
//     (so a refactor cannot silently drop a surface back onto `default`);
//   * the auth route wiring for /logout (fail-open logout profile, 873-F5)
//     and /auth/firebase/link-account (otp limiter on the pre-auth OTP
//     verify, 873-F4).
import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import express from 'express';
import request from 'supertest';

jest.unstable_mockModule('rate-limit-redis', () => ({ RedisStore: class {} }));
jest.unstable_mockModule('../../lib/redis.js', () => ({
  initRedis: jest.fn(async () => null),
  getRedisClient: () => null,
  isRedisConnected: () => false,
  hasRedisInitFailed: () => false,
  isRedisConfigured: () => false, // MemoryStore — real counting, no Redis
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => false),
}));
// Shrink the profile cap to 3 so the behavioural test stays fast; the real
// cap (120/min) is documented on the profile and pinned by its own numbers.
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getRateLimitOverride: jest.fn(async () => ({ max: 3 })),
}));

const { getRateLimiter } = await import('../../middleware/rateLimitMiddleware.js');

const readSource = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const appSource = readSource('../../app.js');
const authRoutesSource = readSource('../../routes/auth/authRoutes.js');
const firebaseAuthRoutesSource = readSource('../../routes/auth/firebaseAuthRoutes.js');

// getRateLimiter's built-in skip disables enforcement under jest; build the
// limiter with a non-test env snapshot so the skip closure captures
// isTestEnv=false and the limiter behaves as in production.
const buildEnforced = (...args) => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedWorker = process.env.JEST_WORKER_ID;
  process.env.NODE_ENV = 'development';
  delete process.env.JEST_WORKER_ID;
  try {
    return getRateLimiter(...args);
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedWorker !== undefined) process.env.JEST_WORKER_ID = savedWorker;
  }
};

describe('SCIM limiter keying — one IP, one bucket, however many bearers', () => {
  const mkScimApp = () => {
    const app = express();
    // Trust supertest's loopback hop so the test can present distinct client
    // IPs via X-Forwarded-For ('loopback' rather than `true` keeps
    // express-rate-limit's permissive-trust-proxy validation quiet).
    app.set('trust proxy', 'loopback');
    app.use(
      '/api/v1/scim/v2',
      buildEnforced('scimProvisioning', { keyMode: 'ip' }),
      (_req, res) => res.status(200).json({ ok: true })
    );
    return app;
  };

  it('rotating the guessed bearer does NOT mint fresh buckets (the 873-F3 aggravation)', async () => {
    const app = mkScimApp();
    for (let i = 1; i <= 3; i += 1) {
      const res = await request(app)
        .get('/api/v1/scim/v2/tenant-a/okta/Users')
        .set('Authorization', `Bearer guessed-token-${i}`)
        .set('X-Forwarded-For', '198.51.100.10');
      expect(res.status).toBe(200);
    }
    // 4th guess, 4th distinct bearer, same IP: over the (shrunk) cap.
    const denied = await request(app)
      .get('/api/v1/scim/v2/tenant-a/okta/Users')
      .set('Authorization', 'Bearer guessed-token-4')
      .set('X-Forwarded-For', '198.51.100.10');
    expect(denied.status).toBe(429);
    expect(denied.body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
  });

  it('a different source IP gets its own bucket (keying is per IP, not global)', async () => {
    const app = mkScimApp();
    for (let i = 1; i <= 4; i += 1) {
      await request(app)
        .get('/api/v1/scim/v2/tenant-a/okta/Users')
        .set('Authorization', `Bearer guessed-token-${i}`)
        .set('X-Forwarded-For', '198.51.100.10');
    }
    const otherIp = await request(app)
      .get('/api/v1/scim/v2/tenant-a/okta/Users')
      .set('Authorization', 'Bearer guessed-token-5')
      .set('X-Forwarded-For', '203.0.113.99');
    expect(otherIp.status).toBe(200);
  });
});

describe('app.js pre-auth mount wiring (873-F3)', () => {
  it('SCIM rides the fail-closed scimProvisioning profile keyed by IP', () => {
    expect(appSource).toMatch(
      /const scimRateLimiter = getRateLimiter\('scimProvisioning', \{ keyMode: 'ip' \}\)/
    );
    expect(appSource).toMatch(
      /app\.use\('\/api\/v1\/scim\/v2', scimRateLimiter, scimRoutes\)/
    );
  });

  it('interface-engine ingress rides the fail-closed interfaceEngineIngress profile keyed by IP', () => {
    expect(appSource).toMatch(
      /const interfaceEngineRateLimiter = getRateLimiter\('interfaceEngineIngress', \{ keyMode: 'ip' \}\)/
    );
    expect(appSource).toMatch(
      /app\.use\('\/api\/v1\/interface-engine', interfaceEngineRateLimiter, interfaceEngineIngressRoutes\)/
    );
  });

  it('downtime-static rides the continuity-delivery profile, not default', () => {
    expect(appSource).toMatch(
      /'\/downtime\/static',\s*getRateLimiter\('clinicalContinuityPolicyDelivery', \{ storePrefix: 'rl:downtimeStatic:' \}\)/
    );
  });

  it('none of the three mounts is on the generic limiter anymore', () => {
    expect(appSource).not.toMatch(/app\.use\('\/api\/v1\/scim\/v2',\s*genericLimiter/);
    expect(appSource).not.toMatch(/app\.use\('\/api\/v1\/interface-engine',\s*genericLimiter/);
    expect(appSource).not.toMatch(/app\.use\(\s*'\/downtime\/static',\s*genericLimiter/);
  });
});

describe('auth route wiring', () => {
  it('/logout uses the fail-open logout limiter, never the fail-closed auth limiter (873-F5)', () => {
    expect(authRoutesSource).toMatch(
      /\['\/logout', jwtAuth, logoutRateLimiter, authController\.logout\]/
    );
    expect(authRoutesSource).not.toMatch(/'\/logout', jwtAuth, authRateLimiter/);
  });

  it('refresh-token and its /token alias keep the fail-closed auth limiter', () => {
    expect(authRoutesSource).toMatch(/\['\/refresh-token', authRateLimiter, authController\.refreshToken\]/);
    expect(authRoutesSource).toMatch(/\['\/token', authRateLimiter, authController\.refreshToken\]/);
  });

  it('/auth/firebase/link-account carries the per-phone otp limiter (873-F4)', () => {
    expect(firebaseAuthRoutesSource).toMatch(/'\/link-account',\s*\n\s*otpRateLimiter,/);
  });
});

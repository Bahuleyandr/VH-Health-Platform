// src/tests/unit/failOpenMountStoreLoss.test.js
//
// 873-F11(c): behavioural store-loss coverage for a fail-open limiter AS
// MOUNTED. rateLimitStoreLossPosture.test.js pins the postures per profile in
// isolation; this file pins the app.js mount SHAPE under the same simulated
// outage: the fail-open `patient` umbrella over /api/v1/auth admits traffic
// unmetered while the fail-closed per-phone `otp` limiter that rides UNDER
// the same umbrella on /auth/firebase/firebase-login still answers an honest
// 429 — i.e. the umbrella's fail-open posture does not leak into the
// credential surface stacked beneath it.
//
// Store-loss simulation follows the rateLimitStoreLossPosture.test.js
// precedent: Redis is CONFIGURED (limiters build Redis-backed stores wrapped
// in ResilientRateLimitStore) and the connection is DOWN (detected loss).

import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import express from 'express';
import request from 'supertest';

let redisConnected = false; // the whole file runs with the store LOST

const incrementMock = jest.fn(async () => {
  throw new Error('store must never be reached while known-down');
});

class FakeRedisStore {
  init(options) {
    this.windowMs = options?.windowMs;
  }

  async increment(key) {
    return incrementMock(key);
  }

  async decrement() {}

  async resetKey() {}
}

jest.unstable_mockModule('rate-limit-redis', () => ({ RedisStore: FakeRedisStore }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../lib/redis.js', () => ({
  initRedis: jest.fn(async () => ({ call: jest.fn() })),
  getRedisClient: () => ({ call: jest.fn() }),
  isRedisConnected: () => redisConnected,
  hasRedisInitFailed: () => false,
  isRedisConfigured: () => true,
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => false),
}));
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getRateLimitOverride: jest.fn(async () => null),
}));

const { getRateLimiter, otpRateLimiter } = await import('../../middleware/rateLimitMiddleware.js');
const { rateLimitStoreStatus, __resetRateLimitStoreHealthForTests } = await import(
  '../../middleware/rateLimitStoreHealth.js'
);
const { RATE_LIMIT_STORE_LOSS_RETRY_AFTER_SECONDS } = await import(
  '../../config/rateLimitStoreLossPolicy.js'
);

const readSource = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// getRateLimiter's built-in skip disables enforcement under jest; snapshot a
// non-test env while constructing so the limiter behaves as in production
// (same helper shape as preAuthRateLimitWiring.test.js).
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

// Mirror of the production mount shape (pinned by source below): the patient
// umbrella covers ALL of /api/v1/auth (app.js:766), and firebase-login adds
// the per-phone otp limiter inside the mounted router (firebaseAuthRoutes).
const mkMountedApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', buildEnforced('patient'));
  const firebaseRouter = express.Router();
  firebaseRouter.post('/firebase-login', otpRateLimiter, (_req, res) =>
    res.status(200).json({ ok: true, surface: 'firebase-login' }));
  firebaseRouter.get('/verify-token', (_req, res) =>
    res.status(200).json({ ok: true, surface: 'umbrella-only' }));
  app.use('/api/v1/auth/firebase', firebaseRouter);
  // The drill's 500 storm arrived through the error chain — keep a terminal
  // handler so a regression is a distinguishable 500.
  app.use((err, _req, res, _next) => res.status(500).json({ boom: true }));
  return app;
};

beforeEach(() => {
  __resetRateLimitStoreHealthForTests();
  redisConnected = false;
  incrementMock.mockClear();
});

describe('fail-open umbrella vs fail-closed rider under store loss (as mounted)', () => {
  it('an umbrella-only auth route passes unmetered, counted, never 500', async () => {
    const app = mkMountedApp();

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).get('/api/v1/auth/firebase/verify-token');
      expect(res.status).toBe(200);
      expect(res.body.surface).toBe('umbrella-only');
    }
    expect(incrementMock).not.toHaveBeenCalled(); // dead store never asked
    expect(rateLimitStoreStatus().counters.passedUnmeteredWhileDown).toBe(3);
  });

  it('firebase-login still 429s via the fail-closed otp limiter UNDER the fail-open umbrella', async () => {
    const app = mkMountedApp();

    const res = await request(app)
      .post('/api/v1/auth/firebase/firebase-login')
      .send({ idToken: 'x'.repeat(64), phone: '+919876543210' });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(RATE_LIMIT_STORE_LOSS_RETRY_AFTER_SECONDS);
    expect(incrementMock).not.toHaveBeenCalled();
    // The umbrella admitted it (fail-open, counted); the otp rider denied it.
    const { counters } = rateLimitStoreStatus();
    expect(counters.passedUnmeteredWhileDown).toBe(1);
    expect(counters.deniedWhileDown).toBe(1);
  });

  it('recovery flips the umbrella back to real metering (no sticky fail-open)', async () => {
    const app = mkMountedApp();
    await request(app).get('/api/v1/auth/firebase/verify-token'); // while down

    redisConnected = true;
    incrementMock.mockImplementationOnce(async () => ({
      totalHits: 1,
      resetTime: new Date(Date.now() + 60000),
    }));
    const res = await request(app).get('/api/v1/auth/firebase/verify-token');
    expect(res.status).toBe(200);
    expect(incrementMock).toHaveBeenCalledTimes(1); // store consulted again
  });
});

describe('mount-shape pins (the simulation above matches production wiring)', () => {
  const appSource = readSource('../../app.js');
  const firebaseAuthRoutesSource = readSource('../../routes/auth/firebaseAuthRoutes.js');

  it('the patient umbrella really covers /api/v1/auth in app.js', () => {
    expect(appSource).toMatch(/app\.use\('\/api\/v1\/auth', patientRateLimiter\);/);
  });

  it('firebase-login really carries the otp limiter inside the mounted router', () => {
    expect(firebaseAuthRoutesSource).toMatch(/'\/firebase-login',\s*\n\s*otpRateLimiter,/);
  });
});

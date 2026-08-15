// Behavioural posture under rate-limit STORE LOSS (Redis-loss drill 2026-08-15,
// Finding 1 remediation).
//
// What the drill proved by execution: with Redis unreachable, every request
// through a Redis-backed limiter died with an undifferentiated 500 —
// express-rate-limit@8 propagated the store error into the Express error chain
// (passOnStoreError defaults false, set by nobody), with no operator signal.
//
// What this file pins instead:
//   * auth/otp/sos under store loss => honest 429 + SHORT Retry-After — never
//     a 200 (no unmetered brute force), never a 500 storm.
//   * fail-open profiles under store loss => request passes, and is counted.
//   * once the store is known-down, requests short-circuit — the store is not
//     asked again until the half-open probe window elapses.
//   * ONE log line per transition (down and up), not per-request spam.
//   * /health/metrics-visible state flips degraded->ok across the outage.
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// ── Controllable environment ────────────────────────────────────────────────
let redisConnected = true;
let redisClient = { call: jest.fn() };
let storeShouldFail = false;

const hits = new Map();
const incrementMock = jest.fn(async (key) => {
  if (storeShouldFail) throw new Error('Stream isn\'t writeable and enableOfflineQueue options is false');
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  return { totalHits: n, resetTime: new Date(Date.now() + 60000) };
});

class FakeRedisStore {
  constructor(opts) {
    this.opts = opts;
  }

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

const loggerError = jest.fn();
const loggerWarn = jest.fn();
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: loggerWarn, error: loggerError },
}));

// Redis is CONFIGURED for this whole file (so limiters build Redis-backed
// stores at import time); connection state is per-test.
jest.unstable_mockModule('../../lib/redis.js', () => ({
  initRedis: jest.fn(async () => redisClient),
  getRedisClient: () => redisClient,
  isRedisConnected: () => redisConnected,
  hasRedisInitFailed: () => false,
  isRedisConfigured: () => true,
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => false),
}));

// Keep the module graph light: the tenant override reads a DB-backed cache.
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getRateLimitOverride: jest.fn(async () => null),
}));

const { authRateLimiter, otpRateLimiter, sosRateLimiter } = await import(
  '../../middleware/rateLimitMiddleware.js'
);
const {
  ResilientRateLimitStore,
  rateLimitStoreStatus,
  __resetRateLimitStoreHealthForTests,
} = await import('../../middleware/rateLimitStoreHealth.js');
const { RATE_LIMIT_STORE_LOSS_RETRY_AFTER_SECONDS, storeLossPostureFor } = await import(
  '../../config/rateLimitStoreLossPolicy.js'
);

const mkApp = (limiter) => {
  const app = express();
  app.use(express.json());
  app.post('/hit', limiter, (_req, res) => res.status(200).json({ ok: true }));
  // The drill's 500 storm arrived through the error chain — keep a terminal
  // handler so a regression shows up as a distinguishable 500 here.
   
  app.use((err, _req, res, _next) => res.status(500).json({ boom: true }));
  return app;
};

beforeEach(() => {
  __resetRateLimitStoreHealthForTests();
  redisConnected = true;
  redisClient = { call: jest.fn() };
  storeShouldFail = false;
  hits.clear();
  incrementMock.mockClear();
  loggerError.mockClear();
  loggerWarn.mockClear();
});

describe('fail-closed profiles under store loss (detected disconnection)', () => {
  it.each([
    ['auth', authRateLimiter, { username: 'dr.a' }],
    ['otp', otpRateLimiter, { phone: '+919876543210' }],
    ['sos', sosRateLimiter, {}],
  ])('%s answers 429 + short Retry-After — never 200, never 500', async (_name, limiter, body) => {
    redisConnected = false; // ioredis saw 'close'; store is known-down

    const res = await request(mkApp(limiter)).post('/hit').send(body);

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(RATE_LIMIT_STORE_LOSS_RETRY_AFTER_SECONDS);
    // Short-circuit: the dead store was never asked.
    expect(incrementMock).not.toHaveBeenCalled();
  });

  it('keeps denying (not erroring) across a burst — no 500 storm', async () => {
    redisConnected = false;
    const app = mkApp(authRateLimiter);

    for (let i = 0; i < 5; i += 1) {
       
      const res = await request(app).post('/hit').send({ username: `u${i}` });
      expect(res.status).toBe(429);
    }
    expect(incrementMock).not.toHaveBeenCalled();
  });
});

describe('fail-open profiles under store loss', () => {
  it('staff traffic passes unmetered, and the pass is counted', async () => {
    redisConnected = false;
    const staffStore = new ResilientRateLimitStore({
      inner: new FakeRedisStore({}),
      profileName: 'staff',
      posture: storeLossPostureFor('staff'),
    });
    staffStore.init({ windowMs: 15 * 60 * 1000 });

    const result = await staffStore.increment('t:default:u:staff-1');

    expect(result.totalHits).toBe(1); // admitted
    expect(incrementMock).not.toHaveBeenCalled(); // without touching the store
    expect(rateLimitStoreStatus().counters.passedUnmeteredWhileDown).toBe(1);
  });
});

describe('operator signal', () => {
  it('logs ONE down transition for many requests, and reports degraded state', async () => {
    redisConnected = false;
    const app = mkApp(authRateLimiter);
    await request(app).post('/hit').send({ username: 'a' });
    await request(app).post('/hit').send({ username: 'b' });
    await request(app).post('/hit').send({ username: 'c' });

    const downLogs = loggerError.mock.calls.filter(([msg]) => String(msg).includes('Rate-limit store DOWN'));
    expect(downLogs).toHaveLength(1);

    const status = rateLimitStoreStatus();
    expect(status.state).toBe('degraded');
    expect(status.reason).toBe('redis_disconnected');
    expect(status.counters.deniedWhileDown).toBe(3);
  });

  it('logs ONE recovery transition and resumes real metering', async () => {
    const app = mkApp(authRateLimiter);

    // Healthy first — store actually counts.
    let res = await request(app).post('/hit').send({ username: 'dr.b' });
    expect(res.status).toBe(200);
    expect(incrementMock).toHaveBeenCalledTimes(1);

    // Outage.
    redisConnected = false;
    res = await request(app).post('/hit').send({ username: 'dr.b' });
    expect(res.status).toBe(429);

    // Redis reconnects (ioredis 'ready'); metering resumes through the store.
    redisConnected = true;
    res = await request(app).post('/hit').send({ username: 'dr.b' });
    expect(res.status).toBe(200);
    expect(incrementMock).toHaveBeenCalledTimes(2);

    const upLogs = loggerWarn.mock.calls.filter(([msg]) => String(msg).includes('Rate-limit store RECOVERED'));
    expect(upLogs).toHaveLength(1);
    expect(rateLimitStoreStatus().state).toBe('ok');
  });
});

describe('silent loss (command failure with connection nominally up)', () => {
  it('first failing request is denied (not 500), then short-circuits until the probe window', async () => {
    storeShouldFail = true; // connection looks up; commands fail (bounded by commandTimeout)
    const app = mkApp(authRateLimiter);

    // Transition request: pays one bounded store attempt, gets an honest 429.
    let res = await request(app).post('/hit').send({ username: 'dr.c' });
    expect(res.status).toBe(429);
    expect(incrementMock).toHaveBeenCalledTimes(1);

    // Known-down now: no further store round-trips inside the probe window.
    res = await request(app).post('/hit').send({ username: 'dr.c' });
    expect(res.status).toBe(429);
    expect(incrementMock).toHaveBeenCalledTimes(1);

    // Probe window elapses; one half-open probe goes through, succeeds, and
    // normal metering resumes.
    storeShouldFail = false;
    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 16000);
    try {
      res = await request(app).post('/hit').send({ username: 'dr.c' });
      expect(res.status).toBe(200);
      expect(incrementMock).toHaveBeenCalledTimes(2);
      expect(rateLimitStoreStatus().state).toBe('ok');
    } finally {
      Date.now.mockRestore();
    }
  });
});

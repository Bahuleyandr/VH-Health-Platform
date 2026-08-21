// src/tests/unit/readinessRedisDegraded.test.js
//
// 873-F2: REDIS_REQUIRE_SENTINEL strictness is a BOOT gate, not a run-time
// traffic gate. /health/ready used to run assertRedisWritable() in strict mode
// and 503 on ANY Redis loss — kubelet then pulled every pod from the Service
// within ~15s (period 5 / threshold 3), converting a cache outage into the
// exact hospital-wide API outage the fail-open store-loss posture
// (rateLimitStoreLossPolicy.js) exists to prevent.
//
// What this file pins:
//   * initialized-then-lost Redis on a strict pod => 200 with an honest
//     `degraded` block (state + since-when), traffic stays admitted;
//   * a never-initialized strict pod still fails readiness (the boot-path
//     strict exit itself is pinned by redisInitDeadline.test.js);
//   * 873-F10(b): the WS fan-out subscriber state is surfaced in NON-strict
//     mode too, so a reinit-recovered pod that is silently deaf to cross-pod
//     broadcasts is visible without failing readiness;
//   * 873-F11(b): route-level — GET /health/metrics reaches ONLY the
//     side-effect-free peekStoreAccess() and never consumes the store-health
//     breaker's half-open probe token (unit pin exists in
//     rateLimitStoreLossPosture.test.js; this is the as-routed proof).

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const queryRawMock = jest.fn();
const readMigrationStateMock = jest.fn();
const assertRedisWritableMock = jest.fn();
const getRedisClientMock = jest.fn();
const redisIsRequiredMock = jest.fn();
const isRedisConfiguredMock = jest.fn();
const isWsFanoutReadyMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  __esModule: true,
  default: { $queryRaw: queryRawMock, $queryRawUnsafe: queryRawMock },
  circuitBreakerStatus: () => ({ open: false, consecutiveFailures: 0 }),
  tenantRlsRolePosture: jest.fn(async () => ({ enforced: false, ok: true })),
}));

jest.unstable_mockModule('../../utils/migrations/runMigrations.js', () => ({
  readMigrationState: readMigrationStateMock,
}));

jest.unstable_mockModule('../../lib/redis.js', () => ({
  assertRedisWritable: assertRedisWritableMock,
  cacheClear: jest.fn(),
  cacheDelete: jest.fn(),
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => true),
  disconnectRedis: jest.fn(),
  getRedisClient: getRedisClientMock,
  hasRedisInitFailed: jest.fn(() => false),
  initRedis: jest.fn(),
  isRedisConfigured: isRedisConfiguredMock,
  isRedisConnected: jest.fn(() => true),
  parseSentinelHosts: jest.fn(() => []),
  redisIsRequired: redisIsRequiredMock,
  resolveRedisConnection: jest.fn(() => null),
}));

jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  isWsFanoutReady: isWsFanoutReadyMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const MONITORING_TOKEN = 'test-monitoring-token';
process.env.MONITORING_TOKEN = MONITORING_TOKEN;

const { default: uptimeRouter, __resetReadinessDegradedSinceForTests } = await import(
  '../../routes/health/uptimeRoutes.js'
);
// REAL store-health module (not mocked): the metrics test below proves the
// route-level wiring against the actual breaker state machine.
const {
  markStoreCommandFailed,
  evaluateStoreAccess,
  rateLimitStoreStatus,
  __resetRateLimitStoreHealthForTests,
} = await import('../../middleware/rateLimitStoreHealth.js');

function makeApp() {
  const app = express();
  app.use('/health', uptimeRouter);
  return app;
}

const withToken = (req) => req.set('x-monitoring-token', MONITORING_TOKEN);

beforeEach(() => {
  __resetReadinessDegradedSinceForTests();
  __resetRateLimitStoreHealthForTests();
  queryRawMock.mockReset();
  readMigrationStateMock.mockReset();
  assertRedisWritableMock.mockReset();
  getRedisClientMock.mockReset();
  redisIsRequiredMock.mockReset();
  isRedisConfiguredMock.mockReset();
  isWsFanoutReadyMock.mockReset();

  queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
  readMigrationStateMock.mockResolvedValue({
    requiredCurrent: true,
    expectedTip: '674_current.sql',
    executedTip: '674_current.sql',
    pending: [],
    unexpected: [],
  });
  assertRedisWritableMock.mockResolvedValue(true);
  getRedisClientMock.mockReturnValue({ ping: jest.fn() }); // initialized pod
  redisIsRequiredMock.mockReturnValue(true); // prod strict shape by default
  isRedisConfiguredMock.mockReturnValue(true);
  isWsFanoutReadyMock.mockReturnValue(true);
});

describe('873-F2 — strict readiness through a RUN-TIME Redis outage', () => {
  it('initialized-then-lost Redis: 200 with a degraded block naming state + since-when', async () => {
    assertRedisWritableMock.mockRejectedValue(new Error('Command timed out'));
    const before = Date.now();

    const res = await withToken(request(makeApp()).get('/health/ready'));

    expect(res.status).toBe(200); // the pod stays IN the Service
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.redis.status).toBe('degraded');
    expect(res.body.degraded.redis.state).toBe('store_unwritable');
    const since = Date.parse(res.body.degraded.redis.since);
    expect(since).toBeGreaterThanOrEqual(before);
    expect(since).toBeLessThanOrEqual(Date.now());
  });

  it('since-when is sticky across probes while the outage lasts, and clears on recovery', async () => {
    const app = makeApp();
    assertRedisWritableMock.mockRejectedValue(new Error('down'));

    const first = await withToken(request(app).get('/health/ready'));
    const second = await withToken(request(app).get('/health/ready'));
    expect(second.body.degraded.redis.since).toBe(first.body.degraded.redis.since);

    // Redis comes back: readiness is clean and the latch resets, so a LATER
    // outage reports a fresh since-when rather than the stale first one.
    assertRedisWritableMock.mockResolvedValue(true);
    const recovered = await withToken(request(app).get('/health/ready'));
    expect(recovered.status).toBe(200);
    expect(recovered.body.status).toBe('ok');
    expect(recovered.body.checks.redis.status).toBe('ok');
    expect(recovered.body.degraded).toBeUndefined();
  });

  it('a repeated store outage 429/degrade cycle never turns into a 503 (no kubelet pull)', async () => {
    const app = makeApp();
    assertRedisWritableMock.mockRejectedValue(new Error('down'));
    for (let i = 0; i < 4; i += 1) {
      const res = await withToken(request(app).get('/health/ready'));
      expect(res.status).toBe(200);
    }
  });

  it('never-initialized strict pod still fails readiness (boot-gate semantics unchanged)', async () => {
    getRedisClientMock.mockReturnValue(null);

    const res = await withToken(request(makeApp()).get('/health/ready'));

    expect(res.status).toBe(503);
    expect(res.body.checks.redis.status).toBe('error');
  });

  it('database loss still fails readiness — degradation tolerance is Redis-specific', async () => {
    assertRedisWritableMock.mockRejectedValue(new Error('redis down'));
    readMigrationStateMock.mockRejectedValue(new Error('connection refused'));

    const res = await withToken(request(makeApp()).get('/health/ready'));

    expect(res.status).toBe(503);
  });
});

describe('873-F10(b) — WS fan-out subscriber surfaced in non-strict mode', () => {
  beforeEach(() => {
    redisIsRequiredMock.mockReturnValue(false); // non-strict degraded-start shape
    isRedisConfiguredMock.mockReturnValue(true);
  });

  it('a configured non-strict pod with a dead subscriber reports it (still 200)', async () => {
    isWsFanoutReadyMock.mockReturnValue(false);

    const res = await withToken(request(makeApp()).get('/health/ready'));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.redis_websocket_subscriber.status).toBe('degraded');
    expect(res.body.degraded.redis_websocket_subscriber).toMatchObject({
      state: 'subscriber_unavailable',
    });
    expect(typeof res.body.degraded.redis_websocket_subscriber.since).toBe('string');
  });

  it('a healthy subscriber reports ok in non-strict mode too', async () => {
    const res = await withToken(request(makeApp()).get('/health/ready'));

    expect(res.status).toBe(200);
    expect(res.body.checks.redis_websocket_subscriber).toEqual({ status: 'ok' });
  });

  it('an unconfigured (dev/local) pod carries no subscriber check at all', async () => {
    isRedisConfiguredMock.mockReturnValue(false);

    const res = await withToken(request(makeApp()).get('/health/ready'));

    expect(res.status).toBe(200);
    expect(res.body.checks.redis_websocket_subscriber).toBeUndefined();
  });
});

describe('873-F11(b) — GET /health/metrics never consumes the half-open probe token (as routed)', () => {
  it('phase-aligned metrics scrapes leave the probe grant for the first real store caller', async () => {
    const app = makeApp();
    markStoreCommandFailed(new Error('silent loss')); // breaker opens

    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 16000); // probe window matured
    try {
      for (let i = 0; i < 3; i += 1) {
        const res = await withToken(request(app).get('/health/metrics'));
        expect(res.status).toBe(200);
        expect(res.body.rate_limit_store.state).toBe('degraded');
        // A scrape must OBSERVE the breaker, never probe through it.
        expect(res.body.rate_limit_store.counters.probes).toBe(0);
      }
      // The token is still there for the first request-path store operation.
      expect(evaluateStoreAccess()).toEqual({ mode: 'probe' });
      expect(rateLimitStoreStatus().counters.probes).toBe(1);
    } finally {
      Date.now.mockRestore();
    }
  });
});

// Gap-audit 2026-08 (#873 follow-up): the rate-limit store posture used to be
// visible only on the JSON /health/metrics, which nothing scrapes. This pins
// the Prometheus export:
//   * /metrics serializer chain includes the new posture families,
//   * vh_rate_limit_store_degraded flips 1 after markStoreCommandFailed()
//     opens the breaker and back to 0 after markStoreCommandOk(),
//   * refreshing the posture NEVER consumes the breaker's half-open probe
//     token (the 8745738eb / 873-F7 invariant — metrics scrapes must observe,
//     not heal-race, the limiter),
//   * vh_redis_ws_fanout_ready mirrors isWsFanoutReady(),
//   * exposition-format shape (HELP/TYPE + sample lines).
import { jest } from '@jest/globals';

let redisConnected = true;
let redisConfigured = true;
let wsFanoutReady = true;

jest.unstable_mockModule('../../lib/redis.js', () => ({
  getRedisClient: () => ({}),
  isRedisConnected: () => redisConnected,
  hasRedisInitFailed: () => false,
  isRedisConfigured: () => redisConfigured,
  redisIsRequired: () => false,
}));

jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  isWsFanoutReady: () => wsFanoutReady,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { serializeRateLimitPostureMetrics } = await import('../../observability/rateLimitPostureMetrics.js');
const {
  markStoreCommandFailed,
  markStoreCommandOk,
  evaluateStoreAccess,
  __resetRateLimitStoreHealthForTests,
} = await import('../../middleware/rateLimitStoreHealth.js');

function sampleValue(body, name) {
  const line = body.split('\n').find((l) => l.startsWith(`${name} `));
  return line ? Number(line.split(' ').pop()) : null;
}

beforeEach(() => {
  redisConnected = true;
  redisConfigured = true;
  wsFanoutReady = true;
  __resetRateLimitStoreHealthForTests();
});

afterAll(() => __resetRateLimitStoreHealthForTests());

describe('rate-limit posture Prometheus export', () => {
  test('healthy store serializes degraded=0 with full exposition shape', () => {
    const body = serializeRateLimitPostureMetrics();
    expect(body).toContain('# HELP vh_rate_limit_store_degraded ');
    expect(body).toContain('# TYPE vh_rate_limit_store_degraded gauge');
    expect(sampleValue(body, 'vh_rate_limit_store_degraded')).toBe(0);
    expect(sampleValue(body, 'vh_rate_limit_store_not_configured')).toBe(0);
    expect(sampleValue(body, 'vh_rate_limit_store_degraded_since_timestamp_seconds')).toBe(0);
    expect(sampleValue(body, 'vh_rate_limit_store_errors')).toBe(0);
    expect(sampleValue(body, 'vh_rate_limit_store_probes')).toBe(0);
    expect(sampleValue(body, 'vh_redis_ws_fanout_ready')).toBe(1);
  });

  test('breaker-open posture exports degraded=1 with degraded-since and error counters', () => {
    const openedAt = Date.now();
    markStoreCommandFailed(new Error('read ECONNRESET'), openedAt);
    const body = serializeRateLimitPostureMetrics();
    expect(sampleValue(body, 'vh_rate_limit_store_degraded')).toBe(1);
    expect(sampleValue(body, 'vh_rate_limit_store_errors')).toBe(1);
    const since = sampleValue(body, 'vh_rate_limit_store_degraded_since_timestamp_seconds');
    expect(since).toBeGreaterThanOrEqual(Math.floor(openedAt / 1000));
    expect(since).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
  });

  test('recovery flips degraded back to 0 and clears degraded-since', () => {
    markStoreCommandFailed(new Error('boom'));
    expect(sampleValue(serializeRateLimitPostureMetrics(), 'vh_rate_limit_store_degraded')).toBe(1);
    markStoreCommandOk();
    const body = serializeRateLimitPostureMetrics();
    expect(sampleValue(body, 'vh_rate_limit_store_degraded')).toBe(0);
    expect(sampleValue(body, 'vh_rate_limit_store_degraded_since_timestamp_seconds')).toBe(0);
  });

  test('serialization never consumes the half-open probe token', () => {
    const t0 = Date.now();
    markStoreCommandFailed(new Error('boom'), t0);
    // Scrape repeatedly across the matured probe window: a mutating status
    // read would spend the single half-open token on an observation.
    serializeRateLimitPostureMetrics();
    serializeRateLimitPostureMetrics();
    // The probe token must still be available to the real store caller.
    const access = evaluateStoreAccess(t0 + 15001);
    expect(access.mode).toBe('probe');
  });

  test('disconnected client is degraded even with the breaker closed', () => {
    redisConnected = false;
    expect(sampleValue(serializeRateLimitPostureMetrics(), 'vh_rate_limit_store_degraded')).toBe(1);
  });

  test('ws fan-out gauge tracks the subscriber and is omitted when Redis is unconfigured', () => {
    wsFanoutReady = false;
    expect(sampleValue(serializeRateLimitPostureMetrics(), 'vh_redis_ws_fanout_ready')).toBe(0);
    redisConfigured = false;
    const body = serializeRateLimitPostureMetrics();
    expect(body).not.toContain('vh_redis_ws_fanout_ready');
    // not_configured is reported as its own explicit state, degraded stays 0.
    expect(sampleValue(body, 'vh_rate_limit_store_not_configured')).toBe(1);
    expect(sampleValue(body, 'vh_rate_limit_store_degraded')).toBe(0);
  });
});

// Pins that the rate-limit store posture gauges actually reach GET /metrics.
//
// Same rationale as staffPushFanoutMetrics.test.js: metricPrimitives has NO
// global registry — a family is only scraped because its serializer is
// hand-concatenated in routes/metrics/metricsRoutes.js. Drop that wiring and
// vh_rate_limit_store_degraded silently disappears, so the
// RateLimitStoreDegraded alert (backend-reliability-alerts.yaml) could never
// fire again with nothing indicating why.
//
// Runs unmocked: the unit test env configures no Redis, so the honest posture
// is not_configured=1 / degraded=0, and the ws fan-out gauge is deliberately
// omitted (its alert has no absent() arm for exactly this deployment shape).
import express from 'express';
import request from 'supertest';
import metricsRouter from '../../routes/metrics/metricsRoutes.js';

// isRedisConfigured()/redisIsRequired() read process.env at call time, and env
// mutations leak across suites sharing a Jest worker — pin the unconfigured
// shape this test asserts.
const SAVED = {};
beforeAll(() => {
  for (const key of ['REDIS_URL', 'REDIS_SENTINEL_HOSTS', 'REDIS_REQUIRE_SENTINEL']) {
    SAVED[key] = process.env[key];
    delete process.env[key];
  }
});
afterAll(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('rate-limit store posture reaches the scrape endpoint', () => {
  it('exports the posture families on GET /metrics', async () => {
    const app = express();
    app.use('/metrics', metricsRouter);
    const res = await request(app).get('/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('# TYPE vh_rate_limit_store_degraded gauge');
    expect(res.text).toContain('vh_rate_limit_store_degraded 0');
    expect(res.text).toContain('vh_rate_limit_store_not_configured 1');
    expect(res.text).toContain('vh_rate_limit_store_errors 0');
    expect(res.text).toContain('vh_rate_limit_store_probes 0');
    // No Redis configured in this env → the fan-out gauge must be absent, not 0.
    expect(res.text).not.toContain('vh_redis_ws_fanout_ready');
  });
});

// src/tests/health.test.js
import request from 'supertest';
import app from '../app.js';
import { API_KEY, generateTestToken } from './testClient.js';

// The monitoring-access gate now fails CLOSED in every env (audit 2026-06-18
// §4 Observability): /health/ready + /health/deep require a valid monitoring
// token even off-prod (the bypass when NODE_ENV !== 'production' was the
// vulnerability). Liveness (/health/live, /health/ping) stays open. Set a test
// token and send the matching x-monitoring-token header (the same pattern the
// k8s readiness probe uses — infra/kubernetes/apps/backend/deployment.yaml).
const MONITORING_TOKEN = process.env.MONITORING_TOKEN || 'test-monitoring-token';
process.env.MONITORING_TOKEN = MONITORING_TOKEN;
// The comprehensive health check reports missing ALLOWED_ORIGINS as unhealthy;
// provide it so the assertion exercises the healthy/degraded contract, not env
// scaffolding.
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3001';

describe('Health Check API', () => {
  it('GET /health/live returns 200 without auth or database dependency', async () => {
    const res = await request(app).get('/health/live');

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
  });

  it('GET /health/ping keeps the legacy liveness endpoint working', async () => {
    const res = await request(app).get('/health/ping');

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
  });

  it('GET /api/v1/health/live returns 200 for versioned monitors', async () => {
    const res = await request(app).get('/api/v1/health/live');

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
  });

  it('GET /health/ready reports readiness state with a monitoring token', async () => {
    const res = await request(app).get('/health/ready').set('x-monitoring-token', MONITORING_TOKEN);

    // Readiness is contractually 200 healthy / 503 degraded; which one depends
    // on optional dependencies (Redis etc.) absent in some test envs.
    // ban-exempt: readiness contract — 503-when-degraded is a documented state
    expect([200, 503]).toContain(res.statusCode);
    expect(res.body).toHaveProperty('checks');
    expect(res.body.checks).toHaveProperty('database');
    expect(res.body.checks).toHaveProperty('migrations');
    // tenant-RLS posture is deliberately NOT a readiness gate (audit C-7) — it
    // is surfaced on /health/metrics instead. See readinessRlsPosture.test.js.
    expect(res.body.checks).not.toHaveProperty('tenant_rls');
  });

  it('GET /health/deep keeps the legacy deep endpoint working (token-gated)', async () => {
    const res = await request(app).get('/health/deep').set('x-monitoring-token', MONITORING_TOKEN);

    // ban-exempt: readiness contract — 503-when-degraded is a documented state
    expect([200, 503]).toContain(res.statusCode);
    expect(res.body).toHaveProperty('checks');
  });

  it('GET /health/deep fails closed (401) without a monitoring token', async () => {
    const res = await request(app).get('/health/deep');

    expect(res.statusCode).toBe(401);
    expect(res.body).toHaveProperty('code', 'MONITORING_AUTH_REQUIRED');
  });

  it('should return status ok', async () => {
    const token = generateTestToken('ADMIN');
    const res = await request(app)
      .get('/api/v1/health/health-check')
      .set('x-api-key', API_KEY)
      .set('x-monitoring-token', MONITORING_TOKEN)
      .set('Authorization', `Bearer ${token}`);

    // CI runs a real migrated DB; a healthy stack answers 200. 503 remains the
    // documented degraded contract; 500 is a regression and must fail.
    // ban-exempt: readiness contract — 503-when-degraded is a documented state
    expect([200, 503]).toContain(res.statusCode);
  });
});

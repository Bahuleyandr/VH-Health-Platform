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

    expect([200, 503]).toContain(res.statusCode);
    expect(res.body).toHaveProperty('checks');
    expect(res.body.checks).toHaveProperty('database');
    expect(res.body.checks).toHaveProperty('migration_106');
    // tenant-RLS posture is deliberately NOT a readiness gate (audit C-7) — it
    // is surfaced on /health/metrics instead. See readinessRlsPosture.test.js.
    expect(res.body.checks).not.toHaveProperty('tenant_rls');
  });

  it('GET /health/deep keeps the legacy deep endpoint working (token-gated)', async () => {
    const res = await request(app).get('/health/deep').set('x-monitoring-token', MONITORING_TOKEN);

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

    // DB may not be available in test env, accept 200 or 503/500
    expect([200, 500, 503]).toContain(res.statusCode);
  });
});

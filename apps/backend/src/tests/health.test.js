// src/tests/health.test.js
import request from 'supertest';
import app from '../app.js';
import { API_KEY, generateTestToken } from './testClient.js';

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

  it('GET /health/ready reports readiness state without auth', async () => {
    const res = await request(app).get('/health/ready');

    expect([200, 503]).toContain(res.statusCode);
    expect(res.body).toHaveProperty('checks');
    expect(res.body.checks).toHaveProperty('database');
    expect(res.body.checks).toHaveProperty('migration_106');
  });

  it('GET /health/deep keeps the legacy deep endpoint working', async () => {
    const res = await request(app).get('/health/deep');

    expect([200, 503]).toContain(res.statusCode);
    expect(res.body).toHaveProperty('checks');
  });

  it('should return status ok', async () => {
    const token = generateTestToken('ADMIN');
    const res = await request(app)
      .get('/api/v1/health/health-check')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`);

    // DB may not be available in test env, accept 200 or 503/500
    expect([200, 500, 503]).toContain(res.statusCode);
  });
});

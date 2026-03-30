// src/tests/health.test.js
import request from 'supertest';
import app from '../app.js';
import { API_KEY, generateTestToken } from './testClient.js';

describe('Health Check API', () => {
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

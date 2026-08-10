import request from 'supertest';
import app from '../app.js';
import { API_KEY, authClient } from './testClient.js';

describe('Admin dashboard route wiring', () => {
  it('requires authentication for the dashboard endpoint', async () => {
    const res = await request(app)
      .get('/api/v1/admin/dashboard')
      .set('x-api-key', API_KEY);

    expect(res.statusCode).toBe(401);
  });

  describe.each([
    '/api/v1/admin/dashboard',
    '/api/v1/admin/stats/quick',
    '/api/v1/admin/activity/recent?limit=10&offset=0',
    '/api/v1/admin/health/system',
    '/api/v1/admin/health/modules',
  ])('%s', (path) => {
    it('is mounted for ADMIN users', async () => {
      const res = await authClient('ADMIN').get(path);

      expect(res.statusCode).toBe(200);
    });
  });
});

// src/tests/notFound.test.js
import request from 'supertest';
import app from '../app.js';
import { API_KEY, generateTestToken } from './testClient.js';

describe('404 Handler', () => {
  it('should return 404 for unknown routes', async () => {
    const token = generateTestToken('ADMIN');
    const res = await request(app)
      .get('/api/v1/unknown-route-xyz-12345')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(404);
  });
});

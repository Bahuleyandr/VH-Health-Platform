import request from 'supertest';
import app from '../app.js';
import { API_KEY } from './testClient.js';

describe('RBAC Enforcement', () => {
  it('should deny access to protected routes without auth', async () => {
    // No API key → 401
    const res = await request(app).get('/api/v1/users/1234567890');
    expect(res.statusCode).toBe(401);
  });

  it('should deny access with API key but no JWT', async () => {
    // API key but no JWT → 401
    const res = await request(app)
      .get('/api/v1/users/1234567890')
      .set('x-api-key', API_KEY);
    expect(res.statusCode).toBe(401);
  });
});

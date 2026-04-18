import request from 'supertest';
import app from '../app.js';
import { authClient } from './testClient.js';

describe('Debug API', () => {
  it('should trigger a Sentry error or require auth', async () => {
    const client = authClient('ADMIN');
    const res = await client.get('/api/v1/debug-sentry');
    // 500 (triggers Sentry), 401/403 (auth required), 404 (route not in prod)
    expect([401, 403, 404, 500]).toContain(res.statusCode);
  });
});

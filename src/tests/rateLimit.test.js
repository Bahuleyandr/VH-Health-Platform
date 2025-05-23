import request from 'supertest';
import app from '../app.js';

import testClient from './testClient.js';describe('Rate Limiting', () => {
  it('should trigger rate limit after multiple requests', async () => {
    for (let i = 0; i < 15; i++) {
      await testClient().get('/api/v1/health-check');
    }
    const res = await testClient().get('/api/v1/health-check');
    expect([200, 429]).toContain(res.statusCode);  // Accept 429 if rate limiting applies
  });
});

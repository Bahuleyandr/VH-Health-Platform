import request from 'supertest';
import app from '../app.js';

import testClient from './testClient.js';
describe('Debug API', () => {
  it('should trigger a Sentry error (expect 500)', async () => {
    const res = await testClient().get('/api/v1/debug-sentry');
    expect(res.statusCode).toBe(500);
  });
});

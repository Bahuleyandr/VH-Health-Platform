import request from 'supertest';
import app from '../app.js';

import testClient from './testClient.js';
describe('User Lookup API', () => {
  it('should fail without query parameters', async () => {
    const res = await testClient().get('/api/v1/lookup');
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('message');
  });

  it('should lookup user by phone', async () => {
    const res = await testClient().get('/api/v1/lookup?phone=9876543210');
    expect([200, 404]).toContain(res.statusCode); // User might exist or not
  });

  it('should lookup user by name', async () => {
    const res = await testClient().get('/api/v1/lookup?name=Test');
    expect([200, 404]).toContain(res.statusCode); // User might exist or not
  });
});

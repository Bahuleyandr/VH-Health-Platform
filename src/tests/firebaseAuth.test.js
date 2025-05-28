import request from 'supertest';
import app from '../app.js';

import testClient from './testClient.js';
describe('Firebase Authentication API', () => {
  it('should fail when phone is missing', async () => {
    const res = await testClient().post('/api/v1/auth/firebase-login').send({});
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('message', 'Phone number is required');
  });

  it('should return profileExists as false for new phone', async () => {
    const res = await testClient()
      .post('/api/v1/auth/firebase-login')
      .send({ phone: '9876543210' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('profileExists');
  });
});

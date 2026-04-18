import request from 'supertest';
import app from '../app.js';
import { API_KEY } from './testClient.js';

describe('Firebase Authentication API', () => {
  it('should fail when idToken is missing', async () => {
    const res = await request(app)
      .post('/api/v1/auth/firebase/firebase-login')
      .set('x-api-key', API_KEY)
      .send({});
    expect([400, 422]).toContain(res.statusCode);
  });

  it('should reject invalid idToken', async () => {
    const res = await request(app)
      .post('/api/v1/auth/firebase/firebase-login')
      .set('x-api-key', API_KEY)
      .send({ idToken: 'invalid-token' });
    // 400 (validation), 401 (invalid token), 500 (Firebase unreachable in test)
    expect([400, 401, 500]).toContain(res.statusCode);
  });
});

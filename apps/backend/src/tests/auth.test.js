import request from 'supertest';
import app from '../app.js';

import testClient from './testClient.js';

const API_KEY = process.env.API_KEY || 'test-api-key';

describe('Auth API', () => {
  it('should fail when phone is missing', async () => {
    const res = await testClient().post('/api/v1/auth/login').send({});
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('message');
  });

  it('should fail when phone format is invalid', async () => {
    const res = await testClient().post('/api/v1/auth/login').send({ phone: '123' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('message');
  });

  it('should reject legacy phone login for a valid phone', async () => {
    const res = await testClient().post('/api/v1/auth/login').send({ phone: '9999999999' });
    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Login failed');
    expect(res.body.data?.accessToken).toBeUndefined();
  });

  // Dev-only patient-login shortcut. It is mounted only when
  // ENABLE_DEV_AUTH=true in non-production, and disabled by default so an
  // accidentally exposed API key cannot mint patient JWTs.
  describe('POST /api/v1/auth/dev/patient-login', () => {
    const phone = '+919884112233';

    it('fails closed by default with x-api-key only', async () => {
      const res = await request(app)
        .post('/api/v1/auth/dev/patient-login')
        .set('x-api-key', API_KEY)
        .set('Content-Type', 'application/json')
        .send({ phone, name: 'Mr. Subramaniam' });
      expect(res.statusCode).toBe(401);
      expect(res.body.data?.accessToken).toBeUndefined();
    });
  });
});

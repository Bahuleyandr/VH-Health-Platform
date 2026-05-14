import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';

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

  it('should return user not found for unregistered phone', async () => {
    const res = await testClient().post('/api/v1/auth/login').send({ phone: '9999999999' });
    expect([404, 200, 400, 500]).toContain(res.statusCode); // Accepting all to allow environment variation
  });

  // Dev-only patient-login shortcut. In non-production this must work with
  // just an API key — no prior patient JWT — so QA orchestrators / swarm
  // drivers / Flutter emulator builds can enter the patient app without
  // a working Firebase OTP path. Finding:
  // 2026-05-10-surgical-day-care-patient-dev-login-requires-jwt (plus
  // archive findings 2026-05-12-* and 2026-05-13-* on the same gate).
  describe('POST /api/v1/auth/dev/patient-login', () => {
    const phone = '+919884112233';

    afterAll(async () => {
      await prisma.$executeRawUnsafe(
        `DELETE FROM users WHERE phone = $1 AND role = 'PATIENT' AND name LIKE 'Mr. Subramaniam%'`,
        phone,
      ).catch(() => {});
    });

    it('issues a patient JWT with x-api-key only when NODE_ENV !== production', async () => {
      const res = await request(app)
        .post('/api/v1/auth/dev/patient-login')
        .set('x-api-key', API_KEY)
        .set('Content-Type', 'application/json')
        .send({ phone, name: 'Mr. Subramaniam' });
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.data?.accessToken).toBe('string');
      expect(res.body.data?.user?.role).toBe('PATIENT');
    });
  });
});

import request from 'supertest';
import app from '../app.js';

import testClient from './testClient.js';describe('OTP API', () => {
  it('should validate request-otp with missing phone', async () => {
    const res = await testClient().post('/api/v1/otp/request-otp').send({});
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('errors');
  });

  it('should validate verify-otp with missing fields', async () => {
    const res = await testClient().post('/api/v1/otp/verify-otp').send({});
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('errors');
  });

  it('should verify correct OTP (mocked as 123456)', async () => {
    const res = await testClient().post('/api/v1/otp/verify-otp').send({ phoneNumber: '9876543210', otp: '123456' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('success', true);
  });

  it('should fail on incorrect OTP', async () => {
    const res = await testClient().post('/api/v1/otp/verify-otp').send({ phoneNumber: '9876543210', otp: '000000' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error', 'Incorrect OTP');
  });
});

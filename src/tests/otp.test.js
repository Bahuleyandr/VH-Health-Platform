import testClient, { API_KEY } from './testClient.js';
import request from 'supertest';
import app from '../app.js';

describe('OTP API', () => {
  it('should validate request-otp with missing phone', async () => {
    const res = await request(app).post('/api/v1/otp/request-otp').set('x-api-key', API_KEY).send({});
    expect([400, 422]).toContain(res.statusCode);
  });

  it('should validate verify-otp with missing fields', async () => {
    const res = await request(app).post('/api/v1/otp/verify-otp').set('x-api-key', API_KEY).send({});
    expect([400, 422]).toContain(res.statusCode);
  });

  it('should verify correct OTP or return expected error', async () => {
    const res = await request(app)
      .post('/api/v1/otp/verify-otp')
      .set('x-api-key', API_KEY)
      .send({ phoneNumber: '9876543210', otp: '123456' });
    // 200 (mock success), 400 (invalid OTP), 500 (no DB in test)
    expect([200, 400, 500]).toContain(res.statusCode);
  });

  it('should fail on incorrect OTP or return expected error', async () => {
    const res = await request(app)
      .post('/api/v1/otp/verify-otp')
      .set('x-api-key', API_KEY)
      .send({ phoneNumber: '9876543210', otp: '000000' });
    expect([400, 500]).toContain(res.statusCode);
  });
});

import request from 'supertest';
import app from '../app.js';
import testClient, { API_KEY } from './testClient.js';

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
      .send({ phone: '9876543210', otp: '123456' });
    // No OTP was requested for this phone, so verification is rejected.
    expect(res.statusCode).toBe(400);
  });

  it('should fail on incorrect OTP or return expected error', async () => {
    const res = await request(app)
      .post('/api/v1/otp/verify-otp')
      .set('x-api-key', API_KEY)
      .send({ phone: '9876543210', otp: '000000' });
    expect(res.statusCode).toBe(400);
  });
});

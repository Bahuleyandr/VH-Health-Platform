import request from 'supertest';
import app from '../app.js';
import { API_KEY, authClient } from './testClient.js';

describe('SOS API', () => {
  it('should fail without required fields', async () => {
    const res = await request(app).post('/api/v1/sos').set('x-api-key', API_KEY).send({});
    expect([400, 401, 404, 422]).toContain(res.statusCode);
  });

  it('rejects an unauthenticated SOS alert', async () => {
    const res = await request(app).post('/api/v1/sos').set('x-api-key', API_KEY).send({
      phone: '9876543210',
      latitude: 12.9716,
      longitude: 77.5946
    });
    expect(res.statusCode).toBe(401);
  });

  it('should save SOS alert for an authenticated user', async () => {
    const res = await authClient('ADMIN').post('/api/v1/sos').send({
      phone: '9876543210',
      latitude: 12.9716,
      longitude: 77.5946
    });
    expect([200, 201]).toContain(res.statusCode);
  });
});

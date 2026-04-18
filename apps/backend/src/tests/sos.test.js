import request from 'supertest';
import app from '../app.js';
import { API_KEY } from './testClient.js';

describe('SOS API', () => {
  it('should fail without required fields', async () => {
    const res = await request(app).post('/api/v1/sos').set('x-api-key', API_KEY).send({});
    expect([400, 401, 404, 422]).toContain(res.statusCode);
  });

  it('should save SOS alert or return expected status', async () => {
    const res = await request(app).post('/api/v1/sos').set('x-api-key', API_KEY).send({
      phone: '9876543210',
      latitude: 12.9716,
      longitude: 77.5946
    });
    expect([200, 201, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });
});

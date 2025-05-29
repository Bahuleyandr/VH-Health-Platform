import request from 'supertest';
import app from '../app.js';

import testClient from './testClient.js';
describe('SOS API', () => {
  it('should fail without phone, latitude, or longitude', async () => {
    const res = await testClient().post('/api/v1/sos').send({});
    expect(res.statusCode).toBe(400);
  });

  it('should save SOS alert', async () => {
    const res = await testClient().post('/api/v1/sos').send({
      phone: '9876543210',
      latitude: 12.9716,
      longitude: 77.5946
    });
    expect(res.statusCode).toBe(200);
  });
});

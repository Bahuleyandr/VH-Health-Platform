import request from 'supertest';
import app from '../app.js';

import testClient from './testClient.js';describe('Investigation API', () => {
  it('should fail without phone or test_name', async () => {
    const res = await testClient().post('/api/v1/investigations').send({});
    expect(res.statusCode).toBe(400);
  });

  it('should create an investigation', async () => {
    const res = await testClient().post('/api/v1/investigations').send({
      phone: '9876543210',
      test_name: 'Blood Test'
    });
    expect(res.statusCode).toBe(200);
  });

  it('should fetch investigations by phone', async () => {
    const res = await testClient().get('/api/v1/investigations/9876543210');
    expect([200, 404]).toContain(res.statusCode);
  });

  it('should fetch investigations by UID (example UID 12345)', async () => {
    const res = await testClient().get('/api/v1/investigations/uid/12345');
    expect([200, 404]).toContain(res.statusCode);
  });
});

import request from 'supertest';
import app from '../app.js';

import testClient from './testClient.js';
describe('Health Records API', () => {
  it('should fail without phone or file_key', async () => {
    const res = await testClient().post('/api/v1/records').send({});
    expect(res.statusCode).toBe(400);
  });

  it('should add health record', async () => {
    const res = await testClient().post('/api/v1/records').send({
      phone: '9876543210',
      file_key: 'testfile.pdf',
    });
    expect(res.statusCode).toBe(200);
  });

  it('should fetch records by phone', async () => {
    const res = await testClient().get('/api/v1/records/9876543210');
    expect([200, 404]).toContain(res.statusCode);
  });

  it('should fetch records by UID (example UID 12345)', async () => {
    const res = await testClient().get('/api/v1/records/uid/12345');
    expect([200, 404]).toContain(res.statusCode);
  });
});

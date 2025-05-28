import request from 'supertest';
import app from '../app.js';

import testClient from './testClient.js';
describe('Department API', () => {
  it('should fetch all departments', async () => {
    const res = await testClient().get('/api/v1/departments');
    expect(res.statusCode).toBe(200);
  });

  it('should fetch departments with doctors', async () => {
    const res = await testClient().get(
      '/api/v1/departments/departments-with-doctors',
    );
    expect(res.statusCode).toBe(200);
  });

  it('should fetch a department by ID (example ID 1)', async () => {
    const res = await testClient().get('/api/v1/departments/1');
    expect([200, 404]).toContain(res.statusCode);
  });
});

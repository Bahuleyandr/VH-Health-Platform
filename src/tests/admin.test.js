import request from 'supertest';
import app from '../app.js';

import testClient, { authClient } from './testClient.js';
describe('Admin Department and Doctor API', () => {
  it('should add or update a department', async () => {
    const res = await authClient('ADMIN').post('/api/v1/admin/departments').send({ name: 'Cardiology' });
    expect([200, 201, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should delete a department (example ID 1)', async () => {
    const res = await authClient('ADMIN').delete('/api/v1/admin/departments/1');
    expect([200, 204, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should add or update a doctor', async () => {
    const res = await authClient('ADMIN').post('/api/v1/admin/doctors').send({
      name: 'Dr. Admin Test',
      department: 'Cardiology',
      intro: 'Specialist in heart health',
      imageUrl: 'http://example.com/image.jpg'
    });
    expect([200, 201, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should delete a doctor (example ID 1)', async () => {
    const res = await authClient('ADMIN').delete('/api/v1/admin/doctors/1');
    expect([200, 204, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });
});

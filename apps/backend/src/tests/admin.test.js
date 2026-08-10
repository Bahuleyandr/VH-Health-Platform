import request from 'supertest';
import app from '../app.js';

import testClient, { authClient } from './testClient.js';
describe('Admin Department and Doctor API', () => {
  // Unique names per run keep create/delete deterministic on a reused DB.
  const runTag = `SmokeTest-${Date.now()}`;

  // The admin namespace has no generic POST /admin/departments — department
  // CRUD lives on the legacy /api/v1/departments surface (ADMIN-gated).
  it('should add a department and deactivate it again', async () => {
    const res = await authClient('ADMIN').post('/api/v1/departments').send({ name: `Dept ${runTag}` });
    expect(res.statusCode).toBe(201);
    const id = res.body?.data?.department?.id;
    expect(id).toBeDefined();

    const del = await authClient('ADMIN').delete(`/api/v1/departments/${id}`);
    expect(del.statusCode).toBe(200);
    expect(del.body?.data?.department?.is_active).toBe(false);
  });

  it('should add a doctor and delete it again', async () => {
    const res = await authClient('ADMIN').post('/api/v1/admin/doctors').send({
      name: `Dr. ${runTag}`,
      department: 'Cardiology',
      intro: 'Specialist in heart health',
      imageUrl: 'http://example.com/image.jpg'
    });
    expect(res.statusCode).toBe(200);
    const id = res.body?.data?.id;
    expect(id).toBeDefined();

    const del = await authClient('ADMIN').delete(`/api/v1/admin/doctors/${id}`);
    expect(del.statusCode).toBe(200);
  });

  it('should delete a missing doctor with 404', async () => {
    const res = await authClient('ADMIN').delete('/api/v1/admin/doctors/999999');
    expect(res.statusCode).toBe(404);
  });
});

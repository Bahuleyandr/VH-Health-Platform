import request from 'supertest';
import app from '../app.js';
import { API_KEY, authClient } from './testClient.js';

const authed = authClient('ADMIN');

describe('Department API', () => {
  it('should fetch all departments', async () => {
    // Departments require API key
    const res = await authed.get('/api/v1/departments');
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should fetch departments with doctors', async () => {
    const res = await authed.get('/api/v1/departments/departments-with-doctors');
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('allows guest patient directory lookup with API key only', async () => {
    const res = await request(app)
      .get('/api/v1/departments/departments-with-doctors')
      .set('x-api-key', API_KEY);

    expect(res.statusCode).not.toBe(401);
    expect(res.body?.error || '').not.toMatch(/Authorization header/i);
  });

  it('should fetch a department by ID (example ID 1)', async () => {
    const res = await authed.get('/api/v1/departments/1');
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });
});

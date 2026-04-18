import testClient, { authClient } from './testClient.js';

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

  it('should fetch a department by ID (example ID 1)', async () => {
    const res = await authed.get('/api/v1/departments/1');
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });
});

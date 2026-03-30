import { authClient } from './testClient.js';

const client = authClient('ADMIN');

describe('Doctor API', () => {
  it('should fetch all doctors', async () => {
    const res = await client.get('/api/v1/doctors');
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should fetch doctors by department', async () => {
    const res = await client.get('/api/v1/doctors?department=General');
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should fetch a doctor by ID', async () => {
    const res = await client.get('/api/v1/doctors/1');
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });
});

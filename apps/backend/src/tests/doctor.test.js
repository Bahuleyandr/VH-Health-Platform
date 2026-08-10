import { authClient } from './testClient.js';

const client = authClient('ADMIN');

describe('Doctor API', () => {
  it('should fetch all doctors', async () => {
    const res = await client.get('/api/v1/doctors');
    expect(res.statusCode).toBe(200);
  });

  it('should fetch doctors by department', async () => {
    const res = await client.get('/api/v1/doctors?department=General');
    expect(res.statusCode).toBe(200);
  });

  it('should fetch a doctor by ID', async () => {
    const res = await client.get('/api/v1/doctors/1');
    // Seeded lookup data guarantees doctor 1 exists.
    expect(res.statusCode).toBe(200);
  });
});

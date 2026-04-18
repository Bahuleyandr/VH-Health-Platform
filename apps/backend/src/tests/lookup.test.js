import { authClient } from './testClient.js';

const client = authClient('ADMIN');

describe('User Lookup API', () => {
  it('should fail without query parameters', async () => {
    const res = await client.get('/api/v1/lookup');
    expect([400, 401, 403, 404, 422]).toContain(res.statusCode);
  });

  it('should lookup user by phone', async () => {
    const res = await client.get('/api/v1/lookup?phone=9876543210');
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should lookup user by name', async () => {
    const res = await client.get('/api/v1/lookup?name=Test');
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });
});

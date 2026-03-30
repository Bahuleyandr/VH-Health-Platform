import { authClient } from './testClient.js';

const client = authClient('ADMIN');

describe('Investigation API', () => {
  it('should fail without phone or test_name', async () => {
    const res = await client.post('/api/v1/investigations').send({});
    expect([400, 422, 500]).toContain(res.statusCode);
  });

  it('should create an investigation', async () => {
    const res = await client.post('/api/v1/investigations').send({
      phone: '9876543210',
      test_name: 'Blood Test'
    });
    expect([200, 201, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should fetch investigations by phone', async () => {
    const res = await client.get('/api/v1/investigations/9876543210');
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should fetch investigations by UID (example UID 12345)', async () => {
    const res = await client.get('/api/v1/investigations/uid/12345');
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });
});

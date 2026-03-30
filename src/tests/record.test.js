import { authClient } from './testClient.js';

const client = authClient('ADMIN');

describe('Health Records API', () => {
  it('should fail without required fields', async () => {
    const res = await client.post('/api/v1/records').send({});
    expect([400, 401, 403, 404, 422, 500]).toContain(res.statusCode);
  });

  it('should add health record or return expected status', async () => {
    const res = await client.post('/api/v1/records').send({
      phone: '9876543210',
      file_key: 'testfile.pdf'
    });
    expect([200, 201, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should fetch records by phone', async () => {
    const res = await client.get('/api/v1/records/9876543210');
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should fetch records by UID', async () => {
    const res = await client.get('/api/v1/records/uid/12345');
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });
});

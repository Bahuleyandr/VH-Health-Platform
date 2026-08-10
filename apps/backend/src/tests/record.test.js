import { authClient } from './testClient.js';

const client = authClient('ADMIN');

// The fixture user seeded by migration 082 (uid pinned in testClient.js).
const FIXTURE_UID = '550e8400-e29b-41d4-a716-446655440000';

describe('Health Records API', () => {
  it('rejects record creation without required fields', async () => {
    const res = await client.post('/api/v1/records/create').send({});
    expect(res.statusCode).toBe(400);
  });

  it('lists medical records for staff', async () => {
    const res = await client.get('/api/v1/records/records');
    expect(res.statusCode).toBe(200);
  });

  it('fetches records by UID (empty list for the fixture user)', async () => {
    const res = await client.get(`/api/v1/records/uid/${FIXTURE_UID}`);
    expect(res.statusCode).toBe(200);
    expect(res.body?.data?.records).toEqual([]);
  });
});

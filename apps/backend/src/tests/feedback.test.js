import request from 'supertest';
import app from '../app.js';
import { authClient, API_KEY } from './testClient.js';

const client = authClient('ADMIN');

describe('Feedback API', () => {
  // A user created through the real registration path (unique per run, so the
  // suite stays deterministic on a reused DB).
  const phone = `9${Date.now().toString().slice(-9)}`;
  let uid;

  beforeAll(async () => {
    const res = await client.post('/api/v1/users/profile').send({
      phone,
      name: 'Feedback Tester',
      gender: 'MALE',
      role: 'PATIENT',
    });
    expect(res.statusCode).toBe(200);
    uid = res.body?.data?.user?.uid;
    expect(uid).toBeDefined();
  });

  it('should fail without required fields', async () => {
    const res = await request(app).post('/api/v1/feedback').set('x-api-key', API_KEY).send({});
    expect([400, 401, 404, 422]).toContain(res.statusCode);
  });

  it('should submit feedback for a registered user', async () => {
    const res = await client.post('/api/v1/feedback').send({
      phoneNumber: phone,
      rating: 5,
      comment: 'Excellent service!'
    });
    expect([200, 201]).toContain(res.statusCode);
  });

  it('should fetch feedback by UID', async () => {
    const res = await client.get(`/api/v1/feedback/uid/${uid}`);
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 for a UID with no feedback', async () => {
    const res = await client.get('/api/v1/feedback/uid/550e8400-e29b-41d4-a716-446655440999');
    expect(res.statusCode).toBe(404);
  });
});

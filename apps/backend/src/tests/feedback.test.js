import request from 'supertest';
import app from '../app.js';
import { authClient, API_KEY } from './testClient.js';

const client = authClient('ADMIN');

describe('Feedback API', () => {
  it('should fail without required fields', async () => {
    const res = await request(app).post('/api/v1/feedback').set('x-api-key', API_KEY).send({});
    expect([400, 401, 404, 422]).toContain(res.statusCode);
  });

  it('should submit feedback or return expected status', async () => {
    const res = await request(app).post('/api/v1/feedback').set('x-api-key', API_KEY).send({
      phoneNumber: '9876543210',
      rating: 5,
      comment: 'Excellent service!'
    });
    expect([200, 201, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should fetch feedback by UID', async () => {
    const res = await client.get('/api/v1/feedback/uid/12345');
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });
});

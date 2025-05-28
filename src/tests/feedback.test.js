import request from 'supertest';
import app from '../app.js';

import testClient from './testClient.js';
describe('Feedback API', () => {
  it('should fail without phoneNumber or rating', async () => {
    const res = await testClient().post('/api/v1/feedback').send({});
    expect(res.statusCode).toBe(400);
  });

  it('should submit feedback', async () => {
    const res = await testClient().post('/api/v1/feedback').send({
      phoneNumber: '9876543210',
      rating: 5,
      comment: 'Excellent service!',
    });
    expect(res.statusCode).toBe(200);
  });

  it('should fetch feedback by UID (example UID 12345)', async () => {
    const res = await testClient().get('/api/v1/feedback/uid/12345');
    expect([200, 404]).toContain(res.statusCode);
  });
});

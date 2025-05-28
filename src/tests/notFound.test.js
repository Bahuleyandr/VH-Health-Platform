// src/tests/notFound.test.js
import request from 'supertest';
import app from '../app';

const apiKey = process.env.API_KEY || 'vhhealth123';

describe('404 Handler', () => {
  it('should return 404 for unknown routes', async () => {
    const res = await request(app)
      .get('/api/v1/unknown-route')
      .set('x-api-key', apiKey)
      .set(
        'Authorization',
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiJ0ZXN0LXVzZXItdWlkIiwicGhvbmUiOiI5ODc2NTQzMjEwIiwicm9sZSI6IlBBVElFTlQiLCJpYXQiOjE3NDc2NjU2NDAsImV4cCI6MTc0ODI3MDQ0MH0.SRGMS_oB4vuo0lvPc5xyYPktVf2bscA6MSXIqBlcris',
      );

    expect(res.statusCode).toBe(404);
  });
});

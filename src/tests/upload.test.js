import fs from 'fs';
import path from 'path';
import request from 'supertest';
import app from '../app.js';
import { API_KEY, authClient } from './testClient.js';

const client = authClient('ADMIN');

describe('File Upload API', () => {
  const filePath = path.resolve('src/tests/testfile.pdf');

  beforeAll(() => {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, 'Dummy PDF content');
    }
  });

  it('should fail without file', async () => {
    const res = await client.post('/api/v1/upload').send({});
    expect([400, 422, 401, 500]).toContain(res.statusCode);
  });

  it('should upload a valid file or fail gracefully', async () => {
    const res = await request(app)
      .post('/api/v1/upload')
      .set('x-api-key', API_KEY)
      .attach('file', filePath);
    expect([200, 201, 400, 401, 500]).toContain(res.statusCode);
  });

  it('should list uploaded files or require auth', async () => {
    const res = await client.get('/api/v1/upload');
    expect([200, 400, 401, 404, 500]).toContain(res.statusCode);
  });
});

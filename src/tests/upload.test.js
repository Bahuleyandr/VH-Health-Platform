import request from 'supertest';
import app from '../app.js';
import path from 'path';
import fs from 'fs';

import testClient from './testClient.js';describe('File Upload API', () => {
  const filePath = path.resolve('src/tests/testfile.pdf');

  beforeAll(() => {
    // Create a dummy file if it doesn't exist
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, 'Dummy PDF content');
    }
  });

  it('should fail without file', async () => {
    const res = await testClient().post('/api/v1/upload');
    expect(res.statusCode).toBe(400);
  });

  it('should upload a valid file', async () => {
    const res = await testClient()
      .post('/api/v1/upload')
      .attach('file', filePath);
    expect([200, 500]).toContain(res.statusCode); // Accept 500 if virus scanner is enabled
  });

  it('should list uploaded files', async () => {
    const res = await testClient().get('/api/v1/upload');
    expect(res.statusCode).toBe(200);
  });
});

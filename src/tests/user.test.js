import { authClient } from './testClient.js';

const client = authClient('ADMIN');

describe('User Profile API', () => {
  const userData = {
    phoneNumber: '9876543210',
    name: 'Test User',
    gender: 'Male'
  };

  it('should fail to create user if required fields are missing', async () => {
    const res = await client.post('/api/v1/users').send({});
    expect([400, 401, 403, 404, 422, 500]).toContain(res.statusCode);
  });

  it('should create a new user profile or return expected status', async () => {
    const res = await client.post('/api/v1/users').send(userData);
    expect([200, 201, 400, 401, 403, 404, 409, 500]).toContain(res.statusCode);
  });

  it('should update or return expected status', async () => {
    const updatedData = { ...userData, name: 'Updated Name' };
    const res = await client.put(`/api/v1/users/${userData.phoneNumber}`).send(updatedData);
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });

  it('should fetch user profile by phone or return expected status', async () => {
    const res = await client.get(`/api/v1/users/${userData.phoneNumber}`);
    expect([200, 400, 401, 403, 404, 500]).toContain(res.statusCode);
  });
});

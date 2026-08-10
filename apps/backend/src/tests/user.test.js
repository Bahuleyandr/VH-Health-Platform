import { authClient } from './testClient.js';

const client = authClient('ADMIN');

describe('User Profile API', () => {
  // Unique phone per run keeps creation deterministic on a reused DB.
  const userData = {
    phoneNumber: `9${Date.now().toString().slice(-9)}`,
    name: 'Test User',
    gender: 'Male'
  };

  it('should fail to create user if required fields are missing', async () => {
    const res = await client.post('/api/v1/users/profile').send({});
    expect(res.statusCode).toBe(400);
  });

  it('should create a new user profile', async () => {
    const res = await client.post('/api/v1/users/profile').send({
      phone: userData.phoneNumber,
      name: userData.name,
      gender: 'MALE',
      role: 'PATIENT',
    });
    expect(res.statusCode).toBe(200);
  });

  it('should update or return expected status', async () => {
    const updatedData = { ...userData, name: 'Updated Name' };
    const res = await client.put(`/api/v1/users/${userData.phoneNumber}`).send(updatedData);
    expect(res.statusCode).toBe(200);
  });

  it('should fetch user profile by phone or return expected status', async () => {
    const res = await client.get(`/api/v1/users/${userData.phoneNumber}`);
    expect(res.statusCode).toBe(200);
  });
});

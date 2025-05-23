import request from 'supertest';
import app from '../app.js';

import testClient from './testClient.js';describe('User Profile API', () => {
  const userData = {
    phoneNumber: '9876543210',
    name: 'Test User',
    gender: 'Male'
  };

  it('should fail to create user if required fields are missing', async () => {
    const res = await testClient().post('/api/v1/users').send({});
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('should create a new user profile', async () => {
    const res = await testClient().post('/api/v1/users').send(userData);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  it('should update the user profile', async () => {
    const updatedData = { ...userData, name: 'Updated Name' };
    const res = await testClient().put(`/api/v1/users/${userData.phoneNumber}`).send(updatedData);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  it('should fetch user profile by phone', async () => {
    const res = await testClient().get(`/api/v1/users/${userData.phoneNumber}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('data');
  });
});

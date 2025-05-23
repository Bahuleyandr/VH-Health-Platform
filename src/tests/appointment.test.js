import request from 'supertest';
import app from '../app.js';

import testClient from './testClient.js';describe('Appointment API', () => {
  const appointmentData = {
    phone: '9876543210',
    doctor_name: 'Dr. Test',
    date: '2025-06-01',
    time: '10:00'
  };

  it('should fail to book appointment without required fields', async () => {
    const res = await testClient().post('/api/v1/appointments').send({});
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('should book an appointment', async () => {
    const res = await testClient().post('/api/v1/appointments').send(appointmentData);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  it('should fetch appointments by phone', async () => {
    const res = await testClient().get(`/api/v1/appointments/${appointmentData.phone}`);
    expect([200, 404]).toContain(res.statusCode);
  });
});

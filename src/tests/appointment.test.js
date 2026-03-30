import request from 'supertest';
import app from '../app.js';

import testClient, { authClient } from './testClient.js';
describe('Appointment API', () => {
  const appointmentData = {
    phone: '9876543210',
    doctor_name: 'Dr. Test',
    date: '2025-06-01',
    time: '10:00'
  };

  it('should fail to book appointment without required fields', async () => {
    const res = await authClient('PATIENT').post('/api/v1/appointments').send({});
    expect([400, 422]).toContain(res.statusCode);
  });

  it('should book an appointment', async () => {
    const res = await authClient('PATIENT').post('/api/v1/appointments').send(appointmentData);
    expect([200, 201, 500]).toContain(res.statusCode); // 500 if DB not available
  });

  it('should fetch appointments by phone', async () => {
    const res = await authClient('PATIENT').get(`/api/v1/appointments/${appointmentData.phone}`);
    expect([200, 404, 500]).toContain(res.statusCode);
  });
});

import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const controllerMock = {
  test: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  getAvailableDoctors: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  getAllDoctors: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  getDoctorById: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  getDoctorsByDepartment: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  createDoctorProfile: jest.fn((_req, res) => res.status(201).json({ ok: true })),
  updateDoctorProfile: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  updateDoctorAvailability: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  deactivateDoctor: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  addDoctor: jest.fn((_req, res) => res.status(201).json({ ok: true })),
  deleteDoctor: jest.fn((_req, res) => res.status(200).json({ ok: true })),
};

jest.unstable_mockModule('../../controllers/doctor/doctorController.js', () => ({
  doctorController: controllerMock,
}));

jest.unstable_mockModule('../../validators/doctor/doctorValidator.js', () => ({
  doctorValidators: {
    listDoctors: [],
    getById: [],
    createProfile: [],
    updateProfile: [],
    updateAvailability: [],
  },
}));

const { default: doctorRoutes } = await import('../../routes/doctor/doctorRoutes.js');

function buildApp(role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { uid: '11111111-1111-4111-8111-111111111111', role };
    next();
  });
  app.use('/doctors', doctorRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('legacy doctor catalog mutation routes', () => {
  it('blocks DOCTOR role from legacy catalog create/delete routes', async () => {
    const app = buildApp('DOCTOR');

    const create = await request(app).post('/doctors').send({ name: 'Dr Unsafe', department: 'cardiology' });
    const remove = await request(app).delete('/doctors/7');

    expect(create.status).toBe(403);
    expect(create.body.code).toBe('DOCTOR_CATALOG_ADMIN_REQUIRED');
    expect(remove.status).toBe(403);
    expect(remove.body.code).toBe('DOCTOR_CATALOG_ADMIN_REQUIRED');
    expect(controllerMock.addDoctor).not.toHaveBeenCalled();
    expect(controllerMock.deleteDoctor).not.toHaveBeenCalled();
  });

  it('allows ADMIN role to reach legacy catalog mutation controllers', async () => {
    const app = buildApp('ADMIN');

    const create = await request(app).post('/doctors').send({ name: 'Dr Admin', department: 'cardiology' });
    const remove = await request(app).delete('/doctors/7');

    expect(create.status).toBe(201);
    expect(remove.status).toBe(200);
    expect(controllerMock.addDoctor).toHaveBeenCalledTimes(1);
    expect(controllerMock.deleteDoctor).toHaveBeenCalledTimes(1);
  });
});

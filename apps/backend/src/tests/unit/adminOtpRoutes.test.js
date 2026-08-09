import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const controllerMock = {
  getAnalytics: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  getSecurityAlerts: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  getActiveSessions: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  getOtpLogs: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  getOtpStatus: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  revokeOtp: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  cleanupLogs: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  updateConfiguration: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  forceSendOtp: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  bulkDeleteSessions: jest.fn((_req, res) => res.status(200).json({ ok: true })),
};

jest.unstable_mockModule('../../controllers/auth/adminOtpController.js', () => controllerMock);

jest.unstable_mockModule('../../middleware/jwtMiddleware.js', () => ({
  default: (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (auth === 'Bearer patient-token') {
      req.user = { uid: 'patient-uid', role: 'PATIENT', rawRole: 'PATIENT', scope: 'full' };
      return next();
    }
    if (auth === 'Bearer admin-token') {
      req.user = { uid: 'admin-uid', role: 'ADMIN', rawRole: 'ADMIN', scope: 'full' };
      return next();
    }
    return res.status(401).json({ success: false, error: 'Authorization header missing or invalid' });
  },
  enforceFullScope: (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const { default: adminOtpRoutes } = await import('../../routes/auth/adminOtpRoutes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin/otp', adminOtpRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('admin OTP route protections', () => {
  it('rejects an unauthenticated GET (401, not silently open)', async () => {
    const res = await request(buildApp()).get('/admin/otp/security-alerts');
    expect(res.statusCode).toBe(401);
    expect(controllerMock.getSecurityAlerts).not.toHaveBeenCalled();
  });

  it('rejects a non-admin JWT with 403 (proves req.user really is checked, not just absent)', async () => {
    const res = await request(buildApp())
      .get('/admin/otp/security-alerts')
      .set('Authorization', 'Bearer patient-token');
    expect(res.statusCode).toBe(403);
    expect(controllerMock.getSecurityAlerts).not.toHaveBeenCalled();
  });

  it('reaches the controller for a valid admin JWT (GET)', async () => {
    const res = await request(buildApp())
      .get('/admin/otp/security-alerts')
      .set('Authorization', 'Bearer admin-token');
    expect(res.statusCode).toBe(200);
    expect(controllerMock.getSecurityAlerts).toHaveBeenCalledTimes(1);
  });

  it('reaches the controller for a valid admin JWT (POST past its validators)', async () => {
    const res = await request(buildApp())
      .post('/admin/otp/cleanup-logs')
      .set('Authorization', 'Bearer admin-token')
      .send({ olderThanDays: 30 });
    expect(res.statusCode).toBe(200);
    expect(controllerMock.cleanupLogs).toHaveBeenCalledTimes(1);
  });

  it('rejects the same POST without auth (401, not a validator 400)', async () => {
    const res = await request(buildApp())
      .post('/admin/otp/cleanup-logs')
      .send({ olderThanDays: 30 });
    expect(res.statusCode).toBe(401);
    expect(controllerMock.cleanupLogs).not.toHaveBeenCalled();
  });
});

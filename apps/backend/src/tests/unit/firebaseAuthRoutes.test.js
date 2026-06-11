import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const controllerMock = {
  firebaseLogin: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  registerUser: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  completeProfile: jest.fn((req, res) => res.status(200).json({ phone: req.body.phone })),
  linkAccount: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  updateFcmToken: jest.fn((req, res) => res.status(200).json({ phone: req.body.phone })),
  revokeSession: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  verifyToken: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  getHealthStatus: jest.fn((_req, res) => res.status(200).json({ ok: true })),
  testRoute: jest.fn((_req, res) => res.status(200).json({ ok: true })),
};

jest.unstable_mockModule('../../controllers/auth/firebaseAuthController.js', () => controllerMock);

jest.unstable_mockModule('../../middleware/jwtMiddleware.js', () => ({
  default: (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (auth === 'Bearer patient-token') {
      req.user = {
        uid: '550e8400-e29b-41d4-a716-446655440001',
        role: 'PATIENT',
        rawRole: 'PATIENT',
        phone: '9876543210',
        scope: 'full',
      };
      return next();
    }
    if (auth === 'Bearer admin-token') {
      req.user = {
        uid: '550e8400-e29b-41d4-a716-446655440002',
        role: 'ADMIN',
        rawRole: 'ADMIN',
        phone: '9876543210',
        scope: 'full',
      };
      return next();
    }
    return res.status(401).json({
      success: false,
      error: 'Authorization header missing or invalid',
    });
  },
  enforceFullScope: (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const { default: firebaseAuthRoutes } = await import('../../routes/auth/firebaseAuthRoutes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/firebase', firebaseAuthRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('firebase auth route protections', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalLegacyRegister = process.env.ENABLE_LEGACY_FIREBASE_REGISTER;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalLegacyRegister === undefined) {
      delete process.env.ENABLE_LEGACY_FIREBASE_REGISTER;
    } else {
      process.env.ENABLE_LEGACY_FIREBASE_REGISTER = originalLegacyRegister;
    }
  });

  it('fails closed for legacy Firebase registration by default', async () => {
    delete process.env.ENABLE_LEGACY_FIREBASE_REGISTER;

    const res = await request(buildApp())
      .post('/firebase/register')
      .send({
        phone: '+919876543210',
        name: 'Patient One',
      });

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('FIREBASE_LEGACY_REGISTER_DISABLED');
    expect(controllerMock.registerUser).not.toHaveBeenCalled();
  });

  it('keeps legacy Firebase registration disabled in production even if the compatibility flag is set', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ENABLE_LEGACY_FIREBASE_REGISTER = 'true';

    const res = await request(buildApp())
      .post('/firebase/register')
      .send({
        phone: '+919876543210',
        name: 'Patient One',
      });

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('FIREBASE_LEGACY_REGISTER_DISABLED');
    expect(controllerMock.registerUser).not.toHaveBeenCalled();
  });

  it('allows legacy Firebase registration only when explicitly enabled outside production', async () => {
    process.env.NODE_ENV = 'test';
    process.env.ENABLE_LEGACY_FIREBASE_REGISTER = 'true';

    const res = await request(buildApp())
      .post('/firebase/register')
      .send({
        phone: '+919876543210',
        name: 'Patient One',
      });

    expect(res.statusCode).toBe(200);
    expect(controllerMock.registerUser).toHaveBeenCalledTimes(1);
  });

  it('requires a local JWT before mutating profile data', async () => {
    const res = await request(buildApp())
      .post('/firebase/complete-profile')
      .send({
        phone: '+919876543210',
        name: 'Patient One',
        gender: 'OTHER',
      });

    expect(res.statusCode).toBe(401);
    expect(controllerMock.completeProfile).not.toHaveBeenCalled();
  });

  it('rejects FCM token updates for a phone outside the JWT', async () => {
    const res = await request(buildApp())
      .post('/firebase/update-fcm-token')
      .set('Authorization', 'Bearer patient-token')
      .send({
        phone: '+919876543211',
        fcmToken: 'test-fcm-token',
        deviceId: 'device-a',
      });

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('FIREBASE_PHONE_MISMATCH');
    expect(controllerMock.updateFcmToken).not.toHaveBeenCalled();
  });

  it('normalizes the bound JWT phone before FCM token updates reach the controller', async () => {
    const res = await request(buildApp())
      .post('/firebase/update-fcm-token')
      .set('Authorization', 'Bearer patient-token')
      .send({
        phone: '+919876543210',
        fcmToken: 'test-fcm-token',
        deviceId: 'device-a',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.phone).toBe('+919876543210');
  });

  it('keeps Firebase session revocation admin-only', async () => {
    const patientRes = await request(buildApp())
      .post('/firebase/revoke-session')
      .set('Authorization', 'Bearer patient-token')
      .send({ firebaseUid: 'victim-firebase-uid' });

    expect(patientRes.statusCode).toBe(403);
    expect(controllerMock.revokeSession).not.toHaveBeenCalled();

    const adminRes = await request(buildApp())
      .post('/firebase/revoke-session')
      .set('Authorization', 'Bearer admin-token')
      .send({ firebaseUid: 'managed-firebase-uid' });

    expect(adminRes.statusCode).toBe(200);
    expect(controllerMock.revokeSession).toHaveBeenCalledTimes(1);
  });
});

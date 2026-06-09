import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

let deviceTypeUnderTest = 'mobile';

const noop = (_req, _res, next) => next();
const checkInMock = jest.fn((_req, res) => res.status(200).json({ success: true, action: 'check-in' }));
const checkOutMock = jest.fn((_req, res) => res.status(200).json({ success: true, action: 'check-out' }));
const updateProfileMock = jest.fn((_req, res) => res.status(200).json({ success: true, action: 'update-profile' }));
const changePasswordMock = jest.fn((_req, res) => res.status(200).json({ success: true, action: 'change-password' }));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

jest.unstable_mockModule('../../middleware/auditLogger.js', () => ({
  auditLogger: noop,
}));

jest.unstable_mockModule('../../middleware/identityValidator.js', () => ({
  validateUID: noop,
  validatePhone: noop,
}));

jest.unstable_mockModule('../../middleware/rateLimitMiddleware.js', () => ({
  authRateLimiter: noop,
  dynamicRoleRateLimiter: noop,
  getRateLimiter: () => noop,
}));

jest.unstable_mockModule('../../middleware/rbacMiddleware.js', () => ({
  default: () => noop,
}));

jest.unstable_mockModule('../../middleware/jwtMiddleware.js', () => ({
  default: (req, _res, next) => {
    req.user = {
      uid: '11111111-1111-4111-8111-111111111111',
      role: 'NURSING_STAFF',
      deviceType: deviceTypeUnderTest,
    };
    next();
  },
}));

jest.unstable_mockModule('../../controllers/auth/staffAuthController.js', () => ({
  login: jest.fn(),
  pinLogin: jest.fn(),
  registerDevice: jest.fn(),
  quickLogin: jest.fn(),
  verifyDevice: jest.fn(),
  getHealthStatus: jest.fn(),
  setupPin: jest.fn(),
  toggleBiometric: jest.fn(),
  checkIn: checkInMock,
  checkOut: checkOutMock,
  logout: jest.fn(),
  getProfile: jest.fn(),
  updateProfile: updateProfileMock,
  changePassword: changePasswordMock,
  getDevices: jest.fn(),
  getTodayAttendance: jest.fn(),
  getAttendanceHistory: jest.fn(),
  removeDevice: jest.fn(),
}));

const router = (await import('../../routes/auth/staffAuthRoutes.js')).default;

function makeApp(deviceType) {
  deviceTypeUnderTest = deviceType;
  const app = express();
  app.use(express.json());
  app.use('/auth/staff', router);
  return app;
}

const attendanceBody = {
  location: {
    latitude: 12.9716,
    longitude: 77.5946,
  },
};

beforeEach(() => {
  checkInMock.mockClear();
  checkOutMock.mockClear();
  updateProfileMock.mockClear();
  changePasswordMock.mockClear();
});

describe('staff auth attendance device gate', () => {
  it('allows the legacy check-in route from a phone/mobile JWT', async () => {
    const app = makeApp('mobile');

    const res = await request(app)
      .post('/auth/staff/check-in')
      .send(attendanceBody);

    expect(res.statusCode).toBe(200);
    expect(checkInMock).toHaveBeenCalledTimes(1);
  });

  it.each(['tablet', 'desktop', 'web'])(
    'rejects legacy check-in from %s JWTs',
    async (deviceType) => {
      const app = makeApp(deviceType);

      const res = await request(app)
        .post('/auth/staff/check-in')
        .send(attendanceBody);

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual(expect.objectContaining({
        success: false,
        code: 'DEVICE_TYPE_FORBIDDEN',
        got: deviceType,
      }));
      expect(res.body.allowed).toEqual(['mobile']);
      expect(checkInMock).not.toHaveBeenCalled();
    },
  );

  it('rejects legacy check-out from tablet JWTs', async () => {
    const app = makeApp('tablet');

    const res = await request(app)
      .post('/auth/staff/check-out')
      .send(attendanceBody);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({
      success: false,
      code: 'DEVICE_TYPE_FORBIDDEN',
      got: 'tablet',
    }));
    expect(checkOutMock).not.toHaveBeenCalled();
  });

  it('wires the authenticated self-service profile update route', async () => {
    const app = makeApp('desktop');

    const res = await request(app)
      .patch('/auth/staff/profile')
      .send({ name: 'Test Staff Updated' });

    expect(res.statusCode).toBe(200);
    expect(updateProfileMock).toHaveBeenCalledTimes(1);
  });

  it('wires the authenticated self-service password change route', async () => {
    const app = makeApp('desktop');

    const res = await request(app)
      .post('/auth/staff/change-password')
      .send({
        currentPassword: 'OldStrong1!',
        newPassword: 'NewStrong1!',
      });

    expect(res.statusCode).toBe(200);
    expect(changePasswordMock).toHaveBeenCalledTimes(1);
  });
});

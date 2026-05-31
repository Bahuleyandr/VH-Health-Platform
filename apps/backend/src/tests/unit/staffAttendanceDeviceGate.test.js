import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

let deviceTypeUnderTest = 'mobile';

const noop = (_req, _res, next) => next();
const markAttendanceMock = jest.fn((_req, res) => res.status(200).json({
  success: true,
  action: 'attendance',
}));
const startBreakMock = jest.fn((_req, res) => res.status(200).json({
  success: true,
  action: 'break-start',
}));
const endBreakMock = jest.fn((_req, res) => res.status(200).json({
  success: true,
  action: 'break-end',
}));

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

jest.unstable_mockModule('../../controllers/staff/attendanceController.js', () => ({
  markAttendance: markAttendanceMock,
  getStaffAttendance: jest.fn(),
  getMyAttendance: jest.fn(),
  getAttendanceCalendar: jest.fn(),
  requestRegularization: jest.fn(),
  requestMyRegularization: jest.fn(),
  startBreak: startBreakMock,
  endBreak: endBreakMock,
  getTodayBreaks: jest.fn(),
  submitDispute: jest.fn(),
  submitMyDispute: jest.fn(),
  getMyDisputes: jest.fn(),
  getPendingDisputes: jest.fn(),
  resolveDispute: jest.fn(),
  getGeofenceBreaches: jest.fn(),
}));

const router = (await import('../../routes/staff/attendanceRoutes.js')).default;

function makeApp(deviceType) {
  deviceTypeUnderTest = deviceType;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      uid: '11111111-1111-4111-8111-111111111111',
      role: 'NURSING_STAFF',
      deviceType: deviceTypeUnderTest,
    };
    next();
  });
  app.use('/staff/attendance', router);
  return app;
}

const attendanceBody = {
  staff_id: 22,
  location: {
    latitude: 12.9716,
    longitude: 77.5946,
  },
};

beforeEach(() => {
  markAttendanceMock.mockClear();
  startBreakMock.mockClear();
  endBreakMock.mockClear();
});

describe('staff attendance device gate', () => {
  it('allows attendance marking from a phone/mobile JWT', async () => {
    const app = makeApp('mobile');

    const res = await request(app)
      .post('/staff/attendance')
      .send(attendanceBody);

    expect(res.statusCode).toBe(200);
    expect(markAttendanceMock).toHaveBeenCalledTimes(1);
  });

  it.each(['tablet', 'desktop', 'web'])(
    'rejects attendance marking from %s JWTs',
    async (deviceType) => {
      const app = makeApp(deviceType);

      const res = await request(app)
        .post('/staff/attendance')
        .send(attendanceBody);

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual(expect.objectContaining({
        success: false,
        code: 'DEVICE_TYPE_FORBIDDEN',
        got: deviceType,
      }));
      expect(res.body.allowed).toEqual(['mobile']);
      expect(markAttendanceMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['tablet', '/staff/attendance/22/break/start', startBreakMock],
    ['desktop', '/staff/attendance/22/break/start', startBreakMock],
    ['web', '/staff/attendance/22/break/start', startBreakMock],
    ['tablet', '/staff/attendance/22/break/end', endBreakMock],
    ['desktop', '/staff/attendance/22/break/end', endBreakMock],
    ['web', '/staff/attendance/22/break/end', endBreakMock],
  ])('rejects break action %s on %s', async (deviceType, path, handlerMock) => {
    const app = makeApp(deviceType);

    const res = await request(app)
      .post(path)
      .send({});

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({
      success: false,
      code: 'DEVICE_TYPE_FORBIDDEN',
      got: deviceType,
    }));
    expect(res.body.allowed).toEqual(['mobile']);
    expect(handlerMock).not.toHaveBeenCalled();
  });

  it('rejects old JWTs with no deviceType claim before the controller runs', async () => {
    const app = makeApp(undefined);

    const res = await request(app)
      .post('/staff/attendance')
      .send(attendanceBody);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({
      success: false,
      code: 'DEVICE_TYPE_MISSING',
    }));
    expect(res.body.allowed).toEqual(['mobile']);
    expect(markAttendanceMock).not.toHaveBeenCalled();
  });
});

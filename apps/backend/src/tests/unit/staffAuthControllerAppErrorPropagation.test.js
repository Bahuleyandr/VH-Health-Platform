import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of
// staffAuthController.js (updateProfile + changePassword catches — the only
// two sites in the file that relayed err.message/err.statusCode). Driven over
// HTTP through the real staffAuthRoutes module, mirroring
// paediatricImmunisationRoutesAppErrorPropagation.test.js.
//
// Security-sensitive surface: the message/status relay must stay
// byte-identical to the pre-port behaviour — the code lift is the ONLY
// addition. The bare-statusCode case below pins that.

const updateOwnProfileMock = jest.fn();
const changeOwnPasswordMock = jest.fn();

jest.unstable_mockModule('../../services/auth/staffAuthService.js', () => ({
  StaffAuthService: {
    updateOwnProfile: updateOwnProfileMock,
    changeOwnPassword: changeOwnPasswordMock,
  },
}));
jest.unstable_mockModule('../../services/staff/staffService.js', () => ({
  getStaffProfile: jest.fn(async () => null),
}));

// Route-wrapper / middleware shims: register the route map verbatim without
// RBAC-config, rate-limit, or audit plumbing.
const registerRoutes = (router, routeMap) => {
  for (const [method, routes] of Object.entries(routeMap)) {
    for (const [path, ...handlers] of routes) {
      router[method](path, ...handlers.flat(Infinity));
    }
  }
};
jest.unstable_mockModule('../../config/routeWrapper.js', () => ({
  wrapAsync: (fn) => fn,
  wrapRoutesWithValidation: (router, _roles, routeMap) => registerRoutes(router, routeMap),
  wrapAutoRBAC: (router, _key, routeMap) => registerRoutes(router, routeMap),
}));
jest.unstable_mockModule('../../middleware/jwtMiddleware.js', () => ({
  default: (req, _res, next) => {
    req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
    next();
  },
}));
const passThrough = (_req, _res, next) => next();
jest.unstable_mockModule('../../middleware/rateLimitMiddleware.js', () => ({
  authRateLimiter: passThrough,
}));
jest.unstable_mockModule('../../middleware/requireDeviceTypeMiddleware.js', () => ({
  requireDeviceType: () => passThrough,
}));
jest.unstable_mockModule('../../validators/passwordValidator.js', () => ({
  passwordComplexityMiddleware: passThrough,
}));
jest.unstable_mockModule('../../validators/auth/adminAuthValidator.js', () => ({
  staffPinLoginValidator: [],
}));
jest.unstable_mockModule('../../validators/auth/authValidator.js', () => ({
  staffPasswordLoginValidator: [],
  deviceRegistrationValidator: [],
  pinSetupValidator: [],
  quickLoginValidator: [],
  attendanceValidator: [],
}));

const { default: staffAuthRoutes } = await import('../../routes/auth/staffAuthRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  next();
});
app.use('/api/v1/auth/staff', staffAuthRoutes);

beforeEach(() => {
  updateOwnProfileMock.mockReset();
  changeOwnPasswordMock.mockReset();
});

describe('staffAuthController relays AppError code + details over HTTP', () => {
  test('updateProfile relays an AppError with code and details (409)', async () => {
    updateOwnProfileMock.mockRejectedValueOnce(AppError.conflict(
      'Display name is already in use',
      'SOME_CODE',
      { reason: 'x' },
    ));

    const response = await request(app)
      .patch('/api/v1/auth/staff/profile')
      .send({ name: 'Test User' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Display name is already in use');
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
  });

  test('updateProfile returns the generic 500 for a non-AppError and never leaks err.message', async () => {
    updateOwnProfileMock.mockRejectedValueOnce(
      new Error('users_name_check constraint violated on shard 3'),
    );

    const response = await request(app)
      .patch('/api/v1/auth/staff/profile')
      .send({ name: 'Test User' });

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to update profile');
    expect(response.body.message).not.toMatch(/shard 3/);
  });

  test('changePassword relays a bare statusCode error byte-identically (code lift is the only addition)', async () => {
    changeOwnPasswordMock.mockRejectedValueOnce(Object.assign(
      new Error('Current password is incorrect'),
      { statusCode: 401 },
    ));

    const response = await request(app)
      .post('/api/v1/auth/staff/change-password')
      .send({ currentPassword: 'old-secret', newPassword: 'new-secret' });

    expect(response.statusCode).toBe(401);
    expect(response.body.message).toBe('Current password is incorrect');
    expect(response.body).not.toHaveProperty('code');
    expect(response.body).not.toHaveProperty('details');
  });

  test('changePassword relays an AppError with code and details', async () => {
    changeOwnPasswordMock.mockRejectedValueOnce(new AppError(
      'New password was used recently',
      400,
      'PASSWORD_HISTORY_REUSE',
      { history_window: 5 },
    ));

    const response = await request(app)
      .post('/api/v1/auth/staff/change-password')
      .send({ currentPassword: 'old-secret', newPassword: 'new-secret' });

    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe('PASSWORD_HISTORY_REUSE');
    expect(response.body.details).toEqual({ history_window: 5 });
  });

  test('changePassword returns the generic 500 for a non-AppError and never leaks err.message', async () => {
    changeOwnPasswordMock.mockRejectedValueOnce(new Error('bcrypt native binding missing'));

    const response = await request(app)
      .post('/api/v1/auth/staff/change-password')
      .send({ currentPassword: 'old-secret', newPassword: 'new-secret' });

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to change password');
    expect(response.body.message).not.toMatch(/bcrypt/);
  });
});

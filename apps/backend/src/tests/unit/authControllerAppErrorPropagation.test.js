import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// HTTP-level regression for authController.js's logout catch block (audit F10,
// 2026-08-09 VH Health full audit). Before the fix, ANY error out of
// AuthService.logout — including a revocation-store write failure — was
// swallowed and reported to the client as "Logged out successfully. Please
// discard your token.", even though the JWT (patient tokens live 7 days) was
// never actually revoked. Mirrors staffAuthControllerAppErrorPropagation.test.js.

const logoutMock = jest.fn();

jest.unstable_mockModule('../../services/auth/authService.js', () => ({
  AuthService: {
    logout: logoutMock,
    requestOtp: jest.fn(),
    verifyOtpAndAuthenticate: jest.fn(),
    refreshToken: jest.fn(),
    getHealthStatus: jest.fn(),
    getPublicStats: jest.fn(),
    login: jest.fn(),
    register: jest.fn(),
  },
}));

jest.unstable_mockModule('../../validators/auth/authValidator.js', () => ({
  phoneValidator: [],
  phoneOtpValidator: [],
}));

const passThrough = (_req, _res, next) => next();
jest.unstable_mockModule('../../middleware/rateLimitMiddleware.js', () => ({
  otpRateLimiter: passThrough,
  authRateLimiter: passThrough,
}));

// Route-wrapper shim: register the route map verbatim without RBAC-config,
// rate-limit, or audit plumbing (mirrors the staffAuthController template).
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

const { default: authRoutes } = await import('../../routes/auth/authRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  next();
});
app.use('/api/v1/auth', authRoutes);

beforeEach(() => {
  logoutMock.mockReset();
});

describe('authController.logout is honest about revocation failures (audit F10)', () => {
  test('happy path: AuthService.logout resolves ⇒ 200 success envelope', async () => {
    logoutMock.mockResolvedValueOnce({ phone: '+919998887776' });

    const response = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', 'Bearer sometoken');

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.phone).toBe('+919998887776');
  });

  test('AuthService.logout rejects (e.g. revocation store unavailable) ⇒ 500 error, never a fake success', async () => {
    logoutMock.mockRejectedValueOnce(
      Object.assign(new Error('No token revocation store accepted the blacklist entry'), {
        code: 'REVOCATION_WRITE_UNAVAILABLE',
      }),
    );

    const response = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', 'Bearer sometoken');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).not.toMatch(/logged out successfully/i);
  });

  test('a bare-statusCode error is relayed with that status, still no fake success', async () => {
    logoutMock.mockRejectedValueOnce(Object.assign(new Error('revocation store down'), { statusCode: 503 }));

    const response = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', 'Bearer sometoken');

    expect(response.statusCode).toBe(503);
    expect(response.body.success).toBe(false);
  });

  test('no Authorization header ⇒ still 200 success (nothing to revoke, matches happy path)', async () => {
    const response = await request(app).post('/api/v1/auth/logout');

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(logoutMock).not.toHaveBeenCalled();
  });
});

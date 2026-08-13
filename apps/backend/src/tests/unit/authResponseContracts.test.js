import { jest } from '@jest/globals';

const mockAdminLogin = jest.fn();
const mockRequestOtp = jest.fn();
const mockVerifyOtpAndAuthenticate = jest.fn();
const mockLegacyLogin = jest.fn();
const mockLegacyRegister = jest.fn();
const mockValidationResult = jest.fn(() => ({
  array: () => [],
  isEmpty: () => true,
}));

const mockAuthenticateStaff = jest.fn();
const mockAuthenticateStaffWithPin = jest.fn();
const mockRefreshStaffSession = jest.fn();
const mockRevokeAllSessions = jest.fn();

const mockAuthenticateWithFirebase = jest.fn();
const mockVerifyTokenStatus = jest.fn();

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
}));

jest.unstable_mockModule('bcrypt', () => ({
  default: {
    compare: jest.fn(),
    hash: jest.fn(),
  },
}));

jest.unstable_mockModule('express-validator', () => ({
  validationResult: mockValidationResult,
}));

jest.unstable_mockModule('../../config/securityConfig.js', () => ({
  SECURITY_CONFIG: {
    admin: { maxFailedAttempts: 5, lockoutDurationMinutes: 15 },
    jwt: { adminAccessExpiry: '15m', staffAccessExpiry: '15m' },
  },
}));

jest.unstable_mockModule('../../services/auth/authService.js', () => ({
  AuthService: {
    adminLogin: mockAdminLogin,
    requestOtp: mockRequestOtp,
    verifyOtpAndAuthenticate: mockVerifyOtpAndAuthenticate,
    legacyLogin: mockLegacyLogin,
    legacyRegister: mockLegacyRegister,
  },
}));

jest.unstable_mockModule('../../services/auth/staffAuthService.js', () => ({
  StaffAuthService: {
    authenticateStaff: mockAuthenticateStaff,
    authenticateStaffWithPin: mockAuthenticateStaffWithPin,
    refreshStaffSession: mockRefreshStaffSession,
    revokeAllSessions: mockRevokeAllSessions,
  },
}));

jest.unstable_mockModule('../../services/auth/firebaseAuthService.js', () => ({
  authenticateWithFirebase: mockAuthenticateWithFirebase,
  completeUserProfile: jest.fn(),
  getHealthStatus: jest.fn(),
  linkFirebaseAccount: jest.fn(),
  revokeFirebaseSession: jest.fn(),
  updateFcmToken: jest.fn(),
  verifyTokenStatus: mockVerifyTokenStatus,
}));

jest.unstable_mockModule('../../services/auth/loginSessionHelper.js', () => ({
  generateRefreshToken: jest.fn(),
  issueAccessTokenAndClaimSession: jest.fn(),
  resolveTenantIdForUid: jest.fn(),
}));

jest.unstable_mockModule('../../services/staff/staffService.js', () => ({
  getStaffProfile: jest.fn(),
}));

jest.unstable_mockModule('../../utils/dateUtils.js', () => ({
  formatDateDDMMYYYY: jest.fn((value) => value),
}));

jest.unstable_mockModule('../../utils/listQuery.js', () => ({
  parseListQuery: jest.fn(),
}));

jest.unstable_mockModule('../../utils/totpUtils.js', () => ({
  generateBackupCodes: jest.fn(),
  generateTotpSetup: jest.fn(),
  verifyTotp: jest.fn(),
}));

const authController = await import('../../controllers/auth/authController.js');
const adminAuthController = await import('../../controllers/auth/adminAuthController.js');
const staffAuthController = await import('../../controllers/auth/staffAuthController.js');
const firebaseAuthController = await import('../../controllers/auth/firebaseAuthController.js');

function makeHttp({ body = {}, headers = {}, originalUrl = '/contract/auth' } = {}) {
  const req = {
    body,
    headers,
    ip: '127.0.0.1',
    originalUrl,
  };
  const res = {
    req,
    body: null,
    statusCode: null,
    json: jest.fn((payload) => {
      res.body = payload;
      return res;
    }),
    status: jest.fn((statusCode) => {
      res.statusCode = statusCode;
      return res;
    }),
  };

  return { req, res };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockValidationResult.mockReturnValue({
    array: () => [],
    isEmpty: () => true,
  });
});

describe('auth response contracts', () => {
  describe('admin login', () => {
    it('returns the current admin validation error envelope with top-level errors', async () => {
      const validationErrors = [{ msg: 'Password is required', path: 'password' }];
      mockValidationResult.mockReturnValueOnce({
        array: () => validationErrors,
        isEmpty: () => false,
      });
      const { req, res } = makeHttp({
        body: { username: 'root-admin' },
      });

      await adminAuthController.login(req, res);

      expect(mockAdminLogin).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        success: false,
        message: 'Validation failed',
        errors: validationErrors,
      });
    });

    it('returns the current admin login success envelope', async () => {
      const data = {
        token: 'admin-access-token',
        refreshToken: 'admin-refresh-token',
        admin: {
          uid: 'admin-uid',
          username: 'root-admin',
          email: 'root@example.test',
          role: 'ADMIN',
        },
      };
      mockAdminLogin.mockResolvedValue(data);
      const { req, res } = makeHttp({
        body: { username: 'root-admin', password: 'correct', deviceType: 'web' },
      });

      await adminAuthController.login(req, res);

      expect(mockAdminLogin).toHaveBeenCalledWith('root-admin', 'correct', req, { deviceType: 'web' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'Admin login successful',
        data,
      });
    });

    it('returns the current admin MFA challenge envelope', async () => {
      const data = {
        requiresTwoFactor: true,
        challengeToken: 'mfa-challenge-token',
        expiresAt: '2026-07-02T12:00:00.000Z',
        admin: {
          uid: 'admin-uid',
          username: 'root-admin',
        },
      };
      mockAdminLogin.mockResolvedValue(data);
      const { req, res } = makeHttp({
        body: { email: 'root@example.test', password: 'correct', deviceType: 'web' },
      });

      await adminAuthController.login(req, res);

      expect(mockAdminLogin).toHaveBeenCalledWith('root@example.test', 'correct', req, { deviceType: 'web' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'MFA challenge issued',
        data,
      });
    });

    it('returns the current admin MFA setup envelope', async () => {
      const data = {
        requiresMfaSetup: true,
        setupToken: 'mfa-setup-token',
        expiresIn: 600,
        admin: {
          uid: 'admin-uid',
          username: 'root-admin',
        },
      };
      mockAdminLogin.mockResolvedValue(data);
      const { req, res } = makeHttp({
        body: { username: 'root-admin', password: 'correct', deviceType: 'web' },
      });

      await adminAuthController.login(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'MFA setup required before full access',
        data,
      });
    });

    it('returns the current admin invalid credentials envelope', async () => {
      mockAdminLogin.mockRejectedValue(new Error('Invalid credentials'));
      const { req, res } = makeHttp({
        body: { username: 'root-admin', password: 'wrong', deviceType: 'web' },
      });

      await adminAuthController.login(req, res);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({
        success: false,
        message: 'Invalid username or password',
      });
    });
  });

  describe('admin force logout', () => {
    it('routes the integer users.id through StaffAuthService.revokeAllSessions', async () => {
      mockRevokeAllSessions.mockResolvedValue({ revokedCount: 3 });
      const { req, res } = makeHttp();
      req.params = { userId: '42' };
      req.user = { uid: 'admin-uid' };

      await adminAuthController.revokeAllSessions(req, res);

      expect(mockRevokeAllSessions).toHaveBeenCalledWith(42);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        data: { revokedCount: 3 },
      });
    });
  });

  describe('staff auth', () => {
    it('returns the current staff password login envelope', async () => {
      const data = {
        accessToken: 'staff-access-token',
        refreshToken: 'staff-refresh-token',
        staff: {
          id: 77,
          uid: 'staff-uid',
          employeeId: 'EMP-001',
          name: 'Nurse Contract',
          email: 'nurse@example.test',
          department: 'ICU',
          role: 'NURSE',
          position: 'Senior Nurse',
        },
      };
      mockAuthenticateStaff.mockResolvedValue(data);
      const { req, res } = makeHttp({
        body: {
          employeeId: 'EMP-001',
          password: 'correct',
          deviceType: 'mobile',
          installationId: '33333333-3333-4333-8333-333333333333',
        },
      });

      await staffAuthController.login(req, res);

      expect(mockAuthenticateStaff).toHaveBeenCalledWith(
        'EMP-001',
        'correct',
        req,
        {
          deviceType: 'mobile',
          installationId: '33333333-3333-4333-8333-333333333333',
        },
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'Staff login successful',
        data,
      });
    });

    it('returns the current staff PIN login envelope', async () => {
      const data = {
        accessToken: 'staff-pin-access-token',
        refreshToken: 'staff-pin-refresh-token',
        staff: {
          id: 77,
          uid: 'staff-uid',
          employeeId: 'EMP-001',
          name: 'Nurse Contract',
          email: 'nurse@example.test',
          department: 'ICU',
          role: 'NURSE',
          position: 'Senior Nurse',
        },
      };
      mockAuthenticateStaffWithPin.mockResolvedValue(data);
      const { req, res } = makeHttp({
        body: {
          employeeId: 'EMP-001',
          pin: '1234',
          deviceToken: 'registered-device',
          deviceType: 'mobile',
          installationId: '33333333-3333-4333-8333-333333333333',
        },
      });

      await staffAuthController.pinLogin(req, res);

      expect(mockAuthenticateStaffWithPin).toHaveBeenCalledWith(
        'EMP-001',
        '1234',
        req,
        {
          deviceType: 'mobile',
          deviceToken: 'registered-device',
          installationId: '33333333-3333-4333-8333-333333333333',
        },
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'Staff login with PIN successful',
        data,
      });
    });

    it('returns the current staff PIN unregistered-device error envelope', async () => {
      const err = new Error('PIN login requires a registered device');
      err.code = 'PIN_DEVICE_NOT_REGISTERED';
      err.statusCode = 403;
      mockAuthenticateStaffWithPin.mockRejectedValue(err);
      const { req, res } = makeHttp({
        body: {
          employeeId: 'EMP-001',
          pin: '1234',
          deviceToken: 'unknown-device',
          deviceType: 'mobile',
          installationId: '33333333-3333-4333-8333-333333333333',
        },
      });

      await staffAuthController.pinLogin(req, res);

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({
        success: false,
        message: 'PIN login requires a registered device',
        code: 'PIN_DEVICE_NOT_REGISTERED',
      });
    });

    it('returns the current staff refresh success envelope', async () => {
      const data = {
        accessToken: 'rotated-staff-access-token',
        staff: {
          id: 77,
          uid: 'staff-uid',
          employeeId: 'EMP-001',
          name: 'Nurse Contract',
          email: 'nurse@example.test',
          department: 'ICU',
          role: 'NURSE',
          position: 'Senior Nurse',
        },
      };
      mockRefreshStaffSession.mockResolvedValue(data);
      const { req, res } = makeHttp({
        body: {
          refreshToken: 'staff-refresh-token',
          deviceToken: 'registered-device',
          installationId: '33333333-3333-4333-8333-333333333333',
        },
      });

      await staffAuthController.refreshSession(req, res);

      expect(mockRefreshStaffSession).toHaveBeenCalledWith(
        'staff-refresh-token',
        'registered-device',
        '33333333-3333-4333-8333-333333333333',
        req,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'Session refreshed successfully',
        data,
      });
    });

    it('returns the current staff refresh failure envelope', async () => {
      const err = new Error('Invalid or expired refresh token');
      err.statusCode = 401;
      mockRefreshStaffSession.mockRejectedValue(err);
      const { req, res } = makeHttp({
        body: {
          refreshToken: 'expired-refresh-token',
          deviceToken: 'registered-device',
          installationId: '33333333-3333-4333-8333-333333333333',
        },
      });

      await staffAuthController.refreshSession(req, res);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({
        success: false,
        message: 'Failed to refresh session',
      });
    });
  });

  describe('firebase-login', () => {
    it('returns the current existing-user Firebase login envelope', async () => {
      const data = {
        accessToken: 'firebase-access-token',
        refreshToken: 'firebase-refresh-token',
        isNewUser: false,
        user: {
          uid: 'patient-uid',
          id: 501,
          phone: '+919000000001',
          name: 'Patient Contract',
          hospital_number: 'VH000501',
          email: 'patient@example.test',
          role: 'PATIENT',
          isNewUser: false,
          profileComplete: true,
          emailVerified: true,
        },
      };
      mockAuthenticateWithFirebase.mockResolvedValue(data);
      const { req, res } = makeHttp({
        body: {
          idToken: 'firebase-id-token',
          deviceInfo: { platform: 'android' },
          deviceType: 'mobile',
        },
      });

      await firebaseAuthController.firebaseLogin(req, res);

      expect(mockAuthenticateWithFirebase).toHaveBeenCalledWith(
        'firebase-id-token',
        { platform: 'android' },
        req,
        { deviceType: 'mobile' },
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'Login successful',
        data,
      });
    });

    it('returns the current new-user Firebase login envelope', async () => {
      const data = {
        accessToken: 'firebase-access-token',
        refreshToken: 'firebase-refresh-token',
        isNewUser: true,
        user: {
          uid: 'patient-uid',
          id: 501,
          phone: '+919000000001',
          name: null,
          hospital_number: null,
          email: 'patient@example.test',
          role: 'PATIENT',
          isNewUser: true,
          profileComplete: false,
          emailVerified: false,
        },
      };
      mockAuthenticateWithFirebase.mockResolvedValue(data);
      const { req, res } = makeHttp({
        body: { idToken: 'firebase-id-token', deviceInfo: null, deviceType: 'mobile' },
      });

      await firebaseAuthController.firebaseLogin(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'User registered successfully',
        data,
      });
    });

    it('returns the current expired-token Firebase error envelope', async () => {
      const err = new Error('expired');
      err.code = 'auth/id-token-expired';
      mockAuthenticateWithFirebase.mockRejectedValue(err);
      const { req, res } = makeHttp({
        body: { idToken: 'expired-token', deviceInfo: null, deviceType: 'mobile' },
      });

      await firebaseAuthController.firebaseLogin(req, res);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({
        success: false,
        message: 'Firebase token has expired',
      });
    });

    it('returns the current default Firebase error envelope', async () => {
      mockAuthenticateWithFirebase.mockRejectedValue(new Error('bad token'));
      const { req, res } = makeHttp({
        body: { idToken: 'bad-token', deviceInfo: null, deviceType: 'mobile' },
      });

      await firebaseAuthController.firebaseLogin(req, res);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({
        success: false,
        message: 'Invalid Firebase ID token',
      });
    });

    it('returns the current Firebase verify-token failure envelope with top-level valid flag', async () => {
      mockVerifyTokenStatus.mockRejectedValue(new Error('bad token'));
      const { req, res } = makeHttp({
        originalUrl: '/auth/firebase/verify-token',
      });
      req.query = { idToken: 'bad-token' };

      await firebaseAuthController.verifyToken(req, res);

      expect(mockVerifyTokenStatus).toHaveBeenCalledWith('bad-token');
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({
        success: false,
        message: 'Invalid or expired Firebase token',
        valid: false,
      });
    });
  });

  describe('OTP auth', () => {
    it('returns the current OTP request success envelope', async () => {
      const data = {
        phone: '+919000000001',
        purpose: 'login',
        expiresIn: 600,
        otpId: 'otp-session-id',
      };
      mockRequestOtp.mockResolvedValue(data);
      const { req, res } = makeHttp({
        body: { phone: '+919000000001', purpose: 'login' },
      });

      await authController.requestOtp(req, res);

      expect(mockRequestOtp).toHaveBeenCalledWith('+919000000001', 'login', req);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'OTP sent successfully',
        data,
      });
    });

    it('returns the current OTP request failure envelope', async () => {
      const err = new Error('too many attempts');
      err.statusCode = 429;
      mockRequestOtp.mockRejectedValue(err);
      const { req, res } = makeHttp({
        body: { phone: '+919000000001', purpose: 'login' },
      });

      await authController.requestOtp(req, res);

      expect(res.statusCode).toBe(429);
      expect(res.body).toEqual({
        success: false,
        message: 'Failed to send OTP',
      });
    });

    it('returns the current OTP verify existing-user success envelope', async () => {
      const data = {
        accessToken: 'patient-access-token',
        refreshToken: 'patient-refresh-token',
        isNewUser: false,
        user: {
          uid: 'patient-uid',
          phone: '+919000000001',
          name: 'Patient Contract',
          role: 'PATIENT',
        },
      };
      mockVerifyOtpAndAuthenticate.mockResolvedValue(data);
      const { req, res } = makeHttp({
        body: { phone: '+919000000001', otp: '123456', deviceType: 'mobile' },
      });

      await authController.verifyOtp(req, res);

      expect(mockVerifyOtpAndAuthenticate).toHaveBeenCalledWith(
        '+919000000001',
        '123456',
        req,
        { deviceType: 'mobile' },
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'Login successful',
        data,
      });
    });

    it('returns the current OTP verify new-user success envelope', async () => {
      const data = {
        accessToken: 'patient-access-token',
        refreshToken: 'patient-refresh-token',
        isNewUser: true,
        user: {
          uid: 'patient-uid',
          phone: '+919000000002',
          name: null,
          role: 'PATIENT',
        },
      };
      mockVerifyOtpAndAuthenticate.mockResolvedValue(data);
      const { req, res } = makeHttp({
        body: { phone: '+919000000002', otp: '123456' },
      });

      await authController.verifyOtp(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'User registered and logged in',
        data,
      });
    });

    it('returns the current OTP verify failure envelope', async () => {
      const err = new Error('invalid otp');
      err.statusCode = 401;
      mockVerifyOtpAndAuthenticate.mockRejectedValue(err);
      const { req, res } = makeHttp({
        body: { phone: '+919000000001', otp: '000000' },
      });

      await authController.verifyOtp(req, res);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({
        success: false,
        message: 'Authentication failed',
      });
    });

    it('threads request metadata and device type through legacy login', async () => {
      mockLegacyLogin.mockResolvedValue({ token: 'legacy-login-token' });
      const { req, res } = makeHttp({
        body: { phone: '+919000000003', deviceType: 'desktop' },
      });

      await authController.login(req, res);

      expect(mockLegacyLogin).toHaveBeenCalledWith(
        '+919000000003',
        req,
        { deviceType: 'desktop' },
      );
      expect(res.statusCode).toBe(200);
    });

    it('threads request metadata and device type through legacy registration', async () => {
      mockLegacyRegister.mockResolvedValue({ token: 'legacy-register-token' });
      const { req, res } = makeHttp({
        body: { phone: '+919000000004', deviceType: 'web' },
      });

      await authController.register(req, res);

      expect(mockLegacyRegister).toHaveBeenCalledWith(
        '+919000000004',
        req,
        { deviceType: 'web' },
      );
      expect(res.statusCode).toBe(200);
    });
  });
});

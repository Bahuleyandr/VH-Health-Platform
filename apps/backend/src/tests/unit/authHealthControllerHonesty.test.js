import { jest } from '@jest/globals';

const firebaseHealth = jest.fn();
const otpHealth = jest.fn();

jest.unstable_mockModule('../../services/auth/firebaseAuthService.js', () => ({
  getHealthStatus: firebaseHealth,
}));

jest.unstable_mockModule('../../services/auth/otpService.js', () => ({
  getHealthStatus: otpHealth,
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: jest.fn(),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const { getHealthStatus: getFirebaseHealthStatus } = await import('../../controllers/auth/firebaseAuthController.js');
const { getHealthStatus: getOtpHealthStatus } = await import('../../controllers/auth/otpController.js');

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

test.each([
  ['Firebase', firebaseHealth, getFirebaseHealthStatus],
  ['OTP', otpHealth, getOtpHealthStatus],
])('%s health reports degraded as HTTP 503 when its dependency fails', async (_name, healthMock, handler) => {
  healthMock.mockRejectedValueOnce(new Error('dependency unavailable'));
  const res = makeRes();

  await handler({}, res);

  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json.mock.calls[0][0]).toMatchObject({
    success: false,
    status: 'degraded',
  });
});

import { jest } from '@jest/globals';

jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: { $queryRawUnsafe: jest.fn() } }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const { syncBiometricData } = await import('../../controllers/staff/staffAdminAttendanceController.js');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    req: { id: 'req-1' },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('syncBiometricData', () => {
  it('honestly reports Not Implemented instead of a fake success with synced:0', async () => {
    const res = mockRes();

    await syncBiometricData({ user: { uid: 'staff-1' } }, res);

    expect(res.statusCode).toBe(501);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeUndefined();
  });
});

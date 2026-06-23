import { jest } from '@jest/globals';

// M18 (audit 2026-06-22): registerDevice (mounted at POST /legacy-register) called
// the success()/error() response helpers with a STRING as the first arg, but those
// helpers take `res` first and send the response themselves (res.status().json()).
// So res.status() threw and EVERY path 500'd. These tests pin the corrected
// envelope/status codes.

const queryRawUnsafeMock = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { registerDevice } = await import('../../controllers/deviceController.js');

function mockRes() {
  return {
    statusCode: null,
    body: null,
    req: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('registerDevice (M18 — response-helper misuse no longer 500s)', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    queryRawUnsafeMock.mockResolvedValue([]);
  });

  it('returns a 400 envelope (not 500) when phone/fcm_token are missing', async () => {
    const res = mockRes();
    await registerDevice({ body: {} }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ success: false });
    // No DB write attempted on the validation path.
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('returns a 200 success envelope on a valid registration', async () => {
    const res = mockRes();
    await registerDevice({ body: { phone: '+919876543210', fcm_token: 'tok', platform: 'android' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(res.body.message).toMatch(/registered/i);
    // Upsert + audit insert both attempted.
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
  });

  it('stamps the Host-resolved req.tenantId on the devices row (M8)', async () => {
    const TENANT = '00000000-0000-4000-8000-0000000000a3';
    const res = mockRes();
    await registerDevice(
      { body: { phone: '+9199', fcm_token: 'tok' }, tenantId: TENANT },
      res,
    );

    const devicesInsert = queryRawUnsafeMock.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO devices'),
    );
    expect(devicesInsert).toBeDefined();
    expect(devicesInsert[0]).toMatch(/tenant_id/);
    // tenant_id is the 4th positional param (after phone, fcm_token, platform).
    expect(devicesInsert[4]).toBe(TENANT);
  });

  it('returns a 500 envelope (cleanly) when the DB write throws', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('db down'));
    const res = mockRes();
    await registerDevice({ body: { phone: '+91999', fcm_token: 'tok' } }, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ success: false });
  });
});

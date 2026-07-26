import { jest } from '@jest/globals';

const setTenantTxMock = jest.fn();
const queryRawUnsafeMock = jest.fn();
const loggerErrorMock = jest.fn();

const tx = {
  $queryRawUnsafe: queryRawUnsafeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: jest.fn(),
  },
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: loggerErrorMock,
    warn: jest.fn(),
  },
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  getTenantById: jest.fn(),
  requireTenantId: tenantId => tenantId,
  resolveTenantOrThrow: req => req.tenantId,
}));

const { createLegacyAppointment } = await import(
  '../../controllers/appointment/appointmentLegacyController.js'
);

const TENANT_ID = '10000000-0000-4000-8000-000000000001';

function makeRequest() {
  return {
    id: 'request-id',
    originalUrl: '/api/v1/appointments',
    tenantId: TENANT_ID,
    user: { uid: '20000000-0000-4000-8000-000000000001', name: 'Front Desk' },
    body: {
      phone: '+919876543210',
      doctor_name: 'Dr Example',
      date: '2026-08-01',
      time: '10:30',
      department: 'General Medicine',
    },
  };
}

function makeResponse(req) {
  return {
    req,
    statusCode: null,
    body: null,
    status: jest.fn(function setStatus(statusCode) {
      this.statusCode = statusCode;
      return this;
    }),
    json: jest.fn(function sendJson(body) {
      this.body = body;
      return this;
    }),
  };
}

beforeEach(() => {
  setTenantTxMock.mockReset();
  queryRawUnsafeMock.mockReset();
  loggerErrorMock.mockReset();
  setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(tx));
});

test('ACTIVE mode rejects identity-less creation before INSERT', async () => {
  queryRawUnsafeMock.mockResolvedValueOnce([{ pathway_mode: 'active' }]);
  const req = makeRequest();
  const res = makeResponse(req);

  await createLegacyAppointment(req, res);

  expect(res.statusCode).toBe(409);
  expect(res.body).toMatchObject({
    success: false,
    code: 'APPOINTMENT_IDENTITIES_REQUIRED',
  });
  expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('FOR SHARE');
  expect(queryRawUnsafeMock.mock.calls[0][1]).toBe(TENANT_ID);
  expect(queryRawUnsafeMock.mock.calls[0][2]).toBe('op_contact_to_recovery');
  expect(loggerErrorMock).not.toHaveBeenCalled();
});

test.each(['off', 'shadow'])(
  '%s mode preserves the legacy appointment response',
  async (mode) => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ pathway_mode: mode }])
      .mockResolvedValueOnce([{
        id: 41,
        uid: '30000000-0000-4000-8000-000000000001',
        phone: '+919876543210',
        patient_name: null,
        doctor_name: 'Dr Example',
        appointment_date: new Date('2026-08-01T00:00:00.000Z'),
        appointment_time: '10:30',
        status: 'SCHEDULED',
        created_at: new Date('2026-07-23T10:00:00.000Z'),
        tenant_id: TENANT_ID,
      }]);
    const req = makeRequest();
    const res = makeResponse(req);

    await createLegacyAppointment(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        id: 41,
        doctor: 'Dr Example',
        department: 'General Medicine',
        booked_by: 'Front Desk',
      },
    });
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('INSERT INTO appointments');
    expect(queryRawUnsafeMock.mock.calls[1].slice(1)).toEqual([
      '+919876543210',
      'Dr Example',
      '2026-08-01',
      '10:30',
      TENANT_ID,
    ]);
  },
);

test('mode lookup failure creates no appointment and returns the legacy database error', async () => {
  queryRawUnsafeMock.mockRejectedValueOnce(new Error('settings unavailable'));
  const req = makeRequest();
  const res = makeResponse(req);

  await createLegacyAppointment(req, res);

  expect(res.statusCode).toBe(500);
  expect(res.body).toMatchObject({
    success: false,
    message: 'Database error',
  });
  expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  expect(loggerErrorMock).toHaveBeenCalledTimes(1);
});

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule('../../services/smsService.js', () => ({
  sendSMS: jest.fn(),
}));

jest.unstable_mockModule('../../utils/notifications/sendPushNotification.js', () => ({
  sendPushNotification: jest.fn(),
}));

jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  uploadFileToR2: jest.fn(),
  getSignedFileUrl: jest.fn(),
  deleteObject: jest.fn(),
}));

jest.unstable_mockModule('../../utils/phoneUtils.js', () => ({
  normalizePhone: (s) => s,
}));

jest.unstable_mockModule('../../controllers/delivery/deliveryTrackingController.js', () => ({
  calculateETA: jest.fn(),
}));

const { uploadResult } = await import(
  '../../controllers/investigation/bookingController.js'
);

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('bookingController.uploadResult — duplicate-result protection', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
  });

  it('rejects a re-upload when the booking already has RESULT_READY status', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 3,
      investigation_id: 21,
      patient_id: 99,
      patient_name: 'Test Patient',
      patient_phone: '9000000000',
      test_name: 'CBC',
      status: 'RESULT_READY',
      scheduled_date: null,
      phlebotomist_id: null,
      notes: null,
      created_at: new Date(),
      updated_at: new Date(),
    }]);

    const req = {
      params: { id: '3' },
      user: { id: 7, role: 'LAB_STAFF' },
      body: { result_notes: 'DUPLICATE UPLOAD TEST' },
      file: { buffer: Buffer.from('fake-pdf'), originalname: 'r.pdf', mimetype: 'application/pdf' },
    };
    const res = makeRes();

    await uploadResult(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    const body = res.json.mock.calls[0][0];
    expect(String(body?.message || body?.error || '')).toMatch(/amendment/i);

    // No subsequent SELECT/INSERT/UPDATE should have run.
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when no file is provided (existing contract preserved)', async () => {
    const req = {
      params: { id: '3' },
      user: { id: 7, role: 'LAB_STAFF' },
      body: { result_notes: 'x' },
      file: null,
    };
    const res = makeRes();

    await uploadResult(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });
});

// Ingest-screen behavior for the investigation-booking result upload
// (871-F1). Mocked at the TRANSPORT layer (virusScanner) so the REAL
// FILE_SCAN_POLICY decision is exercised end to end through the controller.

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const scanBufferVerdictMock = jest.fn();
const uploadFileToR2Mock = jest.fn();
const deleteObjectMock = jest.fn();

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

jest.unstable_mockModule('../../utils/virusScanner.js', () => ({
  SCAN_OUTCOME: { CLEAN: 'clean', INFECTED: 'infected', UNAVAILABLE: 'unavailable', ERROR: 'error' },
  scanBufferVerdict: scanBufferVerdictMock,
  default: { scanBufferVerdict: scanBufferVerdictMock },
}));

jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  uploadFileToR2: uploadFileToR2Mock,
  getSignedFileUrl: jest.fn(),
  deleteObject: deleteObjectMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule('../../utils/notifications/smsOutbox.js', () => ({
  queuePatientSms: jest.fn(),
}));

jest.unstable_mockModule('../../utils/notifications/sendPushNotification.js', () => ({
  sendPushNotification: jest.fn(),
}));

jest.unstable_mockModule('../../utils/phoneUtils.js', () => ({
  normalizePhone: (s) => s,
}));

jest.unstable_mockModule('../../controllers/delivery/deliveryTrackingController.js', () => ({
  calculateETA: jest.fn(),
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: jest.fn().mockResolvedValue({ timeline: { id: 1 }, audit: { id: 2 } }),
}));

jest.unstable_mockModule('../../services/notification/staffPushRecipientService.js', () => ({
  resolveStaffPushRecipients: jest.fn().mockResolvedValue([]),
}));

jest.unstable_mockModule('../../observability/staffPushFanoutMetrics.js', () => ({
  recordStaffPushFanoutFailure: jest.fn(),
}));

const { uploadResult } = await import('../../controllers/investigation/bookingController.js');
const { FILE_SCAN_POLICY } = await import('../../config/fileScanPolicy.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function processingBookingRow() {
  return {
    id: 3,
    booking_number: 'INV-3',
    investigation_id: 21,
    patient_id: 99,
    patient_name: 'Test Patient',
    patient_phone: '9000000000',
    test_name: 'CBC',
    status: 'PROCESSING',
    scheduled_date: null,
    phlebotomist_id: null,
    notes: null,
    tenant_id: TENANT_ID,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function makeReq() {
  return {
    params: { id: '3' },
    user: { id: 7, uid: '33333333-3333-4333-8333-333333333333', role: 'LAB_STAFF' },
    tenantId: TENANT_ID,
    body: { result_notes: 'ok' },
    file: { buffer: Buffer.from('fake-pdf'), originalname: 'r.pdf', mimetype: 'application/pdf' },
  };
}

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

let previousPolicy;

beforeEach(() => {
  previousPolicy = process.env.FILE_SCAN_POLICY;
  queryRawUnsafeMock.mockReset();
  scanBufferVerdictMock.mockReset();
  uploadFileToR2Mock.mockReset();
  deleteObjectMock.mockReset();
});

afterEach(() => {
  if (previousPolicy === undefined) delete process.env.FILE_SCAN_POLICY;
  else process.env.FILE_SCAN_POLICY = previousPolicy;
});

describe('uploadResult — FILE_SCAN_POLICY screen before storage', () => {
  it('required policy + no scanner: 503 FILE_SCAN_UNAVAILABLE, nothing stored', async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
    scanBufferVerdictMock.mockResolvedValue({ outcome: 'unavailable', signature: null, detail: 'no clamd' });
    queryRawUnsafeMock.mockResolvedValueOnce([processingBookingRow()]);

    const res = makeRes();
    await uploadResult(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(503);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('FILE_SCAN_UNAVAILABLE');
    expect(uploadFileToR2Mock).not.toHaveBeenCalled();
    // Only the booking pre-flight SELECT ran — no UPDATE stored a key.
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('required policy + infected: 422 FILE_SCAN_QUARANTINED, nothing stored', async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
    scanBufferVerdictMock.mockResolvedValue({ outcome: 'infected', signature: 'Eicar', detail: null });
    queryRawUnsafeMock.mockResolvedValueOnce([processingBookingRow()]);

    const res = makeRes();
    await uploadResult(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(uploadFileToR2Mock).not.toHaveBeenCalled();
  });

  it("disabled_accepted_risk: no scanner probe; stores and stamps result_file_scan_status 'not_scanned'", async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK;
    uploadFileToR2Mock.mockResolvedValue('https://r2/key');

    queryRawUnsafeMock.mockImplementation(async (sql, ...params) => {
      if (/FROM investigation_bookings WHERE id=\$1/.test(sql)) return [processingBookingRow()];
      if (/UPDATE investigation_bookings SET/.test(sql)) {
        return [{ ...processingBookingRow(), status: 'RESULT_READY' }];
      }
      return [];
    });

    const res = makeRes();
    await uploadResult(makeReq(), res);

    expect(scanBufferVerdictMock).not.toHaveBeenCalled();
    expect(uploadFileToR2Mock).toHaveBeenCalledTimes(1);

    const updateCall = queryRawUnsafeMock.mock.calls.find(([sql]) => /UPDATE investigation_bookings SET/.test(sql));
    expect(updateCall).toBeDefined();
    expect(updateCall[0]).toContain('result_file_scan_status=$3');
    expect(updateCall[3]).toBe('not_scanned'); // $3 bind value
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

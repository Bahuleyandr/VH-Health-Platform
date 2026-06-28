import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const getSignedFileUrlMock = jest.fn();
const uploadFileToR2Mock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  getSignedFileUrl: getSignedFileUrlMock,
  uploadFileToR2: uploadFileToR2Mock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { getFileByKey, uploadFile } = await import('../../controllers/upload/uploadController.js');

const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const OTHER_UID = '22222222-2222-4222-8222-222222222222';

function makeRes() {
  const res = {
    req: { originalUrl: '/api/v1/upload/by-key/uploads/test/file.pdf' },
    status: jest.fn(() => res),
    json: jest.fn(() => res),
  };
  return res;
}

function makeReq({ splat, user, headers = {} }) {
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    params: { splat },
    user,
    protocol: 'https',
    get: jest.fn((name) => lowerHeaders[String(name).toLowerCase()]),
  };
}

function fileMeta(overrides = {}) {
  return {
    id: 10,
    file_name: 'result.pdf',
    file_type: 'application/pdf',
    storage_key: `uploads/${PATIENT_UID}/result.pdf`,
    file_size: 1234n,
    uploaded_by: PATIENT_UID,
    scan_status: 'clean',
    is_active: true,
    ...overrides,
  };
}

describe('uploadController.getFileByKey', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    getSignedFileUrlMock.mockReset();
    uploadFileToR2Mock.mockReset();
  });

  it('does not let broad staff roles mint signed URLs for another user storage key', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([fileMeta()]);

    const req = makeReq({
      splat: ['uploads', PATIENT_UID, 'result.pdf'],
      user: { uid: OTHER_UID, role: 'HOUSEKEEPING_STAFF' },
      headers: { host: 'api.test' },
    });
    const res = makeRes();

    await getFileByKey(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(getSignedFileUrlMock).not.toHaveBeenCalled();
  });

  it('blocks owner downloads until scan_status is clean', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([fileMeta({ scan_status: 'PENDING' })]);

    const req = makeReq({
      splat: ['uploads', PATIENT_UID, 'result.pdf'],
      user: { uid: PATIENT_UID, role: 'PATIENT' },
      headers: { host: 'api.test' },
    });
    const res = makeRes();

    await getFileByKey(req, res);

    expect(res.status).toHaveBeenCalledWith(423);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      details: expect.objectContaining({ scan_status: 'PENDING' }),
    }));
    expect(getSignedFileUrlMock).not.toHaveBeenCalled();
  });

  it('returns signed URLs only for clean files bound to the uploader prefix', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([fileMeta()]);
    getSignedFileUrlMock.mockResolvedValueOnce('https://signed.test/result.pdf');

    const req = makeReq({
      splat: ['uploads', PATIENT_UID, 'result.pdf'],
      user: { uid: PATIENT_UID, role: 'PATIENT' },
      headers: { host: 'api.test' },
    });
    const res = makeRes();

    await getFileByKey(req, res);

    expect(getSignedFileUrlMock).toHaveBeenCalledWith(
      `uploads/${PATIENT_UID}/result.pdf`,
      3600,
      { baseUrl: 'https://api.test' },
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        storage_url: 'https://signed.test/result.pdf',
        storage_key: `uploads/${PATIENT_UID}/result.pdf`,
      }),
    }));
  });

  it('blocks non-clean files even for admins with the legacy override header (CAN-022)', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([fileMeta({ scan_status: 'failed' })]);
    getSignedFileUrlMock.mockResolvedValueOnce('https://signed.test/failed.pdf');

    const req = makeReq({
      splat: ['uploads', PATIENT_UID, 'result.pdf'],
      user: { uid: OTHER_UID, role: 'ADMIN' },
      headers: { host: 'api.test', 'x-vh-internal-download': '1' },
    });
    const res = makeRes();

    await getFileByKey(req, res);

    // The client header no longer bypasses the scan gate: 423 + no signed URL.
    expect(res.status).toHaveBeenCalledWith(423);
    expect(getSignedFileUrlMock).not.toHaveBeenCalled();
  });
});

describe('uploadController.uploadFile', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    getSignedFileUrlMock.mockReset();
    uploadFileToR2Mock.mockReset();
  });

  it('stores normalized MIME metadata and does not return a pre-scan signed URL', async () => {
    const pdf = Buffer.from('%PDF-1.7\n');
    uploadFileToR2Mock.mockResolvedValueOnce('https://storage.internal/result.pdf');
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    const req = {
      user: { uid: PATIENT_UID, role: 'PATIENT' },
      file: {
        originalname: 'result.pdf',
        mimetype: 'application/octet-stream',
        buffer: pdf,
        size: pdf.length,
      },
    };
    const res = makeRes();

    await uploadFile(req, res);

    expect(uploadFileToR2Mock).toHaveBeenCalledWith(
      pdf,
      expect.stringMatching(new RegExp(`^uploads/${PATIENT_UID}/\\d+_result\\.pdf$`)),
      'application/pdf',
    );
    expect(queryRawUnsafeMock.mock.calls[0][2]).toBe('application/pdf');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        storage_url: null,
        scan_status: 'PENDING',
        download_available: false,
      }),
    }));
  });
});

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const getSignedFileUrlMock = jest.fn();
const uploadFileToR2Mock = jest.fn();
const scanBufferVerdictMock = jest.fn();

// Mocked at the TRANSPORT layer, not at the policy layer, so these tests
// exercise the real FILE_SCAN_POLICY decision the controller makes.
jest.unstable_mockModule('../../utils/virusScanner.js', () => ({
  SCAN_OUTCOME: { CLEAN: 'clean', INFECTED: 'infected', UNAVAILABLE: 'unavailable', ERROR: 'error' },
  scanBufferVerdict: scanBufferVerdictMock,
  default: { scanBufferVerdict: scanBufferVerdictMock },
}));

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
const { FILE_SCAN_POLICY } = await import('../../config/fileScanPolicy.js');

const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const OTHER_UID = '22222222-2222-4222-8222-222222222222';

let previousPolicy;

beforeEach(() => {
  previousPolicy = process.env.FILE_SCAN_POLICY;
});

afterEach(() => {
  if (previousPolicy === undefined) delete process.env.FILE_SCAN_POLICY;
  else process.env.FILE_SCAN_POLICY = previousPolicy;
});

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
    scanBufferVerdictMock.mockReset();
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
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

    // TTL pin (871-F6): servability is checked only at URL-issue time, so the
    // signed-URL TTL is exactly how long an already-issued URL outlives a later
    // quarantine or policy flip. 300s, not the old 3600s.
    expect(getSignedFileUrlMock).toHaveBeenCalledWith(
      `uploads/${PATIENT_UID}/result.pdf`,
      300,
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

  it('never serves a quarantined file, even where the deployment runs without a scanner', async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK;
    queryRawUnsafeMock.mockResolvedValueOnce([fileMeta({ scan_status: 'quarantined' })]);

    const req = makeReq({
      splat: ['uploads', PATIENT_UID, 'result.pdf'],
      user: { uid: PATIENT_UID, role: 'PATIENT' },
      headers: { host: 'api.test' },
    });
    const res = makeRes();

    await getFileByKey(req, res);

    expect(res.status).toHaveBeenCalledWith(423);
    expect(getSignedFileUrlMock).not.toHaveBeenCalled();
  });

  it('never serves a legacy `failed` file, even where the deployment runs without a scanner', async () => {
    // 'failed' means "a scan was attempted and we could not tell". It is not
    // servable under either policy — only the deliberate 'not_scanned' status is.
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK;
    queryRawUnsafeMock.mockResolvedValueOnce([fileMeta({ scan_status: 'failed' })]);

    const req = makeReq({
      splat: ['uploads', PATIENT_UID, 'result.pdf'],
      user: { uid: PATIENT_UID, role: 'PATIENT' },
      headers: { host: 'api.test' },
    });
    const res = makeRes();

    await getFileByKey(req, res);

    expect(res.status).toHaveBeenCalledWith(423);
    expect(getSignedFileUrlMock).not.toHaveBeenCalled();
  });

  it('serves a not_scanned file where the deployment declared it runs without a scanner', async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK;
    queryRawUnsafeMock.mockResolvedValueOnce([fileMeta({ scan_status: 'not_scanned' })]);
    getSignedFileUrlMock.mockResolvedValueOnce('https://signed.test/result.pdf');

    const req = makeReq({
      splat: ['uploads', PATIENT_UID, 'result.pdf'],
      user: { uid: PATIENT_UID, role: 'PATIENT' },
      headers: { host: 'api.test' },
    });
    const res = makeRes();

    await getFileByKey(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(getSignedFileUrlMock).toHaveBeenCalledTimes(1);
  });

  it('blocks a not_scanned file where scanning is required', async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
    queryRawUnsafeMock.mockResolvedValueOnce([fileMeta({ scan_status: 'not_scanned' })]);

    const req = makeReq({
      splat: ['uploads', PATIENT_UID, 'result.pdf'],
      user: { uid: PATIENT_UID, role: 'PATIENT' },
      headers: { host: 'api.test' },
    });
    const res = makeRes();

    await getFileByKey(req, res);

    expect(res.status).toHaveBeenCalledWith(423);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ scan_policy: 'required' }),
    }));
    expect(getSignedFileUrlMock).not.toHaveBeenCalled();
  });
});

describe('uploadController.uploadFile', () => {
  const pdf = Buffer.from('%PDF-1.7\n');

  function uploadReq() {
    return {
      user: { uid: PATIENT_UID, role: 'PATIENT' },
      file: {
        originalname: 'result.pdf',
        mimetype: 'application/octet-stream',
        buffer: pdf,
        size: pdf.length,
      },
    };
  }

  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    getSignedFileUrlMock.mockReset();
    uploadFileToR2Mock.mockReset();
    scanBufferVerdictMock.mockReset();
  });

  it('stores normalized MIME metadata and does not return a pre-scan signed URL', async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
    scanBufferVerdictMock.mockResolvedValueOnce({ outcome: 'clean', signature: null, detail: null });
    uploadFileToR2Mock.mockResolvedValueOnce('https://storage.internal/result.pdf');
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    const res = makeRes();
    await uploadFile(uploadReq(), res);

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
        scan_status: 'clean',
        download_available: true,
      }),
    }));
  });

  it('THE REPORTED BUG: a no-scanner deployment no longer accepts a file it can never serve', async () => {
    // Old behaviour: 201 + scan_status 'PENDING' + a permanent 423 on download.
    // New behaviour under `required`: refuse at ingest, store nothing, say why.
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
    scanBufferVerdictMock.mockResolvedValueOnce({
      outcome: 'unavailable', signature: null, detail: 'no clamd daemon answered at 127.0.0.1:3310',
    });

    const res = makeRes();
    await uploadFile(uploadReq(), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(uploadFileToR2Mock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    // The caller is TOLD, at upload time, in a machine-readable way.
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      code: 'FILE_SCAN_UNAVAILABLE',
      message: expect.stringMatching(/malware scanner is unavailable/),
      details: expect.objectContaining({ scan_policy: 'required' }),
    }));
  });

  it('refuses an infected file at ingest with 422 and stores nothing', async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
    scanBufferVerdictMock.mockResolvedValueOnce({
      outcome: 'infected', signature: 'Eicar-Test-Signature', detail: null,
    });

    const res = makeRes();
    await uploadFile(uploadReq(), res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      code: 'FILE_SCAN_QUARANTINED',
    }));
    expect(uploadFileToR2Mock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    // The malware signature is an internal detail — it must not reach the client.
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toMatch(/Eicar/);
  });

  it('under a declared no-scanner deployment: stores not_scanned and says the file IS retrievable', async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK;
    uploadFileToR2Mock.mockResolvedValueOnce('https://storage.internal/result.pdf');
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    const res = makeRes();
    await uploadFile(uploadReq(), res);

    expect(scanBufferVerdictMock).not.toHaveBeenCalled();
    // The status persisted to file_metadata is the honest one, not 'PENDING'.
    expect(queryRawUnsafeMock.mock.calls[0][7]).toBe('not_scanned');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        scan_status: 'not_scanned',
        scan_policy: 'disabled_accepted_risk',
        download_available: true,
      }),
    }));
  });

  it('the ingest answer and the download gate agree on the same row', async () => {
    // The invariant that makes the blackhole impossible: whatever the upload
    // response promises about retrievability, the download gate must honour.
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK;
    uploadFileToR2Mock.mockResolvedValueOnce('https://storage.internal/result.pdf');
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    const uploadRes = makeRes();
    await uploadFile(uploadReq(), uploadRes);
    const uploaded = uploadRes.json.mock.calls[0][0].data;
    expect(uploaded.download_available).toBe(true);

    queryRawUnsafeMock.mockResolvedValueOnce([fileMeta({ scan_status: uploaded.scan_status })]);
    getSignedFileUrlMock.mockResolvedValueOnce('https://signed.test/result.pdf');
    const downloadRes = makeRes();
    await getFileByKey(
      makeReq({
        splat: ['uploads', PATIENT_UID, 'result.pdf'],
        user: { uid: PATIENT_UID, role: 'PATIENT' },
        headers: { host: 'api.test' },
      }),
      downloadRes,
    );

    expect(downloadRes.status).toHaveBeenCalledWith(200);
  });
});

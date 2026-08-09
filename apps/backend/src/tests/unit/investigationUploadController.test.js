import { PassThrough } from 'node:stream';

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const getFileByIdMock = jest.fn();
const getFileStreamMock = jest.fn();
const getInvestigationFilesMock = jest.fn();
const uploadInvestigationFileMock = jest.fn();
const deleteFileMock = jest.fn();
const logAuditMock = jest.fn();

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

jest.unstable_mockModule('../../services/investigation/fileService.js', () => ({
  uploadInvestigationFile: uploadInvestigationFileMock,
  getInvestigationFiles: getInvestigationFilesMock,
  getFileById: getFileByIdMock,
  deleteFile: deleteFileMock,
  getFileStream: getFileStreamMock,
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: logAuditMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { downloadFile, getFileInfo } = await import('../../controllers/investigation/uploadController.js');

const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function makeRes() {
  const res = {
    req: { originalUrl: '/api/v1/investigations/42/files/8' },
    status: jest.fn(() => res),
    json: jest.fn(() => res),
    setHeader: jest.fn(() => res),
  };
  return res;
}

function makeReq(params, user = { uid: PATIENT_UID, role: 'PATIENT', tenantId: TENANT_ID }) {
  return { params, user };
}

describe('investigation upload controller file authorization', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    getFileByIdMock.mockReset();
    getFileStreamMock.mockReset();
    getInvestigationFilesMock.mockReset();
    uploadInvestigationFileMock.mockReset();
    deleteFileMock.mockReset();
    logAuditMock.mockReset();
  });

  it('denies patient file metadata before loading file ids for another patient investigation', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    const req = makeReq({ id: '42', fileId: '8' });
    const res = makeRes();

    await getFileInfo(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(getFileByIdMock).not.toHaveBeenCalled();
  });

  it('does not stream a file id that is not bound to the authorized investigation', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 42 }]);
    getFileByIdMock.mockResolvedValueOnce({
      id: 8,
      investigation_id: 99,
      file_name: 'other-patient.pdf',
      file_path: '/tmp/other-patient.pdf',
      file_type: '.pdf',
      file_size: 123n,
      uploaded_by: '22222222-2222-4222-8222-222222222222',
      created_at: new Date('2026-06-11T00:00:00Z'),
    });

    const req = makeReq({ id: '42', fileId: '8' });
    const res = makeRes();

    await downloadFile(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(getFileStreamMock).not.toHaveBeenCalled();
  });
});

describe('investigation download stream error handling', () => {
  const boundFile = {
    id: 8,
    investigation_id: 42,
    file_name: 'report.pdf',
    file_path: '/tmp/report.pdf',
    file_type: '.pdf',
    file_size: 123n,
    uploaded_by: PATIENT_UID,
    created_at: new Date('2026-06-11T00:00:00Z'),
  };

  function makeStreamingRes() {
    const res = makeRes();
    res.headersSent = false;
    res.destroy = jest.fn();
    res.on = jest.fn(() => res);
    res.write = jest.fn(() => true);
    res.end = jest.fn(() => res);
    res.emit = jest.fn();
    res.once = jest.fn(() => res);
    res.removeListener = jest.fn(() => res);
    return res;
  }

  async function startDownload(res) {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 42 }]);
    getFileByIdMock.mockResolvedValueOnce(boundFile);
    const stream = new PassThrough();
    getFileStreamMock.mockResolvedValueOnce({ stream, fileName: 'report.pdf', fileType: '.pdf' });
    logAuditMock.mockResolvedValueOnce(undefined);

    const req = makeReq({ id: '42', fileId: '8' });
    await downloadFile(req, res);
    return stream;
  }

  it('a stream error before headers are sent returns a 500 JSON error instead of crashing', async () => {
    const res = makeStreamingRes();
    const stream = await startDownload(res);

    // Before the fix this emit was an unhandled 'error' event — a process-
    // killing uncaught exception the controller's try/catch cannot see.
    expect(() => stream.emit('error', new Error('R2 read failed mid-stream'))).not.toThrow();

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(res.destroy).not.toHaveBeenCalled();
  });

  it('a stream error after headers are sent destroys the response instead of double-sending', async () => {
    const res = makeStreamingRes();
    const stream = await startDownload(res);
    res.headersSent = true;

    expect(() => stream.emit('error', new Error('disk read failed mid-stream'))).not.toThrow();

    expect(res.destroy).toHaveBeenCalled();
    // No status/json after headers went out — only the 404-free happy path ran.
    expect(res.json).not.toHaveBeenCalled();
  });

  it('destroys the source stream when the client disconnects mid-download', async () => {
    const res = makeStreamingRes();
    const stream = await startDownload(res);

    const closeHandler = res.on.mock.calls.find(([event]) => event === 'close')?.[1];
    expect(typeof closeHandler).toBe('function');
    closeHandler();

    expect(stream.destroyed).toBe(true);
  });
});

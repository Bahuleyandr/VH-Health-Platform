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

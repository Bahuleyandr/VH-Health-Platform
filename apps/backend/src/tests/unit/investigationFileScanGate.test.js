// Behavior tests for the investigation-file ingest screen + serving gate
// (871-F1). Mocked at the TRANSPORT layer (virusScanner) so the REAL
// FILE_SCAN_POLICY decision in fileScanService/fileScanPolicy is exercised.

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const scanBufferVerdictMock = jest.fn();
const writeFileMock = jest.fn();
const accessMock = jest.fn();
const unlinkMock = jest.fn();
const mkdirMock = jest.fn();
const createReadStreamMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();

jest.unstable_mockModule('../../utils/virusScanner.js', () => ({
  SCAN_OUTCOME: { CLEAN: 'clean', INFECTED: 'infected', UNAVAILABLE: 'unavailable', ERROR: 'error' },
  scanBufferVerdict: scanBufferVerdictMock,
  default: { scanBufferVerdict: scanBufferVerdictMock },
}));

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $queryRaw: jest.fn(),
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('fs/promises', () => ({
  default: {
    writeFile: writeFileMock,
    access: accessMock,
    unlink: unlinkMock,
    mkdir: mkdirMock,
  },
}));

jest.unstable_mockModule('fs', () => ({
  createReadStream: createReadStreamMock,
  default: { createReadStream: createReadStreamMock },
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { uploadInvestigationFile, getFileStream } = await import(
  '../../services/investigation/fileService.js'
);
const { FILE_SCAN_POLICY, FILE_SCAN_STATUS } = await import('../../config/fileScanPolicy.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const UPLOADER = '11111111-1111-4111-8111-111111111111';

const investigationRow = {
  id: 42,
  tenant_id: TENANT_ID,
  patient_uid: '22222222-2222-4222-8222-222222222222',
  test_name: 'CBC',
  test_type: 'lab',
  type: 'lab',
  status: 'ORDERED',
};

function multerFile() {
  return {
    originalname: 'result.pdf',
    buffer: Buffer.from('%PDF-1.4 test'),
    size: 13,
  };
}

let previousPolicy;

beforeEach(() => {
  previousPolicy = process.env.FILE_SCAN_POLICY;
  queryRawUnsafeMock.mockReset();
  __prismaDefaultMock.$queryRaw.mockReset();
  scanBufferVerdictMock.mockReset();
  writeFileMock.mockReset().mockResolvedValue(undefined);
  accessMock.mockReset().mockResolvedValue(undefined);
  unlinkMock.mockReset().mockResolvedValue(undefined);
  mkdirMock.mockReset().mockResolvedValue(undefined);
  createReadStreamMock.mockReset().mockReturnValue({ mock: 'stream' });
  recordCanonicalClinicalEventMock.mockReset().mockResolvedValue({
    timeline: { id: 1 },
    audit: { id: 2 },
  });
});

afterEach(() => {
  if (previousPolicy === undefined) delete process.env.FILE_SCAN_POLICY;
  else process.env.FILE_SCAN_POLICY = previousPolicy;
});

describe('uploadInvestigationFile — ingest screen', () => {
  it('required policy + no scanner: refuses 503 and writes NOTHING to disk or DB', async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
    scanBufferVerdictMock.mockResolvedValue({ outcome: 'unavailable', signature: null, detail: 'x' });
    __prismaDefaultMock.$queryRaw.mockResolvedValue([investigationRow]);

    await expect(
      uploadInvestigationFile(42, multerFile(), UPLOADER, { tenantId: TENANT_ID }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'FILE_SCAN_UNAVAILABLE' });

    expect(writeFileMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('required policy + infected: refuses 422 and stores nothing', async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
    scanBufferVerdictMock.mockResolvedValue({ outcome: 'infected', signature: 'Eicar-Test', detail: null });
    __prismaDefaultMock.$queryRaw.mockResolvedValue([investigationRow]);

    await expect(
      uploadInvestigationFile(42, multerFile(), UPLOADER, { tenantId: TENANT_ID }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'FILE_SCAN_QUARANTINED' });

    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("disabled_accepted_risk: no scan probe, stores the row with scan_status 'not_scanned'", async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK;
    __prismaDefaultMock.$queryRaw.mockResolvedValue([investigationRow]);
    queryRawUnsafeMock.mockResolvedValue([{
      id: 7, investigation_id: 42, file_name: 'result.pdf', file_path: '/x',
      file_type: '.pdf', file_size: 13n, uploaded_by: UPLOADER,
      tenant_id: TENANT_ID, scan_status: 'not_scanned', created_at: new Date(),
    }]);

    const created = await uploadInvestigationFile(42, multerFile(), UPLOADER, { tenantId: TENANT_ID });

    expect(scanBufferVerdictMock).not.toHaveBeenCalled();
    expect(created.scan_status).toBe(FILE_SCAN_STATUS.NOT_SCANNED);
    // The INSERT carries the screener verdict as a bind param.
    const insertCall = queryRawUnsafeMock.mock.calls.find(([sql]) => /INSERT INTO investigation_files/.test(sql));
    expect(insertCall).toBeDefined();
    expect(insertCall).toContain(FILE_SCAN_STATUS.NOT_SCANNED);
  });
});

describe('getFileStream — serving gate', () => {
  function fileRow(scanStatus) {
    return {
      id: 7, investigation_id: 42, file_name: 'r.pdf', file_path: '/tmp/r.pdf',
      file_type: '.pdf', file_size: 13n, uploaded_by: UPLOADER,
      scan_status: scanStatus, created_at: new Date(),
    };
  }

  it("legacy 'failed' is NEVER streamed — 423 under BOTH policies", async () => {
    for (const policy of [FILE_SCAN_POLICY.REQUIRED, FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK]) {
      process.env.FILE_SCAN_POLICY = policy;
      queryRawUnsafeMock.mockResolvedValue([fileRow('failed')]);
      await expect(getFileStream(7)).rejects.toMatchObject({
        statusCode: 423,
        code: 'FILE_SCAN_NOT_CLEAN',
      });
      expect(createReadStreamMock).not.toHaveBeenCalled();
    }
  });

  it("backfilled 'not_scanned' serves under disabled_accepted_risk but 423s under required", async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK;
    queryRawUnsafeMock.mockResolvedValue([fileRow('not_scanned')]);
    const served = await getFileStream(7);
    expect(served.stream).toEqual({ mock: 'stream' });

    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
    queryRawUnsafeMock.mockResolvedValue([fileRow('not_scanned')]);
    await expect(getFileStream(7)).rejects.toMatchObject({ statusCode: 423 });
  });

  it("a NULL status on an old row folds to 'pending' and is never served", async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK;
    queryRawUnsafeMock.mockResolvedValue([fileRow(null)]);
    await expect(getFileStream(7)).rejects.toMatchObject({ statusCode: 423 });
  });

  it("'clean' streams under required", async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
    queryRawUnsafeMock.mockResolvedValue([fileRow('clean')]);
    const served = await getFileStream(7);
    expect(served.fileName).toBe('r.pdf');
    expect(createReadStreamMock).toHaveBeenCalledWith('/tmp/r.pdf');
  });
});

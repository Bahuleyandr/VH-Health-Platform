// Behavior pins for the rewired admin quarantine/rescan stack (871-F3).
//
// The previous implementation probed for tables that have never existed
// (uploads/file_uploads/files/documents), reported 0 quarantined files
// forever, and its rescan would have stamped the never-servable legacy
// 'pending'. These tests pin the new contract:
//   * queries target the REAL stores (file_metadata, staff_message_attachments)
//   * rescan writes ONLY terminal vocabulary statuses — never 'pending'/'failed'
//   * a quarantined (known-bad) row cannot be released without a real clean scan
//   * purge touches known-bad rows only

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const scanBufferVerdictMock = jest.fn();
const getFileFromR2Mock = jest.fn();
const deleteObjectMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));

jest.unstable_mockModule('../../utils/virusScanner.js', () => ({
  SCAN_OUTCOME: { CLEAN: 'clean', INFECTED: 'infected', UNAVAILABLE: 'unavailable', ERROR: 'error' },
  scanBufferVerdict: scanBufferVerdictMock,
  default: { scanBufferVerdict: scanBufferVerdictMock },
}));

jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  getFileFromR2: getFileFromR2Mock,
  deleteObject: deleteObjectMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const {
  getUploadSummary,
  listQuarantinedFiles,
  parseUploadFileId,
  purgeQuarantinedFiles,
  rescanFile,
} = await import('../../routes/admin/services/uploadService.js');
const { FILE_SCAN_POLICY, FILE_SCAN_STATUS } = await import('../../config/fileScanPolicy.js');

let previousPolicy;

beforeEach(() => {
  previousPolicy = process.env.FILE_SCAN_POLICY;
  queryRawUnsafeMock.mockReset();
  scanBufferVerdictMock.mockReset();
  getFileFromR2Mock.mockReset();
  deleteObjectMock.mockReset();
});

afterEach(() => {
  if (previousPolicy === undefined) delete process.env.FILE_SCAN_POLICY;
  else process.env.FILE_SCAN_POLICY = previousPolicy;
});

describe('parseUploadFileId', () => {
  it('addresses both real stores and keeps bare ids back-compatible', () => {
    expect(parseUploadFileId('generic:12')).toEqual({ source: 'generic', id: 12 });
    expect(parseUploadFileId('attachment:7')).toEqual({ source: 'attachment', id: 7 });
    expect(parseUploadFileId('34')).toEqual({ source: 'generic', id: 34 });
    expect(parseUploadFileId('uploads:1')).toBeNull();
    expect(parseUploadFileId('DROP TABLE')).toBeNull();
  });
});

describe('queries target the real scan-status stores', () => {
  it('summary and quarantine list read file_metadata + staff_message_attachments (never the phantom tables)', async () => {
    queryRawUnsafeMock.mockResolvedValue([{ count: 0 }]);
    await getUploadSummary();
    await listQuarantinedFiles(20, 0);

    const allSql = queryRawUnsafeMock.mock.calls.map(([sql]) => sql).join('\n');
    expect(allSql).toContain('file_metadata');
    expect(allSql).toContain('staff_message_attachments');
    for (const phantom of ['FROM uploads', 'file_uploads', 'FROM files', 'FROM documents', 'quarantined_files']) {
      expect(allSql).not.toContain(phantom);
    }
    // Review set = never-servable-under-any-policy statuses; the declared
    // 'not_scanned' posture is NOT flagged for review.
    expect(allSql).toContain("IN ('quarantined', 'failed', 'pending', '')");
    expect(allSql).not.toContain("'not_scanned',");
  });

  it('quarantine list casts both stores\' ids to text — integer (file_metadata) and uuid (staff_message_attachments) ids cannot be UNIONed raw', async () => {
    // Regression pin for the 2026-08-20 Smoke E2E route-crawl red:
    // "UNION types integer and uuid cannot be matched" 500'd /dashboard/uploads.
    queryRawUnsafeMock.mockResolvedValue([]);
    await listQuarantinedFiles(20, 0);

    const sql = queryRawUnsafeMock.mock.calls[0][0];
    const castCount = (sql.match(/id::text AS id/g) || []).length;
    expect(castCount).toBe(2); // one per UNION branch
  });
});

describe('rescanFile — can never mint a permanently-blocked status', () => {
  const failedRow = { id: 5, file_name: 'a.pdf', storage_key: 'k', scan_status: 'failed' };

  it("disabled_accepted_risk: releases a legacy 'failed' row to 'not_scanned' without probing a scanner", async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK;
    queryRawUnsafeMock
      .mockResolvedValueOnce([failedRow]) // load
      .mockResolvedValueOnce([{ id: 5 }]); // stamp

    const result = await rescanFile('generic:5');

    expect(result).toMatchObject({ success: true, updated: 1, scan_status: FILE_SCAN_STATUS.NOT_SCANNED });
    expect(scanBufferVerdictMock).not.toHaveBeenCalled();
    const stamp = queryRawUnsafeMock.mock.calls[1];
    expect(stamp[0]).toContain('UPDATE file_metadata');
    expect(stamp[1]).toBe(FILE_SCAN_STATUS.NOT_SCANNED);
  });

  it('disabled_accepted_risk: REFUSES to release a quarantined (known-bad) row', async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK;
    queryRawUnsafeMock.mockResolvedValueOnce([{ ...failedRow, scan_status: 'quarantined' }]);

    const result = await rescanFile('generic:5');

    expect(result.success).toBe(false);
    expect(result.updated).toBe(0);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1); // load only, no write
  });

  it("required: a clean scan stamps 'clean' on the addressed attachment row", async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
    queryRawUnsafeMock
      .mockResolvedValueOnce([failedRow])
      .mockResolvedValueOnce([{ id: 5 }]);
    getFileFromR2Mock.mockResolvedValue(Buffer.from('bytes'));
    scanBufferVerdictMock.mockResolvedValue({ outcome: 'clean', signature: null, detail: null });

    const result = await rescanFile('attachment:5');

    expect(result).toMatchObject({ success: true, scan_status: FILE_SCAN_STATUS.CLEAN });
    const stamp = queryRawUnsafeMock.mock.calls[1];
    expect(stamp[0]).toContain('UPDATE staff_message_attachments');
    expect(stamp[1]).toBe(FILE_SCAN_STATUS.CLEAN);
  });

  it("required: an infected scan stamps 'quarantined'", async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
    queryRawUnsafeMock
      .mockResolvedValueOnce([failedRow])
      .mockResolvedValueOnce([{ id: 5 }]);
    getFileFromR2Mock.mockResolvedValue(Buffer.from('bytes'));
    scanBufferVerdictMock.mockResolvedValue({ outcome: 'infected', signature: 'Eicar', detail: null });

    const result = await rescanFile('generic:5');
    expect(result).toMatchObject({ success: true, scan_status: FILE_SCAN_STATUS.QUARANTINED });
  });

  it('required: scanner unavailable writes NOTHING (status unchanged, no stuck pending)', async () => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
    queryRawUnsafeMock.mockResolvedValueOnce([failedRow]);
    getFileFromR2Mock.mockResolvedValue(Buffer.from('bytes'));
    scanBufferVerdictMock.mockResolvedValue({ outcome: 'unavailable', signature: null, detail: 'no clamd' });

    const result = await rescanFile('generic:5');

    expect(result.success).toBe(false);
    expect(result.updated).toBe(0);
    expect(result.scan_status).toBe('failed'); // untouched
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1); // load only
  });

  it("the module source never stamps 'pending' or 'failed' (the old stub's defect)", async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../routes/admin/services/uploadService.js', import.meta.url)),
      'utf8',
    );
    expect(src).not.toMatch(/scan_status = 'pending'/);
    expect(src).not.toMatch(/FILE_SCAN_STATUS\.PENDING\)/);
    expect(src).not.toMatch(/stampScanStatus\([^)]*FILE_SCAN_STATUS\.FAILED/);
  });
});

describe('purgeQuarantinedFiles — known-bad only', () => {
  it('dry run lists only rows matching the quarantined predicate and deletes nothing', async () => {
    // ids arrive as text — the candidate query casts both stores' ids for the UNION
    queryRawUnsafeMock.mockResolvedValueOnce([
      { source: 'generic', id: '1', storage_key: 'k1' },
      { source: 'attachment', id: '2e9c1d34-0000-4000-8000-000000000002', storage_key: 'k2' },
    ]);

    const result = await purgeQuarantinedFiles(true);

    expect(result).toEqual({
      success: true,
      purged: 0,
      dryRun: true,
      details: ['generic:1', 'attachment:2e9c1d34-0000-4000-8000-000000000002'],
    });
    expect(deleteObjectMock).not.toHaveBeenCalled();
    const sql = queryRawUnsafeMock.mock.calls[0][0];
    expect(sql).toContain("= 'quarantined'");
    expect(sql).not.toContain("'failed'"); // unreviewed rows are never purged
    // Same UNION type pin as the quarantine list: both branches cast id to text.
    expect((sql.match(/id::text AS id/g) || []).length).toBe(2);
  });

  it('real run deletes the stored object and deactivates the generic row', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ source: 'generic', id: '1', storage_key: 'k1' }])
      .mockResolvedValueOnce([{ id: 1 }]);
    deleteObjectMock.mockResolvedValue(undefined);

    const result = await purgeQuarantinedFiles(false);

    expect(result.purged).toBe(1);
    expect(deleteObjectMock).toHaveBeenCalledWith('k1');
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('SET is_active = false');
  });
});

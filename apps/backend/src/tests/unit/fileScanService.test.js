// Behaviour of the shared ingest screen, under both declared postures.
//
// The rule under test is "never accept bytes you cannot serve": under
// FILE_SCAN_POLICY=required an unreachable scanner must REFUSE the upload, not
// store it with a status that no gate will ever release.

import { jest } from '@jest/globals';

const scanBufferVerdictMock = jest.fn();

jest.unstable_mockModule('../../utils/virusScanner.js', () => ({
  SCAN_OUTCOME: {
    CLEAN: 'clean',
    INFECTED: 'infected',
    UNAVAILABLE: 'unavailable',
    ERROR: 'error',
  },
  scanBufferVerdict: scanBufferVerdictMock,
  default: { scanBufferVerdict: scanBufferVerdictMock },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { screenUploadBuffer } = await import('../../services/security/fileScanService.js');
const { FILE_SCAN_POLICY, FILE_SCAN_STATUS, isScanStatusServable } =
  await import('../../config/fileScanPolicy.js');

const BYTES = Buffer.from('%PDF-1.7\n');
let previousPolicy;

beforeEach(() => {
  previousPolicy = process.env.FILE_SCAN_POLICY;
  scanBufferVerdictMock.mockReset();
});

afterEach(() => {
  if (previousPolicy === undefined) delete process.env.FILE_SCAN_POLICY;
  else process.env.FILE_SCAN_POLICY = previousPolicy;
});

describe('screenUploadBuffer — FILE_SCAN_POLICY=required', () => {
  beforeEach(() => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.REQUIRED;
  });

  it('accepts a clean file as clean, and that status is servable', async () => {
    scanBufferVerdictMock.mockResolvedValueOnce({ outcome: 'clean', signature: null, detail: null });

    const screened = await screenUploadBuffer(BYTES);

    expect(screened.scanStatus).toBe(FILE_SCAN_STATUS.CLEAN);
    expect(isScanStatusServable(screened.scanStatus)).toBe(true);
    expect(screened.metadata).toMatchObject({ scanner: 'clamav', scan_policy: 'required' });
  });

  it('REFUSES an infected file with 422 and stores nothing', async () => {
    scanBufferVerdictMock.mockResolvedValueOnce({
      outcome: 'infected', signature: 'Eicar-Test-Signature', detail: null,
    });

    await expect(screenUploadBuffer(BYTES)).rejects.toMatchObject({
      statusCode: 422,
      code: 'FILE_SCAN_QUARANTINED',
    });
  });

  it('REFUSES the upload with 503 when no scanner answers — never stores an unservable file', async () => {
    // This is the no-scanner deployment. Under `required`, the honest answer is
    // a retryable refusal, NOT a 201 followed by a permanent 423.
    scanBufferVerdictMock.mockResolvedValueOnce({
      outcome: 'unavailable', signature: null, detail: 'no clamd daemon answered at 127.0.0.1:3310',
    });

    await expect(screenUploadBuffer(BYTES)).rejects.toMatchObject({
      statusCode: 503,
      code: 'FILE_SCAN_UNAVAILABLE',
    });
  });

  it('REFUSES the upload when the scanner errors mid-scan', async () => {
    scanBufferVerdictMock.mockResolvedValueOnce({
      outcome: 'error', signature: null, detail: 'clamd accepted the connection but did not complete the scan',
    });

    await expect(screenUploadBuffer(BYTES)).rejects.toMatchObject({
      statusCode: 503,
      code: 'FILE_SCAN_UNAVAILABLE',
    });
  });

  it('names the subject in the refusal so the caller knows what was rejected', async () => {
    scanBufferVerdictMock.mockResolvedValueOnce({ outcome: 'unavailable', signature: null, detail: null });

    await expect(screenUploadBuffer(BYTES, { subject: 'Attachment' })).rejects.toThrow(
      /^Attachment cannot be accepted right now/,
    );
  });

  it('never leaks scanner internals into the client-facing details', async () => {
    scanBufferVerdictMock.mockResolvedValueOnce({
      outcome: 'unavailable', signature: null, detail: 'ECONNREFUSED 127.0.0.1:3310',
    });

    const err = await screenUploadBuffer(BYTES).catch(e => e);
    expect(JSON.stringify(err.details)).not.toMatch(/ECONNREFUSED/);
    expect(err.message).not.toMatch(/ECONNREFUSED/);
  });
});

describe('screenUploadBuffer — FILE_SCAN_POLICY=disabled_accepted_risk', () => {
  beforeEach(() => {
    process.env.FILE_SCAN_POLICY = FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK;
  });

  it('accepts without probing the scanner at all', async () => {
    const screened = await screenUploadBuffer(BYTES);

    expect(scanBufferVerdictMock).not.toHaveBeenCalled();
    expect(screened.scanStatus).toBe(FILE_SCAN_STATUS.NOT_SCANNED);
    expect(isScanStatusServable(screened.scanStatus)).toBe(true);
  });

  it('records the reason as policy, not as a scan failure', async () => {
    const screened = await screenUploadBuffer(BYTES);

    expect(screened.scanStatus).not.toBe(FILE_SCAN_STATUS.FAILED);
    expect(screened.scanStatus).not.toBe(FILE_SCAN_STATUS.CLEAN);
    expect(screened.metadata).toMatchObject({
      scanner: 'none',
      scan_policy: FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK,
    });
    expect(screened.metadata.scan_detail).toMatch(/disabled by deployment configuration/);
  });
});

describe('screenUploadBuffer — an unset policy is the strict one', () => {
  it('treats a missing FILE_SCAN_POLICY as required', async () => {
    delete process.env.FILE_SCAN_POLICY;
    scanBufferVerdictMock.mockResolvedValueOnce({ outcome: 'unavailable', signature: null, detail: null });

    await expect(screenUploadBuffer(BYTES)).rejects.toMatchObject({ code: 'FILE_SCAN_UNAVAILABLE' });
    expect(scanBufferVerdictMock).toHaveBeenCalledTimes(1);
  });
});

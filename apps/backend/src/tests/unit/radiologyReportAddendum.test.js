// Unit regression for finding H' D50 (42f9bdb5).
//
// `submitReport` correctly refuses overwrites once a radiology report
// is signed off (REPORT_SIGNED_OFF), but the comment in that path
// said "issue an addendum instead" — yet no addendum route existed.
// The radiologist who wanted to amend a signed report had to ask
// IT for a DB poke. This adds a proper `appendReportAddendum` path
// that appends a labelled section (timestamp + author) to the
// existing report blob, leaves the original sign-off metadata
// untouched, and records each addendum to audit_logs for the
// chain-of-custody.
//
// Asserts:
//   * Pre-signoff order → 400 REPORT_NOT_SIGNED_OFF (use submitReport).
//   * Cancelled order → 400 (cannot amend a cancelled study).
//   * Signed report → 200 with appended labelled section + audit row.
//   * Missing addendum text → 400.
//   * Sign-off metadata is preserved (original signed_off_at + by
//     unchanged after addendum).

import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawMock,
    $executeRawUnsafe: executeRawMock,
  },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: radiologyService } = await import('../../services/radiology/radiologyService.js');

const SIGNED_AT = new Date('2026-05-22T10:00:00Z');
const SIGNED_BY = 'aaaa1111-2222-4333-8444-555555555555';
const RADIOLOGIST_UID = 'bbbb1111-2222-4333-8444-666666666666';

describe('radiologyService.appendReportAddendum (H D50)', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    executeRawMock.mockReset();
    executeRawMock.mockResolvedValue(1);
  });

  it('rejects when the report is not yet signed off (use submitReport instead)', async () => {
    queryRawMock.mockResolvedValueOnce([{
      id: 17, status: 'in_progress', report: 'Draft text',
      report_signed_off_at: null,
    }]);
    await expect(
      radiologyService.appendReportAddendum(17, { addendum: 'extra finding', addendum_by: RADIOLOGIST_UID }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'REPORT_NOT_SIGNED_OFF' });
  });

  it('rejects when the order is cancelled', async () => {
    queryRawMock.mockResolvedValueOnce([{
      id: 18, status: 'cancelled', report: '',
      report_signed_off_at: null,
    }]);
    await expect(
      radiologyService.appendReportAddendum(18, { addendum: 'late note', addendum_by: RADIOLOGIST_UID }),
    ).rejects.toThrow(/cancelled/i);
  });

  it('rejects missing addendum text (400)', async () => {
    await expect(
      radiologyService.appendReportAddendum(19, { addendum: '   ', addendum_by: RADIOLOGIST_UID }),
    ).rejects.toThrow(/addendum text is required/i);
  });

  it('appends a labelled section to a signed report and writes an audit row', async () => {
    queryRawMock
      .mockResolvedValueOnce([{
        id: 20, status: 'completed', report: 'Original findings.\nImpression: normal.',
        report_signed_off_at: SIGNED_AT,
      }])
      .mockResolvedValueOnce([{
        id: 20,
        report: '... will be filled by the UPDATE',
        report_signed_off_at: SIGNED_AT,
        report_signed_off_by: SIGNED_BY,
      }]);

    const result = await radiologyService.appendReportAddendum(20, {
      addendum: 'On second review, a small subpleural nodule is seen.',
      addendum_by: RADIOLOGIST_UID,
    });

    // The UPDATE was issued with a report that starts with the
    // original blob and ends with the labelled addendum.
    const updateCall = queryRawMock.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE radiology_orders/);
    expect(updateCall[1]).toMatch(/^Original findings/);
    expect(updateCall[1]).toMatch(/--- Addendum \(.*by bbbb1111-2222-4333-8444-666666666666\) ---/);
    expect(updateCall[1]).toMatch(/subpleural nodule/);

    // Audit row written.
    expect(executeRawMock).toHaveBeenCalledWith(
      expect.stringContaining('RADIOLOGY_REPORT_ADDENDUM'),
      RADIOLOGIST_UID, '20', expect.stringContaining('"addendum_text"'),
    );

    // Returned shape (from the second mock) carries the unchanged
    // sign-off metadata — the addendum did NOT bump or invalidate it.
    expect(result.report_signed_off_at).toBe(SIGNED_AT);
    expect(result.report_signed_off_by).toBe(SIGNED_BY);
  });

  it('rejects when addendum_by is missing', async () => {
    await expect(
      radiologyService.appendReportAddendum(21, { addendum: 'X', addendum_by: null }),
    ).rejects.toThrow(/addendum_by is required/i);
  });
});

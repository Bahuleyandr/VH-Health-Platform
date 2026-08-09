import { jest } from '@jest/globals';

const reportServiceMock = {
  generateInvestigationReport: jest.fn(),
  exportInvestigationsToExcel: jest.fn(),
  generateStatisticsReport: jest.fn(),
  emailInvestigationReport: jest.fn(),
};
const logAuditMock = jest.fn();

jest.unstable_mockModule('../../services/investigation/reportService.js', () => reportServiceMock);
jest.unstable_mockModule('../../services/investigation/investigationService.js', () => ({
  getInvestigationById: jest.fn(),
}));
jest.unstable_mockModule('../../services/portal/portalAccessService.js', () => ({
  getResultEpisodeReleaseDecision: jest.fn(),
}));
jest.unstable_mockModule('../../utils/logAudit.js', () => ({ logAudit: logAuditMock }));
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: { $queryRaw: jest.fn() } }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const { emailReport } = await import('../../controllers/investigation/reportController.js');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    req: { id: 'req-1' },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function mockReq(overrides = {}) {
  return {
    params: { id: '42' },
    body: { email: 'doc@example.com' },
    user: { role: 'DOCTOR', uid: 'sender-uid' },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reportController.emailReport', () => {
  it('audits and reports success only after the service confirms a real send', async () => {
    reportServiceMock.emailInvestigationReport.mockResolvedValueOnce({ success: true, messageId: 'real-id' });
    const res = mockRes();

    await emailReport(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      'investigation-report-emailed',
      expect.objectContaining({ investigation_id: '42', sent_to: 'doc@example.com' })
    );
  });

  it('does NOT write an audit row and reports failure when the service cannot confirm delivery', async () => {
    reportServiceMock.emailInvestigationReport.mockRejectedValueOnce(new Error('Failed to email investigation report: smtp_not_configured'));
    const res = mockRes();

    await emailReport(mockReq(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});

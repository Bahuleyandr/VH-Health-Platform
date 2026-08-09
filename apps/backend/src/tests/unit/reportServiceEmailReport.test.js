import { jest } from '@jest/globals';

const prismaMock = { $queryRaw: jest.fn() };
const sendEmailMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../utils/notifications/sendEmailNotification.js', () => ({ sendEmail: sendEmailMock }));

const { emailInvestigationReport } = await import('../../services/investigation/reportService.js');

const investigationRow = {
  id: 42,
  uid: 'uid-1',
  phone: '9876543210',
  test_name: 'CBC',
  test_type: 'blood',
  status: 'completed',
  priority: 'normal',
  notes: null,
  results: null,
  interpretation: null,
  requested_at: new Date('2026-08-01'),
  completed_at: new Date('2026-08-02'),
  created_at: new Date('2026-08-01'),
  updated_at: new Date('2026-08-02'),
  patient_name: 'John Doe',
  birthday: new Date('1990-01-01'),
  gender: 'male',
  requested_by_name: 'Dr. Smith',
  requested_by_role: 'DOCTOR',
  doctor_name: 'Dr. Smith',
  department: 'Pathology',
  specialization: 'General',
};

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.$queryRaw.mockResolvedValue([investigationRow]);
});

describe('reportService.emailInvestigationReport', () => {
  it('returns the real provider messageId once the transport actually accepts the mail', async () => {
    sendEmailMock.mockResolvedValueOnce({ messageId: 'real-provider-id-123' });

    const result = await emailInvestigationReport(42, { email: 'doc@example.com', cc: 'x@example.com' }, 'sender-uid');

    expect(result).toEqual({ success: true, messageId: 'real-provider-id-123' });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.to).toBe('doc@example.com');
    expect(call.cc).toBe('x@example.com');
    expect(call.receiptMode).toBe(true);
    expect(call.attachments).toHaveLength(1);
    expect(call.attachments[0].filename).toBe('investigation_report_42.pdf');
    expect(Buffer.isBuffer(call.attachments[0].content)).toBe(true);
  });

  it('rejects instead of faking success when SMTP is not configured', async () => {
    sendEmailMock.mockResolvedValueOnce({ outcome: 'rejected', code: 'smtp_not_configured', messageId: null });

    await expect(
      emailInvestigationReport(42, { email: 'doc@example.com' }, 'sender-uid')
    ).rejects.toThrow();
  });

  it('rejects instead of faking success when the transport rejects the send', async () => {
    sendEmailMock.mockRejectedValueOnce(Object.assign(new Error('SMTP delivery outcome is uncertain'), { code: 'ECONNREFUSED' }));

    await expect(
      emailInvestigationReport(42, { email: 'doc@example.com' }, 'sender-uid')
    ).rejects.toThrow();
  });
});

import { jest } from '@jest/globals';

const sendMailMock = jest.fn();
const createTransportMock = jest.fn(() => ({ sendMail: sendMailMock }));

jest.unstable_mockModule('nodemailer', () => ({ default: { createTransport: createTransportMock } }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const ORIGINAL_ENV = { ...process.env };

// sendEmailNotification.js caches its transporter in module-level state, so
// each test needs a fresh module instance to control whether SMTP looks
// "configured" — otherwise an earlier test's real transporter leaks in.
async function freshSendEmail() {
  jest.resetModules();
  const mod = await import('../../utils/notifications/sendEmailNotification.js');
  return mod.sendEmail;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('sendEmail', () => {
  it('forwards attachments through to the transport', async () => {
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'user@test';
    process.env.SMTP_PASS = 'secret';
    sendMailMock.mockResolvedValueOnce({ messageId: 'provider-id-1' });
    const sendEmail = await freshSendEmail();

    const result = await sendEmail({
      to: 'recipient@example.com',
      subject: 'Report',
      text: 'body',
      attachments: [{ filename: 'report.pdf', content: Buffer.from('pdf-bytes'), contentType: 'application/pdf' }],
    });

    expect(result.messageId).toBe('provider-id-1');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const sentArgs = sendMailMock.mock.calls[0][0];
    expect(sentArgs.attachments).toEqual([
      { filename: 'report.pdf', content: Buffer.from('pdf-bytes'), contentType: 'application/pdf' },
    ]);
  });

  it('in receiptMode, resolves a rejected receipt instead of throwing when SMTP is unconfigured', async () => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    const sendEmail = await freshSendEmail();

    const result = await sendEmail({ to: 'a@b.com', subject: 's', receiptMode: true });

    expect(result).toEqual({ outcome: 'rejected', code: 'smtp_not_configured', messageId: null });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('in receiptMode, throws when the transport rejects the send', async () => {
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'user@test';
    process.env.SMTP_PASS = 'secret';
    sendMailMock.mockRejectedValueOnce(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));
    const sendEmail = await freshSendEmail();

    await expect(sendEmail({ to: 'a@b.com', subject: 's', receiptMode: true })).rejects.toThrow(
      'SMTP delivery outcome is uncertain'
    );
  });
});

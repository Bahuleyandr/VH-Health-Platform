import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_A = '11111111-1111-4111-8111-111111111111';
const PATIENT_B = '22222222-2222-4222-8222-222222222222';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const sendEmailMock = jest.fn();
const sendWhatsAppMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
    $executeRawUnsafe: executeRawUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../utils/notifications/sendEmailNotification.js', () => ({
  sendEmail: sendEmailMock,
}));

jest.unstable_mockModule('../../utils/notifications/sendWhatsAppNotification.js', () => ({
  sendWhatsApp: sendWhatsAppMock,
}));

const { createPaymentLink, sendPaymentLink } = await import('../../services/billing/paymentLinkService.js');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.HOSPITAL_UPI_VPA = 'hospital@upi';
  process.env.HOSPITAL_UPI_PAYEE_NAME = 'VH Hospital';
  process.env.HOSPITAL_PAY_BASE_URL = 'https://pay.vhhealth.app/pay';
  executeRawUnsafeMock.mockResolvedValue(1);
});

describe('paymentLinkService tenant and server-owned destination controls', () => {
  it('resolves invoice ownership inside tenant and ignores caller UPI payee overrides', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 22, patient_uid: PATIENT_A }])
      .mockResolvedValueOnce([{ id: 5, invoice_id: 22, patient_uid: PATIENT_A }]);

    await createPaymentLink({
      tenantId: TENANT,
      invoice_id: 22,
      patient_uid: PATIENT_A,
      amount: 2500,
      upi_payee_vpa: 'attacker@upi',
      upi_payee_name: 'Attacker',
    });

    const [resolveSql, ...resolveParams] = queryRawUnsafeMock.mock.calls[0];
    expect(resolveSql).toContain('FROM billing_invoices');
    expect(resolveSql).toContain('tenant_id = $2::uuid');
    expect(resolveParams).toEqual([22, TENANT]);

    const [, , , , , , insertedVpa, insertedPayeeName] = queryRawUnsafeMock.mock.calls[1];
    expect(insertedVpa).toBe('hospital@upi');
    expect(insertedPayeeName).toBe('VH Hospital');
  });

  it('rejects a payment link when request patient_uid does not match the tenant-scoped invoice', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 22, patient_uid: PATIENT_A }]);

    await expect(
      createPaymentLink({
        tenantId: TENANT,
        invoice_id: 22,
        patient_uid: PATIENT_B,
        amount: 2500,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PAYMENT_LINK_PATIENT_MISMATCH',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('builds send URLs from server configuration, not caller-supplied bases', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 5,
        link_token: 'tok_123',
        amount: '2500',
        status: 'created',
      }])
      .mockResolvedValueOnce([{
        id: 5,
        link_token: 'tok_123',
        amount: '2500',
        status: 'sent',
      }]);

    await sendPaymentLink({
      tenantId: TENANT,
      link_token: 'tok_123',
      channels: ['email'],
      patient_email: 'patient@example.test',
      hospital_short_url_base: 'https://evil.example/pay',
    });

    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('https://pay.vhhealth.app/pay/tok_123'),
      html: expect.stringContaining('https://pay.vhhealth.app/pay/tok_123'),
    }));
    expect(sendEmailMock.mock.calls[0][0].text).not.toContain('evil.example');
  });
});

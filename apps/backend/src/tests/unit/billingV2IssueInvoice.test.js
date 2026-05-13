import { jest } from '@jest/globals';

const mockPrisma = { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { issueInvoice } = await import('../../services/billing/billingV2Service.js');

// Finding: 2026-05-09-inpatient-admission-billing-invoice-missing-patient-fields
// At issue time, billing_invoices must auto-populate patient_name,
// patient_phone, doctor_uid, and department from users + admissions if
// the caller did not pre-fill them. GST B2C invoices with null
// recipient name are statutorily invalid.
describe('billing v2 issueInvoice — GST recipient-field backfill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
  });

  it('backfills patient_name, patient_phone, doctor_uid, and department on issue', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000001';
    mockPrisma.$queryRawUnsafe
      // 1) initial status check
      .mockResolvedValueOnce([{ id: 11, status: 'DRAFT', tenant_id: tenantId }])
      // 2) item count check
      .mockResolvedValueOnce([{ c: 2 }])
      // 3) nextInvoiceNumber counter UPSERT
      .mockResolvedValueOnce([{ next_value: 2 }])
      // 4) tpa-cap meta lookup (no admission)
      .mockResolvedValueOnce([{
        admission_id: null,
        patient_uid: null,
        tenant_id: tenantId,
        total_amount: '0',
      }])
      // 5) getInvoice -> invoices SELECT
      .mockResolvedValueOnce([{ id: 11, invoice_number: 'INV-2026-000001' }])
      // 6) getInvoice -> items SELECT
      .mockResolvedValueOnce([])
      // 7) getInvoice -> payments SELECT
      .mockResolvedValueOnce([]);

    await issueInvoice(11);

    const updateCall = mockPrisma.$executeRawUnsafe.mock.calls.find(
      (c) => /UPDATE\s+billing_invoices/i.test(c[0]) && /SET\s+invoice_number/i.test(c[0]),
    );
    expect(updateCall).toBeTruthy();
    const sql = updateCall[0];

    // Statutory snapshot fields must be filled from users/admissions
    // joins, preferring the value the caller already supplied (COALESCE).
    expect(sql).toMatch(/patient_name\s*=\s*COALESCE/i);
    expect(sql).toMatch(/FROM\s+users\s+u\s+WHERE\s+u\.uid\s*=\s*billing_invoices\.patient_uid/i);
    expect(sql).toMatch(/patient_phone\s*=\s*COALESCE/i);
    expect(sql).toMatch(/SELECT\s+u\.phone/i);
    expect(sql).toMatch(/doctor_uid\s*=\s*COALESCE/i);
    expect(sql).toMatch(/SELECT\s+a\.attending_doctor/i);
    expect(sql).toMatch(/department\s*=\s*COALESCE/i);
    expect(sql).toMatch(/SELECT\s+a\.department\s+FROM\s+admissions/i);
  });
});

import { jest } from '@jest/globals';

const mockPrisma = { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() };
const postInvoiceIssueEntry = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  isTenantTransactionClient: (value) => value === mockPrisma,
  setTenantTx: async (_tenantId, fn) => fn(mockPrisma),
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../services/billing/ledger/ledgerPostings.js', () => ({
  postInvoiceIssueEntry,
  postPaymentEntry: jest.fn(),
  postAdvanceCollectEntry: jest.fn(),
  postAdvanceSettleEntry: jest.fn(),
  postPaymentReversalEntry: jest.fn(),
  postRefundApproveEntry: jest.fn(),
  postRefundPaidEntry: jest.fn(),
}));

jest.unstable_mockModule('../../services/billing/ledger/ledgerAuthoritativeMode.js', () => ({
  resolveLedgerWiring: async () => ({ mode: 'shadow', sameTx: false, postCommit: true, skip: false }),
  resolveLedgerModeForTenant: async () => 'shadow',
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
      // 2) locked status recheck
      .mockResolvedValueOnce([{ id: 11, status: 'DRAFT', tenant_id: tenantId }])
      // 3) item count check
      .mockResolvedValueOnce([{ c: 2 }])
      // 4) nextInvoiceNumber counter UPSERT
      .mockResolvedValueOnce([{ next_value: 2 }])
      // 5) tpa-cap meta lookup (no admission)
      .mockResolvedValueOnce([{
        admission_id: null,
        patient_uid: null,
        tenant_id: tenantId,
        total_amount: '0',
      }])
      // 6) getInvoice -> invoices SELECT
      .mockResolvedValueOnce([{ id: 11, invoice_number: 'INV-2026-000001' }])
      // 7) getInvoice -> items SELECT
      .mockResolvedValueOnce([])
      // 8) getInvoice -> payments SELECT
      .mockResolvedValueOnce([])
      // 9) getInvoice -> advance settlements SELECT
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

    const issueMetaSql = mockPrisma.$queryRawUnsafe.mock.calls.find(
      (c) => /AS\s+ledger_issue_amount/i.test(c[0]),
    )?.[0];
    expect(issueMetaSql).toMatch(
      /GREATEST\(total_amount\s*-\s*COALESCE\(credit_note_amount,\s*0\),\s*0\)\s+AS\s+ledger_issue_amount/i,
    );
  });

  it('posts only the net receivable when a draft invoice already has an applied credit', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000001';
    const patientUid = '11111111-1111-4111-8111-111111111111';
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 12, status: 'DRAFT', tenant_id: tenantId }])
      .mockResolvedValueOnce([{ id: 12, status: 'DRAFT', tenant_id: tenantId }])
      .mockResolvedValueOnce([{ c: 1 }])
      .mockResolvedValueOnce([{ next_value: 3 }])
      .mockResolvedValueOnce([{
        admission_id: null,
        patient_uid: patientUid,
        tenant_id: tenantId,
        total_amount: '25.00',
        ledger_issue_amount: '12.50',
        tax_amount: '0.00',
      }])
      .mockResolvedValueOnce([{ id: 12, invoice_number: 'INV-2026-000002' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await issueInvoice(12, { tenantId });

    expect(postInvoiceIssueEntry).toHaveBeenCalledTimes(1);
    expect(postInvoiceIssueEntry).toHaveBeenCalledWith({
      invoice: {
        id: 12,
        patient_uid: patientUid,
        total_amount: '12.50',
        tax_amount: '0.00',
      },
      tenantId,
    });
  });
});

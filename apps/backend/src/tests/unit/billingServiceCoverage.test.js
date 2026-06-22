// Unit coverage for src/services/billing/billingService.js (roadmap B3.2).
//
// The integration suite (src/tests/billing.test.js) drives the early methods
// (createInvoice/recordPayment/getPatientInvoices/getInvoiceDetail/
// getRevenueStats/submitInsuranceClaim/updateClaimStatus/getInsuranceClaims)
// through the HTTP routes against a live DB, but the large `createEnhancementClaim`
// raw-SQL block (lines ~577-699) plus several validation / edge branches across
// the service were uncovered. This file is a *self-contained* unit suite with a
// fully-mocked Prisma so a SCOPED coverage run (which only executes this file)
// exercises the whole service to >=80% statements without needing the QA DB.
//
// Prisma-mock convention matches the sibling billing unit tests
// (billingDailyCollectionIst.test.js / billingLegacyTenantAuthorization.test.js):
// jest.unstable_mockModule('../../lib/prisma.js', () => ({ default, setTenantTx, ... }))
// and setTenantTx delegates to a per-test transaction mock so wrapped writes run.

import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';

// ── Prisma mock ─────────────────────────────────────────────────────────────
// Each model method is an independent jest.fn() so per-test assertions and
// resolved values stay isolated. $queryRaw / $queryRawUnsafe cover the raw-SQL
// paths in getRevenueStats + createEnhancementClaim.
const mockPrisma = {
  invoices: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    groupBy: jest.fn(),
    aggregate: jest.fn(),
  },
  insurance_claims: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  payment_transactions: {
    create: jest.fn(),
    groupBy: jest.fn(),
  },
  $queryRaw: jest.fn(),
  $queryRawUnsafe: jest.fn(),
};

// The interactive-transaction client handed to scopedTx/setTenantTx callbacks.
// Defaults to the same surface as the top-level mock; createEnhancementClaim
// uses tx.$queryRawUnsafe, recordPayment uses tx.payment_transactions/tx.invoices.
const txClient = {
  payment_transactions: { create: jest.fn() },
  invoices: { update: jest.fn() },
  $queryRawUnsafe: jest.fn(),
};

// setTenantTx is used two ways in the service:
//   - via scopedTx(tenantId, fn) for recordPayment / getPatientInvoices / getInsuranceClaims
//   - directly as setTenantTx(parent.tenant_id, fn) for createEnhancementClaim
// In both cases the wrapped writes must actually run, so the mock delegates the
// callback to the per-test transaction client.
const setTenantTx = jest.fn(async (_tenantId, fn) => fn(txClient));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenantTx,
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const billingService = (await import('../../services/billing/billingService.js')).default;
const { AppError } = await import('../../utils/AppError.js');

beforeEach(() => {
  jest.clearAllMocks();
  // Safe defaults — individual tests override as needed.
  mockPrisma.invoices.findFirst.mockResolvedValue(null);
  mockPrisma.invoices.findMany.mockResolvedValue([]);
  mockPrisma.invoices.count.mockResolvedValue(0);
  mockPrisma.invoices.create.mockResolvedValue({});
  mockPrisma.invoices.update.mockResolvedValue({});
  mockPrisma.insurance_claims.findFirst.mockResolvedValue(null);
  mockPrisma.insurance_claims.findUnique.mockResolvedValue(null);
  mockPrisma.insurance_claims.findMany.mockResolvedValue([]);
  mockPrisma.insurance_claims.count.mockResolvedValue(0);
  mockPrisma.insurance_claims.create.mockResolvedValue({});
  mockPrisma.insurance_claims.update.mockResolvedValue({});
  mockPrisma.payment_transactions.create.mockResolvedValue({});
  mockPrisma.payment_transactions.groupBy.mockResolvedValue([]);
  mockPrisma.$queryRaw.mockResolvedValue([]);
  mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
  txClient.payment_transactions.create.mockResolvedValue({});
  txClient.invoices.update.mockResolvedValue({});
  txClient.$queryRawUnsafe.mockResolvedValue([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// createInvoice
// ─────────────────────────────────────────────────────────────────────────────
describe('createInvoice', () => {
  const valid = {
    patient_uid: PATIENT_UID,
    type: 'Consultation',
    items: [{ description: 'x', amount: 100 }],
    subtotal: 100,
    total_amount: 118,
  };

  it('rejects a missing patient_uid', async () => {
    await expect(billingService.createInvoice({ ...valid, patient_uid: undefined }))
      .rejects.toThrow(/Patient UID is required/i);
  });

  it('rejects an invalid invoice type', async () => {
    await expect(billingService.createInvoice({ ...valid, type: 'bogus' }))
      .rejects.toThrow(/Invalid invoice type/i);
  });

  it('rejects a missing / non-array / empty items list', async () => {
    await expect(billingService.createInvoice({ ...valid, items: undefined }))
      .rejects.toThrow(/At least one line item/i);
    await expect(billingService.createInvoice({ ...valid, items: 'nope' }))
      .rejects.toThrow(/At least one line item/i);
    await expect(billingService.createInvoice({ ...valid, items: [] }))
      .rejects.toThrow(/At least one line item/i);
  });

  it('rejects null subtotal or null total_amount', async () => {
    await expect(billingService.createInvoice({ ...valid, subtotal: null }))
      .rejects.toThrow(/Subtotal and total_amount are required/i);
    await expect(billingService.createInvoice({ ...valid, total_amount: null }))
      .rejects.toThrow(/Subtotal and total_amount are required/i);
  });

  it('creates an invoice, lowercasing type + payment_method, with a generated number and tenant', async () => {
    mockPrisma.invoices.findFirst.mockResolvedValueOnce(null); // no prior invoice → seq 1
    mockPrisma.invoices.create.mockResolvedValueOnce({ id: 7, invoice_number: 'INV-X' });

    const out = await billingService.createInvoice({
      ...valid,
      payment_method: 'CASH',
      appointment_id: 42,
      notes: 'hi',
      issued_by: 'admin-1',
      due_date: '2026-07-01',
      tenant_id: TENANT,
    });

    expect(out).toEqual({ id: 7, invoice_number: 'INV-X' });
    const data = mockPrisma.invoices.create.mock.calls[0][0].data;
    expect(data.type).toBe('consultation');
    expect(data.payment_method).toBe('cash');
    expect(data.appointment_id).toBe(42);
    expect(data.tenant_id).toBe(TENANT);
    expect(data.due_date).toBeInstanceOf(Date);
    expect(data.invoice_number).toMatch(/^INV-\d{6}-0001$/);
  });

  it('continues the sequence from the last invoice number and applies nullish defaults', async () => {
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    mockPrisma.invoices.findFirst.mockResolvedValueOnce({ invoice_number: `INV-${ym}-0041` });
    mockPrisma.invoices.create.mockResolvedValueOnce({ id: 8 });

    await billingService.createInvoice(valid); // no payment_method / due_date / tenant_id

    const data = mockPrisma.invoices.create.mock.calls[0][0].data;
    expect(data.invoice_number).toBe(`INV-${ym}-0042`);
    expect(data.payment_method).toBeNull();
    expect(data.appointment_id).toBeNull();
    expect(data.notes).toBeNull();
    expect(data.issued_by).toBeNull();
    expect(data.due_date).toBeNull();
    expect(data.tenant_id).toBeUndefined(); // tenant spread is empty
    expect(data.tax_amount).toBe(0);
    expect(data.discount_amount).toBe(0);
  });

  it('falls back to sequence 1 when the last invoice number is non-numeric (NaN guard)', async () => {
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    mockPrisma.invoices.findFirst.mockResolvedValueOnce({ invoice_number: `INV-${ym}-NOTANUM` });
    mockPrisma.invoices.create.mockResolvedValueOnce({ id: 9 });

    await billingService.createInvoice(valid);

    const data = mockPrisma.invoices.create.mock.calls[0][0].data;
    expect(data.invoice_number).toBe(`INV-${ym}-0001`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recordPayment
// ─────────────────────────────────────────────────────────────────────────────
describe('recordPayment', () => {
  it('rejects a missing invoiceId', async () => {
    await expect(billingService.recordPayment(null, 100, 'cash'))
      .rejects.toThrow(/Invoice ID is required/i);
  });

  it('rejects a non-positive amount', async () => {
    await expect(billingService.recordPayment(1, 0, 'cash'))
      .rejects.toThrow(/greater than zero/i);
    await expect(billingService.recordPayment(1, -5, 'cash'))
      .rejects.toThrow(/greater than zero/i);
  });

  it('rejects an invalid payment method', async () => {
    await expect(billingService.recordPayment(1, 100, 'barter'))
      .rejects.toThrow(/Invalid payment method/i);
  });

  it('404s when the invoice is not found', async () => {
    // H2: the invoice is now read via the FOR UPDATE lock (tx.$queryRawUnsafe)
    // INSIDE the tx, not findFirst outside it. An empty lock result → not found.
    txClient.$queryRawUnsafe.mockResolvedValueOnce([]);
    await expect(billingService.recordPayment(1, 100, 'cash'))
      .rejects.toThrow(/Invoice not found/i);
  });

  it('rejects a payment that would exceed the remaining balance', async () => {
    txClient.$queryRawUnsafe.mockResolvedValueOnce([{
      id: 1, total_amount: '100.00', paid_amount: '90.00', payment_status: 'partial',
    }]);
    await expect(billingService.recordPayment(1, 50, 'cash'))
      .rejects.toThrow(/exceed the remaining balance of 10\.00/i);
  });

  it('records a partial payment (status partial, paid_at null) and runs both writes in the tx', async () => {
    txClient.$queryRawUnsafe.mockResolvedValueOnce([{
      id: 1, total_amount: '100.00', paid_amount: '0', payment_status: 'pending',
    }]);
    txClient.invoices.update.mockResolvedValueOnce({ id: 1, payment_status: 'partial' });
    txClient.payment_transactions.create.mockResolvedValueOnce({ id: 11 });

    const out = await billingService.recordPayment(1, 50, 'UPI', 'cashier-1', 'TXN-1', TENANT);

    expect(setTenantTx).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(txClient.payment_transactions.create).toHaveBeenCalledTimes(1);
    // The row is locked FOR UPDATE before the balance check + writes (H2).
    expect(txClient.$queryRawUnsafe.mock.calls[0][0]).toMatch(/FOR UPDATE/i);
    const updateArg = txClient.invoices.update.mock.calls[0][0].data;
    expect(updateArg.payment_status).toBe('partial');
    expect(updateArg.paid_amount).toBe(50);
    expect(updateArg.paid_at).toBeNull();
    expect(out).toEqual({ invoice: { id: 1, payment_status: 'partial' }, transaction: { id: 11 } });
  });

  it('records a final payment (status paid, paid_at set) when it clears the balance', async () => {
    txClient.$queryRawUnsafe.mockResolvedValueOnce([{
      id: 2, total_amount: '100.00', paid_amount: '40.00', payment_status: 'partial',
    }]);
    txClient.invoices.update.mockResolvedValueOnce({ id: 2, payment_status: 'paid' });
    txClient.payment_transactions.create.mockResolvedValueOnce({ id: 12 });

    await billingService.recordPayment(2, 60, 'card');

    // falsy tenantId → scopedTx falls back to DEFAULT_TENANT_ID inside setTenantTx
    expect(setTenantTx).toHaveBeenCalledTimes(1);
    const updateArg = txClient.invoices.update.mock.calls[0][0].data;
    expect(updateArg.payment_status).toBe('paid');
    expect(updateArg.paid_at).toBeInstanceOf(Date);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPatientInvoices
// ─────────────────────────────────────────────────────────────────────────────
describe('getPatientInvoices', () => {
  it('rejects a missing patientUid', async () => {
    await expect(billingService.getPatientInvoices(null))
      .rejects.toThrow(/Patient UID is required/i);
  });

  it('builds an unfiltered where + pagination when no filters/tenant supplied', async () => {
    txClient.invoices = mockPrisma.invoices; // route count/findMany through the shared mock for assertions
    mockPrisma.invoices.count.mockResolvedValueOnce(0);
    mockPrisma.invoices.findMany.mockResolvedValueOnce([]);

    const out = await billingService.getPatientInvoices(PATIENT_UID, {});

    expect(mockPrisma.invoices.count).toHaveBeenCalledWith({ where: { patient_uid: PATIENT_UID } });
    expect(out.pagination).toMatchObject({ total: 0, page: 1 });
    // restore tx client for later tests
    txClient.invoices = { update: jest.fn().mockResolvedValue({}) };
  });

  it('applies status/type/date filters and tenant scoping', async () => {
    txClient.invoices = mockPrisma.invoices;
    mockPrisma.invoices.count.mockResolvedValueOnce(3);
    mockPrisma.invoices.findMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const out = await billingService.getPatientInvoices(
      PATIENT_UID,
      {
        status: 'paid',
        type: 'Pharmacy',
        date_from: '2026-01-01',
        date_to: '2026-12-31',
        limit: 2,
        page: 1,
      },
      { tenantId: TENANT },
    );

    const where = mockPrisma.invoices.count.mock.calls[0][0].where;
    expect(where).toMatchObject({
      patient_uid: PATIENT_UID,
      tenant_id: TENANT,
      payment_status: 'paid',
      type: 'pharmacy',
    });
    expect(where.issued_at.gte).toBeInstanceOf(Date);
    expect(where.issued_at.lte).toBeInstanceOf(Date);
    expect(out.invoices).toHaveLength(3);
    expect(out.pagination.total).toBe(3);
    txClient.invoices = { update: jest.fn().mockResolvedValue({}) };
  });

  it('ignores an unknown status/type and a date_from-only range', async () => {
    txClient.invoices = mockPrisma.invoices;
    mockPrisma.invoices.count.mockResolvedValueOnce(0);
    mockPrisma.invoices.findMany.mockResolvedValueOnce([]);

    await billingService.getPatientInvoices(
      PATIENT_UID,
      { status: 'not-a-status', type: 'not-a-type', date_from: '2026-03-01' },
    );

    const where = mockPrisma.invoices.count.mock.calls[0][0].where;
    expect(where.payment_status).toBeUndefined();
    expect(where.type).toBeUndefined();
    expect(where.issued_at.gte).toBeInstanceOf(Date);
    expect(where.issued_at.lte).toBeUndefined();
    txClient.invoices = { update: jest.fn().mockResolvedValue({}) };
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getInvoiceDetail
// ─────────────────────────────────────────────────────────────────────────────
describe('getInvoiceDetail', () => {
  it('rejects a missing invoiceId', async () => {
    await expect(billingService.getInvoiceDetail(undefined))
      .rejects.toThrow(/Invoice ID is required/i);
  });

  it('404s when the invoice does not exist', async () => {
    mockPrisma.invoices.findFirst.mockResolvedValueOnce(null);
    await expect(billingService.getInvoiceDetail(1)).rejects.toThrow(/Invoice not found/i);
  });

  it('forbids a PATIENT requester reading another patient\'s invoice', async () => {
    mockPrisma.invoices.findFirst.mockResolvedValueOnce({
      id: 1, patient_uid: PATIENT_UID, insurance_claim_id: null,
    });
    await expect(
      billingService.getInvoiceDetail(1, { requester: { role: 'PATIENT', uid: 'someone-else' } }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'BILLING_PATIENT_ACCESS_DENIED' });
  });

  it('allows the owning PATIENT (case-insensitive uid) and returns a null insurance_claim when unlinked', async () => {
    mockPrisma.invoices.findFirst.mockResolvedValueOnce({
      id: 1, patient_uid: PATIENT_UID.toUpperCase(), insurance_claim_id: null,
      payment_transactions: [],
    });
    const out = await billingService.getInvoiceDetail(1, {
      requester: { role: 'patient', uid: PATIENT_UID },
    });
    expect(out.insurance_claim).toBeNull();
    expect(out.id).toBe(1);
  });

  it('hydrates the linked insurance claim when insurance_claim_id is set, scoped by tenant', async () => {
    mockPrisma.invoices.findFirst.mockResolvedValueOnce({
      id: 5, patient_uid: PATIENT_UID, insurance_claim_id: 99, payment_transactions: [],
    });
    mockPrisma.insurance_claims.findFirst.mockResolvedValueOnce({ id: 99, claim_number: 'CLM-X' });

    const out = await billingService.getInvoiceDetail(5, { tenantId: TENANT });

    expect(mockPrisma.insurance_claims.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 99, tenant_id: TENANT,
    });
    expect(out.insurance_claim).toEqual({ id: 99, claim_number: 'CLM-X' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getRevenueStats
// ─────────────────────────────────────────────────────────────────────────────
describe('getRevenueStats', () => {
  it('rejects a missing date range', async () => {
    await expect(billingService.getRevenueStats(null, '2026-12-31'))
      .rejects.toThrow(/dateFrom and dateTo are required/i);
    await expect(billingService.getRevenueStats('2026-01-01', null))
      .rejects.toThrow(/dateFrom and dateTo are required/i);
  });

  it('assembles summary/by_type/by_payment_method/daily_totals from the aggregates', async () => {
    mockPrisma.invoices.groupBy
      .mockResolvedValueOnce([ // by type
        { type: 'consultation', _count: { id: 2 }, _sum: { total_amount: '300', paid_amount: '200' } },
      ])
      .mockResolvedValueOnce([ // status counts
        { payment_status: 'paid', _count: { id: 1 } },
        { payment_status: 'pending', _count: { id: 1 } },
      ]);
    mockPrisma.invoices.aggregate.mockResolvedValueOnce({
      _count: { id: 2 },
      _sum: { total_amount: '300', paid_amount: '200', discount_amount: '10', tax_amount: '20' },
    });
    mockPrisma.payment_transactions.groupBy.mockResolvedValueOnce([
      { payment_method: 'cash', _count: { id: 1 }, _sum: { amount: '200' } },
    ]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ date: '2026-05-01', invoice_count: 2, billed: '300', collected: '200' }]);

    const out = await billingService.getRevenueStats('2026-01-01', '2026-12-31');

    expect(out.summary.total_invoices).toBe(2);
    expect(out.summary.total_outstanding).toBe('100.00');
    expect(out.summary.paid_count).toBe(1);
    expect(out.summary.pending_count).toBe(1);
    expect(out.summary.partial_count).toBe(0);
    expect(out.by_type[0]).toMatchObject({ type: 'consultation', invoice_count: 2, outstanding: '100.00' });
    expect(out.by_payment_method[0]).toMatchObject({ payment_method: 'cash', transaction_count: 1 });
    expect(out.daily_totals).toHaveLength(1);
  });

  it('handles null aggregate sums without NaN (outstanding falls back to 0.00)', async () => {
    mockPrisma.invoices.groupBy
      .mockResolvedValueOnce([
        { type: 'pharmacy', _count: { id: 1 }, _sum: { total_amount: null, paid_amount: null } },
      ])
      .mockResolvedValueOnce([]); // empty status counts → all 0
    mockPrisma.invoices.aggregate.mockResolvedValueOnce({
      _count: { id: 0 },
      _sum: { total_amount: null, paid_amount: null, discount_amount: null, tax_amount: null },
    });
    mockPrisma.payment_transactions.groupBy.mockResolvedValueOnce([]);
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);

    const out = await billingService.getRevenueStats('2026-01-01', '2026-12-31');

    expect(out.summary.total_outstanding).toBe('0.00');
    expect(out.summary.paid_count).toBe(0);
    expect(out.by_type[0].outstanding).toBe('0.00');
    expect(out.by_payment_method).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// submitInsuranceClaim
// ─────────────────────────────────────────────────────────────────────────────
describe('submitInsuranceClaim', () => {
  const valid = {
    patient_uid: PATIENT_UID,
    insurance_provider: 'TestCorp',
    policy_number: 'POL-1',
    claim_amount: 5000,
  };

  it('rejects a missing patient_uid', async () => {
    await expect(billingService.submitInsuranceClaim({ ...valid, patient_uid: undefined }))
      .rejects.toThrow(/Patient UID is required/i);
  });

  it('rejects a missing provider or policy number', async () => {
    await expect(billingService.submitInsuranceClaim({ ...valid, insurance_provider: undefined }))
      .rejects.toThrow(/provider and policy number/i);
    await expect(billingService.submitInsuranceClaim({ ...valid, policy_number: undefined }))
      .rejects.toThrow(/provider and policy number/i);
  });

  it('rejects a non-positive claim amount', async () => {
    await expect(billingService.submitInsuranceClaim({ ...valid, claim_amount: 0 }))
      .rejects.toThrow(/greater than zero/i);
  });

  it('404s when a linked invoice_id is not found', async () => {
    mockPrisma.invoices.findFirst.mockResolvedValueOnce(null);
    await expect(billingService.submitInsuranceClaim({ ...valid, invoice_id: 7, tenant_id: TENANT }))
      .rejects.toThrow(/Linked invoice not found/i);
  });

  it('rejects a linked invoice belonging to a different patient', async () => {
    mockPrisma.invoices.findFirst.mockResolvedValueOnce({ id: 7, patient_uid: 'other-patient' });
    await expect(billingService.submitInsuranceClaim({ ...valid, invoice_id: 7 }))
      .rejects.toThrow(/does not belong/i);
  });

  it('creates a standalone claim (no invoice link) with generated number + tenant', async () => {
    mockPrisma.insurance_claims.findFirst.mockResolvedValueOnce(null); // seq 1
    mockPrisma.insurance_claims.create.mockResolvedValueOnce({ id: 3, claim_number: 'CLM-X' });

    const out = await billingService.submitInsuranceClaim({ ...valid, tenant_id: TENANT });

    expect(out).toEqual({ id: 3, claim_number: 'CLM-X' });
    const data = mockPrisma.insurance_claims.create.mock.calls[0][0].data;
    expect(data.claim_number).toMatch(/^CLM-\d{6}-0001$/);
    expect(data.tenant_id).toBe(TENANT);
    expect(data.invoice_id).toBeNull();
    expect(mockPrisma.invoices.update).not.toHaveBeenCalled();
  });

  it('creates an invoice-linked claim, continues the claim sequence, and back-links the invoice', async () => {
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    mockPrisma.invoices.findFirst.mockResolvedValueOnce({ id: 7, patient_uid: PATIENT_UID });
    mockPrisma.insurance_claims.findFirst.mockResolvedValueOnce({ claim_number: `CLM-${ym}-0009` });
    mockPrisma.insurance_claims.create.mockResolvedValueOnce({ id: 4, claim_number: `CLM-${ym}-0010` });

    await billingService.submitInsuranceClaim({ ...valid, invoice_id: 7 });

    expect(mockPrisma.insurance_claims.create.mock.calls[0][0].data.claim_number).toBe(`CLM-${ym}-0010`);
    expect(mockPrisma.invoices.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: expect.objectContaining({ insurance_claim_id: 4 }),
      }),
    );
  });

  it('falls back to claim sequence 1 when the last claim number is non-numeric', async () => {
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    mockPrisma.insurance_claims.findFirst.mockResolvedValueOnce({ claim_number: `CLM-${ym}-XX` });
    mockPrisma.insurance_claims.create.mockResolvedValueOnce({ id: 5 });

    await billingService.submitInsuranceClaim(valid);

    expect(mockPrisma.insurance_claims.create.mock.calls[0][0].data.claim_number).toBe(`CLM-${ym}-0001`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateClaimStatus
// ─────────────────────────────────────────────────────────────────────────────
describe('updateClaimStatus', () => {
  it('rejects a missing claimId', async () => {
    await expect(billingService.updateClaimStatus(null, 'approved'))
      .rejects.toThrow(/Claim ID is required/i);
  });

  it('rejects an invalid status', async () => {
    await expect(billingService.updateClaimStatus(1, 'frobnicated'))
      .rejects.toThrow(/Invalid status/i);
  });

  it('404s when the claim is not found', async () => {
    mockPrisma.insurance_claims.findUnique.mockResolvedValueOnce(null);
    await expect(billingService.updateClaimStatus(1, 'approved'))
      .rejects.toThrow(/Insurance claim not found/i);
  });

  it('legacy string 4th arg is treated as rejection_reason; non-review status leaves reviewed_at null', async () => {
    mockPrisma.insurance_claims.findUnique.mockResolvedValueOnce({ id: 1, documents: null, status: 'submitted' });
    mockPrisma.insurance_claims.update.mockResolvedValueOnce({ id: 1, status: 'under_review' });

    await billingService.updateClaimStatus(1, 'under_review', null, 'some note');

    const data = mockPrisma.insurance_claims.update.mock.calls[0][0].data;
    expect(data.status).toBe('under_review');
    expect(data.rejection_reason).toBe('some note');
    expect(data.reviewed_at).toBeNull();
  });

  it('approved status stamps reviewed_at and persists approved_amount', async () => {
    mockPrisma.insurance_claims.findUnique.mockResolvedValueOnce({ id: 1, documents: null, status: 'submitted' });
    mockPrisma.insurance_claims.update.mockResolvedValueOnce({ id: 1, status: 'approved' });

    await billingService.updateClaimStatus(1, 'approved', 4500);

    const data = mockPrisma.insurance_claims.update.mock.calls[0][0].data;
    expect(data.approved_amount).toBe(4500);
    expect(data.reviewed_at).toBeInstanceOf(Date);
  });

  it('options object: merges a documents patch object into existing documents', async () => {
    mockPrisma.insurance_claims.findUnique.mockResolvedValueOnce({
      id: 1, documents: { existing: true }, status: 'submitted',
    });
    mockPrisma.insurance_claims.update.mockResolvedValueOnce({ id: 1 });

    await billingService.updateClaimStatus(1, 'partially_approved', 3000, {
      documents: { caps: { room: 5000 } },
      rejection_reason: 'partial caps',
      non_payable_amount: 1000,
      disallowed_reason: 'non-medical',
    });

    const data = mockPrisma.insurance_claims.update.mock.calls[0][0].data;
    expect(data.documents).toEqual({ existing: true, caps: { room: 5000 } });
    expect(data.non_payable_amount).toBe(1000);
    expect(data.disallowed_reason).toBe('non-medical');
    expect(data.rejection_reason).toBe('partial caps');
    expect(data.reviewed_at).toBeInstanceOf(Date);
  });

  it('options object: documents=null explicitly clears the documents jsonb', async () => {
    mockPrisma.insurance_claims.findUnique.mockResolvedValueOnce({
      id: 1, documents: { existing: true }, status: 'submitted',
    });
    mockPrisma.insurance_claims.update.mockResolvedValueOnce({ id: 1 });

    await billingService.updateClaimStatus(1, 'rejected', null, { documents: null });

    expect(mockPrisma.insurance_claims.update.mock.calls[0][0].data.documents).toBeNull();
  });

  it('options object: a non-object/non-null documents patch replaces wholesale', async () => {
    mockPrisma.insurance_claims.findUnique.mockResolvedValueOnce({
      id: 1, documents: { existing: true }, status: 'submitted',
    });
    mockPrisma.insurance_claims.update.mockResolvedValueOnce({ id: 1 });

    await billingService.updateClaimStatus(1, 'approved', null, { documents: ['a.pdf', 'b.pdf'] });

    expect(mockPrisma.insurance_claims.update.mock.calls[0][0].data.documents).toEqual(['a.pdf', 'b.pdf']);
  });

  it('paid + payment_reference stamps a payment audit block inside documents (existing docs preserved)', async () => {
    mockPrisma.insurance_claims.findUnique.mockResolvedValueOnce({
      id: 1, documents: { existing: true }, status: 'approved',
    });
    mockPrisma.insurance_claims.update.mockResolvedValueOnce({ id: 1, status: 'paid' });

    await billingService.updateClaimStatus(1, 'paid', 4500, {
      payment_reference: 'PAY-REF-1', actor_uid: 'finance-1',
    });

    const docs = mockPrisma.insurance_claims.update.mock.calls[0][0].data.documents;
    expect(docs.existing).toBe(true);
    expect(docs.payment).toMatchObject({ reference: 'PAY-REF-1', recorded_by: 'finance-1' });
    expect(typeof docs.payment.recorded_at).toBe('string');
  });

  it('paid + payment_reference stamps payment even when merged documents is non-object (spreads {})', async () => {
    mockPrisma.insurance_claims.findUnique.mockResolvedValueOnce({
      id: 1, documents: null, status: 'approved',
    });
    mockPrisma.insurance_claims.update.mockResolvedValueOnce({ id: 1 });

    await billingService.updateClaimStatus(1, 'paid', 4500, { payment_reference: 'PAY-REF-2' });

    const docs = mockPrisma.insurance_claims.update.mock.calls[0][0].data.documents;
    expect(docs.payment.reference).toBe('PAY-REF-2');
    expect(docs.payment.recorded_by).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createEnhancementClaim  (the large previously-uncovered block, ~577-699)
// ─────────────────────────────────────────────────────────────────────────────
describe('createEnhancementClaim', () => {
  const parentRow = {
    id: 10,
    claim_number: 'CLM-202605-0007',
    patient_uid: PATIENT_UID,
    invoice_id: 55,
    insurance_provider: 'TestCorp',
    policy_number: 'POL-9',
    tenant_id: TENANT,
  };

  it('rejects a missing parentClaimId', async () => {
    await expect(billingService.createEnhancementClaim({ enhancementAmount: 100 }))
      .rejects.toThrow(/parentClaimId is required/i);
  });

  it('rejects a non-finite or non-positive enhancementAmount', async () => {
    await expect(billingService.createEnhancementClaim({ parentClaimId: 10, enhancementAmount: 'abc' }))
      .rejects.toThrow(/positive number/i);
    await expect(billingService.createEnhancementClaim({ parentClaimId: 10, enhancementAmount: 0 }))
      .rejects.toThrow(/positive number/i);
    await expect(billingService.createEnhancementClaim({ parentClaimId: 10, enhancementAmount: -50 }))
      .rejects.toThrow(/positive number/i);
  });

  it('propagates a malformed structured clinicalJustification as AppError.badRequest', async () => {
    // normalizeClinicalJustification throws before any DB call (array input).
    await expect(
      billingService.createEnhancementClaim({
        parentClaimId: 10, enhancementAmount: 100, clinicalJustification: ['nope'],
      }),
    ).rejects.toThrow(/must be a string or an object/i);
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('404s when neither insurance_claims nor tpa_claims has the parent id', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([])  // insurance_claims probe → empty
      .mockResolvedValueOnce([]); // tpa_claims probe → empty

    await expect(
      billingService.createEnhancementClaim({ parentClaimId: 999, enhancementAmount: 100 }),
    ).rejects.toMatchObject({ statusCode: 404, message: expect.stringMatching(/Parent insurance claim not found/i) });
    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('routes a tpa_claims id to the preauth workflow guard (TPA_CLAIM_USE_PREAUTH_ENHANCEMENT)', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([]) // insurance_claims miss
      .mockResolvedValueOnce([{ id: 999, claim_number: 'TPA-XYZ' }]); // tpa_claims hit

    await expect(
      billingService.createEnhancementClaim({ parentClaimId: 999, enhancementAmount: 100 }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'TPA_CLAIM_USE_PREAUTH_ENHANCEMENT',
      message: expect.stringMatching(/insurance_preauth enhancement workflow/i),
    });
  });

  it('creates an enhancement child claim with a free-text justification (documents jsonb populated)', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([parentRow]); // insurance_claims hit
    // Inside the tenant tx: count existing enhancements, then INSERT.
    txClient.$queryRawUnsafe
      .mockResolvedValueOnce([{ n: 1 }]) // one existing enhancement → suffix E2
      .mockResolvedValueOnce([{ id: 20, claim_number: 'CLM-202605-0007-E2', stage: 'enhancement' }]);

    const out = await billingService.createEnhancementClaim({
      parentClaimId: 10,
      enhancementAmount: 4000,
      justification: 'patient deteriorated, ICU required',
      actorUid: 'doc-1',
    });

    expect(setTenantTx).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(out).toMatchObject({ id: 20, claim_number: 'CLM-202605-0007-E2' });

    // Suffix allocation derives E(n+1) from the count.
    const insertParams = txClient.$queryRawUnsafe.mock.calls[1];
    expect(insertParams[1]).toBe('CLM-202605-0007-E2'); // claim_number
    expect(insertParams[2]).toBe(PATIENT_UID);          // patient_uid
    expect(insertParams[3]).toBe(55);                   // invoice_id
    expect(insertParams[6]).toBe(4000);                 // amount
    // docsJson ($8) is a JSON string carrying the justification (free_text format).
    const docsJson = JSON.parse(insertParams[8]);
    expect(docsJson.enhancement.justification).toBe('patient deteriorated, ICU required');
    expect(docsJson.enhancement.justification_format).toBe('free_text');
    expect(docsJson.enhancement.requested_by).toBe('doc-1');
  });

  it('defaults the enhancement suffix to E1 when no prior enhancements exist and caps the base number length', async () => {
    const longParent = { ...parentRow, claim_number: 'CLM-202605-0007-VERYLONGSUFFIXxxxxxxx', invoice_id: null };
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([longParent]);
    txClient.$queryRawUnsafe
      .mockResolvedValueOnce([{}]) // countRows[0].n is undefined → nextSuffix 1
      .mockResolvedValueOnce([{ id: 21, claim_number: 'capped-E1' }]);

    await billingService.createEnhancementClaim({ parentClaimId: 10, enhancementAmount: 1500 });

    const insertParams = txClient.$queryRawUnsafe.mock.calls[1];
    const base = 'CLM-202605-0007-VERYLONGSUFFIXxxxxxxx'.slice(0, 26);
    expect(insertParams[1]).toBe(`${base}-E1`); // E1 default + 26-char cap
    expect(insertParams[3]).toBeNull();         // null invoice_id passthrough
    expect(insertParams[8]).toBeNull();         // no justification → docsJson null
  });

  it('builds a structured-justification documents block when a template object is passed', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([parentRow]);
    txClient.$queryRawUnsafe
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([{ id: 22, claim_number: 'CLM-202605-0007-E1' }]);

    await billingService.createEnhancementClaim({
      parentClaimId: 10,
      enhancementAmount: 2500,
      clinicalJustification: {
        clinical_reason: 'Sepsis with AKI',
        additional_los_days: 3,
      },
    });

    const docsJson = JSON.parse(txClient.$queryRawUnsafe.mock.calls[1][8]);
    expect(docsJson.enhancement.justification_format).toBe('structured');
    expect(docsJson.enhancement.justification_structured.clinical_reason).toBe('Sepsis with AKI');
    expect(docsJson.enhancement.template_version).toBe(1);
  });

  it('logs and rethrows a Postgres error raised by the INSERT inside the tx', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([parentRow]);
    const pgErr = Object.assign(new Error('duplicate key value'), { code: '23505' });
    txClient.$queryRawUnsafe
      .mockResolvedValueOnce([{ n: 0 }])
      .mockRejectedValueOnce(pgErr); // INSERT fails

    await expect(
      billingService.createEnhancementClaim({ parentClaimId: 10, enhancementAmount: 999 }),
    ).rejects.toThrow(/duplicate key value/i);

    const { default: logger } = await import('../../logging/logger.js');
    expect(logger.error).toHaveBeenCalledWith(
      'createEnhancementClaim insert failed',
      expect.objectContaining({ parentClaimId: 10, amount: 999, code: '23505' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getInsuranceClaims
// ─────────────────────────────────────────────────────────────────────────────
describe('getInsuranceClaims', () => {
  it('returns an unfiltered, untenanted list with pagination', async () => {
    txClient.insurance_claims = mockPrisma.insurance_claims;
    mockPrisma.insurance_claims.count.mockResolvedValueOnce(0);
    mockPrisma.insurance_claims.findMany.mockResolvedValueOnce([]);

    const out = await billingService.getInsuranceClaims({}, {});

    expect(mockPrisma.insurance_claims.count).toHaveBeenCalledWith({ where: {} });
    expect(out.pagination).toMatchObject({ total: 0, page: 1 });
    delete txClient.insurance_claims;
  });

  it('applies patient_uid + status filters and tenant scoping', async () => {
    txClient.insurance_claims = mockPrisma.insurance_claims;
    mockPrisma.insurance_claims.count.mockResolvedValueOnce(2);
    mockPrisma.insurance_claims.findMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    const out = await billingService.getInsuranceClaims(
      { patient_uid: PATIENT_UID, status: 'approved' },
      { tenantId: TENANT },
    );

    expect(mockPrisma.insurance_claims.count.mock.calls[0][0].where).toEqual({
      tenant_id: TENANT,
      patient_uid: PATIENT_UID,
      status: 'approved',
    });
    expect(out.claims).toHaveLength(2);
    expect(out.pagination.total).toBe(2);
    delete txClient.insurance_claims;
  });

  it('ignores an unknown status value', async () => {
    txClient.insurance_claims = mockPrisma.insurance_claims;
    mockPrisma.insurance_claims.count.mockResolvedValueOnce(0);
    mockPrisma.insurance_claims.findMany.mockResolvedValueOnce([]);

    await billingService.getInsuranceClaims({ status: 'not-real' }, {});

    expect(mockPrisma.insurance_claims.count.mock.calls[0][0].where.status).toBeUndefined();
    delete txClient.insurance_claims;
  });
});

// AppError is imported to keep the contract explicit; assert the factory shape
// the service relies on so a refactor of AppError that breaks these is caught.
describe('AppError contract (sanity)', () => {
  it('badRequest/notFound/forbidden carry the expected status codes', () => {
    expect(AppError.badRequest('x').statusCode).toBe(400);
    expect(AppError.notFound('x').statusCode).toBe(404);
    expect(AppError.forbidden('x').statusCode).toBe(403);
  });
});

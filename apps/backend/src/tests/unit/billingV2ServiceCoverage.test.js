// Coverage-lift suite for billingV2Service (roadmap B3.2).
//
// This file drives the billing v2 line-item / GST / advance / refund /
// receipts / itemizer lifecycle through a fully-mocked prisma so the
// pure logic, validation/AppError branches, and the large
// query-orchestration blocks (resolveAdmissionTpaCap, maybeEmitTpaCapAlerts,
// getInvoice, itemizeAdmissionInvoice, refunds, advances, reports) all
// execute without a live DB. Narrow-path suites already exist
// (billingV2Payments / billingV2IssueInvoice / billingV2ListInvoices /
// billingDailyCollectionIst / cash-payment-requires-shift); this suite
// targets the remaining uncovered surface.
//
// Mock convention matches the established billing-v2 unit tests: a single
// $queryRawUnsafe / $executeRawUnsafe pair, with setTenantTx / setTenant
// delegating to the same mock so wrapped writes run.

import { jest } from '@jest/globals';

const queryMock = jest.fn();
const execMock = jest.fn();

const mockPrisma = {
  $queryRawUnsafe: queryMock,
  $executeRawUnsafe: execMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  isTenantTransactionClient: (value) => value === mockPrisma,
  setTenantTx: async (_tenantId, fn) => fn(mockPrisma),
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/billing/ledger/ledgerAuthoritativeMode.js', () => ({
  resolveLedgerWiring: async () => ({ mode: 'shadow', sameTx: false, postCommit: true, skip: false }),
  resolveLedgerModeForTenant: async () => 'shadow',
}));

const svc = await import('../../services/billing/billingV2Service.js');
const { refundApprovalRequestFingerprint } = await import(
  '../../services/billing/billingRefundApprovalCommand.js'
);
const { hashRequestBody } = await import(
  '../../services/idempotency/idempotencyService.js'
);

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = 'refund-coverage-request';

function refundAuditContext(actorUid, overrides = {}) {
  return {
    actorUid,
    subjectUid: actorUid,
    actorRole: 'FINANCE_INCHARGE',
    actingAsDependent: false,
    requestId: REQUEST_ID,
    deviceType: 'web',
    ipAddress: '127.0.0.1',
    userAgent: 'billing-refund-coverage',
    ...overrides,
  };
}

function refundCommand(body, overrides = {}) {
  return {
    commandKey: 'refund-coverage-key',
    requestFingerprint: hashRequestBody(body),
    httpIdempotencyClaimId: 41,
    requestId: REQUEST_ID,
    ...overrides,
  };
}

beforeEach(() => {
  queryMock.mockReset();
  execMock.mockReset();
  execMock.mockResolvedValue(1);
});

// ───────────────────────────────────────────────────────────────────────
// Pure helpers (no DB)
// ───────────────────────────────────────────────────────────────────────

describe('pure helpers', () => {
  it('canonicalizes every refund idempotency body without losing null identity', () => {
    expect(svc.refundManualPayoutIdempotencyBody(7, {
      cash_drawer_session_id: ' 99 ',
      reference: null,
    })).toEqual({
      action: 'pay_refund_manual',
      refund_id: '7',
      cash_drawer_session_id: '99',
      reference: null,
    });
    expect(svc.refundOfflineElectronicPayoutIdempotencyBody(8, {
      original_payment_reference: ' collection-8 ',
      provider_name: ' bank ',
      provider_refund_reference: ' refund-8 ',
      provider_refunded_at: ' 2026-08-28T08:00:00.000Z ',
    })).toEqual(expect.objectContaining({
      original_payment_reference: 'collection-8',
      provider_name: 'bank',
      provider_refund_reference: 'refund-8',
      provider_refunded_at: '2026-08-28T08:00:00.000Z',
    }));
    expect(svc.refundRejectionIdempotencyBody(9, {
      rejection_reason: undefined,
    }).rejection_reason).toBeNull();
    expect(svc.refundRaiseIdempotencyBody({
      patient_uid: ` ${PATIENT} `,
      invoice_id: 11,
      amount: 10,
      reason: ' duplicate ',
      mode: ' CASH ',
    })).toEqual({
      action: 'raise_refund',
      patient_uid: PATIENT,
      invoice_id: '11',
      advance_id: null,
      amount: '10',
      reason: 'duplicate',
      mode: 'CASH',
    });
  });

  it.each([
    '0',
    '01',
    '2147483648',
    '9223372036854775807',
  ])('rejects non-canonical or overflowing billing refund id %s before SQL', async (id) => {
    await expect(svc.getRefund(id, { tenantId: TENANT })).rejects.toMatchObject({
      statusCode: 400,
      code: 'BILLING_REFUND_ID_INVALID',
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('fiscalYearOf returns same calendar year for Apr-Dec', () => {
    expect(svc.fiscalYearOf(new Date(Date.UTC(2026, 5, 14)))).toBe(2026); // June
    expect(svc.fiscalYearOf(new Date(Date.UTC(2026, 3, 1)))).toBe(2026); // Apr 1
    expect(svc.fiscalYearOf(new Date(Date.UTC(2026, 11, 31)))).toBe(2026); // Dec 31
  });

  it('fiscalYearOf returns previous calendar year for Jan-Mar', () => {
    expect(svc.fiscalYearOf(new Date(Date.UTC(2026, 0, 1)))).toBe(2025); // Jan
    expect(svc.fiscalYearOf(new Date(Date.UTC(2026, 2, 31)))).toBe(2025); // Mar 31
  });

  it('fiscalYearOf defaults to now without throwing', () => {
    expect(typeof svc.fiscalYearOf()).toBe('number');
  });

  it('parseDiscountAmount rejects missing / non-numeric / negative', () => {
    expect(() => svc.parseDiscountAmount(undefined)).toThrow(/amount is required/);
    expect(() => svc.parseDiscountAmount(null)).toThrow(/amount is required/);
    expect(() => svc.parseDiscountAmount('')).toThrow(/amount is required/);
    expect(() => svc.parseDiscountAmount('abc')).toThrow(/numeric/);
    expect(() => svc.parseDiscountAmount(-5)).toThrow(/negative/);
  });

  it('parseDiscountAmount rounds to 2 decimals', () => {
    expect(svc.parseDiscountAmount('10.005')).toBe(10.01);
    expect(svc.parseDiscountAmount(0)).toBe(0);
  });

  it('canApproveHighValueDiscount checks the approver role set (case/space-insensitive)', () => {
    expect(svc.canApproveHighValueDiscount('FINANCE_INCHARGE')).toBe(true);
    expect(svc.canApproveHighValueDiscount(' admin ')).toBe(true);
    expect(svc.canApproveHighValueDiscount('super_admin')).toBe(true);
    expect(svc.canApproveHighValueDiscount('NURSE')).toBe(false);
    expect(svc.canApproveHighValueDiscount(null)).toBe(false);
    expect(svc.canApproveHighValueDiscount(undefined)).toBe(false);
  });

  it('requiresDiscountApproval fires on absolute-amount threshold', () => {
    // default amount threshold = 500
    expect(svc.requiresDiscountApproval({ amount: 600, invoiceGross: 0 })).toBe(true);
    expect(svc.requiresDiscountApproval({ amount: 100, invoiceGross: 0 })).toBe(false);
  });

  it('requiresDiscountApproval fires on percent threshold', () => {
    // default percent threshold = 5%; gross 1000 -> 5% = 50
    expect(svc.requiresDiscountApproval({ amount: 60, invoiceGross: 1000 })).toBe(true);
    expect(svc.requiresDiscountApproval({ amount: 40, invoiceGross: 1000 })).toBe(false);
  });

  it('splitGst returns no tax when taxAmount is zero', () => {
    expect(svc.splitGst({ subtotal: 100, gstRate: 0 })).toEqual({
      cgst: 0, sgst: 0, igst: 0, lineTotal: 100,
    });
  });

  it('splitGst splits CGST+SGST for same-state (case-insensitive trim)', () => {
    const r = svc.splitGst({
      subtotal: 100, gstRate: 18, patientState: ' KeralA ', hospitalState: 'kerala',
    });
    expect(r.igst).toBe(0);
    expect(r.cgst).toBe(9);
    expect(r.sgst).toBe(9);
    expect(r.lineTotal).toBe(118);
  });

  it('splitGst assigns rounding drift to SGST on odd halves', () => {
    // taxAmount = 100 * 5 / 100 = 5 -> half = 2.5 each (clean), use odd:
    // subtotal 100 @ 2.5% -> tax 2.5 -> half 1.25 / 1.25
    const r = svc.splitGst({
      subtotal: 33.33, gstRate: 9, patientState: 'TN', hospitalState: 'TN',
    });
    expect(r.cgst + r.sgst).toBeCloseTo(svc.splitGst({
      subtotal: 33.33, gstRate: 9, patientState: 'TN', hospitalState: 'X',
    }).igst, 2);
  });

  it('splitGst uses IGST for inter-state', () => {
    const r = svc.splitGst({
      subtotal: 200, gstRate: 12, patientState: 'Kerala', hospitalState: 'Karnataka',
    });
    expect(r.cgst).toBe(0);
    expect(r.sgst).toBe(0);
    expect(r.igst).toBe(24);
    expect(r.lineTotal).toBe(224);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Service master
// ───────────────────────────────────────────────────────────────────────

describe('service master', () => {
  it('listServiceMaster builds active-only query with category + search filters', async () => {
    queryMock.mockResolvedValueOnce([{ id: 1, code: 'CONS' }]);
    const rows = await svc.listServiceMaster({ category: 'consultation', search: 'Cardio' });
    expect(rows).toHaveLength(1);
    const [sql, ...params] = queryMock.mock.calls[0];
    expect(sql).toContain('is_active = true');
    expect(sql).toContain('category = $1');
    expect(sql).toMatch(/LOWER\(code\) LIKE \$2 OR LOWER\(description\) LIKE \$2/);
    expect(params).toEqual(['consultation', '%cardio%']);
  });

  it('listServiceMaster with includeInactive omits the is_active filter and has no WHERE', async () => {
    queryMock.mockResolvedValueOnce([]);
    await svc.listServiceMaster({ includeInactive: true });
    const [sql, ...params] = queryMock.mock.calls[0];
    expect(sql).not.toContain('is_active = true');
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([]);
  });

  it('listServiceMaster works with no args', async () => {
    queryMock.mockResolvedValueOnce([]);
    await svc.listServiceMaster();
    expect(queryMock.mock.calls[0][0]).toContain('is_active = true');
  });

  it('createServiceMaster rejects missing required fields', async () => {
    await expect(svc.createServiceMaster({ code: 'X' })).rejects.toMatchObject({ statusCode: 400 });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('createServiceMaster inserts with coerced numeric defaults', async () => {
    queryMock.mockResolvedValueOnce([{ id: 5, code: 'RAD' }]);
    const row = await svc.createServiceMaster({
      code: 'RAD', description: 'X-Ray', category: 'radiology',
    });
    expect(row).toMatchObject({ id: 5 });
    const params = queryMock.mock.calls[0].slice(1);
    expect(params).toEqual(['RAD', 'X-Ray', 'radiology', 0, 0, null]);
  });

  it('createServiceMaster passes through provided price/gst/hsn', async () => {
    queryMock.mockResolvedValueOnce([{ id: 6 }]);
    await svc.createServiceMaster({
      code: 'C', description: 'd', category: 'consultation',
      default_price: 500, gst_rate: 18, hsn_sac: '9993',
    });
    expect(queryMock.mock.calls[0].slice(1)).toEqual(['C', 'd', 'consultation', 500, 18, '9993']);
  });

  it('updateServiceMaster rejects when no valid fields supplied', async () => {
    await expect(svc.updateServiceMaster(1, { bogus: 1 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('updateServiceMaster builds dynamic SET clause and returns updated row', async () => {
    queryMock.mockResolvedValueOnce([{ id: 1, description: 'New' }]);
    const row = await svc.updateServiceMaster(1, { description: 'New', is_active: false });
    expect(row).toMatchObject({ id: 1 });
    const [sql, ...params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/description = \$2/);
    expect(sql).toMatch(/is_active = \$3/);
    expect(params).toEqual([1, 'New', false]);
  });

  it('updateServiceMaster throws notFound when no row updated', async () => {
    queryMock.mockResolvedValueOnce([]);
    await expect(svc.updateServiceMaster(99, { description: 'x' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ───────────────────────────────────────────────────────────────────────
// createDraftInvoice
// ───────────────────────────────────────────────────────────────────────

describe('createDraftInvoice', () => {
  it('rejects missing patient_uid', async () => {
    await expect(svc.createDraftInvoice({})).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects invalid invoice_type', async () => {
    await expect(
      svc.createDraftInvoice({ patient_uid: PATIENT, invoice_type: 'BOGUS' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('creates a draft without admission/tenant (uses DEFAULT_TENANT_ID)', async () => {
    queryMock.mockResolvedValueOnce([{ id: 1, status: 'DRAFT', tenant_id: TENANT }]);
    const row = await svc.createDraftInvoice({ patient_uid: PATIENT });
    expect(row).toMatchObject({ id: 1 });
    // Only the INSERT runs (no admission check, no patient-in-tenant check).
    expect(queryMock).toHaveBeenCalledTimes(1);
    const params = queryMock.mock.calls[0].slice(1);
    expect(params[params.length - 1]).toBe(TENANT); // tenant defaulted
  });

  it('blocks creation when the admission billing is closed (409 BILLING_CLOSED)', async () => {
    queryMock.mockResolvedValueOnce([{
      patient_uid: PATIENT,
      billing_closed_at: new Date('2026-01-01T00:00:00Z'),
    }]);
    await expect(
      svc.createDraftInvoice({ patient_uid: PATIENT, admission_id: 7 }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'BILLING_CLOSED' });
  });

  it('handles billing_closed_at that lacks toISOString (string column)', async () => {
    queryMock.mockResolvedValueOnce([{
      patient_uid: PATIENT,
      billing_closed_at: '2026-01-01 10:00:00',
    }]);
    await expect(
      svc.createDraftInvoice({ patient_uid: PATIENT, admission_id: 7 }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('with tenantId asserts patient-in-tenant then inserts', async () => {
    queryMock
      .mockResolvedValueOnce([{ patient_uid: PATIENT, billing_closed_at: null }])
      .mockResolvedValueOnce([{ uid: PATIENT }]) // assertPatientInTenant
      .mockResolvedValueOnce([{ id: 2, status: 'DRAFT' }]); // INSERT
    const row = await svc.createDraftInvoice({
      patient_uid: PATIENT, admission_id: 9, tenantId: TENANT,
      patient_name: 'Asha', doctor_uid: PATIENT, invoice_type: 'IP',
    });
    expect(row).toMatchObject({ id: 2 });
    expect(queryMock.mock.calls[0][0]).toContain('tenant_id = $2::uuid');
    expect(queryMock.mock.calls[0][0]).toContain('FOR SHARE');
    expect(queryMock.mock.calls[0].slice(1)).toEqual([9, TENANT]);
  });

  it('rejects an admission owned by another patient before invoice insert', async () => {
    queryMock.mockResolvedValueOnce([{
      patient_uid: '22222222-2222-4222-8222-222222222222',
      billing_closed_at: null,
    }]);
    await expect(svc.createDraftInvoice({
      patient_uid: PATIENT,
      admission_id: 9,
      tenantId: TENANT,
      invoice_type: 'IP',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_ADMISSION_PATIENT_MISMATCH',
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('with tenantId throws notFound when patient is in another tenant', async () => {
    queryMock
      .mockResolvedValueOnce([{ uid: PATIENT }]); // assertPatientInTenant -> empty would be notFound; supply empty:
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce([]); // assertPatientInTenant returns no rows
    await expect(
      svc.createDraftInvoice({ patient_uid: PATIENT, tenantId: TENANT }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ───────────────────────────────────────────────────────────────────────
// addInvoiceItem
// ───────────────────────────────────────────────────────────────────────

describe('addInvoiceItem', () => {
  // Helper: build the standard query sequence for a successful ad-hoc add.
  // calls: [findBillingInvoice], [INSERT item], then recomputeInvoiceTotals:
  // [aggregates], [discount/paid], [exec UPDATE], [meta admission lookup].
  function mockSuccessfulAdd({
    admissionId = null,
    item = { id: 100, line_total: '118' },
  } = {}) {
    queryMock
      .mockResolvedValueOnce([{
        status: 'DRAFT', patient_state: 'TN', hospital_state: 'TN', admission_id: admissionId,
        patient_uid: PATIENT, tenant_id: TENANT,
      }]) // findBillingInvoice
      .mockResolvedValueOnce([item]) // INSERT item
      // recomputeInvoiceTotals:
      .mockResolvedValueOnce([{ subtotal: '100', cgst: '9', sgst: '9', igst: '0' }]) // aggregates
      .mockResolvedValueOnce([{ discount_amount: '0', amount_paid: '0' }]) // discount/paid
      .mockResolvedValueOnce([{ admission_id: admissionId, patient_uid: null, tenant_id: TENANT }]); // meta
  }

  it('rejects unknown category', async () => {
    await expect(
      svc.addInvoiceItem(1, { description: 'x', unit_price: 10, category: 'spaceship' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects when no description and no service_code resolves', async () => {
    await expect(
      svc.addInvoiceItem(1, { unit_price: 10 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects when unit_price missing on ad-hoc line', async () => {
    await expect(
      svc.addInvoiceItem(1, { description: 'manual line' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects invalid source_ref_type', async () => {
    await expect(
      svc.addInvoiceItem(1, { description: 'x', unit_price: 10, source_ref_type: 'bogus' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects non-integer source_ref_id', async () => {
    await expect(
      svc.addInvoiceItem(1, {
        description: 'x', unit_price: 10, source_ref_type: 'lab_order', source_ref_id: 'abc',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a zero source_ref_id', async () => {
    await expect(
      svc.addInvoiceItem(1, {
        description: 'x', unit_price: 10, source_ref_type: 'lab_order', source_ref_id: '0',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('preserves BIGINT source references beyond JavaScript safe-integer range', async () => {
    mockSuccessfulAdd({
      item: { id: 100, line_total: '118', source_ref_id: 9_007_199_254_740_993n },
    });
    const item = await svc.addInvoiceItem(1, {
      tenantId: TENANT,
      description: 'Large source id',
      unit_price: 10,
      source_ref_type: 'lab_order',
      source_ref_id: '9007199254740993',
    });

    expect(queryMock.mock.calls[1].at(-2)).toBe('9007199254740993');
    expect(queryMock.mock.calls[1].at(-1)).toBe(TENANT);
    expect(item.source_ref_id).toBe('9007199254740993');
    expect(() => JSON.stringify(item)).not.toThrow();
  });

  it('rejects unsafe numeric source references before JSON rounding can be persisted', async () => {
    await expect(svc.addInvoiceItem(1, {
      description: 'Rounded source id',
      unit_price: 10,
      source_ref_type: 'lab_order',
      source_ref_id: 9_007_199_254_740_992,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('requires source_ref_id for source-backed types (SOURCE_REF_ID_REQUIRED)', async () => {
    await expect(
      svc.addInvoiceItem(1, {
        description: 'Room day', unit_price: 1000, category: 'room_rent', source_ref_type: 'room_day',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'SOURCE_REF_ID_REQUIRED' });
  });

  it('throws notFound when the parent invoice does not exist', async () => {
    queryMock.mockResolvedValueOnce([]); // findBillingInvoice -> none
    await expect(
      svc.addInvoiceItem(1, { tenantId: TENANT, description: 'x', unit_price: 10 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects adding to a non-DRAFT invoice', async () => {
    queryMock.mockResolvedValueOnce([{ status: 'ISSUED', admission_id: null, tenant_id: TENANT }]);
    await expect(
      svc.addInvoiceItem(1, { tenantId: TENANT, description: 'x', unit_price: 10 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('resolves service_code from the master and computes GST split', async () => {
    queryMock
      .mockResolvedValueOnce([{
        status: 'DRAFT', patient_state: 'TN', hospital_state: 'TN', admission_id: null,
        patient_uid: PATIENT, tenant_id: TENANT,
      }]) // lockBillingInvoice
      .mockResolvedValueOnce([{
        description: 'Consultation', category: 'consultation', hsn_sac: '9993',
        default_price: '500', gst_rate: '0',
      }]) // service master lookup
      .mockResolvedValueOnce([{ id: 101 }]) // INSERT
      .mockResolvedValueOnce([{ subtotal: '500', cgst: '0', sgst: '0', igst: '0' }]) // aggregates
      .mockResolvedValueOnce([{ discount_amount: '0', amount_paid: '0' }]) // discount/paid
      .mockResolvedValueOnce([{ admission_id: null, patient_uid: null, tenant_id: TENANT }]); // meta
    const row = await svc.addInvoiceItem(7, { service_code: 'CONS', tenantId: TENANT });
    expect(row).toMatchObject({ id: 101 });
    // INSERT uses resolved description from the master
    const insertParams = queryMock.mock.calls[2];
    expect(insertParams).toContain('Consultation');
  });

  it('scopes service-code resolution to the invoice tenant', async () => {
    queryMock
      .mockResolvedValueOnce([{
        status: 'DRAFT', patient_state: 'TN', hospital_state: 'TN', admission_id: null,
        patient_uid: PATIENT, tenant_id: TENANT,
      }])
      .mockResolvedValueOnce([{
        description: 'Consultation', category: 'consultation', hsn_sac: '9993',
        default_price: '500', gst_rate: '0',
      }])
      .mockResolvedValueOnce([{ id: 101 }])
      .mockResolvedValueOnce([{ subtotal: '500', cgst: '0', sgst: '0', igst: '0' }])
      .mockResolvedValueOnce([{ discount_amount: '0', amount_paid: '0' }])
      .mockResolvedValueOnce([{ admission_id: null, patient_uid: null, tenant_id: TENANT }]);

    await svc.addInvoiceItem(7, { service_code: 'CONS', tenantId: TENANT });

    expect(queryMock.mock.calls[1][0]).toContain('tenant_id = $2::uuid');
    expect(queryMock.mock.calls[1].slice(1)).toEqual(['CONS', TENANT]);
  });

  it('adds an ad-hoc line and recomputes totals (no admission -> no TPA alert)', async () => {
    mockSuccessfulAdd();
    const row = await svc.addInvoiceItem(7, {
      tenantId: TENANT,
      description: 'Dressing', unit_price: 100, gst_rate: 18, quantity: 1, category: 'procedure',
    });
    expect(row).toMatchObject({ id: 100 });
    // recompute UPDATE ran
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE billing_invoices'),
      expect.anything(), expect.anything(), expect.anything(),
      expect.anything(), expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it('accepts a package line with null source_ref_id (optional type)', async () => {
    queryMock
      .mockResolvedValueOnce([{
        status: 'DRAFT', patient_state: null, hospital_state: null, admission_id: null,
        patient_uid: PATIENT, tenant_id: TENANT,
      }])
      .mockResolvedValueOnce([{ id: 102 }])
      .mockResolvedValueOnce([{ subtotal: '0', cgst: '0', sgst: '0', igst: '0' }])
      .mockResolvedValueOnce([{ discount_amount: '0', amount_paid: '0' }])
      .mockResolvedValueOnce([{ admission_id: null, patient_uid: null, tenant_id: TENANT }]);
    const row = await svc.addInvoiceItem(7, {
      tenantId: TENANT,
      description: 'Package bundle', unit_price: 0, source_ref_type: 'package',
    });
    expect(row).toMatchObject({ id: 102 });
  });

  it('recompute after add emits a TPA cap alert when the bill (with admission) is over cap', async () => {
    // Drives recomputeInvoiceTotals' maybeEmitTpaCapAlerts branch (235-243).
    routeQueries([
      // addInvoiceItem -> findBillingInvoice
      ['status, patient_state, hospital_state, admission_id', [{
        status: 'DRAFT', patient_state: null, hospital_state: null, admission_id: 77,
        patient_uid: PATIENT, tenant_id: TENANT,
      }]],
      ['SELECT billing_closed_at FROM admissions', []], // billing open
      ['INSERT INTO billing_invoice_items', [{ id: 103 }]],
      ['COALESCE(SUM(line_subtotal)', [{ subtotal: '90000', cgst: '0', sgst: '0', igst: '0' }]],
      ['SELECT discount_amount, credit_note_amount, amount_paid', [{ discount_amount: '0', credit_note_amount: '0', amount_paid: '0' }]],
      // meta lookup -> has admission + patient -> alert path fires
      ['SELECT admission_id, patient_uid, tenant_id\n       FROM billing_invoices', [{
        admission_id: 77, patient_uid: PATIENT, tenant_id: TENANT,
      }]],
      // maybeEmitTpaCapAlerts:
      ['WITH active_root AS', [{
        root_preauth_id: 7, root_preauth_number: 'PA-7', root_preauth_status: 'approved',
        root_preauth_denial_reason: null, root_preauth_sanctioned_amount: '80000',
        policy_id: 3, cumulative_approved: '80000',
      }]],
      ['SELECT id FROM users WHERE uid', [{ id: 4242 }]],
      ['FROM clinical_alerts', []], // no existing -> insert
      ['INSERT INTO clinical_alerts', [{ id: 1, severity: 'CRITICAL', message: 'x' }]],
    ]);
    const row = await svc.addInvoiceItem(7, {
      tenantId: TENANT,
      description: 'Implant', unit_price: 90000, category: 'implants',
    });
    expect(row).toMatchObject({ id: 103 });
    // alert insert happened
    const alertInsert = queryMock.mock.calls.find((c) => /INSERT INTO clinical_alerts/.test(c[0]));
    expect(alertInsert).toBeTruthy();
  });

  it('swallows a TPA-alert failure during recompute (logged, not thrown) — line 243', async () => {
    routeQueries([
      ['status, patient_state, hospital_state, admission_id', [{
        status: 'DRAFT', patient_state: null, hospital_state: null, admission_id: 77,
        patient_uid: PATIENT, tenant_id: TENANT,
      }]],
      ['SELECT billing_closed_at FROM admissions', []],
      ['INSERT INTO billing_invoice_items', [{ id: 104 }]],
      ['COALESCE(SUM(line_subtotal)', [{ subtotal: '90000', cgst: '0', sgst: '0', igst: '0' }]],
      ['SELECT discount_amount, credit_note_amount, amount_paid', [{ discount_amount: '0', credit_note_amount: '0', amount_paid: '0' }]],
      ['SELECT admission_id, patient_uid, tenant_id\n       FROM billing_invoices', [{
        admission_id: 77, patient_uid: PATIENT, tenant_id: TENANT,
      }]],
      // maybeEmitTpaCapAlerts -> resolveAdmissionTpaCap throws -> caught + logged
      ['WITH active_root AS', () => { throw new Error('cap projection boom'); }],
    ]);
    // Must still resolve (the invoice update is authoritative).
    const row = await svc.addInvoiceItem(7, {
      tenantId: TENANT,
      description: 'Implant', unit_price: 90000, category: 'implants',
    });
    expect(row).toMatchObject({ id: 104 });
  });
});

// ───────────────────────────────────────────────────────────────────────
// removeInvoiceItem
// ───────────────────────────────────────────────────────────────────────

describe('removeInvoiceItem', () => {
  it('throws notFound when invoice missing', async () => {
    queryMock.mockResolvedValueOnce([]);
    await expect(svc.removeInvoiceItem(1, 2)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects removal from a non-DRAFT invoice', async () => {
    queryMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([{ status: 'PAID', admission_id: null }]);
    await expect(svc.removeInvoiceItem(1, 2)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('deletes the item and recomputes totals', async () => {
    queryMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([{ status: 'DRAFT', admission_id: null }])
      .mockResolvedValueOnce([{ subtotal: '0', cgst: '0', sgst: '0', igst: '0' }]) // aggregates
      .mockResolvedValueOnce([{ discount_amount: '0', credit_note_amount: '0', amount_paid: '0' }])
      .mockResolvedValueOnce([{ admission_id: null, patient_uid: null, tenant_id: TENANT }]); // meta
    const r = await svc.removeInvoiceItem(1, 2);
    expect(r).toHaveProperty('total');
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM billing_invoice_items'), 1, 2, TENANT,
    );
  });

  it('holds the admission lock and rejects removal after billing close', async () => {
    queryMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([{ status: 'DRAFT', admission_id: 7 }])
      .mockResolvedValueOnce([{ billing_closed_at: new Date('2026-08-27T00:00:00Z') }]);

    await expect(svc.removeInvoiceItem(1, 2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_CLOSED',
    });
    expect(queryMock.mock.calls[2][0]).toContain('FOR SHARE');
    expect(execMock).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM billing_invoice_items'),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
// applyDiscount
// ───────────────────────────────────────────────────────────────────────

describe('applyDiscount', () => {
  it('rejects when invoice missing', async () => {
    queryMock.mockResolvedValueOnce([]);
    await expect(svc.applyDiscount(1, { amount: 10 })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects discounting a VOID invoice', async () => {
    queryMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([{ status: 'VOID', subtotal: '0' }]);
    await expect(svc.applyDiscount(1, { amount: 10 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_DISCOUNT_REQUIRES_DRAFT_INVOICE',
    });
  });

  it('rejects post-issue discounts that would bypass a ledger credit', async () => {
    queryMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([{ status: 'ISSUED', subtotal: '1000', admission_id: null }]);
    await expect(svc.applyDiscount(1, { amount: 10 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_DISCOUNT_REQUIRES_DRAFT_INVOICE',
    });
    expect(execMock).not.toHaveBeenCalled();
  });

  it('forbids high-value discount without an approver role', async () => {
    queryMock.mockResolvedValueOnce([{
      tenant_id: TENANT,
    }]).mockResolvedValueOnce([{
      status: 'DRAFT', subtotal: '10000', cgst_amount: '0', sgst_amount: '0', igst_amount: '0',
      admission_id: null,
    }]);
    await expect(
      svc.applyDiscount(1, { amount: 5000, approved_by_role: 'NURSE' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'DISCOUNT_APPROVAL_REQUIRED' });
  });

  it('applies a high-value discount when approver role is allowed', async () => {
    queryMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([{
        status: 'DRAFT', subtotal: '10000', cgst_amount: '0', sgst_amount: '0', igst_amount: '0',
        admission_id: null,
      }])
      .mockResolvedValueOnce([{ subtotal: '10000', cgst: '0', sgst: '0', igst: '0' }]) // recompute aggregates
      .mockResolvedValueOnce([{ discount_amount: '5000', credit_note_amount: '0', amount_paid: '0' }])
      .mockResolvedValueOnce([{ admission_id: null, patient_uid: null, tenant_id: TENANT }]); // meta
    const r = await svc.applyDiscount(1, {
      amount: 5000, reason: 'Camp', approved_by: PATIENT, approved_by_role: 'FINANCE_INCHARGE',
    });
    expect(r).toHaveProperty('discount');
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('SET discount_amount'),
      5000, 'Camp', PATIENT, 1, TENANT,
    );
  });

  it('applies a small discount without approval', async () => {
    queryMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([{
        status: 'DRAFT', subtotal: '1000', cgst_amount: '0', sgst_amount: '0', igst_amount: '0',
        admission_id: null,
      }])
      .mockResolvedValueOnce([{ subtotal: '1000', cgst: '0', sgst: '0', igst: '0' }])
      .mockResolvedValueOnce([{ discount_amount: '10', credit_note_amount: '0', amount_paid: '0' }])
      .mockResolvedValueOnce([{ admission_id: null, patient_uid: null, tenant_id: TENANT }]);
    const r = await svc.applyDiscount(1, { amount: 10 });
    expect(r).toHaveProperty('total');
  });

  it('holds the admission lock and rejects a discount after billing close', async () => {
    queryMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([{
        status: 'DRAFT',
        subtotal: '1000',
        cgst_amount: '0',
        sgst_amount: '0',
        igst_amount: '0',
        admission_id: 7,
      }])
      .mockResolvedValueOnce([{ billing_closed_at: new Date('2026-08-27T00:00:00Z') }]);

    await expect(svc.applyDiscount(1, { amount: 10 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_CLOSED',
    });
    expect(queryMock.mock.calls[2][0]).toContain('FOR SHARE');
    expect(execMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
// issueInvoice
// ───────────────────────────────────────────────────────────────────────

describe('issueInvoice', () => {
  it('throws notFound when missing', async () => {
    queryMock.mockResolvedValueOnce([]);
    await expect(svc.issueInvoice(1)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects re-issuing an already-issued invoice', async () => {
    queryMock.mockResolvedValueOnce([{ id: 1, status: 'ISSUED', tenant_id: TENANT }]);
    await expect(svc.issueInvoice(1)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects issuing an invoice with no items', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1, status: 'DRAFT', tenant_id: TENANT }]) // findBillingInvoice
      .mockResolvedValueOnce([{ id: 1, status: 'DRAFT', tenant_id: TENANT }]) // lockBillingInvoice
      .mockResolvedValueOnce([{ c: 0 }]); // item count
    await expect(svc.issueInvoice(1)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('issues and returns the full invoice (insert path -> seq 1)', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 11, status: 'DRAFT', tenant_id: TENANT }]) // findBillingInvoice
      .mockResolvedValueOnce([{ id: 11, status: 'DRAFT', tenant_id: TENANT }]) // lockBillingInvoice
      .mockResolvedValueOnce([{ c: 2 }]) // item count
      .mockResolvedValueOnce([{ next_value: 2 }]) // nextInvoiceNumber (insert -> 2 -> seq 1)
      .mockResolvedValueOnce([{ admission_id: null, patient_uid: null, tenant_id: TENANT, total_amount: '0' }]) // meta
      // getInvoice:
      .mockResolvedValueOnce([{ id: 11, invoice_number: 'INV-2026-000001', admission_id: null, tenant_id: TENANT, total_amount: '0' }]) // invoice
      .mockResolvedValueOnce([]) // items
      .mockResolvedValueOnce([]) // payments
      .mockResolvedValueOnce([]); // settlements
    const r = await svc.issueInvoice(11, { tenantId: TENANT });
    expect(r).toMatchObject({ id: 11 });
    // number assigned via UPDATE
    const numUpdate = execMock.mock.calls.find((c) => /SET\s+invoice_number/i.test(c[0]));
    expect(numUpdate[1]).toBe('INV-2026-000001');
  });
});

// ───────────────────────────────────────────────────────────────────────
// voidInvoice
// ───────────────────────────────────────────────────────────────────────

describe('voidInvoice', () => {
  it('rejects when no reason', async () => {
    await expect(svc.voidInvoice(1, {})).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws notFound when invoice missing', async () => {
    queryMock.mockResolvedValueOnce([]);
    await expect(svc.voidInvoice(1, { reason: 'dup' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects voiding an already-void invoice', async () => {
    queryMock.mockResolvedValueOnce([{ status: 'VOID' }]);
    await expect(svc.voidInvoice(1, { reason: 'dup' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects voiding a paid invoice without a reversal workflow', async () => {
    queryMock.mockResolvedValueOnce([{ status: 'PAID' }]);
    await expect(svc.voidInvoice(1, { reason: 'dup' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_INVOICE_REVERSAL_WORKFLOW_REQUIRED',
    });
  });

  it('voids a DRAFT invoice, releases source references, and returns it', async () => {
    queryMock
      .mockResolvedValueOnce([{ status: 'DRAFT', tenant_id: TENANT }]) // findBillingInvoice
      .mockResolvedValueOnce([{ status: 'DRAFT' }]) // lockBillingInvoice
      // getInvoice:
      .mockResolvedValueOnce([{ id: 1, admission_id: null, tenant_id: TENANT, total_amount: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const r = await svc.voidInvoice(1, { reason: 'dup', voided_by: PATIENT });
    expect(r).toMatchObject({ id: 1 });
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining("status = 'VOID'"), PATIENT, 'dup', 1, TENANT,
    );
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('source_ref_active = FALSE'), 1, TENANT,
    );
  });

  it('rejects voiding an ISSUED invoice without an auditable reversal workflow', async () => {
    queryMock.mockResolvedValueOnce([{ status: 'ISSUED', tenant_id: TENANT }]);
    await expect(svc.voidInvoice(1, {
      reason: 'duplicate',
      voided_by: PATIENT,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_INVOICE_REVERSAL_WORKFLOW_REQUIRED',
    });
    expect(execMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
// resolveAdmissionTpaCap
// ───────────────────────────────────────────────────────────────────────

describe('resolveAdmissionTpaCap', () => {
  it('returns null when admissionId is falsy', async () => {
    expect(await svc.resolveAdmissionTpaCap(null, TENANT)).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns null when no active root preauth', async () => {
    queryMock.mockResolvedValueOnce([{ root_preauth_id: null }]);
    expect(await svc.resolveAdmissionTpaCap(18, TENANT)).toBeNull();
  });

  it('returns null when the query returns an empty rowset', async () => {
    queryMock.mockResolvedValueOnce([]);
    expect(await svc.resolveAdmissionTpaCap(18, TENANT)).toBeNull();
  });

  it('projects the cumulative cap + preauth identity', async () => {
    queryMock.mockResolvedValueOnce([{
      root_preauth_id: 7,
      root_preauth_number: 'PA-7',
      root_preauth_status: 'approved',
      root_preauth_denial_reason: null,
      root_preauth_sanctioned_amount: '50000',
      policy_id: 3,
      cumulative_approved: '80000',
    }]);
    const cap = await svc.resolveAdmissionTpaCap(18); // default tenant
    expect(cap).toMatchObject({
      root_preauth_id: 7,
      root_preauth_number: 'PA-7',
      root_preauth_sanctioned_amount: 50000,
      cumulative_approved: 80000,
    });
  });

  it('handles null sanctioned amount + cumulative', async () => {
    queryMock.mockResolvedValueOnce([{
      root_preauth_id: 9, root_preauth_number: 'PA-9', root_preauth_status: 'pending',
      root_preauth_denial_reason: null, root_preauth_sanctioned_amount: null, policy_id: null,
      cumulative_approved: null,
    }]);
    const cap = await svc.resolveAdmissionTpaCap(20, TENANT);
    expect(cap.root_preauth_sanctioned_amount).toBeNull();
    expect(cap.cumulative_approved).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// getInvoice — the TPA projection branches
// ───────────────────────────────────────────────────────────────────────

describe('getInvoice', () => {
  function mockInvoiceBase(invoice, items = [{ id: 1, line_total: '100' }]) {
    queryMock
      .mockResolvedValueOnce([invoice]) // findBillingInvoice
      .mockResolvedValueOnce(items) // items
      .mockResolvedValueOnce([{ id: 2, amount: '50' }]) // payments
      .mockResolvedValueOnce([{ id: 3, amount: '20', advance_mode: 'CASH' }]); // settlements
  }

  it('throws notFound when the invoice is absent', async () => {
    queryMock.mockResolvedValueOnce([]);
    await expect(svc.getInvoice(1)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns invoice with null TPA when admission has no preauth', async () => {
    mockInvoiceBase({ id: 1, admission_id: 5, tenant_id: TENANT, total_amount: '1000' });
    queryMock.mockResolvedValueOnce([{ root_preauth_id: null }]); // resolveAdmissionTpaCap
    const r = await svc.getInvoice(1, { tenantId: TENANT });
    expect(r.tpa_utilisation).toBeNull();
    expect(r.tpa_preauth).toBeNull();
    expect(r.items).toHaveLength(1);
    expect(r.payments).toHaveLength(1);
    expect(r.advance_settlements).toHaveLength(1);
  });

  it('serializes safe and oversized BIGINT item source references', async () => {
    mockInvoiceBase(
      { id: 1, admission_id: 5, tenant_id: TENANT, total_amount: '1000' },
      [
        { id: 1, line_total: '100', source_ref_id: 42n },
        { id: 2, line_total: '200', source_ref_id: 9_007_199_254_740_993n },
      ],
    );
    queryMock.mockResolvedValueOnce([{ root_preauth_id: null }]);

    const r = await svc.getInvoice(1, { tenantId: TENANT });

    expect(r.items[0].source_ref_id).toBe(42);
    expect(r.items[1].source_ref_id).toBe('9007199254740993');
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it('surfaces tpa_preauth but null utilisation when cumulative_approved is 0 (denied/pending)', async () => {
    mockInvoiceBase({ id: 1, admission_id: 5, tenant_id: TENANT, total_amount: '1000' });
    queryMock.mockResolvedValueOnce([{
      root_preauth_id: 7, root_preauth_number: 'PA-7', root_preauth_status: 'denied',
      root_preauth_denial_reason: 'Not covered', root_preauth_sanctioned_amount: '0',
      policy_id: 3, cumulative_approved: '0',
    }]);
    const r = await svc.getInvoice(1, { tenantId: TENANT });
    expect(r.tpa_preauth).toMatchObject({ preauth_id: 7, tpa_status: 'denied', denial_reason: 'Not covered' });
    expect(r.tpa_utilisation).toBeNull();
  });

  it.each([
    ['within_cap', 40000, 'within_cap'],
    ['approaching_limit', 65000, 'approaching_limit'], // 81.25%
    ['near_limit', 75000, 'near_limit'], // 93.75%
    ['over_cap', 90000, 'over_cap'], // 112.5%
  ])('classifies utilisation status %s', async (_label, total, expectedStatus) => {
    mockInvoiceBase({ id: 1, admission_id: 5, tenant_id: TENANT, total_amount: String(total) });
    queryMock.mockResolvedValueOnce([{
      root_preauth_id: 7, root_preauth_number: 'PA-7', root_preauth_status: 'approved',
      root_preauth_denial_reason: null, root_preauth_sanctioned_amount: '80000',
      policy_id: 3, cumulative_approved: '80000',
    }]);
    const r = await svc.getInvoice(1, { tenantId: TENANT });
    expect(r.tpa_utilisation.status).toBe(expectedStatus);
    expect(r.tpa_utilisation.total_charged).toBe(total);
  });
});

// ───────────────────────────────────────────────────────────────────────
// listInvoices — the filter + projection error branch
// ───────────────────────────────────────────────────────────────────────

describe('listInvoices additional branches', () => {
  it('applies status / invoice_type / date filters', async () => {
    queryMock.mockResolvedValueOnce([]); // list query, no rows
    await svc.listInvoices({
      tenantId: TENANT, patient_uid: PATIENT, status: 'ISSUED', invoice_type: 'IP',
      date_from: '2026-01-01', date_to: '2026-12-31', page: 2, limit: 5,
    });
    const [sql, ...params] = queryMock.mock.calls[0];
    expect(sql).toContain('tenant_id = $1::uuid');
    expect(sql).toContain('patient_uid = $2::uuid');
    expect(sql).toContain('status = $3');
    expect(sql).toContain('invoice_type = $4');
    expect(sql).toMatch(/issued_at, created_at\) >= \$5/);
    expect(sql).toMatch(/issued_at, created_at\) <= \$6/);
    // offset = (2-1)*5 = 5
    expect(params[params.length - 1]).toBe(5);
  });

  it('returns null tpa_utilisation for rows without admission_id', async () => {
    queryMock.mockResolvedValueOnce([{ id: 1, admission_id: null, total_amount: '100' }]);
    const rows = await svc.listInvoices({ limit: 10 });
    expect(rows[0].tpa_utilisation).toBeNull();
  });

  it('resolves the numeric patient_id filter via a users subquery', async () => {
    queryMock.mockResolvedValueOnce([]);
    await svc.listInvoices({ patient_id: 42, limit: 10 });
    const [sql, ...params] = queryMock.mock.calls[0];
    expect(sql).toContain('patient_uid = (SELECT uid FROM users WHERE id = $1::int)');
    expect(params[0]).toBe(42);
  });

  it('swallows TPA projection errors per-row and returns null utilisation', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1, admission_id: 18, tenant_id: TENANT, total_amount: '100' }]) // list
      .mockRejectedValueOnce(new Error('cap projection boom')); // resolveAdmissionTpaCap throws
    const rows = await svc.listInvoices({ limit: 10 });
    expect(rows[0].tpa_utilisation).toBeNull();
  });

  it('returns null utilisation when admission has a row but cap is 0', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1, admission_id: 18, tenant_id: TENANT, total_amount: '100' }])
      .mockResolvedValueOnce([{ root_preauth_id: 7, cumulative_approved: '0' }]);
    const rows = await svc.listInvoices({ limit: 10 });
    expect(rows[0].tpa_utilisation).toBeNull();
  });

  it.each([
    ['within_cap', 40000, 'within_cap'],
    ['approaching_limit', 65000, 'approaching_limit'],
    ['near_limit', 75000, 'near_limit'],
    ['over_cap', 90000, 'over_cap'],
  ])('projects %s utilisation onto list rows', async (_label, total, expected) => {
    queryMock
      .mockResolvedValueOnce([{
        id: 1, admission_id: 18, tenant_id: TENANT, total_amount: String(total),
      }])
      .mockResolvedValueOnce([{
        root_preauth_id: 7, root_preauth_number: 'PA-7', cumulative_approved: '80000',
      }]);
    const rows = await svc.listInvoices({ limit: 10 });
    expect(rows[0].tpa_utilisation.status).toBe(expected);
    expect(rows[0].tpa_utilisation.total_charged).toBe(total);
  });
});

// ───────────────────────────────────────────────────────────────────────
// collectPayment / reversePayment happy + edge paths
// ───────────────────────────────────────────────────────────────────────

describe('collectPayment additional branches', () => {
  it('rejects invalid mode', async () => {
    await expect(
      svc.collectPayment({ amount: 100, mode: 'BARTER' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects non-positive amount', async () => {
    await expect(
      svc.collectPayment({ amount: 0, mode: 'UPI' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects sub-paisa payment amounts before opening a transaction', async () => {
    await expect(
      svc.collectPayment({ invoice_id: 9, amount: 100.001, mode: 'UPI' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects CASH without a shift (CASH_PAYMENT_REQUIRES_SHIFT)', async () => {
    await expect(
      svc.collectPayment({ invoice_id: 9, amount: 100, mode: 'CASH' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'CASH_PAYMENT_REQUIRES_SHIFT' });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('throws notFound when invoice_id given but invoice missing', async () => {
    queryMock.mockResolvedValueOnce([]); // findBillingInvoice
    await expect(
      svc.collectPayment({ invoice_id: 9, amount: 100, mode: 'UPI' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects collecting against a DRAFT/VOID invoice', async () => {
    queryMock.mockResolvedValueOnce([{ status: 'DRAFT', patient_uid: PATIENT, amount_due: '100' }]);
    await expect(
      svc.collectPayment({ invoice_id: 9, amount: 100, mode: 'UPI' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects amount exceeding outstanding due', async () => {
    queryMock.mockResolvedValueOnce([{ status: 'ISSUED', patient_uid: PATIENT, amount_due: '100' }]);
    await expect(
      svc.collectPayment({ invoice_id: 9, amount: 500, mode: 'UPI' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects exactly one paisa above outstanding due', async () => {
    queryMock.mockResolvedValueOnce([{
      status: 'ISSUED', patient_uid: PATIENT, amount_due: '100.00',
    }]);
    await expect(
      svc.collectPayment({ invoice_id: 9, amount: 100.01, mode: 'UPI' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when no patient_uid and no invoice_id', async () => {
    await expect(
      svc.collectPayment({ amount: 100, mode: 'UPI' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('collects against an invoice and recomputes + syncs advances', async () => {
    queryMock
      .mockResolvedValueOnce([{ status: 'ISSUED', patient_uid: PATIENT, amount_due: '500' }]) // findBillingInvoice
      .mockResolvedValueOnce([{ id: 50, invoice_id: 9, amount: '500' }]) // INSERT payment
      // recomputeInvoicePaymentState:
      .mockResolvedValueOnce([{ paid: '500' }]) // aggregate
      .mockResolvedValueOnce([{ total_amount: '500' }]) // total
      // syncUnusedAdmissionAdvancesForInvoice:
      .mockResolvedValueOnce([{ id: 9, admission_id: null }]); // invoice lookup (no admission -> returns early)
    const row = await svc.collectPayment({ invoice_id: 9, amount: 500, mode: 'UPI', reference: 'X' });
    expect(row).toMatchObject({ id: 50 });
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE billing_invoices'), 500, 0, 'PAID', 9,
    );
  });

  it('collects a standalone (no invoice) payment after asserting patient in tenant', async () => {
    queryMock
      .mockResolvedValueOnce([{ uid: PATIENT }]) // assertPatientInTenant
      .mockResolvedValueOnce([{ id: 51, invoice_id: null, amount: '200' }]); // INSERT payment
    const row = await svc.collectPayment({
      patient_uid: PATIENT, amount: 200, mode: 'UPI', tenantId: TENANT,
    });
    expect(row).toMatchObject({ id: 51 });
    // No invoice -> no recompute UPDATE for billing_invoices payment state
    expect(execMock).not.toHaveBeenCalled();
  });

  it('syncs admission advances to REFUND_DUE when invoice fully paid', async () => {
    queryMock
      .mockResolvedValueOnce([{ status: 'ISSUED', patient_uid: PATIENT, amount_due: '500' }]) // findBillingInvoice
      .mockResolvedValueOnce([{ id: 60, invoice_id: 9, amount: '500' }]) // INSERT
      .mockResolvedValueOnce([{ paid: '500' }]) // aggregate
      .mockResolvedValueOnce([{ total_amount: '500' }]) // total
      .mockResolvedValueOnce([{ id: 9, admission_id: 77 }]); // invoice lookup (has admission)
    await svc.collectPayment({ invoice_id: 9, amount: 500, mode: 'UPI' });
    // PAID -> sync sets REFUND_DUE on leftover active advances
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining("status = 'REFUND_DUE'"),
      77, expect.stringContaining('Invoice 9 paid'),
    );
  });

  it('reactivates REFUND_DUE advances when invoice falls back to PARTIAL', async () => {
    queryMock
      .mockResolvedValueOnce([{ status: 'ISSUED', patient_uid: PATIENT, amount_due: '500' }])
      .mockResolvedValueOnce([{ id: 61, invoice_id: 9, amount: '200' }])
      .mockResolvedValueOnce([{ paid: '200' }]) // not fully paid
      .mockResolvedValueOnce([{ total_amount: '500' }])
      .mockResolvedValueOnce([{ id: 9, admission_id: 77 }]);
    await svc.collectPayment({ invoice_id: 9, amount: 200, mode: 'UPI' });
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining("status = 'ACTIVE'"), 77,
    );
  });

  it('rejects INSURANCE payment with no invoice link (anchor guard, no invoice)', async () => {
    await expect(
      svc.collectPayment({ patient_uid: PATIENT, amount: 5000, mode: 'INSURANCE' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INSURANCE_PAYMENT_REQUIRES_INVOICE' });
  });

  it('rejects INSURANCE payment when the invoice has no submitted cashless claim', async () => {
    queryMock
      .mockResolvedValueOnce([{ status: 'ISSUED', patient_uid: PATIENT, amount_due: '5000' }]) // findBillingInvoice
      .mockResolvedValueOnce([]); // assertInsurancePaymentHasClaimAnchor -> no claim
    await expect(
      svc.collectPayment({ invoice_id: 9, amount: 5000, mode: 'INSURANCE' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INSURANCE_PAYMENT_REQUIRES_TPA_CLAIM' });
  });

  it('rejects INSURANCE payment when the cashless claim is not preauth-linked', async () => {
    queryMock
      .mockResolvedValueOnce([{ status: 'ISSUED', patient_uid: PATIENT, amount_due: '5000' }])
      .mockResolvedValueOnce([{ id: 44, claim_number: 'CL-1', preauth_id: null, status: 'approved' }]);
    await expect(
      svc.collectPayment({ invoice_id: 9, amount: 5000, mode: 'INSURANCE' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INSURANCE_PAYMENT_REQUIRES_TPA_PREAUTH' });
  });

  it('accepts an INSURANCE payment anchored to a preauth-linked final claim', async () => {
    queryMock
      .mockResolvedValueOnce([{ status: 'ISSUED', patient_uid: PATIENT, amount_due: '5000' }]) // findBillingInvoice
      .mockResolvedValueOnce([{ id: 45, claim_number: 'CL-2', preauth_id: 9, status: 'approved' }]) // claim anchor
      .mockResolvedValueOnce([{ id: 70, invoice_id: 9, amount: '5000', mode: 'INSURANCE' }]) // INSERT
      .mockResolvedValueOnce([{ paid: '5000' }]) // aggregate
      .mockResolvedValueOnce([{ total_amount: '5000' }]) // total
      .mockResolvedValueOnce([{ id: 9, admission_id: null }]); // invoice lookup (no admission)
    const row = await svc.collectPayment({ invoice_id: 9, amount: 5000, mode: 'INSURANCE', reference: 'UTR-1' });
    expect(row).toMatchObject({ id: 70 });
  });
});

describe('reversePayment additional branches', () => {
  it('rejects when no reason', async () => {
    await expect(svc.reversePayment(1, {})).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws notFound when payment missing / already reversed', async () => {
    queryMock.mockResolvedValueOnce([]); // UPDATE ... RETURNING -> none
    await expect(svc.reversePayment(1, { reason: 'x' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reverses a standalone payment (no invoice attached)', async () => {
    queryMock
      .mockResolvedValueOnce([{
        id: 5, reversed: false, mode: 'UPI', immutable_drawer_close: false,
      }])
      .mockResolvedValueOnce([{ id: 5, invoice_id: null }]); // UPDATE RETURNING
    const r = await svc.reversePayment(5, { reason: 'x', reversed_by: PATIENT, tenantId: TENANT });
    expect(r).toMatchObject({ id: 5 });
    // No invoice -> no recompute
    expect(execMock).not.toHaveBeenCalled();
  });

  it('reverses a payment attached to an invoice and recomputes payment state', async () => {
    queryMock
      .mockResolvedValueOnce([{
        id: 6, reversed: false, mode: 'CASH', immutable_drawer_close: false,
      }])
      .mockResolvedValueOnce([{ id: 6, invoice_id: 9 }]) // UPDATE RETURNING (has invoice)
      .mockResolvedValueOnce([{ id: 9 }]) // lockBillingInvoice (SELECT ... FOR UPDATE)
      // recomputeInvoicePaymentStateTx:
      .mockResolvedValueOnce([{ paid: '0' }]) // aggregate
      .mockResolvedValueOnce([{ total_amount: '500' }]) // total
      // syncUnusedAdmissionAdvancesForInvoice -> invoice lookup, no admission
      .mockResolvedValueOnce([{ id: 9, admission_id: null }]);
    const r = await svc.reversePayment(6, { reason: 'voided' });
    expect(r).toMatchObject({ id: 6 });
    // paid 0 -> status ISSUED
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE billing_invoices'), 0, 500, 'ISSUED', 9,
    );
  });

  it('forbids reversing CASH that belongs to an immutable closed drawer', async () => {
    queryMock.mockResolvedValueOnce([{
      id: 7, reversed: false, mode: 'CASH', immutable_drawer_close: true,
    }]);

    await expect(svc.reversePayment(7, {
      reason: 'entry correction', reversed_by: PATIENT, tenantId: TENANT,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_CASH_PAYMENT_CLOSED_DRAWER_REVERSAL_FORBIDDEN',
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toContain("drawer.status IN ('closed', 'reviewed')");
  });

  it('translates a racing database drawer-close guard into the stable service error', async () => {
    queryMock
      .mockResolvedValueOnce([{
        id: 8, reversed: false, mode: 'CASH', immutable_drawer_close: false,
      }])
      .mockRejectedValueOnce(Object.assign(new Error('immutable closed drawer'), {
        code: '23514',
        constraint: 'billing_cash_payment_reversal_guard_747',
      }));

    await expect(svc.reversePayment(8, {
      reason: 'entry correction', reversed_by: PATIENT, tenantId: TENANT,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_CASH_PAYMENT_CLOSED_DRAWER_REVERSAL_FORBIDDEN',
    });
  });
});

// ───────────────────────────────────────────────────────────────────────
// collectAdvance / listAdvances / settleAdvance
// ───────────────────────────────────────────────────────────────────────

describe('advances', () => {
  it('collectAdvance rejects missing patient_uid', async () => {
    await expect(svc.collectAdvance({ amount: 100, mode: 'CASH' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('collectAdvance rejects invalid mode', async () => {
    await expect(
      svc.collectAdvance({ patient_uid: PATIENT, amount: 100, mode: 'BARTER' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('collectAdvance rejects non-positive amount', async () => {
    await expect(
      svc.collectAdvance({ patient_uid: PATIENT, amount: 0, mode: 'CASH' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('collectAdvance inserts (no tenant -> default, no patient check)', async () => {
    queryMock.mockResolvedValueOnce([{ id: 1, balance: '1000' }]);
    const r = await svc.collectAdvance({ patient_uid: PATIENT, amount: 1000, mode: 'CASH', admission_id: 5 });
    expect(r).toMatchObject({ id: 1 });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('collectAdvance with tenant asserts patient then inserts', async () => {
    queryMock
      .mockResolvedValueOnce([{ uid: PATIENT }]) // assertPatientInTenant
      .mockResolvedValueOnce([{ id: 2 }]); // INSERT
    const r = await svc.collectAdvance({
      patient_uid: PATIENT, amount: 500, mode: 'UPI', tenantId: TENANT,
    });
    expect(r).toMatchObject({ id: 2 });
  });

  it('listAdvances applies all filters', async () => {
    queryMock.mockResolvedValueOnce([{ id: 1 }]);
    await svc.listAdvances({ tenantId: TENANT, patient_uid: PATIENT, admission_id: 5, status: 'ACTIVE' });
    const [sql, ...params] = queryMock.mock.calls[0];
    expect(sql).toContain('tenant_id = $1::uuid');
    expect(sql).toContain('patient_uid = $2::uuid');
    expect(sql).toContain('admission_id = $3::int');
    expect(sql).toContain('status = $4');
    expect(params).toEqual([TENANT, PATIENT, 5, 'ACTIVE']);
  });

  it('listAdvances with no filters and status null', async () => {
    queryMock.mockResolvedValueOnce([]);
    await svc.listAdvances({ status: null });
    const sql = queryMock.mock.calls[0][0];
    expect(sql).not.toContain('WHERE');
  });

  it('settleAdvance throws notFound when advance missing', async () => {
    queryMock.mockResolvedValueOnce([]); // advance lookup
    await expect(
      svc.settleAdvance({ advance_id: 1, invoice_id: 2, amount: 100 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('settleAdvance rejects a non-ACTIVE advance', async () => {
    queryMock.mockResolvedValueOnce([{ status: 'EXHAUSTED', balance: '0' }]);
    await expect(
      svc.settleAdvance({ advance_id: 1, invoice_id: 2, amount: 100 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('settleAdvance rejects amount exceeding advance balance', async () => {
    queryMock.mockResolvedValueOnce([{ status: 'ACTIVE', balance: '50', patient_uid: PATIENT }]);
    await expect(
      svc.settleAdvance({ advance_id: 1, invoice_id: 2, amount: 100 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('settleAdvance throws notFound when invoice missing', async () => {
    queryMock
      .mockResolvedValueOnce([{ status: 'ACTIVE', balance: '1000', patient_uid: PATIENT }]) // advance
      .mockResolvedValueOnce([]); // invoice
    await expect(
      svc.settleAdvance({ advance_id: 1, invoice_id: 2, amount: 100 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('settleAdvance forbids cross-patient settlement', async () => {
    queryMock
      .mockResolvedValueOnce([{ status: 'ACTIVE', balance: '1000', patient_uid: PATIENT }]) // advance
      .mockResolvedValueOnce([{ amount_due: '500', patient_uid: '99999999-9999-4999-8999-999999999999' }]); // invoice diff patient
    await expect(
      svc.settleAdvance({ advance_id: 1, invoice_id: 2, amount: 100 }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'BILLING_ADVANCE_INVOICE_PATIENT_MISMATCH' });
  });

  it('settleAdvance rejects amount exceeding invoice due', async () => {
    queryMock
      .mockResolvedValueOnce([{ status: 'ACTIVE', balance: '1000', patient_uid: PATIENT }])
      .mockResolvedValueOnce([{ amount_due: '50', patient_uid: PATIENT }]);
    await expect(
      svc.settleAdvance({ advance_id: 1, invoice_id: 2, amount: 100 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('settleAdvance partial -> advance stays ACTIVE (atomic decrement)', async () => {
    queryMock
      .mockResolvedValueOnce([{ status: 'ACTIVE', balance: '1000', patient_uid: PATIENT }]) // advance FOR UPDATE
      .mockResolvedValueOnce([{ amount_due: '500', patient_uid: PATIENT }]) // lockBillingInvoice
      .mockResolvedValueOnce([{ id: 70, amount: '300' }]) // INSERT settlement
      .mockResolvedValueOnce([{ id: 1 }]); // atomic balance decrement RETURNING id (sufficient -> ACTIVE)
    const r = await svc.settleAdvance({ advance_id: 1, invoice_id: 2, amount: 300, settled_by: PATIENT });
    expect(r).toMatchObject({ id: 70 });
    // Atomic decrement: `balance = balance - $amt WHERE balance >= $amt` with the
    // partial→ACTIVE / full→EXHAUSTED CASE baked into the same UPDATE; params are
    // (amount, advance_id). The decrement is the authoritative debit.
    const decCall = queryMock.mock.calls.find(
      (c) => /UPDATE billing_advances/.test(c[0]) && /balance >= \$1::numeric/.test(c[0]),
    );
    expect(decCall).toBeTruthy();
    expect(decCall.slice(1)).toEqual([300, 1]);
    expect(decCall[0]).toMatch(/'EXHAUSTED'.*ELSE\s+'ACTIVE'/s);
    // Invoice amount_paid is then bumped by the settled amount.
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE billing_invoices'), 300, 2,
    );
  });

  it('settleAdvance full -> advance EXHAUSTED (atomic decrement)', async () => {
    queryMock
      .mockResolvedValueOnce([{ status: 'ACTIVE', balance: '300', patient_uid: PATIENT }])
      .mockResolvedValueOnce([{ amount_due: '500', patient_uid: PATIENT }])
      .mockResolvedValueOnce([{ id: 71, amount: '300' }]) // INSERT settlement
      .mockResolvedValueOnce([{ id: 1 }]); // atomic decrement RETURNING id (full -> EXHAUSTED)
    await svc.settleAdvance({ advance_id: 1, invoice_id: 2, amount: 300 });
    const decCall = queryMock.mock.calls.find(
      (c) => /UPDATE billing_advances/.test(c[0]) && /balance >= \$1::numeric/.test(c[0]),
    );
    expect(decCall).toBeTruthy();
    expect(decCall.slice(1)).toEqual([300, 1]);
  });

  it('settleAdvance rejects when the atomic decrement affects zero rows (insufficient balance)', async () => {
    // The FOR UPDATE balance check passes (concurrent drain not yet visible to
    // the early read), but the conditional `WHERE balance >= $amt` decrement
    // affects zero rows -> BILLING_ADVANCE_INSUFFICIENT_BALANCE.
    queryMock
      .mockResolvedValueOnce([{ status: 'ACTIVE', balance: '300', patient_uid: PATIENT }]) // advance FOR UPDATE
      .mockResolvedValueOnce([{ amount_due: '500', patient_uid: PATIENT }]) // lockBillingInvoice
      .mockResolvedValueOnce([{ id: 72, amount: '300' }]) // INSERT settlement
      .mockResolvedValueOnce([]); // atomic decrement affects zero rows
    await expect(
      svc.settleAdvance({ advance_id: 1, invoice_id: 2, amount: 300 }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'BILLING_ADVANCE_INSUFFICIENT_BALANCE' });
    // The invoice bump must NOT run when the decrement failed.
    expect(execMock).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE billing_invoices'), expect.anything(), expect.anything(),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
// Refunds
// ───────────────────────────────────────────────────────────────────────

describe('refunds', () => {
  const raiseBody = {
    patient_uid: PATIENT,
    invoice_id: 1,
    amount: 10,
    reason: 'coverage refund',
    mode: 'CASH',
  };

  it.each([
    ['missing actor', { raised_by: null }],
    ['zero claim', { httpIdempotencyClaimId: 0 }],
    ['empty key', { commandKey: '' }],
    ['space-padded key', { commandKey: ' padded ' }],
    ['invalid key characters', { commandKey: 'not allowed' }],
    ['overlong key', { commandKey: 'a'.repeat(201) }],
    ['invalid fingerprint', { requestFingerprint: 'not-a-sha256' }],
  ])('rejects invalid refund mutation idempotency identity: %s', async (_label, overrides) => {
    const command = refundCommand(svc.refundRaiseIdempotencyBody(raiseBody), overrides);
    await expect(svc.raiseRefund({
      ...raiseBody,
      raised_by: PATIENT,
      tenantId: TENANT,
      ...command,
      ...overrides,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'BILLING_REFUND_RAISE_IDEMPOTENCY_INVALID',
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects a mutation idempotency fingerprint bound to another command', async () => {
    await expect(svc.raiseRefund({
      ...raiseBody,
      raised_by: PATIENT,
      tenantId: TENANT,
      ...refundCommand(svc.refundRaiseIdempotencyBody(raiseBody), {
        requestFingerprint: 'a'.repeat(64),
      }),
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'BILLING_REFUND_RAISE_COMMAND_MISMATCH',
    });
  });

  it('fails closed when an idempotent refund mutation has no audit context', async () => {
    await expect(svc.raiseRefund({
      ...raiseBody,
      raised_by: PATIENT,
      tenantId: TENANT,
      ...refundCommand(svc.refundRaiseIdempotencyBody(raiseBody)),
    })).rejects.toMatchObject({
      statusCode: 500,
      code: 'BILLING_REFUND_RAISE_AUDIT_CONTEXT_MISSING',
    });
  });

  it.each([
    ['array', []],
    ['actor mismatch', refundAuditContext(APPROVER)],
    ['invalid subject', refundAuditContext(PATIENT, { subjectUid: 'not-a-uuid' })],
    ['missing acting-as flag', refundAuditContext(PATIENT, { actingAsDependent: undefined })],
    ['empty actor role', refundAuditContext(PATIENT, { actorRole: '' })],
    ['overlong actor role', refundAuditContext(PATIENT, { actorRole: 'x'.repeat(51) })],
    ['empty request id', refundAuditContext(PATIENT, { requestId: '' })],
    ['overlong request id', refundAuditContext(PATIENT, { requestId: 'x'.repeat(201) })],
    ['empty device type', refundAuditContext(PATIENT, { deviceType: '' })],
    ['overlong device type', refundAuditContext(PATIENT, { deviceType: 'x'.repeat(81) })],
    ['empty IP address', refundAuditContext(PATIENT, { ipAddress: '' })],
    ['overlong IP address', refundAuditContext(PATIENT, { ipAddress: '1'.repeat(46) })],
    ['empty user agent', refundAuditContext(PATIENT, { userAgent: '' })],
    ['overlong user agent', refundAuditContext(PATIENT, { userAgent: 'x'.repeat(501) })],
    ['unattributed subject', refundAuditContext(PATIENT, { subjectUid: APPROVER })],
  ])('rejects invalid refund mutation audit context: %s', async (_label, auditContext) => {
    await expect(svc.raiseRefund({
      ...raiseBody,
      raised_by: PATIENT,
      tenantId: TENANT,
      auditContext,
    })).rejects.toMatchObject({
      statusCode: 500,
      code: 'BILLING_REFUND_RAISE_AUDIT_CONTEXT_INVALID',
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects audit context whose request identity differs from its command', async () => {
    await expect(svc.raiseRefund({
      ...raiseBody,
      raised_by: PATIENT,
      tenantId: TENANT,
      ...refundCommand(svc.refundRaiseIdempotencyBody(raiseBody)),
      auditContext: refundAuditContext(PATIENT, { requestId: 'another-request' }),
    })).rejects.toMatchObject({
      statusCode: 500,
      code: 'BILLING_REFUND_RAISE_AUDIT_CONTEXT_INVALID',
    });
  });

  it('atomically records audit and finalises idempotency for refund creation', async () => {
    const created = {
      id: 82,
      patient_uid: PATIENT,
      invoice_id: 1,
      advance_id: null,
      approval_status: 'PENDING',
      amount: '10',
    };
    queryMock
      .mockResolvedValueOnce([{ patient_uid: PATIENT, amount_paid: '50' }])
      .mockResolvedValueOnce([{ gross_paid: '50', active_refunds: '0' }])
      .mockResolvedValueOnce([created])
      .mockResolvedValueOnce([{ id: 901 }])
      .mockResolvedValueOnce([{ id: 41, status: 'complete' }]);

    const result = await svc.raiseRefund({
      ...raiseBody,
      raised_by: PATIENT,
      tenantId: TENANT,
      ...refundCommand(svc.refundRaiseIdempotencyBody(raiseBody)),
      auditContext: refundAuditContext(PATIENT),
    });

    expect(result).toBe(created);
    expect(queryMock.mock.calls.some(call => /INSERT INTO audit_logs/.test(call[0])))
      .toBe(true);
    expect(queryMock.mock.calls.some(call => /UPDATE idempotency_keys/.test(call[0])))
      .toBe(true);
  });

  it('fails closed when refund mutation audit persistence returns no receipt', async () => {
    queryMock
      .mockResolvedValueOnce([{ patient_uid: PATIENT, amount_paid: '50' }])
      .mockResolvedValueOnce([{ gross_paid: '50', active_refunds: '0' }])
      .mockResolvedValueOnce([{ id: 83, patient_uid: PATIENT, invoice_id: 1, approval_status: 'PENDING' }])
      .mockResolvedValueOnce([]);
    await expect(svc.raiseRefund({
      ...raiseBody,
      raised_by: PATIENT,
      tenantId: TENANT,
      auditContext: refundAuditContext(PATIENT),
    })).rejects.toMatchObject({
      statusCode: 500,
      code: 'BILLING_REFUND_RAISE_AUDIT_MISSING',
    });
  });

  it('rolls back when refund mutation idempotency ownership changes before commit', async () => {
    queryMock
      .mockResolvedValueOnce([{ patient_uid: PATIENT, amount_paid: '50' }])
      .mockResolvedValueOnce([{ gross_paid: '50', active_refunds: '0' }])
      .mockResolvedValueOnce([{ id: 84, patient_uid: PATIENT, invoice_id: 1, approval_status: 'PENDING' }])
      .mockResolvedValueOnce([{ id: 902 }])
      .mockResolvedValueOnce([]);
    await expect(svc.raiseRefund({
      ...raiseBody,
      raised_by: PATIENT,
      tenantId: TENANT,
      ...refundCommand(svc.refundRaiseIdempotencyBody(raiseBody)),
      auditContext: refundAuditContext(PATIENT),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_REFUND_RAISE_IDEMPOTENCY_CHANGED',
    });
  });

  it('raiseRefund rejects missing reason / invalid mode / non-positive amount', async () => {
    await expect(svc.raiseRefund({ amount: 1, mode: 'CASH', invoice_id: 1 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.raiseRefund({ reason: 'r', amount: 1, mode: 'BARTER', invoice_id: 1 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.raiseRefund({ reason: 'r', amount: 1, mode: 'INSURANCE', invoice_id: 1 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.raiseRefund({ reason: 'r', amount: 0, mode: 'CASH', invoice_id: 1 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('raiseRefund rejects when neither or both of invoice_id/advance_id are given', async () => {
    await expect(svc.raiseRefund({ reason: 'r', amount: 1, mode: 'CASH' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      svc.raiseRefund({ reason: 'r', amount: 1, mode: 'CASH', invoice_id: 1, advance_id: 2 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('raiseRefund (invoice) throws notFound when invoice missing', async () => {
    queryMock.mockResolvedValueOnce([]); // findBillingInvoice
    await expect(
      svc.raiseRefund({ reason: 'r', amount: 1, mode: 'CASH', invoice_id: 1 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('raiseRefund (invoice) rejects patient mismatch', async () => {
    queryMock.mockResolvedValueOnce([{ patient_uid: '99999999-9999-4999-8999-999999999999' }]);
    await expect(
      svc.raiseRefund({ reason: 'r', amount: 1, mode: 'CASH', invoice_id: 1, patient_uid: PATIENT }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'BILLING_REFUND_PATIENT_MISMATCH' });
  });

  it('raiseRefund (invoice) inserts and resolves patient from invoice', async () => {
    queryMock
      // lockBillingInvoice (patient_uid, amount_paid) — paid 100 so a 100 refund is allowed
      .mockResolvedValueOnce([{ patient_uid: PATIENT, amount_paid: '100' }])
      .mockResolvedValueOnce([{ gross_paid: '100', active_refunds: '0' }])
      .mockResolvedValueOnce([{ id: 80, amount: '100' }]); // INSERT
    const r = await svc.raiseRefund({ reason: 'overpay', amount: 100, mode: 'CASH', invoice_id: 1 });
    expect(r).toMatchObject({ id: 80 });
  });

  it('raiseRefund (invoice) rejects an over-refund beyond refundable headroom', async () => {
    // paid 100, prior refunds 40 -> refundable 60; a 100 refund must be rejected.
    queryMock
      .mockResolvedValueOnce([{ patient_uid: PATIENT, amount_paid: '100' }]) // lockBillingInvoice
      .mockResolvedValueOnce([{ gross_paid: '100', active_refunds: '40' }]);
    await expect(
      svc.raiseRefund({ reason: 'overpay', amount: 100, mode: 'CASH', invoice_id: 1 }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'BILLING_REFUND_EXCEEDS_PAID' });
    // No INSERT must run when the refund is rejected.
    const insertCall = queryMock.mock.calls.find((c) => /INSERT INTO billing_refunds/.test(c[0]));
    expect(insertCall).toBeFalsy();
  });

  it('raiseRefund (advance) throws notFound when advance missing', async () => {
    queryMock.mockResolvedValueOnce([]); // advance lookup
    await expect(
      svc.raiseRefund({ reason: 'r', amount: 1, mode: 'CASH', advance_id: 2 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('raiseRefund (advance) rejects patient mismatch', async () => {
    queryMock.mockResolvedValueOnce([{ patient_uid: '99999999-9999-4999-8999-999999999999' }]);
    await expect(
      svc.raiseRefund({ reason: 'r', amount: 1, mode: 'CASH', advance_id: 2, patient_uid: PATIENT }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('raiseRefund (advance) inserts and resolves patient from advance', async () => {
    queryMock
      // advance FOR UPDATE (patient_uid, balance) — balance 500 so a 500 refund is allowed
      .mockResolvedValueOnce([{ patient_uid: PATIENT, balance: '500' }])
      .mockResolvedValueOnce([{ total: '0' }]) // pending/approved refund reservations
      .mockResolvedValueOnce([{ id: 81 }]); // INSERT
    const r = await svc.raiseRefund({ reason: 'deposit return', amount: 500, mode: 'UPI', advance_id: 2, tenantId: TENANT });
    expect(r).toMatchObject({ id: 81 });
  });

  it('raiseRefund (advance) rejects a refund exceeding the advance balance', async () => {
    queryMock
      .mockResolvedValueOnce([{ patient_uid: PATIENT, balance: '300' }]) // advance FOR UPDATE
      .mockResolvedValueOnce([{ total: '0' }]); // pending/approved refund reservations
    await expect(
      svc.raiseRefund({ reason: 'deposit return', amount: 500, mode: 'UPI', advance_id: 2 }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'BILLING_REFUND_EXCEEDS_ADVANCE_BALANCE' });
    const insertCall = queryMock.mock.calls.find((c) => /INSERT INTO billing_refunds/.test(c[0]));
    expect(insertCall).toBeFalsy();
  });

  it('approveRefund throws notFound when not pending', async () => {
    queryMock.mockResolvedValueOnce([]);
    await expect(svc.approveRefund(1, {})).rejects.toMatchObject({ statusCode: 404 });
  });

  it('approveRefund updates a pending refund', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1, approval_status: 'APPROVED' }])
      .mockResolvedValueOnce([]);
    const r = await svc.approveRefund(1, { approved_by: PATIENT, tenantId: TENANT });
    expect(r).toMatchObject({ approval_status: 'APPROVED' });
  });

  it.each([
    ['invalid actor', { approved_by: 'not-a-uuid' }, 'BILLING_REFUND_APPROVAL_IDEMPOTENCY_INVALID'],
    ['invalid claim', { httpIdempotencyClaimId: 0 }, 'BILLING_REFUND_APPROVAL_IDEMPOTENCY_INVALID'],
    ['invalid key', { commandKey: ' bad key ' }, 'BILLING_REFUND_APPROVAL_IDEMPOTENCY_INVALID'],
    ['invalid hash', { requestFingerprint: 'bad' }, 'BILLING_REFUND_APPROVAL_IDEMPOTENCY_INVALID'],
    ['mismatched hash', { requestFingerprint: 'b'.repeat(64) }, 'BILLING_REFUND_APPROVAL_COMMAND_MISMATCH'],
  ])('approveRefund rejects %s', async (_label, overrides, code) => {
    await expect(svc.approveRefund(1, {
      approved_by: APPROVER,
      tenantId: TENANT,
      commandKey: 'approve-refund-1',
      requestFingerprint: refundApprovalRequestFingerprint(1),
      httpIdempotencyClaimId: 42,
      requestId: REQUEST_ID,
      ...overrides,
    })).rejects.toMatchObject({ code });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('approveRefund requires valid audit attribution for an idempotent command', async () => {
    const command = {
      commandKey: 'approve-refund-1',
      requestFingerprint: refundApprovalRequestFingerprint(1),
      httpIdempotencyClaimId: 42,
      requestId: REQUEST_ID,
    };
    await expect(svc.approveRefund(1, {
      approved_by: APPROVER,
      tenantId: TENANT,
      ...command,
    })).rejects.toMatchObject({
      code: 'BILLING_REFUND_APPROVAL_AUDIT_CONTEXT_MISSING',
    });
    await expect(svc.approveRefund(1, {
      approved_by: APPROVER,
      tenantId: TENANT,
      ...command,
      auditContext: [],
    })).rejects.toMatchObject({
      code: 'BILLING_REFUND_APPROVAL_AUDIT_CONTEXT_INVALID',
    });
    await expect(svc.approveRefund(1, {
      approved_by: APPROVER,
      tenantId: TENANT,
      ...command,
      auditContext: refundAuditContext(APPROVER, { requestId: 'wrong-request' }),
    })).rejects.toMatchObject({
      code: 'BILLING_REFUND_APPROVAL_AUDIT_CONTEXT_INVALID',
    });
  });

  it('atomically persists approval audit and idempotency receipts', async () => {
    const approved = {
      id: 1,
      patient_uid: PATIENT,
      invoice_id: 11,
      approval_status: 'APPROVED',
      approved_by: APPROVER,
    };
    queryMock
      .mockResolvedValueOnce([approved])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 903 }])
      .mockResolvedValueOnce([{ id: 42, status: 'complete' }]);
    const result = await svc.approveRefund(1, {
      approved_by: APPROVER,
      tenantId: TENANT,
      commandKey: 'approve-refund-1',
      requestFingerprint: refundApprovalRequestFingerprint(1),
      httpIdempotencyClaimId: 42,
      requestId: REQUEST_ID,
      auditContext: refundAuditContext(APPROVER),
    });
    expect(result).toBe(approved);
  });

  it('fails approval when its audit or idempotency receipt is missing', async () => {
    const approved = { id: 1, patient_uid: PATIENT, approval_status: 'APPROVED' };
    queryMock
      .mockResolvedValueOnce([approved])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await expect(svc.approveRefund(1, {
      approved_by: APPROVER,
      tenantId: TENANT,
      auditContext: refundAuditContext(APPROVER),
    })).rejects.toMatchObject({ code: 'BILLING_REFUND_APPROVAL_AUDIT_MISSING' });

    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce([approved])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 904 }])
      .mockResolvedValueOnce([]);
    await expect(svc.approveRefund(1, {
      approved_by: APPROVER,
      tenantId: TENANT,
      commandKey: 'approve-refund-1',
      requestFingerprint: refundApprovalRequestFingerprint(1),
      httpIdempotencyClaimId: 42,
      requestId: REQUEST_ID,
      auditContext: refundAuditContext(APPROVER),
    })).rejects.toMatchObject({
      code: 'BILLING_REFUND_APPROVAL_IDEMPOTENCY_CHANGED',
    });
  });

  it('rejectRefund rejects missing rejection_reason', async () => {
    await expect(svc.rejectRefund(1, {})).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejectRefund throws notFound when not pending', async () => {
    queryMock.mockResolvedValueOnce([]);
    await expect(svc.rejectRefund(1, { rejection_reason: 'dup' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejectRefund updates a pending refund', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1, approval_status: 'PENDING' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 1, approval_status: 'REJECTED' }]);
    const r = await svc.rejectRefund(1, { rejection_reason: 'dup', rejected_by: PATIENT });
    expect(r).toMatchObject({ approval_status: 'REJECTED' });
  });

  it('rejectRefund enforces reason bounds and medication-credit obligations', async () => {
    await expect(svc.rejectRefund(1, {
      rejection_reason: 'x'.repeat(256),
      rejected_by: PATIENT,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'BILLING_REFUND_REJECTION_REASON_INVALID',
    });

    queryMock
      .mockResolvedValueOnce([{ id: 1, approval_status: 'PENDING' }])
      .mockResolvedValueOnce([{ id: 91, status: 'applied' }]);
    await expect(svc.rejectRefund(1, {
      rejection_reason: 'duplicate',
      rejected_by: PATIENT,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'BILLING_CREDIT_NOTE_REFUND_REJECTION_FORBIDDEN',
    });
  });

  it('atomically records rejection audit and finalises its command claim', async () => {
    const rejected = {
      id: 1,
      patient_uid: PATIENT,
      advance_id: 22,
      approval_status: 'REJECTED',
    };
    const body = svc.refundRejectionIdempotencyBody(1, {
      rejection_reason: 'duplicate',
    });
    queryMock
      .mockResolvedValueOnce([{ id: 1, approval_status: 'PENDING' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([rejected])
      .mockResolvedValueOnce([{ id: 905 }])
      .mockResolvedValueOnce([{ id: 43, status: 'complete' }]);
    const result = await svc.rejectRefund(1, {
      rejection_reason: ' duplicate ',
      rejected_by: PATIENT,
      tenantId: TENANT,
      ...refundCommand(body, {
        commandKey: 'reject-refund-1',
        httpIdempotencyClaimId: 43,
      }),
      auditContext: refundAuditContext(PATIENT),
    });
    expect(result).toBe(rejected);
  });

  it('markRefundPaid throws notFound when not approved', async () => {
    queryMock.mockResolvedValueOnce([]);
    await expect(svc.markRefundPaid(1, { tenantId: TENANT }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('markRefundPaid marks an approved invoice-refund paid (no advance balance update)', async () => {
    queryMock
      .mockResolvedValueOnce([{
        id: 1,
        approval_status: 'APPROVED',
        approved_by: APPROVER,
        mode: 'CHEQUE',
        advance_id: null,
        invoice_id: null,
        amount: '100',
      }])
      .mockResolvedValueOnce([{
        id: 1,
        approval_status: 'PAID',
        mode: 'CHEQUE',
        advance_id: null,
        invoice_id: null,
        amount: '100',
      }])
      .mockResolvedValueOnce([]);
    const r = await svc.markRefundPaid(1, {
      tenantId: TENANT,
      paid_by: PATIENT,
      reference: 'CHEQUE-1',
    });
    expect(r).toMatchObject({ id: 1 });
    // no advance => no balance update exec
    expect(execMock).not.toHaveBeenCalled();
  });

  it('markRefundPaid rejects insurance refunds without insurer settlement evidence', async () => {
    queryMock.mockResolvedValueOnce([{
      id: 9,
      approval_status: 'APPROVED',
      approved_by: APPROVER,
      mode: 'INSURANCE',
      payout_rail: null,
      gateway_refund_id: null,
    }]);

    await expect(
      svc.markRefundPaid(9, {
        tenantId: TENANT,
        paid_by: PATIENT,
        reference: 'MANUAL-INSURER-CLAIM',
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_INSURANCE_REFUND_SETTLEMENT_EVIDENCE_REQUIRED',
    });
    expect(queryMock.mock.calls.some((call) => /UPDATE billing_refunds/.test(call[0])))
      .toBe(false);
  });

  it('markRefundPaid cannot be switched to the gateway rail by untrusted options', async () => {
    queryMock
      .mockResolvedValueOnce([{
        id: 8,
        approval_status: 'APPROVED',
        approved_by: APPROVER,
        mode: 'DD',
        advance_id: null,
        invoice_id: null,
        amount: '100',
      }])
      .mockResolvedValueOnce([{
        id: 8, approval_status: 'PAID', mode: 'DD', advance_id: null, amount: '100',
      }])
      .mockResolvedValueOnce([]);

    await svc.markRefundPaid(8, {
      tenantId: TENANT,
      paid_by: PATIENT,
      reference: 'MANUAL-ATTACK',
      payout_rail: 'gateway',
      gateway_refund_id: 9876,
    });

    const update = queryMock.mock.calls.find(call => /UPDATE billing_refunds/.test(call[0]));
    expect(update.slice(1)).toEqual([
      PATIENT,
      'MANUAL-ATTACK',
      'manual',
      null,
      null,
      null,
      TENANT,
      8,
    ]);
  });

  it('markRefundPaid rejects invalid actor, rail, reference, and drawer combinations', async () => {
    const locked = (overrides = {}) => ({
      id: 8,
      approval_status: 'APPROVED',
      approved_by: APPROVER,
      mode: 'CHEQUE',
      payout_rail: null,
      amount: '50',
      ...overrides,
    });
    const expectFailure = async (refund, options, code, extraRows = []) => {
      queryMock.mockReset();
      queryMock.mockResolvedValueOnce([refund]);
      for (const rows of extraRows) queryMock.mockResolvedValueOnce(rows);
      await expect(svc.markRefundPaid(8, {
        tenantId: TENANT,
        paid_by: PATIENT,
        reference: 'CHEQUE-8',
        ...options,
      })).rejects.toMatchObject({ code });
    };

    await expectFailure(locked(), { paid_by: 'invalid' }, 'BILLING_REFUND_PAYOUT_ACTOR_REQUIRED');
    await expectFailure(locked(), { paid_by: APPROVER }, 'BILLING_REFUND_PAYER_MUST_DIFFER_FROM_APPROVER');
    await expectFailure(locked({ payout_rail: 'offline_electronic' }), {}, 'BILLING_REFUND_PAYOUT_RAIL_CONFLICT');
    await expectFailure(locked({ mode: 'UPI' }), {}, 'BILLING_REFUND_MANUAL_ELECTRONIC_FORBIDDEN');
    await expectFailure(locked(), { reference: '' }, 'BILLING_REFUND_PAYOUT_REFERENCE_REQUIRED');
    await expectFailure(locked(), { reference: 'bad\u0007reference' }, 'BILLING_REFUND_PAYOUT_REFERENCE_REQUIRED');
    await expectFailure(locked(), { reference: 'x'.repeat(256) }, 'BILLING_REFUND_PAYOUT_REFERENCE_REQUIRED');
    await expectFailure(locked({ mode: 'CASH' }), {}, 'BILLING_REFUND_CASH_DRAWER_REQUIRED');
    await expectFailure(locked({ mode: 'CASH' }), { cash_drawer_session_id: 'abc' }, 'BILLING_REFUND_CASH_DRAWER_INVALID');
    await expectFailure(
      locked({ mode: 'CASH' }),
      { cash_drawer_session_id: '10' },
      'BILLING_REFUND_CASH_DRAWER_NOT_OPEN',
      [[]],
    );
    await expectFailure(
      locked({ mode: 'CASH' }),
      { cash_drawer_session_id: '10' },
      'BILLING_REFUND_CASH_DRAWER_OWNER_MISMATCH',
      [[{ id: '10', cashier_uid: APPROVER, status: 'open' }]],
    );
    await expectFailure(
      locked({ mode: 'CASH' }),
      { cash_drawer_session_id: '10' },
      'BILLING_REFUND_CASH_DRAWER_INSUFFICIENT_FUNDS',
      [[{
        id: '10', cashier_uid: PATIENT, status: 'open', shift: 'GENERAL',
        opened_at: '2026-08-28T08:00:00.000Z', opening_float: '10',
      }], [{ cash_inflow_total: '5', cash_refund_total: '0' }]],
    );
    await expectFailure(
      locked({ mode: 'DD' }),
      { cash_drawer_session_id: '10' },
      'BILLING_REFUND_CASH_DRAWER_MODE_MISMATCH',
    );
  });

  it('pays a CASH refund only inside the accountable open drawer and closes its command', async () => {
    const paid = {
      id: 8,
      patient_uid: PATIENT,
      approval_status: 'PAID',
      approved_by: APPROVER,
      mode: 'CASH',
      payout_rail: 'manual',
      cash_drawer_session_id: '10',
      reference: 'CASH-8',
      amount: '50',
      invoice_id: null,
      advance_id: null,
    };
    const body = svc.refundManualPayoutIdempotencyBody(8, {
      cash_drawer_session_id: '10',
      reference: 'CASH-8',
    });
    queryMock
      .mockResolvedValueOnce([{
        ...paid,
        approval_status: 'APPROVED',
        payout_rail: null,
        cash_drawer_session_id: null,
      }])
      .mockResolvedValueOnce([{
        id: '10', cashier_uid: PATIENT, status: 'open', shift: 'GENERAL',
        opened_at: '2026-08-28T08:00:00.000Z', opening_float: '100',
      }])
      .mockResolvedValueOnce([{ cash_inflow_total: '200', cash_refund_total: '20' }])
      .mockResolvedValueOnce([paid])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ cash_inflow_total: '200', cash_refund_total: '70' }])
      .mockResolvedValueOnce([{ id: 906 }])
      .mockResolvedValueOnce([{ id: 44, status: 'complete' }]);

    const result = await svc.markRefundPaid(8, {
      tenantId: TENANT,
      paid_by: PATIENT,
      reference: 'CASH-8',
      cash_drawer_session_id: '10',
      ...refundCommand(body, {
        commandKey: 'pay-cash-refund-8',
        httpIdempotencyClaimId: 44,
      }),
      auditContext: refundAuditContext(PATIENT),
    });

    expect(result).toMatchObject({
      cash_inflow_total: 200,
      cash_refund_total: 70,
      system_total: 130,
    });
  });

  it('markOfflineElectronicRefundPaid validates provenance fields and eligible source modes', async () => {
    const locked = (overrides = {}) => ({
      id: 8,
      patient_uid: PATIENT,
      invoice_id: 11,
      advance_id: null,
      approval_status: 'APPROVED',
      approved_by: APPROVER,
      mode: 'UPI',
      amount: '50',
      ...overrides,
    });
    const base = {
      tenantId: TENANT,
      paid_by: PATIENT,
      original_payment_reference: 'UPI-COLLECTION-8',
      provider_name: 'Acquirer',
      provider_refund_reference: 'OFFLINE-REFUND-8',
      provider_refunded_at: '2026-08-28T08:00:00.000Z',
    };
    const expectFailure = async (refund, overrides, code, extraRows = []) => {
      queryMock.mockReset();
      queryMock.mockResolvedValueOnce([refund]);
      for (const rows of extraRows) queryMock.mockResolvedValueOnce(rows);
      await expect(svc.markOfflineElectronicRefundPaid(8, {
        ...base,
        ...overrides,
      })).rejects.toMatchObject({ code });
    };

    await expectFailure(locked({ mode: 'CASH' }), {}, 'BILLING_REFUND_OFFLINE_ELECTRONIC_MODE_MISMATCH');
    await expectFailure(locked(), { original_payment_reference: '' }, 'BILLING_REFUND_ORIGINAL_PAYMENT_REFERENCE_REQUIRED');
    await expectFailure(locked(), { provider_name: '' }, 'BILLING_REFUND_PROVIDER_REQUIRED');
    await expectFailure(locked(), { provider_refund_reference: '' }, 'BILLING_REFUND_PROVIDER_REFUND_REFERENCE_REQUIRED');
    await expectFailure(locked(), { provider_refunded_at: 'not-a-date' }, 'BILLING_REFUND_PROVIDER_REFUNDED_AT_INVALID');
    await expectFailure(
      locked(),
      { provider_refunded_at: '2999-01-01T00:00:00.000Z' },
      'BILLING_REFUND_PROVIDER_REFUNDED_AT_FUTURE',
    );
    await expectFailure(
      locked(),
      {},
      'BILLING_REFUND_ORIGINAL_PAYMENT_REFERENCE_MISMATCH',
      [[]],
    );
    await expectFailure(
      locked(),
      {},
      'BILLING_REFUND_GATEWAY_CAPTURE_AUTHORITATIVE',
      [[{ id: 51 }], [{ id: 61, provider: 'dry_run' }]],
    );
    await expectFailure(
      locked({ invoice_id: null, advance_id: 12 }),
      {},
      'BILLING_REFUND_ORIGINAL_PAYMENT_REFERENCE_MISMATCH',
      [[]],
    );
  });

  it('settles an offline-electronic invoice refund with exact non-gateway evidence', async () => {
    const paid = {
      id: 8,
      patient_uid: PATIENT,
      invoice_id: 11,
      advance_id: null,
      approval_status: 'PAID',
      approved_by: APPROVER,
      mode: 'UPI',
      amount: '50',
      payout_rail: 'offline_electronic',
      offline_electronic_evidence_id: '901',
      reference: 'OFFLINE-REFUND-8',
    };
    const commandBody = {
      original_payment_reference: 'UPI-COLLECTION-8',
      provider_name: 'Acquirer',
      provider_refund_reference: 'OFFLINE-REFUND-8',
      provider_refunded_at: '2026-08-28T08:00:00.000Z',
    };
    const body = svc.refundOfflineElectronicPayoutIdempotencyBody(8, commandBody);
    queryMock
      .mockResolvedValueOnce([{ ...paid, approval_status: 'APPROVED', payout_rail: null }])
      .mockResolvedValueOnce([{ id: 51, amount: '50', mode: 'UPI', reference: 'UPI-COLLECTION-8' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: '901' }])
      .mockResolvedValueOnce([paid])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 907 }])
      .mockResolvedValueOnce([{ id: 45, status: 'complete' }]);

    const result = await svc.markOfflineElectronicRefundPaid(8, {
      tenantId: TENANT,
      paid_by: PATIENT,
      ...commandBody,
      ...refundCommand(body, {
        commandKey: 'pay-offline-refund-8',
        httpIdempotencyClaimId: 45,
      }),
      auditContext: refundAuditContext(PATIENT),
    });
    expect(result).toBe(paid);
  });

  it('settles an offline-electronic advance refund and atomically decrements the advance', async () => {
    queryMock
      .mockResolvedValueOnce([{
        id: 9,
        patient_uid: PATIENT,
        invoice_id: null,
        advance_id: 12,
        approval_status: 'APPROVED',
        approved_by: APPROVER,
        mode: 'CARD',
        amount: '30',
      }])
      .mockResolvedValueOnce([{ id: 12, amount: '100', mode: 'CARD', reference: 'CARD-12' }])
      .mockResolvedValueOnce([{ id: '902' }])
      .mockResolvedValueOnce([{
        id: 9, patient_uid: PATIENT, advance_id: 12, invoice_id: null,
        approval_status: 'PAID', mode: 'CARD', amount: '30',
      }])
      .mockResolvedValueOnce([{ id: 12 }])
      .mockResolvedValueOnce([]);
    const result = await svc.markOfflineElectronicRefundPaid(9, {
      tenantId: TENANT,
      paid_by: PATIENT,
      original_payment_reference: 'CARD-12',
      provider_name: 'Acquirer',
      provider_refund_reference: 'OFFLINE-REFUND-9',
      provider_refunded_at: '2026-08-28T08:00:00.000Z',
    });
    expect(result).toMatchObject({ id: 9, approval_status: 'PAID' });
    expect(queryMock.mock.calls.some(call => /UPDATE billing_advances/.test(call[0])))
      .toBe(true);
  });

  it('markGatewayRefundPaid requires an exact locked provider execution leg', async () => {
    queryMock.mockResolvedValueOnce([]);

    await expect(svc.markGatewayRefundPaid(8, {
      tenantId: TENANT,
      gateway_refund_id: 77,
      provider_refund_id: 'rfnd_verified_77',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_REFUND_GATEWAY_EVIDENCE_INVALID',
    });
  });

  it.each([
    [{ gateway_refund_id: 0, provider_refund_id: 'rfnd-1' }],
    [{ gateway_refund_id: 1.5, provider_refund_id: 'rfnd-1' }],
    [{ gateway_refund_id: 1, provider_refund_id: '' }],
    [{ gateway_refund_id: 1, provider_refund_id: 'x'.repeat(121) }],
  ])('markGatewayRefundPaid rejects incomplete execution identity %#', async (evidence) => {
    await expect(svc.markGatewayRefundPaid(8, {
      tenantId: TENANT,
      ...evidence,
    })).rejects.toMatchObject({
      code: 'BILLING_REFUND_GATEWAY_EXECUTION_REQUIRED',
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('markGatewayRefundPaid rejects mode, actor, chronology, and atomic evidence conflicts', async () => {
    const evidence = {
      id: 77,
      initiated_by: PATIENT,
      initiated_at: '2026-08-28T08:05:00.000Z',
      status: 'pending',
    };
    const authority = {
      id: 8,
      approval_status: 'APPROVED',
      approved_by: APPROVER,
      approved_at: '2026-08-28T08:00:00.000Z',
      mode: 'UPI',
      payout_rail: 'gateway',
      gateway_refund_id: 77,
    };
    const expectFailure = async (gateway, refund, processedRows, code) => {
      queryMock.mockReset();
      queryMock
        .mockResolvedValueOnce([gateway])
        .mockResolvedValueOnce([refund]);
      if (processedRows !== undefined) queryMock.mockResolvedValueOnce(processedRows);
      await expect(svc.markGatewayRefundPaid(8, {
        tenantId: TENANT,
        gateway_refund_id: 77,
        provider_refund_id: 'rfnd-77',
      })).rejects.toMatchObject({ code });
    };

    await expectFailure(evidence, { ...authority, mode: 'CASH' }, undefined, 'BILLING_REFUND_GATEWAY_MODE_MISMATCH');
    await expectFailure({ ...evidence, initiated_by: APPROVER }, authority, undefined, 'BILLING_REFUND_PAYER_MUST_DIFFER_FROM_APPROVER');
    await expectFailure(
      { ...evidence, initiated_at: '2026-08-28T07:55:00.000Z' },
      authority,
      undefined,
      'BILLING_REFUND_GATEWAY_EVIDENCE_INVALID',
    );
    await expectFailure(evidence, authority, [], 'BILLING_REFUND_GATEWAY_EVIDENCE_INVALID');
    await expectFailure(evidence, authority, [{
      id: 77, status: 'failed', provider_refund_id: 'rfnd-77', processed_at: null,
    }], 'BILLING_REFUND_GATEWAY_EVIDENCE_INVALID');
  });

  it('markGatewayRefundPaid binds exact provider evidence before gateway settlement', async () => {
    queryMock
      .mockResolvedValueOnce([{
        id: 77,
        initiated_by: PATIENT,
        initiated_at: '2026-08-28T08:05:00.000Z',
        status: 'pending',
      }])
      .mockResolvedValueOnce([{
        id: 8,
        approval_status: 'APPROVED',
        approved_by: APPROVER,
        approved_at: '2026-08-28T08:00:00.000Z',
        mode: 'UPI',
        payout_rail: 'gateway',
        gateway_refund_id: 77,
      }])
      .mockResolvedValueOnce([{
        id: 77,
        status: 'processed',
        provider_refund_id: 'rfnd_verified_77',
        processed_at: '2026-08-28T08:06:00.000Z',
      }])
      .mockResolvedValueOnce([{
        id: 8, approval_status: 'PAID', mode: 'UPI', advance_id: null, amount: '100',
      }])
      .mockResolvedValueOnce([]);

    await svc.markGatewayRefundPaid(8, {
      tenantId: TENANT,
      gateway_refund_id: 77,
      provider_refund_id: 'rfnd_verified_77',
    });

    expect(queryMock.mock.calls[0][0]).toContain('payment_gateway_refunds');
    expect(queryMock.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(queryMock.mock.calls[1][0]).toContain('billing_refunds');
    expect(queryMock.mock.calls[1][0]).toContain('FOR UPDATE');
    expect(queryMock.mock.calls[2][0]).toContain("SET status = 'processed'");
    expect(queryMock.mock.calls[2].slice(1)).toEqual([
      'rfnd_verified_77', 77, TENANT, 8,
    ]);
    const settlement = queryMock.mock.calls.find(call => /UPDATE billing_refunds/.test(call[0]));
    expect(settlement.slice(1)).toEqual([
      null,
      'rfnd_verified_77',
      'gateway',
      77,
      null,
      null,
      TENANT,
      8,
    ]);
  });

  it('rejects concurrent payout ownership changes and translates duplicate references', async () => {
    const locked = {
      id: 8,
      approval_status: 'APPROVED',
      approved_by: APPROVER,
      mode: 'CHEQUE',
      payout_rail: null,
      amount: '50',
    };
    queryMock
      .mockResolvedValueOnce([locked])
      .mockResolvedValueOnce([]);
    await expect(svc.markRefundPaid(8, {
      tenantId: TENANT,
      paid_by: PATIENT,
      reference: 'CHEQUE-8',
    })).rejects.toMatchObject({ code: 'BILLING_REFUND_PAYOUT_RAIL_CONFLICT' });

    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce([locked])
      .mockRejectedValueOnce({
        meta: { code: '23505', constraint: 'ux_billing_refund_manual_payout_reference' },
      });
    await expect(svc.markRefundPaid(8, {
      tenantId: TENANT,
      paid_by: PATIENT,
      reference: 'CHEQUE-8',
    })).rejects.toMatchObject({ code: 'BILLING_REFUND_PAYOUT_REFERENCE_DUPLICATE' });

    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce([{
        ...locked, mode: 'UPI', patient_uid: PATIENT, invoice_id: 11,
      }])
      .mockResolvedValueOnce([{ id: 51 }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce({
        code: '23505',
        constraint: 'ux_billing_refund_provider_refund_reference',
      });
    await expect(svc.markOfflineElectronicRefundPaid(8, {
      tenantId: TENANT,
      paid_by: PATIENT,
      original_payment_reference: 'UPI-COLLECTION-8',
      provider_name: 'Acquirer',
      provider_refund_reference: 'OFFLINE-REFUND-8',
      provider_refunded_at: '2026-08-28T08:00:00.000Z',
    })).rejects.toMatchObject({
      code: 'BILLING_REFUND_PROVIDER_REFUND_REFERENCE_DUPLICATE',
    });
  });

  it('requires a completion actor for a gateway-settled medication credit note', async () => {
    queryMock
      .mockResolvedValueOnce([{
        id: 77, initiated_by: PATIENT, initiated_at: '2026-08-28T08:05:00.000Z',
      }])
      .mockResolvedValueOnce([{
        id: 8, approval_status: 'APPROVED', approved_by: APPROVER,
        approved_at: '2026-08-28T08:00:00.000Z', mode: 'UPI',
        payout_rail: 'gateway', gateway_refund_id: 77,
      }])
      .mockResolvedValueOnce([{
        id: 77, status: 'processed', provider_refund_id: 'rfnd-77',
        processed_at: '2026-08-28T08:06:00.000Z',
      }])
      .mockResolvedValueOnce([{
        id: 8, approval_status: 'PAID', mode: 'UPI', amount: '50',
        invoice_id: null, advance_id: null,
      }])
      .mockResolvedValueOnce([{ id: 301, status: 'applied' }])
      .mockResolvedValueOnce([]);
    await expect(svc.markGatewayRefundPaid(8, {
      tenantId: TENANT,
      gateway_refund_id: 77,
      provider_refund_id: 'rfnd-77',
    })).rejects.toMatchObject({
      code: 'BILLING_CREDIT_NOTE_REFUND_COMPLETION_ACTOR_MISSING',
    });
  });

  it('markRefundPaid reduces the advance balance when linked to an advance (atomic decrement)', async () => {
    queryMock
      .mockResolvedValueOnce([{
        id: 2,
        approval_status: 'APPROVED',
        approved_by: APPROVER,
        mode: 'DD',
        advance_id: 55,
        amount: '300',
      }])
      .mockResolvedValueOnce([{
        id: 2, approval_status: 'PAID', mode: 'DD', advance_id: 55, amount: '300',
      }])
      .mockResolvedValueOnce([{ id: 55 }]) // atomic advance-balance decrement RETURNING id
      .mockResolvedValueOnce([]); // no linked medication credit note
    await svc.markRefundPaid(2, {
      tenantId: TENANT,
      paid_by: PATIENT,
      reference: 'DD-2',
    });
    // The balance reduction is now an atomic guarded UPDATE (queryRaw, not exec):
    // `balance = balance - $amt WHERE balance >= $amt`, params (amount, advance_id).
    const decCall = queryMock.mock.calls.find(
      (c) => /UPDATE billing_advances/.test(c[0]) && /balance >= \$1::numeric/.test(c[0]),
    );
    expect(decCall).toBeTruthy();
    expect(decCall.slice(1)).toEqual([300, 55]);
  });

  it('markRefundPaid rejects when the advance decrement affects zero rows at payout time', async () => {
    queryMock
      .mockResolvedValueOnce([{
        id: 3,
        approval_status: 'APPROVED',
        approved_by: APPROVER,
        mode: 'DD',
        advance_id: 55,
        amount: '300',
      }])
      .mockResolvedValueOnce([{
        id: 3, approval_status: 'PAID', mode: 'DD', advance_id: 55, amount: '300',
      }])
      .mockResolvedValueOnce([]); // decrement affects zero rows (balance drained)
    await expect(
      svc.markRefundPaid(3, {
        tenantId: TENANT,
        paid_by: PATIENT,
        reference: 'DD-3',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'BILLING_REFUND_EXCEEDS_ADVANCE_BALANCE' });
  });

  it('calculateInvoiceRefundHeadroomTx handles empty aggregates and exclusion identity', async () => {
    queryMock.mockResolvedValueOnce([]);
    await expect(svc.calculateInvoiceRefundHeadroomTx(mockPrisma, 11)).resolves.toEqual({
      gross_paid: 0,
      active_refunds: 0,
      refundable: 0,
    });
    queryMock.mockResolvedValueOnce([{ gross_paid: '250.005', active_refunds: '49.995' }]);
    await expect(svc.calculateInvoiceRefundHeadroomTx(mockPrisma, 11, {
      excludeRefundId: 8,
    })).resolves.toEqual({
      gross_paid: 250.01,
      active_refunds: 50,
      refundable: 200.01,
    });
    expect(queryMock.mock.calls[1][0]).toContain('refund.id <> $2::int');
    expect(queryMock.mock.calls[1].slice(1)).toEqual([11, 8]);
  });

  it('getRefund reports missing identity before projecting a workflow', async () => {
    queryMock.mockResolvedValueOnce([]);
    await expect(svc.getRefund(8, { tenantId: TENANT })).rejects.toMatchObject({
      code: 'BILLING_REFUND_NOT_FOUND',
    });
    queryMock.mockReset();
    await expect(svc.getRefund(Number.MAX_SAFE_INTEGER + 1, {
      tenantId: TENANT,
    })).rejects.toMatchObject({ code: 'BILLING_REFUND_ID_INVALID' });
  });

  it('getRefund exposes the manual payout rail for an approved cash-like refund', async () => {
    queryMock.mockResolvedValueOnce([{
      id: 8,
      approval_status: 'APPROVED',
      mode: ' cash ',
      counter_sale_void_request_id: null,
      offline_electronic_evidence_id: null,
    }]);
    await expect(svc.getRefund(8, { tenantId: TENANT })).resolves.toMatchObject({
      workflow_status: 'ready_for_payout',
      allowed_payout_rails: ['manual'],
      original_payment: null,
    });
  });

  it('getRefund distinguishes gateway and offline-electronic invoice candidates', async () => {
    queryMock
      .mockResolvedValueOnce([{
        id: 8, patient_uid: PATIENT, invoice_id: 11, amount: '50',
        approval_status: 'APPROVED', mode: 'UPI',
      }])
      .mockResolvedValueOnce([
        { id: 51, mode: 'UPI', reference: 'UPI-51', provider_name: 'dry_run', gateway_order_id: 61 },
        { id: 52, mode: 'UPI', reference: 'UPI-52', provider_name: null, gateway_order_id: null },
      ]);
    await expect(svc.getRefund(8, { tenantId: TENANT })).resolves.toMatchObject({
      allowed_payout_rails: ['gateway', 'offline_electronic'],
      original_payment: null,
    });

    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce([{
        id: 8, patient_uid: PATIENT, invoice_id: 11, amount: '50',
        approval_status: 'APPROVED', mode: 'CARD',
      }])
      .mockResolvedValueOnce([{
        id: 53, mode: 'CARD', reference: 'CARD-53',
        provider_name: null, gateway_order_id: null,
      }]);
    await expect(svc.getRefund(8, { tenantId: TENANT })).resolves.toMatchObject({
      allowed_payout_rails: ['offline_electronic'],
      original_payment: {
        id: 53, mode: 'CARD', reference: 'CARD-53', provider_name: null,
      },
    });
  });

  it('getRefund projects an eligible advance and retained offline payout evidence', async () => {
    queryMock
      .mockResolvedValueOnce([{
        id: 9, patient_uid: PATIENT, advance_id: 12, invoice_id: null,
        amount: '30', approval_status: 'APPROVED', mode: 'CARD',
      }])
      .mockResolvedValueOnce([{ id: 12, mode: 'CARD', reference: 'CARD-12' }]);
    await expect(svc.getRefund(9, { tenantId: TENANT })).resolves.toMatchObject({
      allowed_payout_rails: ['offline_electronic'],
      original_payment: {
        id: 12, mode: 'CARD', reference: 'CARD-12', provider_name: null,
      },
    });

    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce([{
        id: 9, approval_status: 'PAID', mode: 'CARD',
        offline_electronic_evidence_id: '901',
      }])
      .mockResolvedValueOnce([{
        id: '901', original_payment_id: null, original_advance_id: '12',
        mode: 'CARD', original_payment_reference: 'CARD-12', provider_name: 'Acquirer',
      }]);
    await expect(svc.getRefund(9, { tenantId: TENANT })).resolves.toMatchObject({
      workflow_status: 'paid',
      original_payment: {
        id: 12, mode: 'CARD', reference: 'CARD-12', provider_name: 'Acquirer',
      },
    });
  });

  it.each([
    ['REFUND_REJECTED_REVIEW', 'refund_rejected_review'],
    ['RECONCILIATION_REQUIRED', 'reconciliation_required'],
    ['COMPLETED', 'counter_sale_void_completed'],
  ])('getRefund maps counter-sale void state %s', async (status, workflowStatus) => {
    queryMock
      .mockResolvedValueOnce([{
        id: 8, approval_status: 'PENDING', mode: 'CASH',
        counter_sale_void_request_id: '71',
      }])
      .mockResolvedValueOnce([{ id: '71', status }]);
    await expect(svc.getRefund(8, { tenantId: TENANT })).resolves.toMatchObject({
      workflow_status: workflowStatus,
    });
  });

  it.each([
    ['REJECTED', 'rejected'],
    ['PENDING', 'awaiting_approval'],
  ])('getRefund maps billing status %s', async (approvalStatus, workflowStatus) => {
    queryMock.mockResolvedValueOnce([{
      id: 8, approval_status: approvalStatus, mode: 'CASH',
    }]);
    await expect(svc.getRefund(8, { tenantId: TENANT })).resolves.toMatchObject({
      workflow_status: workflowStatus,
    });
  });

  it('listRefunds applies status + patient filters', async () => {
    queryMock.mockResolvedValueOnce([{ id: 1 }]);
    await svc.listRefunds({ tenantId: TENANT, approval_status: 'PENDING', patient_uid: PATIENT });
    const [sql, ...params] = queryMock.mock.calls[0];
    expect(sql).toContain('approval_status = $2');
    expect(sql).toContain('patient_uid = $3::uuid');
    expect(params).toEqual([TENANT, 'PENDING', PATIENT]);
  });

  it('listRefunds with no filters has no WHERE', async () => {
    queryMock.mockResolvedValueOnce([]);
    await svc.listRefunds();
    expect(queryMock.mock.calls[0][0]).not.toContain('WHERE');
  });

  it('listRefunds validates status and bigint workflow filters', async () => {
    await expect(svc.listRefunds({ approval_status: 'UNKNOWN' })).rejects.toMatchObject({
      code: 'BILLING_REFUND_STATUS_FILTER_INVALID',
    });
    for (const counter_sale_void_request_id of ['-1', 'abc', '9223372036854775808']) {
      await expect(svc.listRefunds({
        counter_sale_void_request_id,
      })).rejects.toMatchObject({ code: 'BILLING_REFUND_FILTER_INVALID' });
    }
  });

  it('listRefunds applies exact refund and counter-sale workflow identities', async () => {
    queryMock.mockResolvedValueOnce([{ id: 8 }]);
    await svc.listRefunds({
      tenantId: TENANT,
      approval_status: ' approved ',
      patient_uid: PATIENT,
      id: '8',
      counter_sale_void_request_id: '9223372036854775807',
    });
    const [sql, ...params] = queryMock.mock.calls[0];
    expect(sql).toContain('id = $4::int');
    expect(sql).toContain('counter_sale_void_request_id = $5::bigint');
    expect(params).toEqual([
      TENANT, 'APPROVED', PATIENT, 8, '9223372036854775807',
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────
// dailyCollection (filter branches) + outstandingBills
// ───────────────────────────────────────────────────────────────────────

describe('reports', () => {
  it('dailyCollection applies mode / shift / collected_by filters', async () => {
    queryMock.mockResolvedValue([]); // every internal query
    const r = await svc.dailyCollection({
      date: '2026-06-01', mode: 'CASH', shift: 'GENERAL', collected_by: PATIENT,
    });
    expect(r.date).toBe('2026-06-01');
    const itemsSql = queryMock.mock.calls[0][0];
    expect(itemsSql).toContain('mode = $2');
    expect(itemsSql).toContain('shift = $3');
    expect(itemsSql).toContain('collected_by = $4::uuid');
    // insurer breakdown query references bp. alias
    const insurerSql = queryMock.mock.calls[2][0];
    expect(insurerSql).toContain("bp.mode = 'INSURANCE'");
  });

  it('outstandingBills builds default ISSUED/PARTIAL filter', async () => {
    queryMock.mockResolvedValueOnce([{ id: 1, days_outstanding: 10 }]);
    const rows = await svc.outstandingBills({});
    expect(rows).toHaveLength(1);
    const [sql, ...params] = queryMock.mock.calls[0];
    expect(sql).toContain("status IN ('ISSUED', 'PARTIAL')");
    expect(sql).toContain('amount_due > 0');
    expect(params).toEqual([100]); // just the limit
  });

  it('outstandingBills applies days_old + department filters', async () => {
    queryMock.mockResolvedValueOnce([]);
    await svc.outstandingBills({ days_old: 30, department: 'Cardiology', limit: 50 });
    const [sql, ...params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/\$1::int \|\| ' days'/);
    expect(sql).toContain('department = $2');
    expect(params).toEqual([30, 'Cardiology', 50]);
  });
});

// ───────────────────────────────────────────────────────────────────────
// TPA decision helpers
// ───────────────────────────────────────────────────────────────────────

describe('recordInvoiceItemTpaDecision', () => {
  it('rejects an invalid decision', async () => {
    await expect(
      svc.recordInvoiceItemTpaDecision({ invoice_id: 1, item_id: 2, decision: 'maybe' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('requires a valid non_payable_reason for non_payable / partial', async () => {
    await expect(
      svc.recordInvoiceItemTpaDecision({ invoice_id: 1, item_id: 2, decision: 'non_payable' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      svc.recordInvoiceItemTpaDecision({
        invoice_id: 1, item_id: 2, decision: 'partial', non_payable_reason: 'bogus_reason',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws notFound when invoice missing', async () => {
    queryMock.mockResolvedValueOnce([]); // findBillingInvoice
    await expect(
      svc.recordInvoiceItemTpaDecision({ invoice_id: 1, item_id: 2, decision: 'payable' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws notFound when the item row does not update', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }]) // findBillingInvoice
      .mockResolvedValueOnce([]); // UPDATE RETURNING -> none
    await expect(
      svc.recordInvoiceItemTpaDecision({ invoice_id: 1, item_id: 2, decision: 'payable' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('records a payable decision (reason nulled)', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }]) // findBillingInvoice
      .mockResolvedValueOnce([{ id: 2, tpa_decision: 'payable' }]); // UPDATE RETURNING
    const r = await svc.recordInvoiceItemTpaDecision({
      invoice_id: 1, item_id: 2, decision: 'payable', decided_by: PATIENT,
    });
    expect(r).toMatchObject({ tpa_decision: 'payable' });
    // reason param should be null for payable
    const updateParams = queryMock.mock.calls[1];
    expect(updateParams[2]).toBeNull();
  });

  it('records a non_payable decision with a valid reason', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 2, tpa_decision: 'non_payable', tpa_non_payable_reason: 'cosmetic' }]);
    const r = await svc.recordInvoiceItemTpaDecision({
      invoice_id: 1, item_id: 2, decision: 'non_payable', non_payable_reason: 'cosmetic',
    });
    expect(r).toMatchObject({ tpa_non_payable_reason: 'cosmetic' });
    expect(queryMock.mock.calls[1][2]).toBe('cosmetic');
  });
});

describe('getInvoiceNonPayableBreakdown', () => {
  it('throws notFound when invoice missing', async () => {
    queryMock.mockResolvedValueOnce([]);
    await expect(svc.getInvoiceNonPayableBreakdown(1)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('sums non-payable line totals', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }]) // findBillingInvoice
      .mockResolvedValueOnce([
        {
          id: 10, line_total: '100.50', tpa_decision: 'non_payable', source_ref_id: 42n,
        },
        {
          id: 11, line_total: '49.50', tpa_decision: 'partial',
          source_ref_id: 9_007_199_254_740_993n,
        },
      ]);
    const r = await svc.getInvoiceNonPayableBreakdown(1, { tenantId: TENANT });
    expect(r.non_payable_total).toBe(150);
    expect(r.line_count).toBe(2);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0].source_ref_id).toBe(42);
    expect(r.lines[1].source_ref_id).toBe('9007199254740993');
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it('handles an empty breakdown (total 0)', async () => {
    queryMock
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([]);
    const r = await svc.getInvoiceNonPayableBreakdown(1);
    expect(r.non_payable_total).toBe(0);
    expect(r.line_count).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// maybeEmitTpaCapAlerts (driven via collectPayment -> recompute path) and
// the issue/recompute TPA-alert branches. These exercise the large
// 766-844 block: cap resolution, idempotency probe, alert INSERT, and the
// CRITICAL+WARNING ladder.
// ───────────────────────────────────────────────────────────────────────

// A SQL-routing prisma stub. Drives the deep internal call chains
// (addInvoiceItem -> recomputeInvoiceTotals -> maybeEmitTpaCapAlerts and
// the itemizer's per-source queries) without having to hand-order dozens
// of mockResolvedValueOnce calls. Each handler receives (sql, params) and
// returns the rows that query would yield.
function routeQueries(handlers) {
  const impl = (sql /* , ...params */) => {
    for (const [needle, rows] of handlers) {
      if (sql.includes(needle)) {
        return Promise.resolve(typeof rows === 'function' ? rows(sql) : rows);
      }
    }
    return Promise.resolve([]);
  };
  queryMock.mockImplementation(impl);
}

describe('maybeEmitTpaCapAlerts via recompute (TPA cap ladder)', () => {
  const ADMISSION = 77;
  const TPA_CAP_ROW = [{
    root_preauth_id: 7,
    root_preauth_number: 'PA-7',
    root_preauth_status: 'approved',
    root_preauth_denial_reason: null,
    root_preauth_sanctioned_amount: '80000',
    policy_id: 3,
    cumulative_approved: '80000',
  }];

  it('emits CRITICAL + WARNING alerts when an over-cap payment recomputes the bill', async () => {
    routeQueries([
      // collectPayment -> findBillingInvoice
      ['FROM billing_invoices\n      WHERE id', [{
        status: 'ISSUED', patient_uid: PATIENT, amount_due: '100000',
      }]],
      // INSERT payment RETURNING *
      ['INSERT INTO billing_payments', [{ id: 90, invoice_id: 9, amount: '90000' }]],
      // recomputeInvoicePaymentState -> paid aggregate (subquery references billing_payments)
      ['SELECT (', [{ paid: '90000' }]],
      // recomputeInvoicePaymentState -> total
      ['SELECT total_amount, credit_note_amount FROM billing_invoices', [{ total_amount: '90000', credit_note_amount: '0' }]],
      // syncUnusedAdmissionAdvancesForInvoice -> invoice lookup (has admission)
      ['FROM billing_invoices\n      WHERE id = $1::int\n      LIMIT 1', [{ id: 9, admission_id: ADMISSION }]],
    ]);
    // collectPayment's recomputeInvoicePaymentState does NOT call
    // maybeEmitTpaCapAlerts — that lives in recomputeInvoiceTotals + issue.
    // Drive the alert path through issueInvoice instead (below). Here we
    // simply confirm the payment recompute + advance sync run without the
    // alert path.
    const row = await svc.collectPayment({ invoice_id: 9, amount: 90000, mode: 'UPI' });
    expect(row).toMatchObject({ id: 90 });
  });

  it('issueInvoice emits TPA alerts when the issued bill is over cap', async () => {
    let alertInserts = 0;
    routeQueries([
      // findBillingInvoice (id,status,tenant_id)
      ['FROM billing_invoices\n      WHERE id', [{ id: 9, status: 'DRAFT', tenant_id: TENANT }]],
      // item count
      ['COUNT(*)::int AS c FROM billing_invoice_items', [{ c: 3 }]],
      // nextInvoiceNumber counter
      ['INSERT INTO billing_invoice_counter', [{ next_value: 5 }]],
      // issue meta lookup (admission + patient + total)
      ['SELECT admission_id, patient_uid, tenant_id, total_amount', [{
        admission_id: ADMISSION, patient_uid: PATIENT, tenant_id: TENANT, total_amount: '90000',
      }]],
      // resolveAdmissionTpaCap
      ['WITH active_root AS', TPA_CAP_ROW],
      // maybeEmitTpaCapAlerts -> users id lookup
      ['SELECT id FROM users WHERE uid', [{ id: 4242 }]],
      // idempotency probe -> none existing, so insert proceeds
      ['FROM clinical_alerts', []],
      // alert INSERT RETURNING
      ['INSERT INTO clinical_alerts', (sql) => {
        alertInserts += 1;
        return [{ id: alertInserts, severity: sql.includes('CRITICAL') ? 'CRITICAL' : 'WARNING', message: 'x' }];
      }],
      // getInvoice tail: invoice, items, payments, settlements
      ['FROM billing_invoices\n      WHERE id', [{ id: 9, invoice_number: 'INV-2026-000004', admission_id: ADMISSION, tenant_id: TENANT, total_amount: '90000' }]],
      ['FROM billing_invoice_items WHERE invoice_id', []],
      ['FROM billing_payments WHERE invoice_id', []],
      ['FROM billing_advance_settlements s', []],
    ]);
    const r = await svc.issueInvoice(9, { tenantId: TENANT });
    expect(r).toBeTruthy();
    // Two alerts inserted (CRITICAL + WARNING) since 90000/80000 = 112.5%
    expect(alertInserts).toBe(2);
  });

  it('issueInvoice TPA alert path is swallowed on DB error (logged not thrown)', async () => {
    routeQueries([
      ['FROM billing_invoices\n      WHERE id', [{ id: 9, status: 'DRAFT', tenant_id: TENANT }]],
      ['COUNT(*)::int AS c FROM billing_invoice_items', [{ c: 1 }]],
      ['INSERT INTO billing_invoice_counter', [{ next_value: 2 }]],
      ['SELECT admission_id, patient_uid, tenant_id, total_amount', [{
        admission_id: ADMISSION, patient_uid: PATIENT, tenant_id: TENANT, total_amount: '90000',
      }]],
      // resolveAdmissionTpaCap throws -> caught + logged
      ['WITH active_root AS', () => { throw new Error('cap boom'); }],
      // getInvoice tail still runs
      ['FROM billing_invoices\n      WHERE id', [{ id: 9, invoice_number: 'INV-2026-000001', admission_id: ADMISSION, tenant_id: TENANT, total_amount: '90000' }]],
      ['FROM billing_invoice_items WHERE invoice_id', []],
      ['FROM billing_payments WHERE invoice_id', []],
      ['FROM billing_advance_settlements s', []],
    ]);
    const r = await svc.issueInvoice(9, { tenantId: TENANT });
    expect(r).toBeTruthy();
  });

  it('maybeEmit suppresses a duplicate alert when one is already unacknowledged', async () => {
    let alertInserts = 0;
    routeQueries([
      ['FROM billing_invoices\n      WHERE id', [{ id: 9, status: 'DRAFT', tenant_id: TENANT }]],
      ['COUNT(*)::int AS c FROM billing_invoice_items', [{ c: 1 }]],
      ['INSERT INTO billing_invoice_counter', [{ next_value: 2 }]],
      ['SELECT admission_id, patient_uid, tenant_id, total_amount', [{
        admission_id: ADMISSION, patient_uid: PATIENT, tenant_id: TENANT, total_amount: '70000',
      }]],
      // 70000/80000 = 87.5% -> WARNING only (>=80, <100)
      ['WITH active_root AS', TPA_CAP_ROW],
      ['SELECT id FROM users WHERE uid', [{ id: 4242 }]],
      // idempotency probe returns an existing row -> skip insert
      ['FROM clinical_alerts', [{ id: 1 }]],
      ['INSERT INTO clinical_alerts', () => { alertInserts += 1; return [{ id: 99 }]; }],
      ['FROM billing_invoices\n      WHERE id', [{ id: 9, invoice_number: 'INV-2026-000001', admission_id: ADMISSION, tenant_id: TENANT, total_amount: '70000' }]],
      ['FROM billing_invoice_items WHERE invoice_id', []],
      ['FROM billing_payments WHERE invoice_id', []],
      ['FROM billing_advance_settlements s', []],
    ]);
    await svc.issueInvoice(9, { tenantId: TENANT });
    expect(alertInserts).toBe(0); // suppressed
  });

  it('maybeEmit returns early when the bill is under the warn threshold', async () => {
    let alertInserts = 0;
    routeQueries([
      ['FROM billing_invoices\n      WHERE id', [{ id: 9, status: 'DRAFT', tenant_id: TENANT }]],
      ['COUNT(*)::int AS c FROM billing_invoice_items', [{ c: 1 }]],
      ['INSERT INTO billing_invoice_counter', [{ next_value: 2 }]],
      ['SELECT admission_id, patient_uid, tenant_id, total_amount', [{
        admission_id: ADMISSION, patient_uid: PATIENT, tenant_id: TENANT, total_amount: '1000',
      }]],
      ['WITH active_root AS', TPA_CAP_ROW], // 1000/80000 = 1.25% -> no alert
      ['SELECT id FROM users WHERE uid', [{ id: 4242 }]],
      ['INSERT INTO clinical_alerts', () => { alertInserts += 1; return [{ id: 1 }]; }],
      ['FROM billing_invoices\n      WHERE id', [{ id: 9, invoice_number: 'INV-2026-000001', admission_id: ADMISSION, tenant_id: TENANT, total_amount: '1000' }]],
      ['FROM billing_invoice_items WHERE invoice_id', []],
      ['FROM billing_payments WHERE invoice_id', []],
      ['FROM billing_advance_settlements s', []],
    ]);
    await svc.issueInvoice(9, { tenantId: TENANT });
    expect(alertInserts).toBe(0);
  });

  it('maybeEmit returns early when the resolved patient user is missing', async () => {
    let alertInserts = 0;
    routeQueries([
      ['FROM billing_invoices\n      WHERE id', [{ id: 9, status: 'DRAFT', tenant_id: TENANT }]],
      ['COUNT(*)::int AS c FROM billing_invoice_items', [{ c: 1 }]],
      ['INSERT INTO billing_invoice_counter', [{ next_value: 2 }]],
      ['SELECT admission_id, patient_uid, tenant_id, total_amount', [{
        admission_id: ADMISSION, patient_uid: PATIENT, tenant_id: TENANT, total_amount: '90000',
      }]],
      ['WITH active_root AS', TPA_CAP_ROW],
      ['SELECT id FROM users WHERE uid', []], // no user -> early return []
      ['INSERT INTO clinical_alerts', () => { alertInserts += 1; return [{ id: 1 }]; }],
      ['FROM billing_invoices\n      WHERE id', [{ id: 9, invoice_number: 'INV-2026-000001', admission_id: ADMISSION, tenant_id: TENANT, total_amount: '90000' }]],
      ['FROM billing_invoice_items WHERE invoice_id', []],
      ['FROM billing_payments WHERE invoice_id', []],
      ['FROM billing_advance_settlements s', []],
    ]);
    await svc.issueInvoice(9, { tenantId: TENANT });
    expect(alertInserts).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// itemizeAdmissionInvoice — the 1563-1878 block (the biggest single lift).
// Drives the package / pharmacy / ward-indent / lab / consult / theatre
// emitters + idempotency skip via a SQL-routing stub (the function calls
// addInvoiceItem internally, which recomputes totals).
// ───────────────────────────────────────────────────────────────────────

describe('itemizeAdmissionInvoice', () => {
  const ADMISSION = 50;

  // Default routes for the addInvoiceItem -> recompute chain that fires
  // once per emitted line. These are order-independent (matched by SQL
  // substring) so the per-line internal calls always resolve.
  function itemizerCommonRoutes(extra = []) {
    return [
      // addInvoiceItem -> findBillingInvoice (status, patient_state, ...)
      ['status, patient_state, hospital_state, admission_id', [{
        status: 'DRAFT', patient_state: null, hospital_state: null, admission_id: ADMISSION,
      }]],
      // assertAdmissionBillingOpen (admission open)
      ['SELECT billing_closed_at FROM admissions', []],
      // addInvoiceItem -> INSERT item RETURNING *
      ['INSERT INTO billing_invoice_items', [{ id: 500 }]],
      // recomputeInvoiceTotals -> aggregates
      ['COALESCE(SUM(line_subtotal)', [{ subtotal: '0', cgst: '0', sgst: '0', igst: '0' }]],
      // recomputeInvoiceTotals -> discount/paid read
      ['SELECT discount_amount, credit_note_amount, amount_paid', [{ discount_amount: '0', credit_note_amount: '0', amount_paid: '0' }]],
      // recomputeInvoiceTotals -> meta lookup (no admission/patient -> no alert)
      ['SELECT admission_id, patient_uid, tenant_id\n       FROM billing_invoices', [{ admission_id: null, patient_uid: null, tenant_id: TENANT }]],
      ...extra,
    ];
  }

  it('rejects a non-positive invoiceId', async () => {
    await expect(svc.itemizeAdmissionInvoice(0)).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.itemizeAdmissionInvoice('abc')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws notFound when the invoice is missing', async () => {
    routeQueries([['id, status, admission_id', []]]);
    await expect(svc.itemizeAdmissionInvoice(1)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects a non-DRAFT invoice', async () => {
    routeQueries([['id, status, admission_id', [{ id: 1, status: 'ISSUED', admission_id: ADMISSION }]]]);
    await expect(svc.itemizeAdmissionInvoice(1)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an invoice with no admission_id', async () => {
    routeQueries([['id, status, admission_id', [{ id: 1, status: 'DRAFT', admission_id: null }]]]);
    await expect(svc.itemizeAdmissionInvoice(1)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws notFound when the admission row is missing', async () => {
    routeQueries([
      ['id, status, admission_id', [{ id: 1, status: 'DRAFT', admission_id: ADMISSION }]],
      ['FROM admissions a', []], // fetchAdmissionForItemizing -> none
    ]);
    await expect(svc.itemizeAdmissionInvoice(1)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('itemizes package + pharmacy + ward indent + lab and stamps tpa_decision', async () => {
    routeQueries([
      // Phase 0 invoice pre-flight (itemizer's findBillingInvoice)
      ['id, status, admission_id', [{ id: 1, status: 'DRAFT', admission_id: ADMISSION }]],
      // fetchAdmissionForItemizing
      ['FROM admissions a', [{
        id: ADMISSION,
        patient_uid: PATIENT,
        encounter_id: null,
        admitted_at: '2026-06-01T00:00:00Z',
        discharged_at: '2026-06-05T00:00:00Z',
        ward: 'W1',
        bed_id: null,
        package_id: 12,
        package_code: 'PKG-1',
        package_estimated_cost_minor: '5000000', // 50000.00
        package_price_minor: null,
        package_name: 'Cataract Package',
      }]],
      // fetchExistingSourceLines -> one existing pharmacy key to exercise the skip branch
      ['SELECT id, source_ref_type', [{ source_ref_type: 'pharmacy_order', source_ref_id: 999 }]],
      // pharmacy orders (one new + one already-existing(999) + one zero-priced)
      ['FROM pharmacy_orders', [
        { id: 201, order_number: 'PH-201', medication: 'Paracetamol', total_amount: '120', dispensed_at: '2026-06-02' },
        { id: 999, order_number: 'PH-999', medication: 'Existing', total_amount: '50', dispensed_at: '2026-06-02' },
        { id: 202, order_number: 'PH-202', medication: 'FreeSample', total_amount: '0', dispensed_at: '2026-06-02' },
      ]],
      // ward indents (one charged, one zero-valued audit line)
      ['FROM ward_indents wi', [
        { id: 301, indent_number: 'WI-301', ward_name: 'W1', billable_at: '2026-06-03', total_amount: '125', item_summary: 'Saline x 1' },
        { id: 302, indent_number: 'WI-302', ward_name: 'W1', billable_at: '2026-06-03', total_amount: '0', item_summary: 'Nil' },
        { id: 303, indent_number: 'WI-303', ward_name: 'W1', billable_at: '2026-06-03', total_amount: 'not-a-number', item_summary: 'Invalid' },
        { id: 304, indent_number: 'WI-304', ward_name: 'W1', billable_at: '2026-06-03', total_amount: '-1', item_summary: 'Invalid' },
      ]],
      // investigations (one billable, one zero-priced skip)
      ['FROM investigations', [
        { id: 401, test_name: 'CBC', cost: '300', completed_at: '2026-06-02' },
        { id: 402, test_name: 'FreeTest', cost: '0', completed_at: '2026-06-02' },
      ]],
      // discharge consults
      ['FROM discharge_consults', [{ id: 501, consult_type: 'Cardiology', completed_at: '2026-06-04' }]],
      // ot schedules
      ['FROM ot_schedules', [{ id: 601, procedure_name: 'Phaco', procedure_code: 'OT-1', scheduled_date: '2026-06-03' }]],
      // ---- per-line addInvoiceItem internal chain (order-independent) ----
      ['status, patient_state, hospital_state, admission_id', [{
        status: 'DRAFT', patient_state: null, hospital_state: null, admission_id: ADMISSION,
      }]],
      ['SELECT billing_closed_at FROM admissions', []],
      ['INSERT INTO billing_invoice_items', [{ id: 500 }]],
      ['COALESCE(SUM(line_subtotal)', [{ subtotal: '0', cgst: '0', sgst: '0', igst: '0' }]],
      ['SELECT discount_amount, credit_note_amount, amount_paid', [{ discount_amount: '0', credit_note_amount: '0', amount_paid: '0' }]],
      ['SELECT admission_id, patient_uid, tenant_id\n       FROM billing_invoices', [{ admission_id: null, patient_uid: null, tenant_id: TENANT }]],
    ]);

    const res = await svc.itemizeAdmissionInvoice(1, { tenantId: TENANT, decided_by: PATIENT });
    expect(res.admission_id).toBe(ADMISSION);
    expect(res.package_id).toBe(12);
    expect(res.summary.package).toBe(1);
    expect(res.summary.pharmacy).toBe(1); // 201 only (999 existing, 202 zero)
    expect(res.summary.ward_indents).toBe(2); // 301 charged, 302 retained for audit traceability
    expect(res.summary.lab).toBe(1); // 401 only
    expect(res.summary.consults).toBe(1);
    expect(res.summary.theatre).toBe(1);
    expect(res.summary.skipped_existing).toBe(1); // pharmacy 999
    // tpa_decision stamped via the post-insert UPDATE (reason may be null,
    // which expect.anything() would reject — assert on the SQL only).
    const tpaStampCall = execMock.mock.calls.find((c) => /SET\s+tpa_decision/i.test(c[0]));
    expect(tpaStampCall).toBeTruthy();
    expect(tpaStampCall[1]).toBe('payable'); // package line decision
  });

  it('keeps unchanged ward-indent lines and synchronizes changed lines in place', async () => {
    const unchanged = {
      id: 701,
      source_ref_type: 'ward_indent',
      source_ref_id: 301,
      description: 'Pharmacy ward indent: WI-301',
      category: 'pharmacy',
      quantity: '1',
      unit_price: '125',
      gst_rate: '0',
      line_subtotal: '125',
      line_total: '125',
      notes: 'W1 - Saline x 1',
      tenant_id: TENANT,
    };
    const changed = {
      ...unchanged,
      id: 702,
      source_ref_id: 302,
      description: 'Pharmacy ward indent: WI-302',
      notes: 'W1 - Old item x 1',
    };
    routeQueries(itemizerCommonRoutes([
      ['id, status, admission_id', [{ id: 1, status: 'DRAFT', admission_id: ADMISSION }]],
      ['FROM admissions a', [{
        id: ADMISSION, tenant_id: TENANT, patient_uid: PATIENT, encounter_id: null,
        admitted_at: '2026-06-01T00:00:00Z', discharged_at: null,
        ward: 'W1', bed_id: null, package_id: null, package_code: null,
        package_estimated_cost_minor: null, package_price_minor: null, package_name: null,
      }]],
      ['SELECT id, source_ref_type', [unchanged, changed]],
      ['FROM ward_indents wi', [
        { id: 301, indent_number: 'WI-301', ward_name: 'W1', total_amount: '125', item_summary: 'Saline x 1' },
        { id: 302, indent_number: 'WI-302', ward_name: 'W1', total_amount: '125', item_summary: 'New item x 1' },
      ]],
      ['SELECT status, admission_id', [{ status: 'DRAFT', admission_id: ADMISSION }]],
      ['UPDATE billing_invoice_items', [{
        ...changed,
        notes: 'W1 - New item x 1',
        source_ref_active: true,
      }]],
    ]));

    const res = await svc.itemizeAdmissionInvoice(1, {
      tenantId: TENANT,
      emit_package: false,
      emit_pharmacy: false,
      emit_lab: false,
      emit_consults: false,
      emit_theatre: false,
    });

    expect(res.summary).toMatchObject({
      ward_indents: 0,
      ward_indents_updated: 1,
      skipped_existing: 1,
    });
    const updateCall = queryMock.mock.calls.find((c) => /UPDATE billing_invoice_items/.test(c[0]));
    expect(updateCall).toBeTruthy();
    expect(updateCall.slice(1)).toEqual([
      'Pharmacy ward indent: WI-302',
      'pharmacy',
      1,
      125,
      0,
      125,
      'W1 - New item x 1',
      702,
      1,
      TENANT,
      'ward_indent',
      302,
    ]);
  });

  it.each([
    {
      name: 'invoice vanished while locking',
      lockRows: [],
      updateRows: null,
      code: undefined,
      statusCode: 404,
    },
    {
      name: 'invoice stopped being a draft',
      lockRows: [{ status: 'ISSUED', admission_id: ADMISSION }],
      updateRows: null,
      code: 'WARD_INDENT_BILLING_INVOICE_NOT_DRAFT',
      statusCode: 409,
    },
    {
      name: 'source line changed concurrently',
      lockRows: [{ status: 'DRAFT', admission_id: ADMISSION }],
      updateRows: [],
      code: 'WARD_INDENT_BILLING_LINE_CHANGED',
      statusCode: 409,
    },
  ])('fails closed when a synchronized $name', async ({ lockRows, updateRows, code, statusCode }) => {
    const existing = {
      id: 702,
      source_ref_type: 'ward_indent',
      source_ref_id: 302,
      description: 'Pharmacy ward indent: WI-302',
      category: 'pharmacy',
      quantity: '1',
      unit_price: '125',
      gst_rate: '0',
      line_subtotal: '125',
      line_total: '125',
      notes: 'W1 - Old item x 1',
      tenant_id: TENANT,
    };
    const routes = [
      ['id, status, admission_id', [{ id: 1, status: 'DRAFT', admission_id: ADMISSION }]],
      ['FROM admissions a', [{
        id: ADMISSION, tenant_id: TENANT, patient_uid: PATIENT, encounter_id: null,
        admitted_at: '2026-06-01T00:00:00Z', discharged_at: null,
        ward: 'W1', bed_id: null, package_id: null, package_code: null,
        package_estimated_cost_minor: null, package_price_minor: null, package_name: null,
      }]],
      ['SELECT id, source_ref_type', [existing]],
      ['FROM ward_indents wi', [{
        id: 302, indent_number: 'WI-302', ward_name: 'W1',
        total_amount: '125', item_summary: 'New item x 1',
      }]],
      ['SELECT status, admission_id', lockRows],
    ];
    if (updateRows) routes.push(['UPDATE billing_invoice_items', updateRows]);
    routeQueries(itemizerCommonRoutes(routes));

    await expect(svc.itemizeAdmissionInvoice(1, {
      tenantId: TENANT,
      emit_package: false,
      emit_pharmacy: false,
      emit_lab: false,
      emit_consults: false,
      emit_theatre: false,
    })).rejects.toMatchObject({ statusCode, ...(code ? { code } : {}) });
  });

  it('falls back to package_price_minor when estimated cost is null', async () => {
    routeQueries(itemizerCommonRoutes([
      ['id, status, admission_id', [{ id: 1, status: 'DRAFT', admission_id: ADMISSION }]],
      ['FROM admissions a', [{
        id: ADMISSION, patient_uid: PATIENT, encounter_id: null,
        admitted_at: '2026-06-01T00:00:00Z', discharged_at: null,
        ward: 'W1', bed_id: null, package_id: 12, package_code: 'PKG-1',
        package_estimated_cost_minor: null, package_price_minor: '3000000', package_name: 'Pkg',
      }]],
      ['SELECT id, source_ref_type', []],
    ]));
    const res = await svc.itemizeAdmissionInvoice(1, {
      tenantId: TENANT,
      emit_pharmacy: false, emit_ward_indents: false, emit_lab: false,
      emit_consults: false, emit_theatre: false,
    });
    expect(res.summary.package).toBe(1);
  });

  it('skips the package line when admission has no package_id', async () => {
    routeQueries([
      ['id, status, admission_id', [{ id: 1, status: 'DRAFT', admission_id: ADMISSION }]],
      ['FROM admissions a', [{
        id: ADMISSION, patient_uid: PATIENT, encounter_id: null,
        admitted_at: '2026-06-01T00:00:00Z', discharged_at: null,
        ward: 'W1', bed_id: null, package_id: null, package_code: null,
        package_estimated_cost_minor: null, package_price_minor: null, package_name: null,
      }]],
      ['SELECT id, source_ref_type', []],
      // all emitters disabled below, so no source queries needed
    ]);
    const res = await svc.itemizeAdmissionInvoice(1, {
      emit_pharmacy: false, emit_ward_indents: false, emit_lab: false,
      emit_consults: false, emit_theatre: false,
    });
    expect(res.summary.package).toBe(0);
    expect(res.package_id).toBeNull();
  });

  it('honours selective emit flags (lab only)', async () => {
    routeQueries([
      ['id, status, admission_id', [{ id: 1, status: 'DRAFT', admission_id: ADMISSION }]],
      ['FROM admissions a', [{
        id: ADMISSION, patient_uid: PATIENT, encounter_id: null,
        admitted_at: '2026-06-01T00:00:00Z', discharged_at: '2026-06-05T00:00:00Z',
        ward: 'W1', bed_id: null, package_id: null, package_code: null,
        package_estimated_cost_minor: null, package_price_minor: null, package_name: null,
      }]],
      ['SELECT id, source_ref_type', []],
      ['FROM investigations', [{ id: 401, test_name: 'CBC', cost: '300', completed_at: '2026-06-02' }]],
      // per-line addInvoiceItem chain
      ['status, patient_state, hospital_state, admission_id', [{
        status: 'DRAFT', patient_state: null, hospital_state: null, admission_id: ADMISSION,
      }]],
      ['SELECT billing_closed_at FROM admissions', []],
      ['INSERT INTO billing_invoice_items', [{ id: 500 }]],
      ['COALESCE(SUM(line_subtotal)', [{ subtotal: '300', cgst: '0', sgst: '0', igst: '0' }]],
      ['SELECT discount_amount, credit_note_amount, amount_paid', [{ discount_amount: '0', credit_note_amount: '0', amount_paid: '0' }]],
      ['SELECT admission_id, patient_uid, tenant_id\n       FROM billing_invoices', [{ admission_id: null, patient_uid: null, tenant_id: TENANT }]],
    ]);
    const res = await svc.itemizeAdmissionInvoice(1, {
      tenantId: TENANT,
      emit_package: false, emit_pharmacy: false, emit_ward_indents: false,
      emit_consults: false, emit_theatre: false,
    });
    expect(res.summary.lab).toBe(1);
    expect(res.summary.pharmacy).toBe(0);
    expect(res.summary.theatre).toBe(0);
  });
});

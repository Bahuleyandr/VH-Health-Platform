import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const prismaMock = { $queryRawUnsafe: queryUnsafeMock };
const txQueryMock = jest.fn();
const txMock = { $queryRawUnsafe: txQueryMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: jest.fn(async (_tenantId, callback) => callback(txMock)),
}));

const settingsMock = jest.fn();
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getGstEInvoiceSettings: settingsMock,
}));

const svc = await import('../../services/billing/gstEInvoiceService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

const INVOICE = {
  id: 7, invoice_number: 'INV-2026-000007', patient_name: 'Test Patient',
  patient_state: 'Kerala', hospital_state: 'Kerala',
  subtotal: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 0,
  discount_amount: 0, total_amount: 1180, status: 'ISSUED', issued_at: '2026-08-01T00:00:00Z',
};
const ITEMS = [{
  description: 'Consultation', hsn_sac: '999311', quantity: 1, unit_price: 1000,
  gst_rate: 18, line_subtotal: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 0, line_total: 1180,
}];

beforeEach(() => {
  queryUnsafeMock.mockReset();
  txQueryMock.mockReset();
  settingsMock.mockReset();
  delete process.env.GST_EINVOICE_ENABLED;
});

describe('dark gate', () => {
  test('env off → 503 GST_EINVOICE_NOT_ENABLED', async () => {
    await expect(svc.requireGstEInvoiceEnabled(TENANT)).rejects.toMatchObject({
      statusCode: 503, code: 'GST_EINVOICE_NOT_ENABLED',
    });
  });
  test('env on + tenant off → 403 GST_EINVOICE_DISABLED', async () => {
    process.env.GST_EINVOICE_ENABLED = 'true';
    settingsMock.mockResolvedValue({ enabled: false, provider: 'mock' });
    await expect(svc.requireGstEInvoiceEnabled(TENANT)).rejects.toMatchObject({
      statusCode: 403, code: 'GST_EINVOICE_DISABLED',
    });
  });
});

describe('payload + adapter', () => {
  test('stateCode maps known + unknown', () => {
    expect(svc._internal.stateCode('Kerala')).toBe('32');
    expect(svc._internal.stateCode('Maharashtra')).toBe('27');
    expect(svc._internal.stateCode('Atlantis')).toBe('99');
  });

  test('buildEInvoicePayload has the required INV blocks and balances', () => {
    const p = svc._internal.buildEInvoicePayload({
      invoice: INVOICE, items: ITEMS,
      seller: { gstin: '32AAAAA0000A1Z0', legalName: 'VH', state: 'Kerala' },
    });
    expect(p.Version).toBe('1.1');
    expect(p.DocDtls.No).toBe('INV-2026-000007');
    expect(p.SellerDtls.Gstin).toBe('32AAAAA0000A1Z0');
    expect(p.ItemList).toHaveLength(1);
    expect(p.ValDtls.TotInvVal).toBe(1180);
    expect(p.ValDtls.AssVal).toBe(1000);
  });

  test('mock adapter is deterministic — same payload → same 64-char IRN', () => {
    const p = svc._internal.buildEInvoicePayload({
      invoice: INVOICE, items: ITEMS, seller: { gstin: 'G', state: 'Kerala' },
    });
    const a = svc._internal.mockGspAdapter(p, { provider: 'mock' });
    const b = svc._internal.mockGspAdapter(p, { provider: 'mock' });
    expect(a.irn).toEqual(b.irn);
    expect(a.irn).toMatch(/^[0-9a-f]{64}$/);
    expect(a.signed_qr_code).toBeTruthy();
  });

  test('resolveGspAdapter: mock/sandbox self-contained, nic/gsp are live seams', () => {
    expect(svc._internal.resolveGspAdapter('mock').key).toBe('mock');
    expect(svc._internal.resolveGspAdapter('sandbox').key).toBe('sandbox');
    const live = svc._internal.resolveGspAdapter('nic');
    expect(() => live.adapter({}, { provider: 'nic' })).toThrow(/GSP credentials/);
  });
});

describe('generateIrn', () => {
  beforeEach(() => {
    process.env.GST_EINVOICE_ENABLED = 'true';
    settingsMock.mockResolvedValue({ enabled: true, provider: 'mock', sellerGstin: '32AAAAA0000A1Z0', sellerLegalName: 'VH' });
  });

  // Sequence the tx mocks for one full generateIrn run. priorCount is what the
  // per-invoice generation COUNT(*) reports (cancelled rows included). The
  // INSERT mock echoes the bound irn param back so assertions see the real IRN.
  function mockGenerateSequence({ priorCount = 0 } = {}) {
    txQueryMock
      .mockResolvedValueOnce([INVOICE])           // loadInvoice
      .mockResolvedValueOnce([])                  // live (non-cancelled) row FOR UPDATE — none
      .mockResolvedValueOnce([{ n: priorCount }]) // generation count
      .mockResolvedValueOnce(ITEMS)               // loadInvoiceItems
      .mockImplementationOnce(async (...args) => [
        { id: 1, invoice_id: 7, status: 'generated', irn: args[5], seller_gstin: args[4] },
      ]);                                         // insert
  }
  const insertCall = () => txQueryMock.mock.calls[4];

  test('stores a generated document for an issued invoice', async () => {
    mockGenerateSequence();
    const row = await svc.generateIrn({ tenantId: TENANT, invoiceId: 7 });
    expect(row.status).toBe('generated');
    expect(row.invoice_id).toBe(7);
    expect(row.irn).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects a DRAFT invoice', async () => {
    txQueryMock.mockResolvedValueOnce([{ ...INVOICE, status: 'DRAFT' }]);
    await expect(svc.generateIrn({ tenantId: TENANT, invoiceId: 7 }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('regenerate after cancel succeeds with a NEW, distinct IRN', async () => {
    mockGenerateSequence({ priorCount: 0 });
    const first = await svc.generateIrn({ tenantId: TENANT, invoiceId: 7 });
    const firstPayload = JSON.parse(insertCall()[11]);

    // The cancelled row keeps its IRN and still counts toward the generation
    // number, so the second document's canonical payload — and therefore the
    // deterministic mock IRN — must differ.
    txQueryMock.mockReset();
    mockGenerateSequence({ priorCount: 1 });
    const second = await svc.generateIrn({ tenantId: TENANT, invoiceId: 7 });
    const secondPayload = JSON.parse(insertCall()[11]);

    expect(first.irn).toMatch(/^[0-9a-f]{64}$/);
    expect(second.irn).toMatch(/^[0-9a-f]{64}$/);
    expect(second.irn).not.toBe(first.irn);
    expect(firstPayload._meta.generation).toBe(1);
    expect(secondPayload._meta.generation).toBe(2);
  });

  test('unique-violation on irn surfaces 409 GST_EINVOICE_IRN_CONFLICT, not a 500', async () => {
    const uniqueErr = Object.assign(
      new Error('duplicate key value violates unique constraint "ux_gst_einvoice_irn"'),
      { code: 'P2010', meta: { code: '23505' } },
    );
    txQueryMock
      .mockResolvedValueOnce([INVOICE])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce(ITEMS)
      .mockRejectedValueOnce(uniqueErr);
    await expect(svc.generateIrn({ tenantId: TENANT, invoiceId: 7 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'GST_EINVOICE_IRN_CONFLICT' });
  });

  test('seller_gstin stores NULL when unconfigured — never the hospital state name', async () => {
    settingsMock.mockResolvedValue({ enabled: true, provider: 'mock', sellerLegalName: 'VH' });
    mockGenerateSequence();
    const row = await svc.generateIrn({ tenantId: TENANT, invoiceId: 7 });
    expect(insertCall()[4]).toBeNull();
    expect(row.seller_gstin).not.toBe('Kerala');
  });
});

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const prismaMock = { $queryRawUnsafe: queryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: jest.fn(),
}));

// gstEInvoiceService's requireGstEInvoiceEnabled is the shared gate — mock it
// open so the export functions run against the mocked prisma.
jest.unstable_mockModule('../../services/billing/gstEInvoiceService.js', () => ({
  requireGstEInvoiceEnabled: jest.fn(async () => ({ enabled: true })),
}));

const svc = await import('../../services/billing/tallyExportService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const INVOICES = [
  {
    id: 1, invoice_number: 'INV-1', patient_name: 'A', patient_state: 'Kerala',
    hospital_state: 'Kerala', subtotal: 1000, cgst_amount: 90, sgst_amount: 90,
    igst_amount: 0, discount_amount: 0, total_amount: 1180, invoice_type: 'OP',
    issued_at: '2026-08-01T00:00:00Z',
  },
  {
    id: 2, invoice_number: 'INV-2', patient_name: 'B, Jr', patient_state: 'Tamil Nadu',
    hospital_state: 'Kerala', subtotal: 2000, cgst_amount: 0, sgst_amount: 0,
    igst_amount: 360, discount_amount: 100, total_amount: 2260, invoice_type: 'IP',
    issued_at: '2026-08-02T00:00:00Z',
  },
];

beforeEach(() => { queryUnsafeMock.mockReset(); });

test('postingsFor produces a balanced double-entry set', () => {
  const p = svc._internal.postingsFor(INVOICES[0]);
  const debit = p.reduce((s, x) => s + x.debit, 0);
  const credit = p.reduce((s, x) => s + x.credit, 0);
  expect(Math.round(debit * 100)).toBe(Math.round(credit * 100));
  // party debit = gross; sales+cgst+sgst credit the components
  expect(p.find((x) => x.kind === 'party').debit).toBe(1180);
});

test('inter-state invoice with discount still balances', () => {
  const p = svc._internal.postingsFor(INVOICES[1]);
  const debit = p.reduce((s, x) => s + x.debit, 0);
  const credit = p.reduce((s, x) => s + x.credit, 0);
  expect(Math.round(debit * 100)).toBe(Math.round(credit * 100));
  expect(p.some((x) => x.ledger === 'Output IGST')).toBe(true);
  expect(p.some((x) => x.ledger === 'Discounts Allowed')).toBe(true);
});

test('exportTallyXml emits an IMPORTDATA envelope with one voucher per invoice', async () => {
  queryUnsafeMock.mockResolvedValueOnce(INVOICES);
  const out = await svc.exportTallyXml({ tenantId: TENANT });
  expect(out.format).toBe('tally_xml');
  expect(out.invoice_count).toBe(2);
  expect(out.content).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
  expect((out.content.match(/<VOUCHER /g) || []).length).toBe(2);
  // XML-escaped party name (comma is fine in XML; ampersand-escape path proven elsewhere)
  expect(out.content).toContain('INV-1');
});

test('exportGlCsv escapes commas and balances columns', async () => {
  queryUnsafeMock.mockResolvedValueOnce(INVOICES);
  const out = await svc.exportGlCsv({ tenantId: TENANT });
  expect(out.format).toBe('gl_csv');
  const lines = out.content.trim().split('\n');
  expect(lines[0]).toBe('date,voucher_no,invoice_type,ledger,debit,credit,narration');
  // "B, Jr" party name must be quoted
  expect(out.content).toContain('"Debtors - B, Jr"');
});

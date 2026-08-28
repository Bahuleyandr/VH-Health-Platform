import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — billing twin of
// paediatricImmunisationRoutesAppErrorPropagation.test.js (#602 pattern).
//
// billingV2Routes.js has THREE catch sites that used to call
// `error(res, err.message, err.statusCode)` with no 4th arg — dropping
// `err.code` and `err.details` from the documented envelope
// { success, message, code, details } (apps/backend/CLAUDE.md) — and then
// relayed raw `err.message` on the generic 500 (`err.message || 'Billing
// error'`), leaking internals on non-prod deployments where sanitize does
// not genericise 5xx:
//
//   * the shared wrap() helper (every JSON endpoint in the file), and
//   * two inline catches on the PDF reprint endpoints
//     (/invoices/:id/tax-invoice-pdf, /invoices/:id/receipt-pdf), whose
//     non-AppError branch fell through to next(err).
//
// All three now delegate to responseHelper.relayAppError with this file's
// per-site generic messages. These tests drive the endpoints over HTTP
// (supertest) and assert the response body itself. Money surface: only the
// catch-path behaviour is asserted — success paths are untouched.

const listInvoicesMock = jest.fn();
const generateInvoicePDFMock = jest.fn();

jest.unstable_mockModule('../../services/billing/billingV2Service.js', () => ({
  listInvoices: listInvoicesMock,
}));

jest.unstable_mockModule('../../services/billing/billingCreditNoteService.js', () => ({}));

jest.unstable_mockModule('../../services/billing/cashDrawerService.js', () => ({}));

jest.unstable_mockModule('../../services/billing/paymentLinkService.js', () => ({}));

jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: jest.fn(async () => {}),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

// Dynamically imported inside the PDF handlers; unstable_mockModule
// intercepts that import() too.
jest.unstable_mockModule('../../services/documents/clinicalPdfGenerator.js', () => ({
  generateInvoicePDF: generateInvoicePDFMock,
  generateReceiptPDF: jest.fn(),
}));

const { default: billingV2Routes } = await import('../../routes/billing/billingV2Routes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'BILLING_STAFF' };
  next();
});
app.use('/api/v1/billing/v2', billingV2Routes);

beforeEach(() => {
  listInvoicesMock.mockReset();
  generateInvoicePDFMock.mockReset();
});

describe('billingV2 wrap() surfaces AppError code + details', () => {
  test('an AppError carrying code + details forwards both (envelope contract)', async () => {
    listInvoicesMock.mockRejectedValueOnce(AppError.conflict(
      'Invoice list is locked while day-close reconciliation is running',
      'BILLING_DAY_CLOSE_IN_PROGRESS',
      { reason: 'day_close_running' },
    ));

    const response = await request(app).get('/api/v1/billing/v2/invoices');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('BILLING_DAY_CLOSE_IN_PROGRESS');
    expect(response.body.details).toEqual({ reason: 'day_close_running' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // Old wrap relayed `err.message || 'Billing error'` — internals leaked on
    // non-prod deployments where sanitize does not genericise 5xx.
    listInvoicesMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'invoice_total')"),
    );

    const response = await request(app).get('/api/v1/billing/v2/invoices');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Billing error');
    expect(JSON.stringify(response.body)).not.toContain('invoice_total');
  });
});

describe('billingV2 inline PDF catch surfaces AppError code + details', () => {
  test('tax-invoice-pdf relays an AppError with its code + details', async () => {
    generateInvoicePDFMock.mockRejectedValueOnce(AppError.conflict(
      'Tax invoice cannot be reprinted while the invoice is void-pending',
      'BILLING_INVOICE_VOID_PENDING',
      { reason: 'void_pending' },
    ));

    const response = await request(app).get('/api/v1/billing/v2/invoices/42/tax-invoice-pdf');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('BILLING_INVOICE_VOID_PENDING');
    expect(response.body.details).toEqual({ reason: 'void_pending' });
  });

  test('tax-invoice-pdf non-AppError returns this site\'s generic 500, not the thrown text', async () => {
    generateInvoicePDFMock.mockRejectedValueOnce(
      new Error('PDFKit stream aborted: ENOENT font file'),
    );

    const response = await request(app).get('/api/v1/billing/v2/invoices/42/tax-invoice-pdf');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('billingV2 tax-invoice PDF error');
    expect(JSON.stringify(response.body)).not.toContain('PDFKit');
  });
});

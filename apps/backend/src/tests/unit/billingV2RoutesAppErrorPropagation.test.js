import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { BILLING_V2_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
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
const getPharmacyFundingRecoveryMock = jest.fn();
const materializePharmacyFundingAuthorityMock = jest.fn();
const recordPharmacyFundingLineDecisionMock = jest.fn();
const retryPharmacyFundingTaskMock = jest.fn();
const reversePaymentMock = jest.fn();
const getPharmacyFundingReconciliationCaseMock = jest.fn();
const recordPharmacyFundingReconciliationDecisionMock = jest.fn();

jest.unstable_mockModule('../../services/billing/billingV2Service.js', () => ({
  listInvoices: listInvoicesMock,
  getPharmacyFundingRecovery: getPharmacyFundingRecoveryMock,
  materializePharmacyFundingAuthority: materializePharmacyFundingAuthorityMock,
  recordPharmacyFundingLineDecision: recordPharmacyFundingLineDecisionMock,
  retryPharmacyFundingTask: retryPharmacyFundingTaskMock,
  reversePayment: reversePaymentMock,
  getPharmacyFundingReconciliationCase: getPharmacyFundingReconciliationCaseMock,
  recordPharmacyFundingReconciliationDecision:
    recordPharmacyFundingReconciliationDecisionMock,
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
  req.user = {
    uid: '11111111-1111-4111-8111-111111111111',
    role: req.get('x-test-role') || 'FINANCE_INCHARGE',
  };
  next();
});
app.use(
  '/api/v1/billing/v2',
  (req, res, next) => BILLING_V2_ROUTE_ROLES.includes(req.user.role)
    ? next()
    : res.status(403).json({ success: false, message: 'Forbidden' }),
  billingV2Routes,
);

beforeEach(() => {
  listInvoicesMock.mockReset();
  generateInvoicePDFMock.mockReset();
  getPharmacyFundingRecoveryMock.mockReset();
  materializePharmacyFundingAuthorityMock.mockReset();
  recordPharmacyFundingLineDecisionMock.mockReset();
  retryPharmacyFundingTaskMock.mockReset();
  reversePaymentMock.mockReset();
  getPharmacyFundingReconciliationCaseMock.mockReset();
  recordPharmacyFundingReconciliationDecisionMock.mockReset();
});

describe('mounted pharmacy funding authority routes', () => {
  test('materialization returns a canonical typed Staff recovery tuple', async () => {
    materializePharmacyFundingAuthorityMock.mockResolvedValueOnce({
      status: 'blocked',
      fundingRecovery: {
        task_id: '81',
        status: 'open',
        owner_role: 'INSURANCE_COORDINATOR',
        pharmacy_order_id: 5,
        invoice_item_id: 7,
        order_version: 3,
        order_items_sha256: 'a'.repeat(64),
        deep_link: '/billing-desk?pharmacy_order_id=5&invoice_item_id=7&tpa_claim_id=9',
      },
    });
    const response = await request(app)
      .post('/api/v1/billing/v2/pharmacy-funding/orders/5/materialize')
      .set('x-test-role', 'INSURANCE_COORDINATOR')
      .send({ tpa_claim_id: 9 });
    expect(response.statusCode).toBe(200);
    expect(response.body.data.fundingRecovery).toMatchObject({
      task_id: '81', status: 'open', owner_role: 'INSURANCE_COORDINATOR',
    });
    expect(response.body.data.fundingRecovery).not.toHaveProperty('assigned_role');
    expect(materializePharmacyFundingAuthorityMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 5, tpaClaimId: 9 }),
    );
  });

  test('materialization preserves the canonical recovery tuple in an AppError', async () => {
    materializePharmacyFundingAuthorityMock.mockRejectedValueOnce(AppError.conflict(
      'The exact funding task remains actionable',
      'COUNTER_FUNDING_POSTED_AUTHORITY_REQUIRED',
      {
        next_action: 'open_exact_pharmacy_funding_task',
        funding_recovery: {
          task_id: '82', status: 'in_progress', owner_role: 'FINANCE_INCHARGE',
          pharmacy_order_id: 5, invoice_item_id: 7, order_version: 3,
          order_items_sha256: 'b'.repeat(64),
          deep_link: '/billing-desk?pharmacy_order_id=5&invoice_item_id=7',
        },
      },
    ));
    const response = await request(app)
      .post('/api/v1/billing/v2/pharmacy-funding/orders/5/materialize')
      .send({});
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      code: 'COUNTER_FUNDING_POSTED_AUTHORITY_REQUIRED',
      details: {
        next_action: 'open_exact_pharmacy_funding_task',
        funding_recovery: {
          task_id: '82', status: 'in_progress', owner_role: 'FINANCE_INCHARGE',
        },
      },
    });
  });

  test('materialization rejects invalid order identity and unreachable TPA_DESK role', async () => {
    const invalid = await request(app)
      .post('/api/v1/billing/v2/pharmacy-funding/orders/0/materialize')
      .send({});
    expect(invalid.statusCode).toBe(400);

    const forbidden = await request(app)
      .post('/api/v1/billing/v2/pharmacy-funding/orders/5/materialize')
      .set('x-test-role', 'TPA_DESK')
      .send({});
    expect(forbidden.statusCode).toBe(403);
    expect(materializePharmacyFundingAuthorityMock).not.toHaveBeenCalled();
  });

  test('recovery returns the exact service tuple', async () => {
    getPharmacyFundingRecoveryMock.mockResolvedValueOnce({ invoice_item_id: 7, claim_id: 9 });
    const response = await request(app).get(
      '/api/v1/billing/v2/pharmacy-funding/recovery'
      + '?pharmacy_order_id=5&invoice_item_id=7&tpa_claim_id=9',
    );
    expect(response.statusCode).toBe(200);
    expect(response.body.data).toMatchObject({ invoice_item_id: 7, claim_id: 9 });
    expect(getPharmacyFundingRecoveryMock).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 5, invoiceItemId: 7, tpaClaimId: 9,
    }));
  });

  test('line decision passes the durable command and preserves replay', async () => {
    recordPharmacyFundingLineDecisionMock.mockResolvedValueOnce({
      status: 'recorded', replayed: true,
    });
    const response = await request(app)
      .post('/api/v1/billing/v2/pharmacy-funding/tasks/11/decision')
      .set('Idempotency-Key', 'decision-replay')
      .send({
        pharmacy_order_id: 5, invoice_item_id: 7, tpa_claim_id: 9,
        order_version: 3, order_items_sha256: 'a'.repeat(64),
        approved_amount: 80, non_payable_amount: 20, reason_code: 'PARTIAL',
      });
    expect(response.statusCode).toBe(200);
    expect(response.body.data.replayed).toBe(true);
    expect(recordPharmacyFundingLineDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: '11', orderId: 5, invoiceItemId: 7, tpaClaimId: 9 }),
    );
  });

  test('posted-payment retry preserves the AppError envelope', async () => {
    retryPharmacyFundingTaskMock.mockRejectedValueOnce(AppError.conflict(
      'Exact posted payment authority is stale',
      'PHARMACY_FUNDING_PAYMENT_AUTHORITY_STALE',
      { payment_id: 13 },
    ));
    const response = await request(app)
      .post('/api/v1/billing/v2/pharmacy-funding/tasks/12/retry')
      .set('Idempotency-Key', 'retry-stale')
      .send({ payment_id: 13 });
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      code: 'PHARMACY_FUNDING_PAYMENT_AUTHORITY_STALE',
      details: { payment_id: 13 },
    });
  });

  test('payment reversal rejects a finance self-attestation and allows admin authority', async () => {
    const forbidden = await request(app)
      .post('/api/v1/billing/v2/payments/13/reverse')
      .set('Idempotency-Key', 'reverse-forbidden')
      .send({ reason: 'correction' });
    expect(forbidden.statusCode).toBe(403);
    expect(reversePaymentMock).not.toHaveBeenCalled();

    reversePaymentMock.mockResolvedValueOnce({ id: 13, reversed: true });
    const allowed = await request(app)
      .post('/api/v1/billing/v2/payments/13/reverse')
      .set('x-test-role', 'SUPER_ADMIN')
      .set('Idempotency-Key', 'reverse-admin')
      .send({ reason: 'correction' });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body.data).toMatchObject({ id: 13, reversed: true });
  });

  test('reconciliation lookup and decision mount exact case authority', async () => {
    getPharmacyFundingReconciliationCaseMock.mockResolvedValueOnce({
      id: 17, status: 'OPEN', current_snapshot_sha256: 'b'.repeat(64),
    });
    const lookup = await request(app)
      .get('/api/v1/billing/v2/pharmacy-funding/reconciliations/17');
    expect(lookup.statusCode).toBe(200);
    expect(lookup.body.data.id).toBe(17);

    recordPharmacyFundingReconciliationDecisionMock.mockResolvedValueOnce({
      status: 'pending_second_approval', replayed: true, caseId: 17,
    });
    const decision = await request(app)
      .post('/api/v1/billing/v2/pharmacy-funding/reconciliations/17/decision')
      .set('Idempotency-Key', 'reconciliation-replay')
      .send({
        keeper_invoice_item_id: 7,
        resolution_path: 'KEEP_CURRENT_AUTHORITY',
        expected_snapshot_sha256: 'b'.repeat(64),
      });
    expect(decision.statusCode).toBe(200);
    expect(decision.body.data.replayed).toBe(true);
    expect(recordPharmacyFundingReconciliationDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: '17', keeperInvoiceItemId: 7 }),
    );
  });
});

describe('billingV2 wrap() surfaces AppError code + details', () => {
  test('mounted pharmacy funding recovery rejects invalid exact ids with 400', async () => {
    const response = await request(app)
      .get('/api/v1/billing/v2/pharmacy-funding/recovery?pharmacy_order_id=0&invoice_item_id=nope');

    expect(response.statusCode).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe(
      'Exact positive pharmacy_order_id and invoice_item_id are required',
    );
  });

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

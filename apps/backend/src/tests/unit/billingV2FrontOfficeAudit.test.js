import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const createDraftInvoiceMock = jest.fn();
const addInvoiceItemMock = jest.fn();
const removeInvoiceItemMock = jest.fn();
const itemizeAdmissionInvoiceMock = jest.fn();
const recordInvoiceItemTpaDecisionMock = jest.fn();
const applyDiscountMock = jest.fn();
const issueInvoiceMock = jest.fn();
const voidInvoiceMock = jest.fn();
const collectPaymentMock = jest.fn();
const reversePaymentMock = jest.fn();
const collectAdvanceMock = jest.fn();
const settleAdvanceMock = jest.fn();
const raiseRefundMock = jest.fn();
const approveRefundMock = jest.fn();
const rejectRefundMock = jest.fn();
const markRefundPaidMock = jest.fn();
const openCashDrawerSessionMock = jest.fn();
const closeCashDrawerSessionMock = jest.fn();
const reviewCashDrawerSessionMock = jest.fn();
const createPaymentLinkMock = jest.fn();
const sendPaymentLinkMock = jest.fn();
const markPaymentLinkPaidMock = jest.fn();
const cancelPaymentLinkMock = jest.fn();
const logAuditMock = jest.fn();

jest.unstable_mockModule('../../services/billing/billingV2Service.js', () => ({
  createDraftInvoice: createDraftInvoiceMock,
  addInvoiceItem: addInvoiceItemMock,
  removeInvoiceItem: removeInvoiceItemMock,
  itemizeAdmissionInvoice: itemizeAdmissionInvoiceMock,
  recordInvoiceItemTpaDecision: recordInvoiceItemTpaDecisionMock,
  applyDiscount: applyDiscountMock,
  issueInvoice: issueInvoiceMock,
  voidInvoice: voidInvoiceMock,
  collectPayment: collectPaymentMock,
  reversePayment: reversePaymentMock,
  collectAdvance: collectAdvanceMock,
  settleAdvance: settleAdvanceMock,
  raiseRefund: raiseRefundMock,
  approveRefund: approveRefundMock,
  rejectRefund: rejectRefundMock,
  markRefundPaid: markRefundPaidMock,
}));

jest.unstable_mockModule('../../services/billing/cashDrawerService.js', () => ({
  openSession: openCashDrawerSessionMock,
  closeSession: closeCashDrawerSessionMock,
  reviewSession: reviewCashDrawerSessionMock,
}));
jest.unstable_mockModule('../../services/billing/paymentLinkService.js', () => ({
  createPaymentLink: createPaymentLinkMock,
  sendPaymentLink: sendPaymentLinkMock,
  markPaymentLinkPaid: markPaymentLinkPaidMock,
  cancelPaymentLink: cancelPaymentLinkMock,
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: logAuditMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const billingV2Routes = (await import('../../routes/billing/billingV2Routes.js')).default;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = '11111111-1111-4111-8111-111111111111';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';

function makeApp({ role = 'BILLING_STAFF' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'req-billing-audit';
    req.tenantId = TENANT_ID;
    req.user = {
      id: 9,
      uid: ACTOR_UID,
      role,
      tenant_id: TENANT_ID,
      deviceType: 'desktop',
    };
    next();
  });
  app.use('/', billingV2Routes);
  return app;
}

beforeEach(() => {
  createDraftInvoiceMock.mockReset();
  addInvoiceItemMock.mockReset();
  removeInvoiceItemMock.mockReset();
  itemizeAdmissionInvoiceMock.mockReset();
  recordInvoiceItemTpaDecisionMock.mockReset();
  applyDiscountMock.mockReset();
  issueInvoiceMock.mockReset();
  voidInvoiceMock.mockReset();
  collectPaymentMock.mockReset();
  reversePaymentMock.mockReset();
  collectAdvanceMock.mockReset();
  settleAdvanceMock.mockReset();
  raiseRefundMock.mockReset();
  approveRefundMock.mockReset();
  rejectRefundMock.mockReset();
  markRefundPaidMock.mockReset();
  openCashDrawerSessionMock.mockReset();
  closeCashDrawerSessionMock.mockReset();
  reviewCashDrawerSessionMock.mockReset();
  createPaymentLinkMock.mockReset();
  sendPaymentLinkMock.mockReset();
  markPaymentLinkPaidMock.mockReset();
  cancelPaymentLinkMock.mockReset();
  logAuditMock.mockReset().mockResolvedValue(undefined);
});

describe('billing v2 front-office audit logging', () => {
  it('writes structured audit context when staff creates a draft OP invoice', async () => {
    createDraftInvoiceMock.mockResolvedValueOnce({
      id: 77,
      patient_uid: PATIENT_UID,
      admission_id: null,
      invoice_type: 'OP',
      department: 'Front Office',
      status: 'DRAFT',
    });

    const response = await request(makeApp())
      .post('/invoices')
      .send({
        patient_uid: PATIENT_UID,
        invoice_type: 'OP',
        department: 'Front Office',
      });

    expect(response.status).toBe(200);
    expect(createDraftInvoiceMock).toHaveBeenCalledWith(expect.objectContaining({
      patient_uid: PATIENT_UID,
      invoice_type: 'OP',
      created_by: ACTOR_UID,
    }));
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'req-billing-audit',
        user: expect.objectContaining({
          uid: ACTOR_UID,
          role: 'BILLING_STAFF',
          deviceType: 'desktop',
        }),
      }),
      'FRONT_OFFICE_BILLING_INVOICE_CREATED',
      expect.objectContaining({
        invoice_id: 77,
        patient_uid: PATIENT_UID,
        invoice_type: 'OP',
        status: 'DRAFT',
        requested_invoice_type: 'OP',
        department: 'Front Office',
        source: 'billing_v2',
      }),
      { resource: 'billing_invoice', resourceId: 77 },
    );
  });

  it('writes structured audit context when staff issues an invoice', async () => {
    issueInvoiceMock.mockResolvedValueOnce({
      id: 77,
      invoice_number: 'INV-2026-000077',
      patient_uid: PATIENT_UID,
      admission_id: 44,
      invoice_type: 'OP',
      status: 'ISSUED',
    });

    const response = await request(makeApp())
      .post('/invoices/77/issue')
      .send({});

    expect(response.status).toBe(200);
    expect(issueInvoiceMock).toHaveBeenCalledWith('77');
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_BILLING_INVOICE_ISSUED',
      expect.objectContaining({
        invoice_id: 77,
        invoice_number: 'INV-2026-000077',
        patient_uid: PATIENT_UID,
        admission_id: 44,
        invoice_type: 'OP',
        status: 'ISSUED',
        source: 'billing_v2',
      }),
      { resource: 'billing_invoice', resourceId: 77 },
    );
  });

  it('writes structured audit context for invoice line-item mutations', async () => {
    addInvoiceItemMock.mockResolvedValueOnce({
      id: 12,
      invoice_id: 77,
      category: 'consultation',
      service_code: 'OP-CONSULT',
      source_ref_type: 'manual',
      source_ref_id: null,
      line_total: '700.00',
    });
    recordInvoiceItemTpaDecisionMock.mockResolvedValueOnce({
      id: 12,
      invoice_id: 77,
      line_total: '700.00',
      tpa_decision: 'non_payable',
      tpa_non_payable_reason: 'other',
    });

    const app = makeApp();
    const addResponse = await request(app)
      .post('/invoices/77/items')
      .send({
        service_code: 'OP-CONSULT',
        description: 'OP consultation',
        unit_price: 700,
      });
    const tpaResponse = await request(app)
      .post('/invoices/77/items/12/tpa-decision')
      .send({
        decision: 'non_payable',
        non_payable_reason: 'other',
      });

    expect(addResponse.status).toBe(200);
    expect(tpaResponse.status).toBe(200);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_BILLING_ITEM_ADDED',
      expect.objectContaining({
        invoice_id: 77,
        item_id: 12,
        category: 'consultation',
        service_code: 'OP-CONSULT',
        line_total: '700.00',
        source: 'billing_v2',
      }),
      { resource: 'billing_invoice_item', resourceId: 12 },
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_BILLING_TPA_DECISION_RECORDED',
      expect.objectContaining({
        invoice_id: 77,
        item_id: 12,
        decision: 'non_payable',
        non_payable_reason: 'other',
        source: 'billing_v2',
      }),
      { resource: 'billing_invoice_item', resourceId: 12 },
    );
  });

  it('writes structured audit context for itemize and discount actions', async () => {
    itemizeAdmissionInvoiceMock.mockResolvedValueOnce({
      invoice_id: 77,
      admission_id: 44,
      summary: { pharmacy: 2, lab: 1 },
    });
    applyDiscountMock.mockResolvedValueOnce({
      discount: 100,
      total: 900,
      due: 900,
    });

    const app = makeApp();
    const itemizeResponse = await request(app)
      .post('/invoices/77/itemize')
      .send({ emit_theatre: false });
    const discountResponse = await request(app)
      .post('/invoices/77/discount')
      .send({ amount: 100, reason: 'Management approval' });

    expect(itemizeResponse.status).toBe(200);
    expect(discountResponse.status).toBe(200);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_BILLING_INVOICE_ITEMIZED',
      expect.objectContaining({
        invoice_id: 77,
        admission_id: 44,
        emit_theatre: false,
        source: 'billing_v2',
      }),
      { resource: 'billing_invoice', resourceId: 77 },
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_BILLING_DISCOUNT_APPLIED',
      expect.objectContaining({
        invoice_id: 77,
        amount: 100,
        reason_present: true,
        totals: expect.objectContaining({ discount: 100 }),
        source: 'billing_v2',
      }),
      { resource: 'billing_invoice', resourceId: 77 },
    );
  });

  it('writes structured audit context when staff collects a payment', async () => {
    collectPaymentMock.mockResolvedValueOnce({
      id: 90,
      invoice_id: 77,
      patient_uid: PATIENT_UID,
      amount: '500.00',
      mode: 'CASH',
      shift: 'MORNING',
      reference: 'RCPT-90',
    });

    const response = await request(makeApp())
      .post('/payments')
      .send({
        invoice_id: 77,
        amount: 500,
        mode: 'CASH',
        shift: 'MORNING',
        reference: 'RCPT-90',
      });

    expect(response.status).toBe(200);
    expect(collectPaymentMock).toHaveBeenCalledWith(expect.objectContaining({
      invoice_id: 77,
      amount: 500,
      mode: 'CASH',
      collected_by: ACTOR_UID,
    }));
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_BILLING_PAYMENT_COLLECTED',
      expect.objectContaining({
        payment_id: 90,
        invoice_id: 77,
        patient_uid: PATIENT_UID,
        amount: '500.00',
        mode: 'CASH',
        shift: 'MORNING',
        reference_present: true,
        source: 'billing_v2',
      }),
      { resource: 'billing_payment', resourceId: 90 },
    );
  });

  it('writes structured audit context for payment reversal and advances', async () => {
    reversePaymentMock.mockResolvedValueOnce({
      id: 90,
      invoice_id: 77,
      patient_uid: PATIENT_UID,
      amount: '500.00',
      mode: 'CASH',
      reversed: true,
    });
    collectAdvanceMock.mockResolvedValueOnce({
      id: 15,
      patient_uid: PATIENT_UID,
      admission_id: 44,
      amount: '2500.00',
      mode: 'UPI',
      reference: 'UPI-15',
    });
    settleAdvanceMock.mockResolvedValueOnce({
      id: 16,
      advance_id: 15,
      invoice_id: 77,
      amount: '1000.00',
    });

    const adminApp = makeApp({ role: 'ADMIN' });
    const staffApp = makeApp();
    const reverseResponse = await request(adminApp)
      .post('/payments/90/reverse')
      .send({ reason: 'Wrong invoice' });
    const advanceResponse = await request(staffApp)
      .post('/advances')
      .send({ patient_uid: PATIENT_UID, admission_id: 44, amount: 2500, mode: 'UPI', reference: 'UPI-15' });
    const settleResponse = await request(staffApp)
      .post('/advances/15/settle')
      .send({ invoice_id: 77, amount: 1000 });

    expect(reverseResponse.status).toBe(200);
    expect(advanceResponse.status).toBe(200);
    expect(settleResponse.status).toBe(200);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_BILLING_PAYMENT_REVERSED',
      expect.objectContaining({
        payment_id: 90,
        invoice_id: 77,
        patient_uid: PATIENT_UID,
        reason_present: true,
        source: 'billing_v2',
      }),
      { resource: 'billing_payment', resourceId: 90 },
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_BILLING_ADVANCE_COLLECTED',
      expect.objectContaining({
        advance_id: 15,
        patient_uid: PATIENT_UID,
        admission_id: 44,
        amount: '2500.00',
        mode: 'UPI',
        reference_present: true,
        source: 'billing_v2',
      }),
      { resource: 'billing_advance', resourceId: 15 },
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_BILLING_ADVANCE_SETTLED',
      expect.objectContaining({
        advance_id: 15,
        invoice_id: 77,
        amount: '1000.00',
        source: 'billing_v2',
      }),
      { resource: 'billing_advance_settlement', resourceId: 16 },
    );
  });

  it('writes structured audit context for refund lifecycle actions', async () => {
    raiseRefundMock.mockResolvedValueOnce({
      id: 21,
      patient_uid: PATIENT_UID,
      invoice_id: 77,
      amount: '300.00',
      mode: 'UPI',
      reason: 'Duplicate payment',
    });
    approveRefundMock.mockResolvedValueOnce({
      id: 21,
      patient_uid: PATIENT_UID,
      invoice_id: 77,
      amount: '300.00',
      approval_status: 'APPROVED',
    });
    markRefundPaidMock.mockResolvedValueOnce({
      id: 21,
      patient_uid: PATIENT_UID,
      invoice_id: 77,
      amount: '300.00',
      approval_status: 'PAID',
      reference: 'UPI-REF-21',
    });

    const staffApp = makeApp();
    const adminApp = makeApp({ role: 'ADMIN' });
    const raiseResponse = await request(staffApp)
      .post('/refunds')
      .send({
        patient_uid: PATIENT_UID,
        invoice_id: 77,
        amount: 300,
        mode: 'UPI',
        reason: 'Duplicate payment',
      });
    const approveResponse = await request(adminApp).post('/refunds/21/approve').send({});
    const payResponse = await request(staffApp)
      .post('/refunds/21/pay')
      .send({ reference: 'UPI-REF-21' });

    expect(raiseResponse.status).toBe(200);
    expect(approveResponse.status).toBe(200);
    expect(payResponse.status).toBe(200);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_BILLING_REFUND_RAISED',
      expect.objectContaining({
        refund_id: 21,
        invoice_id: 77,
        patient_uid: PATIENT_UID,
        amount: '300.00',
        reason_present: true,
        source: 'billing_v2',
      }),
      { resource: 'billing_refund', resourceId: 21 },
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_BILLING_REFUND_APPROVED',
      expect.objectContaining({
        refund_id: 21,
        invoice_id: 77,
        patient_uid: PATIENT_UID,
        approval_status: 'APPROVED',
        source: 'billing_v2',
      }),
      { resource: 'billing_refund', resourceId: 21 },
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_BILLING_REFUND_PAID',
      expect.objectContaining({
        refund_id: 21,
        invoice_id: 77,
        patient_uid: PATIENT_UID,
        approval_status: 'PAID',
        reference_present: true,
        source: 'billing_v2',
      }),
      { resource: 'billing_refund', resourceId: 21 },
    );
  });

  it('writes structured audit context for cash-drawer lifecycle actions', async () => {
    openCashDrawerSessionMock.mockResolvedValueOnce({
      id: 31,
      cashier_uid: ACTOR_UID,
      shift: 'MORNING',
      opening_float: '1000.00',
      status: 'open',
    });
    closeCashDrawerSessionMock.mockResolvedValueOnce({
      id: 31,
      shift: 'MORNING',
      system_total: '500.00',
      counted_total: '1500.00',
      variance: '0.00',
      requires_review: false,
      status: 'reviewed',
    });
    reviewCashDrawerSessionMock.mockResolvedValueOnce({
      id: 31,
      shift: 'MORNING',
      variance: '50.00',
      status: 'reviewed',
    });

    const staffApp = makeApp();
    const financeApp = makeApp({ role: 'FINANCE_INCHARGE' });
    const openResponse = await request(staffApp)
      .post('/cash-drawer/sessions/open')
      .send({ shift: 'MORNING', opening_float: 1000 });
    const closeResponse = await request(staffApp)
      .post('/cash-drawer/sessions/31/close')
      .send({ counted_denominations: { 500: 3 } });
    const reviewResponse = await request(financeApp)
      .post('/cash-drawer/sessions/31/review')
      .send({ review_notes: 'Checked' });

    expect(openResponse.status).toBe(200);
    expect(closeResponse.status).toBe(200);
    expect(reviewResponse.status).toBe(200);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_CASH_DRAWER_OPENED',
      expect.objectContaining({
        cash_drawer_session_id: 31,
        shift: 'MORNING',
        cashier_uid: ACTOR_UID,
        source: 'billing_v2',
      }),
      { resource: 'cash_drawer_session', resourceId: 31 },
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_CASH_DRAWER_CLOSED',
      expect.objectContaining({
        cash_drawer_session_id: 31,
        shift: 'MORNING',
        variance: '0.00',
        requires_review: false,
        source: 'billing_v2',
      }),
      { resource: 'cash_drawer_session', resourceId: 31 },
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_CASH_DRAWER_REVIEWED',
      expect.objectContaining({
        cash_drawer_session_id: 31,
        shift: 'MORNING',
        review_notes_present: true,
        source: 'billing_v2',
      }),
      { resource: 'cash_drawer_session', resourceId: 31 },
    );
  });

  it('writes structured audit context for payment-link lifecycle actions', async () => {
    createPaymentLinkMock.mockResolvedValueOnce({
      id: 41,
      invoice_id: 77,
      patient_uid: PATIENT_UID,
      amount: '500.00',
      provider: 'upi_intent',
      status: 'created',
    });
    sendPaymentLinkMock.mockResolvedValueOnce({
      id: 41,
      invoice_id: 77,
      patient_uid: PATIENT_UID,
      status: 'sent',
    });
    markPaymentLinkPaidMock.mockResolvedValueOnce({
      link: {
        id: 41,
        invoice_id: 77,
        patient_uid: PATIENT_UID,
        paid_via: 'upi',
        paid_reference: 'UPI-PAID-41',
        status: 'paid',
      },
      payment: {
        id: 90,
        invoice_id: 77,
        patient_uid: PATIENT_UID,
      },
    });
    cancelPaymentLinkMock.mockResolvedValueOnce({
      id: 42,
      invoice_id: 78,
      patient_uid: PATIENT_UID,
      status: 'cancelled',
    });

    const app = makeApp();
    const createResponse = await request(app)
      .post('/payment-links')
      .send({ invoice_id: 77, patient_uid: PATIENT_UID, amount: 500 });
    const sendResponse = await request(app)
      .post('/payment-links/token-41/send')
      .send({ channels: ['whatsapp', 'email'], patient_phone: '+919876543210', patient_email: 'patient@example.test' });
    const paidResponse = await request(app)
      .post('/payment-links/token-41/mark-paid')
      .send({ paid_via: 'upi', paid_reference: 'UPI-PAID-41' });
    const cancelResponse = await request(app)
      .post('/payment-links/token-42/cancel')
      .send({ reason: 'Patient paid at counter' });

    expect(createResponse.status).toBe(200);
    expect(sendResponse.status).toBe(200);
    expect(paidResponse.status).toBe(200);
    expect(cancelResponse.status).toBe(200);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_PAYMENT_LINK_CREATED',
      expect.objectContaining({
        payment_link_id: 41,
        invoice_id: 77,
        patient_uid: PATIENT_UID,
        amount: '500.00',
        provider: 'upi_intent',
        source: 'billing_v2',
      }),
      { resource: 'billing_payment_link', resourceId: 41 },
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_PAYMENT_LINK_SENT',
      expect.objectContaining({
        payment_link_id: 41,
        invoice_id: 77,
        channels: ['whatsapp', 'email'],
        patient_phone_present: true,
        patient_email_present: true,
        source: 'billing_v2',
      }),
      { resource: 'billing_payment_link', resourceId: 41 },
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_PAYMENT_LINK_MARKED_PAID',
      expect.objectContaining({
        payment_link_id: 41,
        payment_id: 90,
        invoice_id: 77,
        patient_uid: PATIENT_UID,
        paid_reference_present: true,
        source: 'billing_v2',
      }),
      { resource: 'billing_payment_link', resourceId: 41 },
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'FRONT_OFFICE_PAYMENT_LINK_CANCELLED',
      expect.objectContaining({
        payment_link_id: 42,
        invoice_id: 78,
        patient_uid: PATIENT_UID,
        reason_present: true,
        source: 'billing_v2',
      }),
      { resource: 'billing_payment_link', resourceId: 42 },
    );
  });
});

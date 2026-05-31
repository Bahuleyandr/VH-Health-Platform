import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const createDraftInvoiceMock = jest.fn();
const issueInvoiceMock = jest.fn();
const collectPaymentMock = jest.fn();
const logAuditMock = jest.fn();

jest.unstable_mockModule('../../services/billing/billingV2Service.js', () => ({
  createDraftInvoice: createDraftInvoiceMock,
  issueInvoice: issueInvoiceMock,
  collectPayment: collectPaymentMock,
}));

jest.unstable_mockModule('../../services/billing/cashDrawerService.js', () => ({}));
jest.unstable_mockModule('../../services/billing/paymentLinkService.js', () => ({}));

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

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'req-billing-audit';
    req.tenantId = TENANT_ID;
    req.user = {
      id: 9,
      uid: ACTOR_UID,
      role: 'BILLING_STAFF',
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
  issueInvoiceMock.mockReset();
  collectPaymentMock.mockReset();
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
});

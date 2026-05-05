import { authClient } from './testClient.js';
import prisma from '../lib/prisma.js';

describe('Billing API', () => {
  const admin = authClient('ADMIN');
  const doctor = authClient('DOCTOR');
  const patient = authClient('PATIENT');
  // Use deterministic UUIDs so tests are isolable + rerunnable
  // UUIDv4-shaped fixtures so express-validator isUUID() accepts them
  const patientUidA = '11111111-1111-4111-8111-111111111111';
  const patientUidB = '22222222-2222-4222-8222-222222222222';

  // Cleanup inserts between test runs to keep assertions deterministic.
  beforeAll(async () => {
    await prisma.payment_transactions.deleteMany({
      where: { invoice: { patient_uid: { in: [patientUidA, patientUidB] } } },
    }).catch(() => {});
    await prisma.invoices.deleteMany({
      where: { patient_uid: { in: [patientUidA, patientUidB] } },
    }).catch(() => {});
    await prisma.insurance_claims.deleteMany({
      where: { patient_uid: { in: [patientUidA, patientUidB] } },
    }).catch(() => {});
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  // ─── Validation guards ────────────────────────────────────────────────
  describe('validation', () => {
    it('rejects invoice creation without required fields', async () => {
      const res = await admin.post('/api/v1/billing/invoice').send({});
      expect(res.statusCode).toBe(400);
    });

    it('rejects invoice with unknown type', async () => {
      const res = await admin.post('/api/v1/billing/invoice').send({
        patient_uid: patientUidA,
        type: 'BOGUS',
        subtotal: 100,
        total_amount: 100,
        items: [{ description: 'x', amount: 100 }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.message || '').toMatch(/Invalid invoice type/i);
    });

    it('rejects invoice with no line items', async () => {
      const res = await admin.post('/api/v1/billing/invoice').send({
        patient_uid: patientUidA,
        type: 'consultation',
        subtotal: 100,
        total_amount: 100,
        items: [],
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects payment with missing required fields', async () => {
      const res = await admin.post('/api/v1/billing/invoice/1/payment').send({});
      expect(res.statusCode).toBe(400);
    });

    it('rejects payment with invalid payment method', async () => {
      const res = await admin.post('/api/v1/billing/invoice/1/payment').send({
        amount: 100,
        payment_method: 'BARTER',
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects revenue stats without required date range', async () => {
      const res = await admin.get('/api/v1/billing/revenue');
      expect(res.statusCode).toBe(400);
    });

    it('forbids non-admin from revenue stats', async () => {
      const res = await doctor.get(
        '/api/v1/billing/revenue?date_from=2026-01-01&date_to=2026-12-31'
      );
      expect(res.statusCode).toBe(403);
    });

    it('forbids patient from creating invoices', async () => {
      const res = await patient.post('/api/v1/billing/invoice').send({
        patient_uid: patientUidA,
        type: 'consultation',
        subtotal: 100,
        total_amount: 100,
        items: [{ description: 'x', amount: 100 }],
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects invalid claim id on update route', async () => {
      const res = await admin.put('/api/v1/billing/insurance/claim/not-a-number').send({
        status: 'approved',
        approved_amount: 1000,
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects invoice detail with non-numeric id', async () => {
      const res = await admin.get('/api/v1/billing/invoice/not-a-number');
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Invoice lifecycle ────────────────────────────────────────────────
  describe('invoice lifecycle', () => {
    let invoiceId;
    let invoiceNumber;

    it('creates an invoice with expected shape', async () => {
      const res = await admin.post('/api/v1/billing/invoice').send({
        patient_uid: patientUidA,
        type: 'consultation',
        subtotal: 1000,
        tax_amount: 180,
        total_amount: 1180,
        items: [{ description: 'Consultation', amount: 1000 }],
        payment_method: 'CASH',
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toEqual(expect.any(Number));
      expect(res.body.data.invoice_number).toMatch(/^INV-\d{6}-\d{4}$/);
      expect(res.body.data.payment_status).toBe('pending');
      expect(parseFloat(res.body.data.paid_amount)).toBe(0);
      expect(parseFloat(res.body.data.total_amount)).toBe(1180);
      invoiceId = res.body.data.id;
      invoiceNumber = res.body.data.invoice_number;
    });

    it('persists the invoice in the DB', async () => {
      const row = await prisma.invoices.findUnique({ where: { id: invoiceId } });
      expect(row).toBeTruthy();
      expect(row.invoice_number).toBe(invoiceNumber);
      expect(row.type).toBe('consultation');
      expect(parseFloat(row.total_amount)).toBe(1180);
    });

    it('invoice detail includes empty payment history initially', async () => {
      const res = await admin.get(`/api/v1/billing/invoice/${invoiceId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.id).toBe(invoiceId);
      expect(Array.isArray(res.body.data.payment_transactions)).toBe(true);
      expect(res.body.data.payment_transactions.length).toBe(0);
      expect(res.body.data.insurance_claim).toBeNull();
    });

    it('records a partial payment and moves status to partial', async () => {
      const res = await admin.post(`/api/v1/billing/invoice/${invoiceId}/payment`).send({
        amount: 500,
        payment_method: 'UPI',
        transaction_ref: 'TXN-PART-001',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.invoice.payment_status).toBe('partial');
      expect(parseFloat(res.body.data.invoice.paid_amount)).toBe(500);
      expect(res.body.data.invoice.paid_at).toBeNull();
      expect(res.body.data.transaction.transaction_ref).toBe('TXN-PART-001');
    });

    it('rejects overpayment that would exceed remaining balance', async () => {
      const res = await admin.post(`/api/v1/billing/invoice/${invoiceId}/payment`).send({
        amount: 10000, // remaining is 680
        payment_method: 'CASH',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.message || '').toMatch(/exceed/i);
    });

    it('records final payment and transitions status to paid with paid_at timestamp', async () => {
      const res = await admin.post(`/api/v1/billing/invoice/${invoiceId}/payment`).send({
        amount: 680,
        payment_method: 'CARD',
        transaction_ref: 'TXN-FINAL-001',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.invoice.payment_status).toBe('paid');
      expect(parseFloat(res.body.data.invoice.paid_amount)).toBe(1180);
      expect(res.body.data.invoice.paid_at).toBeTruthy();
    });

    it('rejects any further payment on a paid invoice', async () => {
      const res = await admin.post(`/api/v1/billing/invoice/${invoiceId}/payment`).send({
        amount: 1,
        payment_method: 'CASH',
      });
      expect(res.statusCode).toBe(400);
    });

    it('invoice detail now lists both payment transactions', async () => {
      const res = await admin.get(`/api/v1/billing/invoice/${invoiceId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.payment_transactions.length).toBe(2);
      const refs = res.body.data.payment_transactions.map((t) => t.transaction_ref);
      expect(refs).toEqual(expect.arrayContaining(['TXN-PART-001', 'TXN-FINAL-001']));
    });

    it('patient invoice list paginates and includes the created invoice', async () => {
      const res = await admin.get(
        `/api/v1/billing/invoices/patient/${patientUidA}?limit=10&page=1`
      );
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta.pagination.total).toBeGreaterThanOrEqual(1);
      const ids = res.body.data.map((i) => i.id);
      expect(ids).toContain(invoiceId);
    });

    it('invoice numbers are monotonically increasing within same year-month', async () => {
      const res1 = await admin.post('/api/v1/billing/invoice').send({
        patient_uid: patientUidA,
        type: 'pharmacy',
        subtotal: 200,
        total_amount: 200,
        items: [{ description: 'Med', amount: 200 }],
      });
      const res2 = await admin.post('/api/v1/billing/invoice').send({
        patient_uid: patientUidA,
        type: 'pharmacy',
        subtotal: 300,
        total_amount: 300,
        items: [{ description: 'Med 2', amount: 300 }],
      });
      expect(res1.statusCode).toBe(201);
      expect(res2.statusCode).toBe(201);
      const seq1 = parseInt(res1.body.data.invoice_number.split('-')[2], 10);
      const seq2 = parseInt(res2.body.data.invoice_number.split('-')[2], 10);
      expect(seq2).toBe(seq1 + 1);
    });
  });

  // ─── Revenue stats ────────────────────────────────────────────────────
  describe('revenue stats', () => {
    it('returns structured aggregates for a given date range', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const nextYear = `${new Date().getFullYear() + 1}-12-31`;
      const res = await admin.get(
        `/api/v1/billing/revenue?date_from=1970-01-01&date_to=${nextYear}`
      );
      expect(res.statusCode).toBe(200);
      const s = res.body.data;
      expect(s.summary).toBeDefined();
      expect(s.summary.total_invoices).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(s.by_type)).toBe(true);
      expect(Array.isArray(s.by_payment_method)).toBe(true);
      expect(Array.isArray(s.daily_totals)).toBe(true);
      // Consultation invoice created above should appear
      const consult = s.by_type.find((r) => r.type === 'consultation');
      expect(consult).toBeDefined();
    });
  });

  // ─── Revenue cycle worklists ─────────────────────────────────────────
  describe('revenue cycle worklists', () => {
    it('returns A/R aging buckets and the oldest open invoices', async () => {
      const daysAgo = (days) => {
        const d = new Date();
        d.setDate(d.getDate() - days);
        return d.toISOString().slice(0, 10);
      };

      await admin.post('/api/v1/billing/invoice').send({
        patient_uid: patientUidA,
        type: 'procedure',
        subtotal: 9000,
        total_amount: 9000,
        due_date: daysAgo(45),
        items: [{ description: 'Procedure balance', amount: 9000 }],
      });
      await admin.post('/api/v1/billing/invoice').send({
        patient_uid: patientUidA,
        type: 'room_charge',
        subtotal: 12000,
        total_amount: 12000,
        due_date: daysAgo(95),
        items: [{ description: 'Room balance', amount: 12000 }],
      });

      const res = await admin.get('/api/v1/billing/ar-aging?limit=10');

      expect(res.statusCode).toBe(200);
      expect(res.body.data.overall.invoice_count).toBeGreaterThanOrEqual(2);
      expect(res.body.data.overall.total_outstanding).toBeGreaterThanOrEqual(21000);
      expect(res.body.data.buckets.map((b) => b.bucket)).toEqual(
        expect.arrayContaining(['31-60', '90+']),
      );
      expect(res.body.data.invoices[0]).toEqual(
        expect.objectContaining({
          invoice_number: expect.stringMatching(/^INV-\d{6}-\d{4}$/),
          outstanding_amount: expect.any(Number),
          age_days: expect.any(Number),
        }),
      );
    });
  });

  // ─── Insurance claims ─────────────────────────────────────────────────
  describe('insurance claims', () => {
    let claimId;
    let linkedInvoiceId;

    it('rejects claim without required fields', async () => {
      const res = await admin.post('/api/v1/billing/insurance/claim').send({});
      expect(res.statusCode).toBe(400);
    });

    it('rejects claim with zero or negative amount', async () => {
      const res = await admin.post('/api/v1/billing/insurance/claim').send({
        patient_uid: patientUidB,
        policy_number: 'POL-001',
        insurance_provider: 'TestCorp',
        claim_amount: 0,
      });
      expect(res.statusCode).toBe(400);
    });

    it('submits a standalone claim (no invoice link)', async () => {
      const res = await admin.post('/api/v1/billing/insurance/claim').send({
        patient_uid: patientUidB,
        policy_number: 'POL-001',
        insurance_provider: 'TestCorp',
        claim_amount: 5000,
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.claim_number).toMatch(/^CLM-\d{6}-\d{4}$/);
      expect(res.body.data.status).toBe('submitted');
      expect(parseFloat(res.body.data.claim_amount)).toBe(5000);
      expect(res.body.data.approved_amount).toBeNull();
      expect(res.body.data.reviewed_at).toBeNull();
      claimId = res.body.data.id;
    });

    it('submits a claim linked to an invoice and updates invoice.insurance_claim_id', async () => {
      const invRes = await admin.post('/api/v1/billing/invoice').send({
        patient_uid: patientUidB,
        type: 'procedure',
        subtotal: 7000,
        total_amount: 7000,
        items: [{ description: 'Surgery', amount: 7000 }],
      });
      linkedInvoiceId = invRes.body.data.id;

      const claimRes = await admin.post('/api/v1/billing/insurance/claim').send({
        patient_uid: patientUidB,
        invoice_id: linkedInvoiceId,
        policy_number: 'POL-002',
        insurance_provider: 'TestCorp',
        claim_amount: 7000,
      });
      expect(claimRes.statusCode).toBe(201);

      const inv = await prisma.invoices.findUnique({ where: { id: linkedInvoiceId } });
      expect(inv.insurance_claim_id).toBe(claimRes.body.data.id);
    });

    it('rejects claim linked to invoice belonging to a different patient', async () => {
      const invRes = await admin.post('/api/v1/billing/invoice').send({
        patient_uid: patientUidA,
        type: 'consultation',
        subtotal: 500,
        total_amount: 500,
        items: [{ description: 'x', amount: 500 }],
      });
      const res = await admin.post('/api/v1/billing/insurance/claim').send({
        patient_uid: patientUidB, // different from invoice owner
        invoice_id: invRes.body.data.id,
        policy_number: 'POL-003',
        insurance_provider: 'TestCorp',
        claim_amount: 500,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.message || '').toMatch(/does not belong/i);
    });

    it('claim transitions to under_review without setting reviewed_at', async () => {
      const res = await admin.put(`/api/v1/billing/insurance/claim/${claimId}`).send({
        status: 'under_review',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('under_review');
      expect(res.body.data.reviewed_at).toBeNull();
    });

    it('claim transitions to approved with approved_amount and sets reviewed_at', async () => {
      const res = await admin.put(`/api/v1/billing/insurance/claim/${claimId}`).send({
        status: 'approved',
        approved_amount: 4500,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('approved');
      expect(parseFloat(res.body.data.approved_amount)).toBe(4500);
      expect(res.body.data.reviewed_at).toBeTruthy();
    });

    it('rejected claim persists reason and timestamps', async () => {
      const res0 = await admin.post('/api/v1/billing/insurance/claim').send({
        patient_uid: patientUidB,
        policy_number: 'POL-004',
        insurance_provider: 'TestCorp',
        claim_amount: 3000,
      });
      const id = res0.body.data.id;
      const res = await admin.put(`/api/v1/billing/insurance/claim/${id}`).send({
        status: 'rejected',
        reason: 'Pre-existing condition excluded',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('rejected');
      expect(res.body.data.rejection_reason).toBe('Pre-existing condition excluded');
      expect(res.body.data.reviewed_at).toBeTruthy();
    });

    it('rejects unknown status values', async () => {
      const res = await admin.put(`/api/v1/billing/insurance/claim/${claimId}`).send({
        status: 'FROBNICATED',
      });
      expect(res.statusCode).toBe(400);
    });

    it('404s on unknown claim id', async () => {
      const res = await admin.put('/api/v1/billing/insurance/claim/999999').send({
        status: 'approved',
        approved_amount: 100,
      });
      expect(res.statusCode).toBe(404);
    });

    it('lists claims filtered by patient_uid', async () => {
      const res = await admin.get(
        `/api/v1/billing/insurance/claims?patient_uid=${patientUidB}&limit=50`
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(3);
      expect(res.body.data.every((c) => c.patient_uid === patientUidB)).toBe(true);
    });

    it('lists claims filtered by status', async () => {
      const res = await admin.get(
        '/api/v1/billing/insurance/claims?status=rejected&limit=50'
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.data.every((c) => c.status === 'rejected')).toBe(true);
    });

    it('returns a claim queue for actionable payer follow-up', async () => {
      const res = await admin.get('/api/v1/billing/claim-queue?limit=20');

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body.data.summary)).toBe(true);
      expect(Array.isArray(res.body.data.claims)).toBe(true);
      expect(res.body.data.claims.length).toBeGreaterThanOrEqual(2);
      expect(res.body.data.claims.every((c) => c.status !== 'approved' && c.status !== 'paid')).toBe(true);
      const testClaim = res.body.data.claims.find((claim) =>
        claim.insurance_provider === 'TestCorp' &&
        /^CLM-\d{6}-\d{4}$/.test(claim.claim_number)
      );
      expect(testClaim).toEqual(
        expect.objectContaining({
          claim_number: expect.stringMatching(/^CLM-\d{6}-\d{4}$/),
          insurance_provider: 'TestCorp',
          payer_balance: expect.any(Number),
          days_in_queue: expect.any(Number),
        }),
      );
    });
  });
});

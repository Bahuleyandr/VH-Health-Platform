// OpenAPI Phase 5 — V2 billing money-movement contract coverage.
// Drives payments / advances / refunds / reports over HTTP and validates every
// response against the canonical spec via assertResponse.
import { authClient } from './testClient.js';
import prisma from '../lib/prisma.js';
import { assertResponse } from './helpers/assertSchema.js';

describe('V2 billing money-movement contract', () => {
  const admin = authClient('ADMIN');
  const TENANT = '00000000-0000-4000-8000-000000000001';
  const patientUid = '44444444-4444-4444-8444-444444444444';
  const RUN = Date.now();
  const idem = (s) => `p5mm-${s}-${RUN}`;

  let advanceId;

  async function makeIssuedInvoice() {
    const draft = await admin.post('/api/v1/billing/v2/invoices').send({
      patient_uid: patientUid, invoice_type: 'OP', patient_name: 'MM Test',
    });
    const id = draft.body.data.id;
    await admin.post(`/api/v1/billing/v2/invoices/${id}/items`).send({
      description: 'Item', quantity: 1, unit_price: 1000, gst_rate: 0,
    });
    await admin.post(`/api/v1/billing/v2/invoices/${id}/issue`).send({});
    return id;
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM billing_advance_settlements WHERE invoice_id IN (SELECT id FROM billing_invoices WHERE patient_uid = $1::uuid)`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_refunds WHERE patient_uid = $1::uuid`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE patient_uid = $1::uuid`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_advances WHERE patient_uid = $1::uuid`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id IN (SELECT id FROM billing_invoices WHERE patient_uid = $1::uuid)`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE patient_uid = $1::uuid`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid, '9001112233', 'MM Test', 'PATIENT', $2::uuid, NOW())`,
      patientUid, TENANT,
    ).catch(() => {});
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  it('collects then reverses a payment', async () => {
    const invId = await makeIssuedInvoice();
    const pay = await admin.post('/api/v1/billing/v2/payments')
      .set('Idempotency-Key', idem('pay'))
      .send({ invoice_id: invId, amount: 600, mode: 'CASH', shift: 'MORNING' });
    expect([200, 201]).toContain(pay.statusCode);
    assertResponse('POST', '/api/v1/billing/v2/payments', pay.body);
    const paymentId = pay.body.data.id;

    const rev = await admin.post(`/api/v1/billing/v2/payments/${paymentId}/reverse`).send({ reason: 'test reversal' });
    expect(rev.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/payments/{id}/reverse', rev.body);
  });

  it('collects + lists an advance', async () => {
    const adv = await admin.post('/api/v1/billing/v2/advances')
      .set('Idempotency-Key', idem('adv'))
      .send({ patient_uid: patientUid, amount: 2000, mode: 'CASH' });
    expect([200, 201]).toContain(adv.statusCode);
    assertResponse('POST', '/api/v1/billing/v2/advances', adv.body);
    advanceId = adv.body.data.id;

    const list = await admin.get(`/api/v1/billing/v2/advances?patient_uid=${patientUid}`);
    expect(list.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/billing/v2/advances', list.body);
  });

  it('settles an advance against an invoice', async () => {
    const invId = await makeIssuedInvoice();
    const res = await admin.post(`/api/v1/billing/v2/advances/${advanceId}/settle`)
      .set('Idempotency-Key', idem('settle'))
      .send({ invoice_id: invId, amount: 500 });
    expect(res.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/advances/{id}/settle', res.body);
  });

  it('raises, lists, approves + pays a refund', async () => {
    const raise = await admin.post('/api/v1/billing/v2/refunds').send({
      patient_uid: patientUid, advance_id: advanceId, amount: 300, reason: 'overpayment', mode: 'CASH',
    });
    expect([200, 201]).toContain(raise.statusCode);
    assertResponse('POST', '/api/v1/billing/v2/refunds', raise.body);
    const refundId = raise.body.data.id;

    const list = await admin.get(`/api/v1/billing/v2/refunds?patient_uid=${patientUid}`);
    expect(list.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/billing/v2/refunds', list.body);

    const approve = await admin.post(`/api/v1/billing/v2/refunds/${refundId}/approve`).send({});
    expect(approve.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/refunds/{id}/approve', approve.body);

    const pay = await admin.post(`/api/v1/billing/v2/refunds/${refundId}/pay`)
      .set('Idempotency-Key', idem('refundpay'))
      .send({ reference: 'REF-PAY-1' });
    expect(pay.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/refunds/{id}/pay', pay.body);
  });

  it('raises + rejects a refund', async () => {
    const raise = await admin.post('/api/v1/billing/v2/refunds').send({
      patient_uid: patientUid, advance_id: advanceId, amount: 200, reason: 'overpayment', mode: 'CASH',
    });
    expect([200, 201]).toContain(raise.statusCode);
    const refundId = raise.body.data.id;

    const reject = await admin.post(`/api/v1/billing/v2/refunds/${refundId}/reject`).send({ rejection_reason: 'not eligible' });
    expect(reject.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/refunds/{id}/reject', reject.body);
  });

  it('returns the daily-collection + outstanding reports', async () => {
    const daily = await admin.get('/api/v1/billing/v2/reports/daily-collection');
    expect(daily.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/billing/v2/reports/daily-collection', daily.body);

    const out = await admin.get('/api/v1/billing/v2/reports/outstanding?limit=50');
    expect(out.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/billing/v2/reports/outstanding', out.body);
  });
});

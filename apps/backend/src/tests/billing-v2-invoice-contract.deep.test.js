// OpenAPI Phase 5 — V2 billing invoice contract coverage.
// Drives the V2 invoice lifecycle over HTTP and validates every response
// against the canonical spec via assertResponse (additionalProperties:false).
import { authClient } from './testClient.js';
import prisma from '../lib/prisma.js';
import { assertResponse } from './helpers/assertSchema.js';

describe('V2 billing invoice contract', () => {
  const admin = authClient('ADMIN');
  // Suite-owned patient. A billing-specific UID (not the shared 33333333, which
  // doubles as a STAFF/ANESTHETIST uid in authorization.test + sprint fixtures)
  // so this suite cannot collide with another suite's user row.
  const patientUid = 'b1110000-0000-4000-8000-000000000001';
  const TENANT = '00000000-0000-4000-8000-000000000001';
  const SVC_CODE = 'P5TEST-SVC';

  let invoiceId;
  let itemId1;
  let itemId2;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM billing_invoice_items WHERE invoice_id IN (SELECT id FROM billing_invoices WHERE patient_uid = $1::uuid)`,
      patientUid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE patient_uid = $1::uuid`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE patient_uid = $1::uuid`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_service_master WHERE code = $1`, SVC_CODE).catch(() => {});
    // Create the patient this suite owns — billingV2Service.assertPatientInTenant
    // 404s if the patient_uid is absent from the caller's tenant on a fresh DB.
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at)
       VALUES ($1::uuid, '9990001112', 'V2 Invoice Test', 'PATIENT', $2::uuid, NOW())`,
      patientUid, TENANT,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  it('creates + lists a service-master entry', async () => {
    const create = await admin.post('/api/v1/billing/v2/services').send({
      code: SVC_CODE, description: 'Test service', category: 'consultation', default_price: 500, gst_rate: 18, hsn_sac: '9993',
    });
    expect([200, 201]).toContain(create.statusCode);
    assertResponse('POST', '/api/v1/billing/v2/services', create.body);

    const list = await admin.get('/api/v1/billing/v2/services?q=P5TEST');
    expect(list.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/billing/v2/services', list.body);
  });

  it('creates + lists a draft invoice', async () => {
    const create = await admin.post('/api/v1/billing/v2/invoices').send({
      patient_uid: patientUid, invoice_type: 'OP', patient_name: 'V2 Test', patient_phone: '9990001111',
    });
    expect([200, 201]).toContain(create.statusCode);
    assertResponse('POST', '/api/v1/billing/v2/invoices', create.body);
    invoiceId = create.body.data.id;

    const list = await admin.get('/api/v1/billing/v2/invoices?limit=20');
    expect(list.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/billing/v2/invoices', list.body);
  });

  it('adds two items, then removes one (returns totals)', async () => {
    const add1 = await admin.post(`/api/v1/billing/v2/invoices/${invoiceId}/items`).send({
      service_code: SVC_CODE, description: 'Consultation', quantity: 1, unit_price: 500, gst_rate: 18,
    });
    expect([200, 201]).toContain(add1.statusCode);
    assertResponse('POST', '/api/v1/billing/v2/invoices/{id}/items', add1.body);
    itemId1 = add1.body.data.id;

    const add2 = await admin.post(`/api/v1/billing/v2/invoices/${invoiceId}/items`).send({
      description: 'Extra', quantity: 2, unit_price: 100, gst_rate: 18,
    });
    expect([200, 201]).toContain(add2.statusCode);
    itemId2 = add2.body.data.id;

    const del = await admin.delete(`/api/v1/billing/v2/invoices/${invoiceId}/items/${itemId2}`);
    expect(del.statusCode).toBe(200);
    assertResponse('DELETE', '/api/v1/billing/v2/invoices/{id}/items/{itemId}', del.body);
  });

  it('applies a discount (returns totals)', async () => {
    const res = await admin.post(`/api/v1/billing/v2/invoices/${invoiceId}/discount`).send({ amount: 50, reason: 'test' });
    expect(res.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/invoices/{id}/discount', res.body);
  });

  it('records a TPA decision on an item', async () => {
    const res = await admin.post(`/api/v1/billing/v2/invoices/${invoiceId}/items/${itemId1}/tpa-decision`).send({
      decision: 'non_payable', non_payable_reason: 'other',
    });
    expect(res.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/invoices/{id}/items/{itemId}/tpa-decision', res.body);
  });

  it('returns the non-payable breakdown', async () => {
    const res = await admin.get(`/api/v1/billing/v2/invoices/${invoiceId}/non-payable`);
    expect(res.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/billing/v2/invoices/{id}/non-payable', res.body);
  });

  it('returns the full invoice detail', async () => {
    const res = await admin.get(`/api/v1/billing/v2/invoices/${invoiceId}`);
    expect(res.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/billing/v2/invoices/{id}', res.body);
  });

  it('voids a draft invoice and returns full detail', async () => {
    const create = await admin.post('/api/v1/billing/v2/invoices').send({
      patient_uid: patientUid, invoice_type: 'OP', patient_name: 'V2 Test', patient_phone: '9990001111',
    });
    expect([200, 201]).toContain(create.statusCode);
    assertResponse('POST', '/api/v1/billing/v2/invoices', create.body);

    const voidRes = await admin.post(`/api/v1/billing/v2/invoices/${create.body.data.id}/void`).send({ reason: 'test draft void' });
    expect(voidRes.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/invoices/{id}/void', voidRes.body);
    expect(voidRes.body.data.status).toBe('VOID');
  });

  it('issues the invoice and requires the auditable reversal workflow', async () => {
    const issue = await admin.post(`/api/v1/billing/v2/invoices/${invoiceId}/issue`).send({});
    expect(issue.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/invoices/{id}/issue', issue.body);

    const voidRes = await admin.post(`/api/v1/billing/v2/invoices/${invoiceId}/void`).send({ reason: 'test void' });
    expect(voidRes.statusCode).toBe(409);
    expect(voidRes.body).toMatchObject({
      success: false,
      code: 'BILLING_INVOICE_REVERSAL_WORKFLOW_REQUIRED',
    });
  });
});

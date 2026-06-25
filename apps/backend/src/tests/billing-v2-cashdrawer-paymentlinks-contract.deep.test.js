// OpenAPI Phase 5 — V2 cash-drawer + payment-link contract coverage.
// Drives both subsystems over HTTP and validates every response against the
// canonical spec via assertResponse.
import pg from 'pg';
import { authClient } from './testClient.js';
import prisma from '../lib/prisma.js';
import { assertResponse } from './helpers/assertSchema.js';

describe('V2 cash-drawer + payment-link contract', () => {
  const admin = authClient('ADMIN');
  const TENANT = '00000000-0000-4000-8000-000000000001';
  const CASHIER = '550e8400-e29b-41d4-a716-446655440000'; // admin token uid
  const patientUid = '55555555-5555-4555-8555-555555555555';
  const RUN = Date.now();

  let sessionId;
  let token;

  beforeAll(async () => {
    process.env.HOSPITAL_UPI_VPA = process.env.HOSPITAL_UPI_VPA || 'test@upi';
    process.env.HOSPITAL_UPI_PAYEE_NAME = process.env.HOSPITAL_UPI_PAYEE_NAME || 'VH Test';
    // cash_drawer_sessions has a restrictive (not permissive-when-unset) RLS policy
    // that blocks plain-prisma + setTenant DELETEs, so clear it via a direct
    // superuser connection (bypasses RLS) — only for test cleanup.
    const su = new pg.Client(process.env.DATABASE_URL);
    await su.connect().then(() => su.query(`DELETE FROM cash_drawer_sessions WHERE cashier_uid = $1`, [CASHIER]))
      .catch(() => {}).finally(() => su.end().catch(() => {}));
    await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE patient_uid = $1::uuid`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_payment_links WHERE patient_uid = $1::uuid`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, patientUid).catch(() => {});
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid, '9002223344', 'PL Test', 'PATIENT', $2::uuid, NOW())`,
      patientUid, TENANT,
    ).catch(() => {});
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  it('opens, gets + lists a cash-drawer session', async () => {
    const open = await admin.post('/api/v1/billing/v2/cash-drawer/sessions/open').send({ shift: 'MORNING', opening_float: 1000 });
    expect([200, 201]).toContain(open.statusCode);
    assertResponse('POST', '/api/v1/billing/v2/cash-drawer/sessions/open', open.body);
    sessionId = open.body.data.id;

    const get = await admin.get(`/api/v1/billing/v2/cash-drawer/sessions/${sessionId}`);
    expect(get.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/billing/v2/cash-drawer/sessions/{id}', get.body);

    const list = await admin.get('/api/v1/billing/v2/cash-drawer/sessions?limit=20');
    expect(list.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/billing/v2/cash-drawer/sessions', list.body);
  });

  it('closes (with variance) then reviews the session', async () => {
    const close = await admin.post(`/api/v1/billing/v2/cash-drawer/sessions/${sessionId}/close`).send({
      counted_denominations: { 500: 2, 100: 2 }, variance_reason: 'test variance',
    });
    expect(close.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/cash-drawer/sessions/{id}/close', close.body);

    const review = await admin.post(`/api/v1/billing/v2/cash-drawer/sessions/${sessionId}/review`).send({ review_notes: 'verified' });
    expect(review.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/cash-drawer/sessions/{id}/review', review.body);
  });

  it('creates, lists + gets a payment link', async () => {
    const create = await admin.post('/api/v1/billing/v2/payment-links').send({ patient_uid: patientUid, amount: 500 });
    expect([200, 201]).toContain(create.statusCode);
    assertResponse('POST', '/api/v1/billing/v2/payment-links', create.body);
    token = create.body.data.link_token;

    const list = await admin.get(`/api/v1/billing/v2/payment-links?patient_uid=${patientUid}`);
    expect(list.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/billing/v2/payment-links', list.body);

    const get = await admin.get(`/api/v1/billing/v2/payment-links/${token}`);
    expect(get.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/billing/v2/payment-links/{token}', get.body);
  });

  it('sends then marks the payment link paid', async () => {
    const send = await admin.post(`/api/v1/billing/v2/payment-links/${token}/send`).send({ channels: ['whatsapp'], patient_phone: '9002223344' });
    expect(send.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/payment-links/{token}/send', send.body);

    const paid = await admin.post(`/api/v1/billing/v2/payment-links/${token}/mark-paid`)
      .set('Idempotency-Key', `p5pl-paid-${RUN}`)
      .send({ paid_via: 'upi', paid_reference: 'UPI-REF-1' });
    expect(paid.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/payment-links/{token}/mark-paid', paid.body);
  });

  it('cancels a payment link + runs expire-stale', async () => {
    const create = await admin.post('/api/v1/billing/v2/payment-links').send({ patient_uid: patientUid, amount: 250 });
    const tok2 = create.body.data.link_token;
    const cancel = await admin.post(`/api/v1/billing/v2/payment-links/${tok2}/cancel`).send({ reason: 'duplicate' });
    expect(cancel.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/payment-links/{token}/cancel', cancel.body);

    const expire = await admin.post('/api/v1/billing/v2/payment-links/run-expire-stale').send({});
    expect(expire.statusCode).toBe(200);
    assertResponse('POST', '/api/v1/billing/v2/payment-links/run-expire-stale', expire.body);
  });
});

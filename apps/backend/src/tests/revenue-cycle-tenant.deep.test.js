// Two-tenant isolation for the revenue-cycle read surface (Sol Ultra
// 2026-07-11 #16). /billing/denials, /billing/denials/summary,
// /billing/ar-aging, /billing/claim-queue and /billing/837/:invoiceId used to
// scan claim_denials / invoices / billing_invoices / insurance_claims / users
// with no tenant predicate — RLS-mitigated in prod, live at the multi-tenant
// cutover. Each family is proven in BOTH directions: tenant A never sees
// tenant B rows, tenant B never sees tenant A rows, and in-tenant rows stay
// visible (no over-filtering).
import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken, ensureTestIdentity } from './testClient.js';

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const STAMP = String(Date.now() % 100000).padStart(5, '0');

const STAFF_A = 'e1616161-6161-4161-8161-aaaaaaaa1601';
const STAFF_B = 'e1616161-6161-4161-8161-bbbbbbbb1602';
const PATIENT_A = 'e1616161-6161-4161-8161-cccccccc1603';
const PATIENT_B = 'e1616161-6161-4161-8161-dddddddd1604';

let tokenA;
let tokenB;
let denialA;
let denialB;
let invLegA;
let invLegB;
let invLegAWithBPatient;
let invV2A;
let invV2B;
let claimA;
let claimB;

const EDI_ITEMS = JSON.stringify([
  { description: 'Consultation', cpt: '99213', icd10: 'J06.9', amount: 500, units: 1 },
]);

async function seedUser({ uid, phone, name, role, tenantId }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, updated_at, tenant_id)
     VALUES ($1::uuid, $2, $3, $4, true, NOW(), $5::uuid)
     ON CONFLICT (uid) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, updated_at = NOW()
     RETURNING id`,
    uid, phone, name, role, tenantId,
  );
  return rows[0].id;
}

async function seedDenial(tenantId, reasonCode, amount) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO claim_denials (tenant_id, payer, reason_code, reason_text,
                                denied_amount, denied_at)
     VALUES ($1::uuid, 'TSWEEP TPA', $2, 'tenant sweep seed', $3::numeric, NOW() - INTERVAL '5 days')
     RETURNING id`,
    tenantId, reasonCode, amount,
  );
  return rows[0].id;
}

async function seedLegacyInvoice({ tenantId, patientUid, number }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO invoices (tenant_id, invoice_number, patient_uid, type, items,
                           subtotal, total_amount, paid_amount, payment_status,
                           issued_at, due_date, created_at, updated_at)
     VALUES ($1::uuid, $2, $3::uuid, 'consultation', $4::jsonb,
             500, 500, 0, 'pending',
             NOW() - INTERVAL '200 days', NOW() - INTERVAL '200 days', NOW(), NOW())
     RETURNING id`,
    tenantId, number, patientUid, EDI_ITEMS,
  );
  return rows[0].id;
}

async function seedV2Invoice({ tenantId, patientUid, number }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_invoices (tenant_id, invoice_number, patient_uid, invoice_type,
                                   subtotal, total_amount, amount_paid, amount_due, status,
                                   issued_at)
     VALUES ($1::uuid, $2, $3::uuid, 'final',
             750::numeric, 750::numeric, 0, 750::numeric, 'ISSUED',
             NOW() - INTERVAL '200 days')
     RETURNING id`,
    tenantId, number, patientUid,
  );
  return rows[0].id;
}

async function seedInsuranceClaim({ tenantId, patientUid, claimNumber }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO insurance_claims (tenant_id, claim_number, patient_uid,
                                   insurance_provider, policy_number, claim_amount,
                                   status, submitted_at, created_at, updated_at)
     VALUES ($1::uuid, $2, $3::uuid,
             'TSWEEP Insurer', $4, 500::numeric,
             'submitted', NOW() - INTERVAL '180 days', NOW(), NOW())
     RETURNING id`,
    tenantId, claimNumber, patientUid, `POL-${STAMP}`,
  );
  return rows[0].id;
}

function asTenant(token) {
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'rev-cycle-sweep-b', 'RevCycle Sweep B')
     ON CONFLICT (id) DO NOTHING`, TENANT_B);

  const staffAId = await seedUser({
    uid: STAFF_A, phone: `991016${STAMP.slice(-4)}`, name: 'RC Sweep Finance A', role: 'ADMIN', tenantId: TENANT_A,
  });
  const staffBId = await seedUser({
    uid: STAFF_B, phone: `991017${STAMP.slice(-4)}`, name: 'RC Sweep Finance B', role: 'ADMIN', tenantId: TENANT_B,
  });
  await seedUser({
    uid: PATIENT_A, phone: `991018${STAMP.slice(-4)}`, name: 'RC Sweep Patient A', role: 'PATIENT', tenantId: TENANT_A,
  });
  await seedUser({
    uid: PATIENT_B, phone: `991019${STAMP.slice(-4)}`, name: 'RC Sweep Patient B', role: 'PATIENT', tenantId: TENANT_B,
  });

  tokenA = generateTestToken('ADMIN', { uid: STAFF_A, id: staffAId, tenant_id: TENANT_A });
  tokenB = generateTestToken('ADMIN', { uid: STAFF_B, id: staffBId, tenant_id: TENANT_B });

  denialA = await seedDenial(TENANT_A, `RCA-${STAMP}`, 1000);
  denialB = await seedDenial(TENANT_B, `RCB-${STAMP}`, 2000);

  invLegA = await seedLegacyInvoice({ tenantId: TENANT_A, patientUid: PATIENT_A, number: `INVL-A-${STAMP}` });
  invLegB = await seedLegacyInvoice({ tenantId: TENANT_B, patientUid: PATIENT_B, number: `INVL-B-${STAMP}` });
  // Tenant A invoice deliberately pointing at a tenant B patient — proves the
  // 837 patient lookup is tenant-scoped independently of the invoice lookup.
  invLegAWithBPatient = await seedLegacyInvoice({
    tenantId: TENANT_A, patientUid: PATIENT_B, number: `INVL-AXB-${STAMP}`,
  });

  invV2A = await seedV2Invoice({ tenantId: TENANT_A, patientUid: PATIENT_A, number: `INVB-A-${STAMP}` });
  invV2B = await seedV2Invoice({ tenantId: TENANT_B, patientUid: PATIENT_B, number: `INVB-B-${STAMP}` });

  claimA = await seedInsuranceClaim({ tenantId: TENANT_A, patientUid: PATIENT_A, claimNumber: `CLQ-A-${STAMP}` });
  claimB = await seedInsuranceClaim({ tenantId: TENANT_B, patientUid: PATIENT_B, claimNumber: `CLQ-B-${STAMP}` });
});

afterAll(async () => {
  for (const id of [claimA, claimB].filter(Boolean)) {
    await prisma.$executeRawUnsafe(`DELETE FROM insurance_claims WHERE id = $1::int`, id).catch(() => {});
  }
  for (const id of [invV2A, invV2B].filter(Boolean)) {
    await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = $1::int`, id).catch(() => {});
  }
  for (const id of [invLegA, invLegB, invLegAWithBPatient].filter(Boolean)) {
    await prisma.$executeRawUnsafe(`DELETE FROM invoices WHERE id = $1::int`, id).catch(() => {});
  }
  for (const id of [denialA, denialB].filter(Boolean)) {
    await prisma.$executeRawUnsafe(`DELETE FROM claim_denials WHERE id = $1::int`, id).catch(() => {});
  }
  for (const uid of [STAFF_A, STAFF_B, PATIENT_A, PATIENT_B]) {
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, uid).catch(() => {});
  }
  await prisma.$disconnect().catch(() => {});
});

describe('GET /billing/denials + /denials/summary — tenant scoped (Sol Ultra #16)', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity(STAFF_A, { tenantId: TENANT_A });
    await ensureTestIdentity(STAFF_B, { tenantId: TENANT_B });
  });
  it('lists only the caller tenant denials, both directions', async () => {
    const resA = await asTenant(tokenA).get('/api/v1/billing/denials?limit=200');
    expect(resA.statusCode).toBe(200);
    const idsA = resA.body.data.items.map((r) => r.id);
    expect(idsA).toContain(denialA);
    expect(idsA).not.toContain(denialB);

    const resB = await asTenant(tokenB).get('/api/v1/billing/denials?limit=200');
    expect(resB.statusCode).toBe(200);
    const idsB = resB.body.data.items.map((r) => r.id);
    expect(idsB).toContain(denialB);
    expect(idsB).not.toContain(denialA);
  });

  it('aggregates denial reasons only within the caller tenant, both directions', async () => {
    const resA = await asTenant(tokenA).get('/api/v1/billing/denials/summary');
    expect(resA.statusCode).toBe(200);
    const reasonsA = resA.body.data.byReason.map((r) => r.reason_code);
    expect(reasonsA).toContain(`RCA-${STAMP}`);
    expect(reasonsA).not.toContain(`RCB-${STAMP}`);

    const resB = await asTenant(tokenB).get('/api/v1/billing/denials/summary');
    expect(resB.statusCode).toBe(200);
    const reasonsB = resB.body.data.byReason.map((r) => r.reason_code);
    expect(reasonsB).toContain(`RCB-${STAMP}`);
    expect(reasonsB).not.toContain(`RCA-${STAMP}`);
  });
});

describe('GET /billing/ar-aging — tenant scoped across both invoice tables (Sol Ultra #16)', () => {
  it('shows only the caller tenant legacy + v2 invoices, both directions', async () => {
    const resA = await asTenant(tokenA).get('/api/v1/billing/ar-aging?limit=100');
    expect(resA.statusCode).toBe(200);
    const keysA = resA.body.data.invoices.map((r) => `${r.source}:${r.id}`);
    expect(keysA).toContain(`legacy:${invLegA}`);
    expect(keysA).toContain(`v2:${invV2A}`);
    expect(keysA).not.toContain(`legacy:${invLegB}`);
    expect(keysA).not.toContain(`v2:${invV2B}`);

    const resB = await asTenant(tokenB).get('/api/v1/billing/ar-aging?limit=100');
    expect(resB.statusCode).toBe(200);
    const keysB = resB.body.data.invoices.map((r) => `${r.source}:${r.id}`);
    expect(keysB).toContain(`legacy:${invLegB}`);
    expect(keysB).toContain(`v2:${invV2B}`);
    expect(keysB).not.toContain(`legacy:${invLegA}`);
    expect(keysB).not.toContain(`v2:${invV2A}`);
  });
});

describe('GET /billing/claim-queue — tenant scoped (Sol Ultra #16)', () => {
  it('queues only the caller tenant insurance claims, both directions', async () => {
    const resA = await asTenant(tokenA).get('/api/v1/billing/claim-queue?limit=200');
    expect(resA.statusCode).toBe(200);
    const idsA = resA.body.data.claims.map((r) => r.id);
    expect(idsA).toContain(claimA);
    expect(idsA).not.toContain(claimB);

    const resB = await asTenant(tokenB).get('/api/v1/billing/claim-queue?limit=200');
    expect(resB.statusCode).toBe(200);
    const idsB = resB.body.data.claims.map((r) => r.id);
    expect(idsB).toContain(claimB);
    expect(idsB).not.toContain(claimA);
  });
});

describe('GET /billing/837/:invoiceId — tenant scoped invoice + patient reads (Sol Ultra #16)', () => {
  it('refuses to build an 837 for another tenant invoice, both directions', async () => {
    const crossA = await asTenant(tokenA).get(`/api/v1/billing/837/${invLegB}`);
    expect(crossA.statusCode).toBe(404);
    expect(crossA.body.message).toBe('Invoice not found');

    const crossB = await asTenant(tokenB).get(`/api/v1/billing/837/${invLegA}`);
    expect(crossB.statusCode).toBe(404);
    expect(crossB.body.message).toBe('Invoice not found');
  });

  it('still builds an 837 for an in-tenant invoice', async () => {
    const res = await asTenant(tokenA).get(`/api/v1/billing/837/${invLegA}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/edi-x12');
    expect(res.text).toContain(`INVL-A-${STAMP}`);
  });

  it('does not resolve the invoice patient across tenants', async () => {
    const res = await asTenant(tokenA).get(`/api/v1/billing/837/${invLegAWithBPatient}`);
    expect(res.statusCode).toBe(404);
    expect(res.body.message).toBe('Patient not found for invoice');
  });
});

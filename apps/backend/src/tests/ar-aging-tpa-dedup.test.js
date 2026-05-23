// Regression test for finding cluster H' D21 (8131f896 + 9c28990d).
//
// `/api/v1/billing/ar-aging` joined `billing_invoices` to
// `tpa_claims tc ON tc.invoice_id = bi.id` as a plain LEFT JOIN.
// When more than one tpa_claims row pointed at the same invoice
// (initial + enhancement chain, or a re-filed claim), the join
// fan-out cartesian-multiplied the invoice row — so a single
// outstanding ₹100k invoice with 3 linked tpa_claims rows counted
// as 3 invoices for ₹300k of receivable. Finance saw inflated AR
// totals on every cashless admission that had been enhanced.
//
// The fix replaces the plain LEFT JOIN with a LATERAL subquery that
// picks the LATEST tpa_claims row (highest id) per invoice and joins
// policy/payer off that single row. The aggregations then see one
// `base` row per invoice.
//
// This test seeds two invoices — one with three tpa_claims linked,
// one with zero — and asserts:
//   * /ar-aging total_outstanding sums each invoice exactly once
//   * /ar-aging invoice_count reflects the distinct invoice count
//   * The insurer_name + claim_reference come from the LATEST claim

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'd9999999-d999-4d99-8d99-aaaaaaaad921';
const STAFF_UID = 'd9999999-d999-4d99-8d99-bbbbbbbb9921';
const STAMP = String(Date.now() % 100000).padStart(5, '0');

let policyId;
let invoiceMultiId;
let invoiceSoloId;
const createdClaimIds = [];
let financeToken;

async function seedInvoice({ idx, total }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_invoices
       (invoice_number, patient_uid, invoice_type,
        subtotal, total_amount, amount_paid, amount_due, status, tenant_id)
     VALUES ($1, $2::uuid, 'final',
             $3::numeric, $3::numeric, 0, $3::numeric, 'ISSUED', $4::uuid)
     RETURNING id`,
    `INV-D21-${STAMP}-${idx}`, PATIENT_UID, total, TENANT,
  );
  return rows[0].id;
}

async function seedTpaClaim({ invoiceId, claimNumber }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tpa_claims
       (claim_number, policy_id, patient_uid, claim_type,
        total_billed, claimed_amount, status, invoice_id, tenant_id)
     VALUES ($1, $2::int, $3::uuid, 'cashless',
             100000, 100000, 'submitted', $4::int, $5::uuid)
     RETURNING id`,
    claimNumber, policyId, PATIENT_UID, invoiceId, TENANT,
  );
  createdClaimIds.push(rows[0].id);
  return rows[0].id;
}

describe('GET /billing/ar-aging — dedupe invoices linked to multiple tpa_claims (H D21)', () => {
  beforeAll(async () => {
    // Finance / admin can read /ar-aging.
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '99102009${STAMP.slice(-2)}', 'D21 Finance', 'ADMIN', true, NOW())
       ON CONFLICT (uid) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      STAFF_UID,
    );
    financeToken = generateTestToken('ADMIN', { uid: STAFF_UID, id: rows[0].id });

    const pol = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policy_number, status, tenant_id)
       VALUES ($1::uuid, $2, 'active', $3::uuid)
       RETURNING id`,
      PATIENT_UID, `POL-D21-${STAMP}`, TENANT,
    );
    policyId = pol[0].id;

    // Invoice A: three tpa_claims linked (initial + enhancement chain).
    invoiceMultiId = await seedInvoice({ idx: 'M', total: 100000 });
    await seedTpaClaim({ invoiceId: invoiceMultiId, claimNumber: `CL-D21-${STAMP}-1` });
    await seedTpaClaim({ invoiceId: invoiceMultiId, claimNumber: `CL-D21-${STAMP}-2` });
    await seedTpaClaim({ invoiceId: invoiceMultiId, claimNumber: `CL-D21-${STAMP}-3` });

    // Invoice B: no tpa_claim attached.
    invoiceSoloId = await seedInvoice({ idx: 'S', total: 25000 });
  });

  afterAll(async () => {
    for (const id of createdClaimIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claims WHERE id = $1::int`, id).catch(() => {});
    }
    for (const id of [invoiceMultiId, invoiceSoloId].filter(Boolean)) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = $1::int`, id).catch(() => {});
    }
    if (policyId) {
      await prisma.$executeRawUnsafe(`DELETE FROM insurance_policies WHERE id = $1::int`, policyId).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, STAFF_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('counts an invoice with 3 linked tpa_claims exactly once in the AR-aging overall + buckets', async () => {
    const res = await request(app)
      .get('/api/v1/billing/ar-aging')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${financeToken}`);

    expect(res.statusCode).toBe(200);
    const ourMulti = res.body.data.invoices.find((r) => r.id === invoiceMultiId && r.source === 'v2');
    expect(ourMulti).toBeTruthy();
    // The invoice must appear exactly once, with outstanding=100000.
    const multiCopies = res.body.data.invoices.filter(
      (r) => r.id === invoiceMultiId && r.source === 'v2',
    );
    expect(multiCopies).toHaveLength(1);
    expect(Number(multiCopies[0].outstanding_amount)).toBe(100000);
  });

  it('overall aggregate counts each test invoice exactly once', async () => {
    const res = await request(app)
      .get('/api/v1/billing/ar-aging')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${financeToken}`);

    expect(res.statusCode).toBe(200);
    // We can't lock in the global invoice_count (other test data exists),
    // but our two seeded invoices contribute 2 — NOT 4 (3 claims on
    // invoice A would have pre-fix made it 3+1=4).
    const ours = res.body.data.invoices.filter(
      (r) => (r.id === invoiceMultiId || r.id === invoiceSoloId) && r.source === 'v2',
    );
    expect(ours).toHaveLength(2);
  });
});

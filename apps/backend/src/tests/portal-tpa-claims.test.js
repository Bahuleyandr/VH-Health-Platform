// Regression test for finding
// 2026-05-09-tpa-insurance-claim-patient-tpa-portal-500-no-tenant-id
//
// The patient portal endpoints GET /api/v1/portal/tpa/claims and
// GET /api/v1/portal/tpa/claims/:id were querying `insurance_claims`
// with a WHERE tenant_id = $1 filter, but `insurance_claims` has no
// `tenant_id` column (it's the legacy table) — every patient request
// 500'd with `column "tenant_id" does not exist`.
//
// The fix routes the portal queries to `tpa_claims` (the Sprint 5
// TPA workflow table that *does* carry tenant_id and is what
// `/portal/tpa/claims` is naming-wise pointing at).

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken, ensureTestIdentity } from './testClient.js';

const PATIENT_UID = 'f2222222-2222-4222-8222-bbbbbbbb2202';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const POLICY_NUMBER = `POL-PORTAL-${Date.now() % 100000}`;
const CLAIM_NUMBER = `CL-PORTAL-${Date.now() % 100000}`;
const INVOICE_NUMBER = `INV-PORTAL-${Date.now() % 100000}`;

describe('GET /portal/tpa/claims — patient self-service', () => {
  let policyId;
  let claimId;
  let invoiceId;
  const admissionId = 920200 + (Date.now() % 10000);
  let patientToken;

  beforeAll(async () => {
    const userRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'TPA Portal Test Patient', 'PATIENT', true, NOW())
       ON CONFLICT (uid) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      PATIENT_UID,
      `9999${Date.now() % 1000000}`.slice(0, 10)
    );
    const userId = userRows[0].id;

    // Migration 753's fk_tpa_claim_admission_authority_753 binds a claim to
    // its admission on the composite key (tenant_id, admission_id,
    // patient_uid): a claim can no longer name an admission id that does not
    // exist for exactly this tenant and patient. Seed the stay the claim and
    // the room-charge invoice both hang off, so the fixture carries the same
    // authority a real cashless admission would.
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions (id, patient_uid, tenant_id)
       VALUES ($1::int, $2::uuid, $3::uuid)
       ON CONFLICT (id) DO NOTHING`,
      admissionId,
      PATIENT_UID,
      TENANT_ID
    );

    const policyRows = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policy_number, policyholder_name, policy_type,
          status, tenant_id)
       VALUES ($1::uuid, $2, 'TPA Portal Test Patient', 'individual',
               'active', $3::uuid)
       RETURNING id`,
      PATIENT_UID,
      POLICY_NUMBER,
      TENANT_ID
    );
    policyId = policyRows[0].id;

    const invoiceRows = await prisma.$queryRawUnsafe(
      `INSERT INTO billing_invoices
         (invoice_number, patient_uid, admission_id, invoice_type,
          subtotal, total_amount, amount_paid, amount_due, status, tenant_id)
       VALUES ($1, $2::uuid, $3::int, 'room_charge',
               5500, 5500, 5500, 0, 'PAID', $4::uuid)
       RETURNING id`,
      INVOICE_NUMBER,
      PATIENT_UID,
      admissionId,
      TENANT_ID
    );
    invoiceId = invoiceRows[0].id;

    const claimRows = await prisma.$queryRawUnsafe(
      `INSERT INTO tpa_claims
         (claim_number, policy_id, patient_uid, claim_type,
          total_billed, patient_copay, non_payable_amount,
          claimed_amount, approved_amount, paid_amount, disallowed_amount,
          status, admission_id, tenant_id)
       VALUES ($1, $2::int, $3::uuid, 'cashless',
               83500, 0, 3500, 80000, 80000, 78000, 2000,
               'settled_partial', $4::int, $5::uuid)
       RETURNING id`,
      CLAIM_NUMBER,
      policyId,
      PATIENT_UID,
      admissionId,
      TENANT_ID
    );
    claimId = claimRows[0].id;

    patientToken = generateTestToken('PATIENT', {
      uid: PATIENT_UID,
      id: userId,
    });
  });

  afterAll(async () => {
    if (claimId) {
      await prisma
        .$executeRawUnsafe(`DELETE FROM tpa_claims WHERE id = $1::int`, claimId)
        .catch(() => {});
    }
    if (policyId) {
      await prisma
        .$executeRawUnsafe(
          `DELETE FROM insurance_policies WHERE id = $1::int`,
          policyId
        )
        .catch(() => {});
    }
    if (invoiceId) {
      await prisma
        .$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = $1::int`, invoiceId)
        .catch(() => {});
    }
    await prisma
      .$executeRawUnsafe(`DELETE FROM admissions WHERE id = $1::int`, admissionId)
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID)
      .catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 120_000);

  it('lists the patient TPA claims without 500', async () => {
    const res = await request(app)
      .get('/api/v1/portal/tpa/claims')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    const list = res.body.data;
    expect(Array.isArray(list)).toBe(true);
    const ours = list.find((c) => c.id === claimId);
    expect(ours).toBeTruthy();
    expect(ours.claim_number).toBe(CLAIM_NUMBER);
    expect(ours.claim_type).toBe('cashless');
    expect(Number(ours.claimed_amount)).toBe(80000);
  });

  it('returns a single claim with summary + invoice breakdown', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/tpa/claims/${claimId}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.claim.id).toBe(claimId);
    expect(res.body.data.claim.policy_number).toBe(POLICY_NUMBER);
    expect(res.body.data.summary).toEqual(
      expect.objectContaining({
        hospital_billed: 83500,
        tpa_claimed: 80000,
        tpa_approved: 80000,
        tpa_paid: 78000,
        tpa_disallowed: 2000,
        non_payable: 3500,
        patient_responsibility: 5500,
        currency: 'INR',
      })
    );
  });

  it('attaches an unlinked settled claim to the patient bill by admission', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/bills/${invoiceId}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.invoice.invoice_number).toBe(INVOICE_NUMBER);
    expect(res.body.data.tpa_breakdown.claim.id).toBe(claimId);
    expect(res.body.data.tpa_breakdown.summary).toEqual(
      expect.objectContaining({
        tpa_paid: 78000,
        tpa_disallowed: 2000,
        non_payable: 3500,
        patient_share: 5500,
      })
    );
    // The patient amount due is the insurer-determined patient share
    // (disallowed + non-payable + co-pay = 5500), NOT conflated with the
    // insurer's cashless receivable. Finding 25a59426.
    expect(res.body.data.responsibility).toEqual(
      expect.objectContaining({
        basis: 'tpa_final',
        is_cashless: true,
        patient_responsibility: 5500,
        patient_amount_due: 5500,
      })
    );
  });

  it('does not return another patient\'s claim', async () => {
    const otherUid = 'f3333333-3333-4333-8333-cccccccc3303';
    // The other patient must be a LIVE identity, otherwise authentication
    // fails closed and this returns 401 — which would pass a "not 200" test for
    // the wrong reason and stop proving the ownership check at all.
    await ensureTestIdentity(otherUid, { role: 'PATIENT' });
    const otherToken = generateTestToken('PATIENT', { uid: otherUid, id: 9_000_001 });
    const res = await request(app)
      .get(`/api/v1/portal/tpa/claims/${claimId}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.statusCode).toBe(404);
  });
});

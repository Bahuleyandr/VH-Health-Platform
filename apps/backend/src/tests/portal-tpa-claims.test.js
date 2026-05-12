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
import { API_KEY, generateTestToken } from './testClient.js';

const PATIENT_UID = 'f2222222-2222-4222-8222-bbbbbbbb2202';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const POLICY_NUMBER = `POL-PORTAL-${Date.now() % 100000}`;
const CLAIM_NUMBER = `CL-PORTAL-${Date.now() % 100000}`;

describe('GET /portal/tpa/claims — patient self-service', () => {
  let policyId;
  let claimId;
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

    const claimRows = await prisma.$queryRawUnsafe(
      `INSERT INTO tpa_claims
         (claim_number, policy_id, patient_uid, claim_type,
          total_billed, patient_copay, non_payable_amount,
          claimed_amount, approved_amount, status, tenant_id)
       VALUES ($1, $2::int, $3::uuid, 'cashless',
               78000, 0, 20000, 58000, 58000,
               'approved', $4::uuid)
       RETURNING id`,
      CLAIM_NUMBER,
      policyId,
      PATIENT_UID,
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
    await prisma
      .$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID)
      .catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

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
    expect(Number(ours.claimed_amount)).toBe(58000);
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
        hospital_billed: 78000,
        tpa_claimed: 58000,
        tpa_approved: 58000,
        patient_responsibility: 20000,
        currency: 'INR',
      })
    );
  });

  it('does not return another patient\'s claim', async () => {
    const otherUid = 'f3333333-3333-4333-8333-cccccccc3303';
    const otherToken = generateTestToken('PATIENT', { uid: otherUid, id: 9_000_001 });
    const res = await request(app)
      .get(`/api/v1/portal/tpa/claims/${claimId}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.statusCode).toBe(404);
  });
});

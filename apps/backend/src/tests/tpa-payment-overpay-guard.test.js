// Regression test for finding
// 2026-05-09-tpa-insurance-claim-billing-tpa-overpay-no-validation
//
// POST /api/v1/insurance/claims/:id/payment used to accept any
// positive paid_amount, regardless of the claim's claimed_amount.
// A 76000 payment against a 58000 claim would silently absorb the
// 20000 non-payable component (pre-disclosed patient liability) into
// the TPA settlement, leaving only 2000 instead of 22000 collectable
// from the patient at discharge — a systematic ~₹20k loss per TPA
// admission processed carelessly.
//
// The fix in claimsService.recordClaimPayment rejects the request
// with AppError.badRequest(code='PAYMENT_EXCEEDS_CLAIM') when
// paid_amount > claimed_amount.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const STAFF_UID = 'f4444444-4444-4444-8444-dddddddd4404';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'f5555555-5555-4555-8555-eeeeeeee5505';
const POLICY_NUMBER = `POL-OVERPAY-${Date.now() % 100000}`;
const CLAIM_NUMBER = `CL-OVERPAY-${Date.now() % 100000}`;

describe('POST /insurance/claims/:id/payment — overpay guard', () => {
  let policyId;
  let claimId;
  let staffToken;

  beforeAll(async () => {
    const staffRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'TPA Overpay Test Staff', 'BILLING_STAFF', true, NOW())
       ON CONFLICT (uid) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      STAFF_UID,
      `9999${Date.now() % 1000000}`.slice(0, 10)
    );
    const staffId = staffRows[0].id;

    const policyRows = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policy_number, status, tenant_id)
       VALUES ($1::uuid, $2, 'active', $3::uuid)
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

    staffToken = generateTestToken('BILLING_STAFF', { uid: STAFF_UID, id: staffId });
  });

  afterAll(async () => {
    if (claimId) {
      await prisma
        .$executeRawUnsafe(
          `DELETE FROM tpa_claim_correspondence WHERE claim_id = $1::int`,
          claimId
        )
        .catch(() => {});
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
      .$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, STAFF_UID)
      .catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('rejects paid_amount that exceeds claimed_amount', async () => {
    const res = await request(app)
      .post(`/api/v1/insurance/claims/${claimId}/payment`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        paid_amount: 76000,
        payment_reference: 'UTR-TEST-OVERPAY',
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message || '').toMatch(/exceeds claimed_amount/i);

    const row = await prisma.$queryRawUnsafe(
      `SELECT status, paid_amount FROM tpa_claims WHERE id = $1::int`,
      claimId
    );
    expect(row[0].status).toBe('approved');
    expect(row[0].paid_amount).toBeNull();
  });

  it('accepts paid_amount equal to claimed_amount', async () => {
    const res = await request(app)
      .post(`/api/v1/insurance/claims/${claimId}/payment`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        paid_amount: 58000,
        payment_reference: 'UTR-TEST-OK',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('paid');
    expect(Number(res.body.data.paid_amount)).toBe(58000);
  });
});

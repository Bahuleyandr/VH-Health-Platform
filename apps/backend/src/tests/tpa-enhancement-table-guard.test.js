// Regression test for finding
// 2026-05-09-tpa-insurance-claim-doctor-enhancement-table-mismatch
//
// The legacy billing enhancement endpoint at
// POST /api/v1/billing/insurance/claim/:id/enhancement reads
// `insurance_claims`, but the Sprint 5 TPA workflow writes to
// `tpa_claims` (a separate table). If a caller hands the endpoint
// a tpa_claims.id, the pre-fix behavior was either:
//   (a) HTTP 404 "Parent insurance claim not found" — confusing,
//   (b) silent cross-contamination if an insurance_claims row
//       happened to share the same SERIAL id, writing the
//       enhancement against an unrelated patient.
//
// The fix in billingService.createEnhancementClaim now probes
// tpa_claims when the insurance_claims lookup misses and throws
// AppError.badRequest(code='TPA_CLAIM_USE_PREAUTH_ENHANCEMENT')
// so the caller is routed to the proper TPA workflow (an
// `insurance_preauth` row with request_type='enhancement' +
// parent_preauth_id).

import { authClient } from './testClient.js';
import prisma from '../lib/prisma.js';

const PATIENT_UID = 'f1111111-1111-4111-8111-aaaaaaaa1101';
const POLICY_NUMBER = `POL-GUARD-${Date.now() % 100000}`;
const CLAIM_NUMBER = `CL-GUARD-${Date.now() % 100000}`;

describe('Enhancement guard against tpa_claims id collision', () => {
  const admin = authClient('ADMIN');
  let policyId;
  let tpaClaimId;

  beforeAll(async () => {
    const policyRows = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policy_number, status, tenant_id)
       VALUES ($1::uuid, $2, 'active',
               '00000000-0000-4000-8000-000000000001'::uuid)
       RETURNING id`,
      PATIENT_UID,
      POLICY_NUMBER
    );
    policyId = policyRows[0].id;

    const claimRows = await prisma.$queryRawUnsafe(
      `INSERT INTO tpa_claims
         (claim_number, policy_id, patient_uid, claim_type,
          total_billed, claimed_amount, status, tenant_id)
       VALUES ($1, $2::int, $3::uuid, 'cashless',
               58000, 58000, 'approved',
               '00000000-0000-4000-8000-000000000001'::uuid)
       RETURNING id`,
      CLAIM_NUMBER,
      policyId,
      PATIENT_UID
    );
    tpaClaimId = claimRows[0].id;
  });

  afterAll(async () => {
    if (tpaClaimId) {
      await prisma
        .$executeRawUnsafe(`DELETE FROM tpa_claims WHERE id = $1::int`, tpaClaimId)
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
    await prisma.$disconnect().catch(() => {});
  });

  it('rejects an enhancement request whose claim_id points at tpa_claims', async () => {
    const res = await admin
      .post(`/api/v1/billing/insurance/claim/${tpaClaimId}/enhancement`)
      .send({ enhancement_amount: 40000 });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message || '').toMatch(/TPA claim/i);
    expect(res.body.message || '').toMatch(/insurance_preauth/i);
  });
});

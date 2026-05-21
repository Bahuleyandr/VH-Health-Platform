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

    // Determinism guard. `tpa_claims` and `insurance_claims` are independent
    // SERIAL sequences, so a freshly-created tpa_claims row can land on an id
    // that already exists in insurance_claims (created by another suite).
    // When it does, createEnhancementClaim's `SELECT FROM insurance_claims
    // WHERE id = $1` hits that unrelated row and creates an enhancement (201)
    // instead of falling through to the tpa_claims guard (400) — a flake that
    // depends on suite execution order. Push the tpa_claims sequence past the
    // current insurance_claims max so this row's id cannot exist in
    // insurance_claims, making the guard assertion deterministic.
    await prisma.$queryRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('tpa_claims', 'id'),
                     GREATEST(
                       (SELECT COALESCE(MAX(id), 0) FROM tpa_claims),
                       (SELECT COALESCE(MAX(id), 0) FROM insurance_claims)
                     ) + 1000, false)`
    );

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

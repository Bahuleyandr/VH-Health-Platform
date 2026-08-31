// Regression test for finding
// 2026-05-20-tpa-insurance-claim-billing-df39fefb
//
// A final TPA claim's settlement/decision could be recorded for an insurer
// that does NOT match the claim's policy payer — e.g. a New India Assurance
// (NIA) settlement reference ("NIA-NEFT-CL-2627-00004-63000") posted against a
// Star Health policy. The insurer is only present in the free-text settlement
// reference (payment_reference) + the claim's tpa_reference_id; the settlement
// path carries no structured insurer the way recordPreauthResponse does. That
// misroutes payer reconciliation / AR follow-up (finance chases Star Health
// for a payment that operationally belongs to New India).
//
// The fix adds a payer-match guard to recordClaimPayment + recordClaimDecision
// (claimsService), reusing insurerMatchesPolicyPayer. It is BEST-EFFORT over
// free text: only a confidently-recognised leading insurer token resolving to
// a payer different from the policy's blocks (CLAIM_INSURER_MISMATCH). An
// unrecognised / compatible / empty reference never blocks — a false reject of
// a legitimate settlement is worse than the miss. A structured `insurer` on the
// decision (when the TPA portal echoes it) is treated as the strong signal.
//
// This test seeds the policy against the migration-203 payer master so the
// guard has an authoritative policy payer to compare against.

import prisma from '../lib/prisma.js';
import * as claims from '../services/insurance/claimsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'f4444444-4444-4444-8444-dddddddd5d40';

const createdClaimIds = [];
let starPolicyId; // policy whose payer is Star Health
let nakedPolicyId; // policy with NO payer_id (permissive case)

async function seedClaim({ policyId, status = 'submitted', tpaRef = null, totalBilled = 80000 }) {
  const created = await claims.createClaim({
    tenantId: TENANT, policy_id: policyId, patient_uid: PATIENT_UID,
    claim_type: 'reimbursement', total_billed: totalBilled,
  });
  createdClaimIds.push(created.id);
  await prisma.$executeRawUnsafe(
    `UPDATE tpa_claims SET status = $1, tpa_reference_id = $2 WHERE id = $3::int`,
    status, tpaRef, created.id,
  );
  return created.id;
}

describe('TPA claim settlement payer-mismatch guard (df39fefb)', () => {
  beforeAll(async () => {
    // Migration 753 routes createClaim through lockInsuranceFundingPatientTx
    // → resolvePharmacyFundingPatientUidTx, which serialises the claim
    // against the ONE active patient it names. seedClaim's patient_uid
    // therefore has to be a real registered patient in this tenant
    // (role='PATIENT', is_active, status='active', not deleted, not merged),
    // not a bare uuid — otherwise every seedClaim call is refused with 409
    // PHARMACY_FUNDING_PATIENT_IDENTITY_MISMATCH before the payer guard under
    // test is ever reached. Register them the way registration would.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'TPA Settlement Mismatch Test Patient', 'PATIENT', true, 'active', $3::uuid, NOW())
       ON CONFLICT (uid) DO UPDATE
          SET is_active = true, status = 'active', is_deleted = false,
              merged_into_uid = NULL, updated_at = NOW()`,
      PATIENT_UID,
      `9603${Date.now() % 1000000}`.slice(0, 10),
      TENANT,
    );

    // Resolve the seeded Star Health payer id from the migration-203 master.
    const starRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM payers WHERE tenant_id = $1::uuid AND payer_code = 'STAR' LIMIT 1`,
      TENANT,
    );
    const starPayerId = starRows[0]?.id ?? null;

    const starPol = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, payer_id, policy_number, status, tenant_id)
       VALUES ($1::uuid, $2::int, $3, 'active', $4::uuid)
       RETURNING id`,
      PATIENT_UID, starPayerId, `STAR-SC-500K-${Date.now() % 100000}`, TENANT,
    );
    starPolicyId = starPol[0].id;

    const nakedPol = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policy_number, status, tenant_id)
       VALUES ($1::uuid, $2, 'active', $3::uuid)
       RETURNING id`,
      PATIENT_UID, `POL-NAKED-${Date.now() % 100000}`, TENANT,
    );
    nakedPolicyId = nakedPol[0].id;
  });

  afterAll(async () => {
    for (const id of createdClaimIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claim_correspondence WHERE claim_id = $1::int`, id).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claim_documents WHERE claim_id = $1::int`, id).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claims WHERE id = $1::int`, id).catch(() => {});
    }
    for (const id of [starPolicyId, nakedPolicyId]) {
      if (id) await prisma.$executeRawUnsafe(`DELETE FROM insurance_policies WHERE id = $1::int`, id).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 120_000);

  it('rejects recordClaimPayment when the settlement reference insurer mismatches the policy payer', async () => {
    // Star Health policy, but the settlement reference is an NIA NEFT ref —
    // the exact misroute from the finding.
    const claimId = await seedClaim({ policyId: starPolicyId, status: 'approved' });

    await expect(
      claims.recordClaimPayment({
        tenantId: TENANT, id: claimId, paid_amount: 63000,
        payment_reference: 'NIA-NEFT-CL-2627-00004-63000',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'CLAIM_INSURER_MISMATCH',
      details: expect.objectContaining({
        policy_payer: 'Star Health and Allied Insurance',
        detected_payer: 'New India Assurance Co Ltd',
      }),
    });

    // The claim must remain unsettled (status unchanged, no paid_amount).
    const after = await claims.getClaim({ tenantId: TENANT, id: claimId });
    expect(after.status).toBe('approved');
    expect(after.paid_amount == null || Number(after.paid_amount) === 0).toBe(true);
  });

  it('rejects recordClaimPayment when the claim tpa_reference_id (not the payment ref) carries the wrong insurer', async () => {
    // Settlement reference is a bare claim number, but the claim was stamped
    // with an NIA tpa_reference_id at submission — still a confident mismatch.
    const claimId = await seedClaim({
      policyId: starPolicyId, status: 'approved', tpaRef: 'NIA-FINAL-CL-2627-00004',
    });

    await expect(
      claims.recordClaimPayment({
        tenantId: TENANT, id: claimId, paid_amount: 63000,
        payment_reference: 'CL-2627-00004',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'CLAIM_INSURER_MISMATCH' });
  });

  it('allows recordClaimPayment when the settlement reference insurer matches the policy payer', async () => {
    const claimId = await seedClaim({ policyId: starPolicyId, status: 'approved' });

    const settled = await claims.recordClaimPayment({
      tenantId: TENANT, id: claimId, paid_amount: 80000,
      payment_reference: 'STAR-NEFT-CL-2627-00004-80000',
    });
    expect(settled.status).toBe('paid');
    expect(Number(settled.paid_amount)).toBe(80000);
  });

  it('does NOT block recordClaimPayment when the reference carries no recognised insurer token', async () => {
    const claimId = await seedClaim({ policyId: starPolicyId, status: 'approved' });

    // Bare claim-number reference + no tpa_reference_id → unreliable, never block.
    const settled = await claims.recordClaimPayment({
      tenantId: TENANT, id: claimId, paid_amount: 70000,
      payment_reference: 'CL-2627-00004',
    });
    expect(settled.status).toBe('settled_partial');
    expect(Number(settled.paid_amount)).toBe(70000);
  });

  it('does NOT block when the policy has no payer master row (nothing authoritative to compare)', async () => {
    // Even with an NIA settlement reference, a policy without a payer_id must
    // not be blocked — the guard stays permissive when the payer is unknown.
    const claimId = await seedClaim({ policyId: nakedPolicyId, status: 'approved' });

    const settled = await claims.recordClaimPayment({
      tenantId: TENANT, id: claimId, paid_amount: 80000,
      payment_reference: 'NIA-NEFT-CL-2627-00004-80000',
    });
    expect(settled.status).toBe('paid');
  });

  it('rejects recordClaimDecision when a structured insurer mismatches the policy payer', async () => {
    const claimId = await seedClaim({ policyId: starPolicyId, status: 'submitted' });

    await expect(
      claims.recordClaimDecision({
        tenantId: TENANT, id: claimId, decision: 'approved',
        approved_amount: 80000, insurer: 'New India Assurance',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'CLAIM_INSURER_MISMATCH' });
  });

  it('allows recordClaimDecision when the structured insurer matches (display-name variant)', async () => {
    const claimId = await seedClaim({ policyId: starPolicyId, status: 'submitted' });

    const decided = await claims.recordClaimDecision({
      tenantId: TENANT, id: claimId, decision: 'approved',
      approved_amount: 80000, insurer: 'Star Health',
    });
    expect(decided.status).toBe('approved');
    expect(Number(decided.approved_amount)).toBe(80000);
  });
});

// Regression test for findings
//   2026-05-22-tpa-insurance-claim-billing-28284746 (parent preauth)
//   2026-05-22-tpa-insurance-claim-billing-d961e4cf (enhancement preauth)
//
// `recordPreauthResponse` carried a payer-mismatch guard (PREAUTH_INSURER_MISMATCH)
// that compared `raw_response.insurer` against `pre.payer_name`. The guard
// was correct, but `getPreauth` did `SELECT * FROM insurance_preauth` without
// joining `insurance_policies` → `payers`, so `pre.payer_name` was always
// undefined and the guard silently short-circuited:
//
//   if (responseInsurer && pre.payer_name && !insurerMatchesPolicyPayer(...))
//                          ^^^^^^^^^^^^^^^ undefined → never throws
//
// Live repro from the swarm: a "New India Assurance" approval was accepted
// against a Star Health pre-auth and against an enhancement on a Star Health
// policy. Both endpoints hit the same code path (`recordPreauthResponse`),
// so a single fix (enrich `getPreauth` to surface `payer_name`) covers both.
//
// This test seeds policies against the migration-203 payer master so the
// guard has an authoritative policy payer to compare against, then drives
// `recordPreauthResponse` directly on parent and enhancement pre-auths.

import prisma from '../lib/prisma.js';
import * as claims from '../services/insurance/claimsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'f5555555-5555-5555-8555-eeeeeeee5e51';

const createdPreauthIds = [];
let starPolicyId;   // policy whose payer is Star Health
let nakedPolicyId;  // policy with NO payer_id (permissive case)

async function seedPreauth({
  policyId, status = 'submitted', requestType = 'planned',
  parentPreauthId = null, tpaRef = null,
}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO insurance_preauth
       (policy_id, patient_uid, preauth_number, request_type, parent_preauth_id,
        primary_diagnosis, expected_cost, status, tpa_reference_id, tenant_id)
     VALUES ($1::int, $2::uuid, $3, $4, $5::int,
             $6, $7::numeric, $8, $9, $10::uuid)
     RETURNING id`,
    Number(policyId), PATIENT_UID,
    `PA-MM-${Date.now() % 1_000_000}-${Math.floor(Math.random() * 1_000_000)}`,
    requestType, parentPreauthId == null ? null : Number(parentPreauthId),
    'Acute cholecystitis', 60000, status, tpaRef, TENANT,
  );
  const id = rows[0].id;
  createdPreauthIds.push(id);
  return id;
}

describe('TPA pre-auth response payer-mismatch guard (28284746 + d961e4cf)', () => {
  beforeAll(async () => {
    // Migration 753 routes recordPreauthResponse through
    // lockInsuranceFundingPatientTx → resolvePharmacyFundingPatientUidTx, which
    // serialises the pre-auth against the ONE active patient it names. The
    // pre-auth's patient_uid therefore has to be a real registered patient in
    // this tenant, not a bare uuid — seed it the way registration would.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'TPA Payer Mismatch Test Patient', 'PATIENT', true, 'active', $3::uuid, NOW())
       ON CONFLICT (uid) DO UPDATE
          SET is_active = true, status = 'active', is_deleted = false,
              merged_into_uid = NULL, updated_at = NOW()`,
      PATIENT_UID,
      `9887${Date.now() % 1000000}`.slice(0, 10),
      TENANT,
    );

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
      PATIENT_UID, starPayerId, `STAR-SC-PA-${Date.now() % 100000}`, TENANT,
    );
    starPolicyId = starPol[0].id;

    const nakedPol = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policy_number, status, tenant_id)
       VALUES ($1::uuid, $2, 'active', $3::uuid)
       RETURNING id`,
      PATIENT_UID, `POL-NAKED-PA-${Date.now() % 100000}`, TENANT,
    );
    nakedPolicyId = nakedPol[0].id;
  });

  afterAll(async () => {
    // Enhancements first so the parent's FK cascade isn't tripped.
    for (const id of createdPreauthIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM insurance_preauth_responses WHERE preauth_id = $1::int`, id).catch(() => {});
    }
    for (const id of [...createdPreauthIds].reverse()) {
      await prisma.$executeRawUnsafe(`DELETE FROM insurance_preauth WHERE id = $1::int`, id).catch(() => {});
    }
    for (const id of [starPolicyId, nakedPolicyId]) {
      if (id) await prisma.$executeRawUnsafe(`DELETE FROM insurance_policies WHERE id = $1::int`, id).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 120_000);

  it('rejects recordPreauthResponse on a parent pre-auth when raw_response.insurer mismatches policy payer (28284746)', async () => {
    const preauthId = await seedPreauth({ policyId: starPolicyId });

    await expect(
      claims.recordPreauthResponse({
        tenantId: TENANT, preauth_id: preauthId, response_type: 'partially_approved',
        sanctioned_amount: 50000,
        raw_response: { insurer: 'New India Assurance' },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'PREAUTH_INSURER_MISMATCH',
      details: expect.objectContaining({
        policy_payer: 'Star Health and Allied Insurance',
        response_insurer: 'New India Assurance',
      }),
    });

    // Pre-auth must remain in submitted state — no response row, no sanctioned amount.
    const after = await claims.getPreauth({ tenantId: TENANT, id: preauthId });
    expect(after.status).toBe('submitted');
    expect(after.sanctioned_amount == null || Number(after.sanctioned_amount) === 0).toBe(true);
    const respCount = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM insurance_preauth_responses WHERE preauth_id = $1::int`,
      preauthId,
    );
    expect(Number(respCount[0].n)).toBe(0);
  });

  it('rejects recordPreauthResponse on an ENHANCEMENT pre-auth when raw_response.insurer mismatches policy payer (d961e4cf)', async () => {
    const parentId = await seedPreauth({ policyId: starPolicyId, status: 'approved' });
    const enhancementId = await seedPreauth({
      policyId: starPolicyId, status: 'submitted',
      requestType: 'enhancement', parentPreauthId: parentId,
    });

    await expect(
      claims.recordPreauthResponse({
        tenantId: TENANT, preauth_id: enhancementId, response_type: 'partially_approved',
        sanctioned_amount: 30000,
        raw_response: { insurer: 'New India Assurance' },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'PREAUTH_INSURER_MISMATCH',
      details: expect.objectContaining({
        policy_payer: 'Star Health and Allied Insurance',
        response_insurer: 'New India Assurance',
      }),
    });

    // Enhancement must NOT be marked partially_approved; cumulative cap must not move.
    const after = await claims.getPreauth({ tenantId: TENANT, id: enhancementId });
    expect(after.status).toBe('submitted');
  });

  it('allows recordPreauthResponse when raw_response.insurer matches the policy payer (display-name variant)', async () => {
    const preauthId = await seedPreauth({ policyId: starPolicyId });

    const { response, preauth } = await claims.recordPreauthResponse({
      tenantId: TENANT, preauth_id: preauthId, response_type: 'approved',
      sanctioned_amount: 60000,
      raw_response: { insurer: 'Star Health' },   // display-name variant
    });
    expect(response).toBeTruthy();
    expect(preauth.status).toBe('approved');
    expect(Number(preauth.sanctioned_amount)).toBe(60000);
  });

  it('does NOT block when the policy has no payer_id (nothing authoritative to compare against)', async () => {
    const preauthId = await seedPreauth({ policyId: nakedPolicyId });

    const { response, preauth } = await claims.recordPreauthResponse({
      tenantId: TENANT, preauth_id: preauthId, response_type: 'partially_approved',
      sanctioned_amount: 40000,
      raw_response: { insurer: 'New India Assurance' },
    });
    expect(response).toBeTruthy();
    expect(preauth.status).toBe('partially_approved');
  });

  it('does NOT block when raw_response carries no insurer field (no signal to compare)', async () => {
    const preauthId = await seedPreauth({ policyId: starPolicyId });

    const { response, preauth } = await claims.recordPreauthResponse({
      tenantId: TENANT, preauth_id: preauthId, response_type: 'approved',
      sanctioned_amount: 50000,
      raw_response: { sanctioned: 50000 }, // no insurer field
    });
    expect(response).toBeTruthy();
    expect(preauth.status).toBe('approved');
  });

  it('getPreauth surfaces payer_name from the joined payer master so future consumers (not just the guard) see it', async () => {
    // Direct check of the join that this PR adds — protects against accidental
    // regression of the SELECT shape (e.g. dropping the join in a refactor).
    const preauthId = await seedPreauth({ policyId: starPolicyId });
    const pre = await claims.getPreauth({ tenantId: TENANT, id: preauthId });
    expect(pre.payer_name).toBe('Star Health and Allied Insurance');

    const nakedPreauthId = await seedPreauth({ policyId: nakedPolicyId });
    const preNaked = await claims.getPreauth({ tenantId: TENANT, id: nakedPreauthId });
    // Naked policy → LEFT JOIN returns NULL → field present but null/empty.
    expect(preNaked.payer_name == null || preNaked.payer_name === '').toBe(true);
  });
});

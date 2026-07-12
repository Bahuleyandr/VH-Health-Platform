// Deep test for Sol Ultra audit #1/#15: createClaim / createPreauth carried
// caller-supplied policy_id / admission_id / parent ids straight into the INSERT
// with no check that the referenced object belongs to the same tenant AND the
// same patient. A biller could bind a claim to another patient's policy
// (intra-tenant financial-integrity) or reference a foreign-tenant id.
import prisma from '../lib/prisma.js';
import * as claims from '../services/insurance/claimsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const A_UID = 'c1111111-1111-4111-8111-aaaaaaaa1a01';
const B_UID = 'c1111111-1111-4111-8111-bbbbbbbb1b01';

let policyA;
let policyB;

async function seedUser(uid) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2, 'Claim graph test', 'PATIENT', true, NOW())
     ON CONFLICT (uid) DO NOTHING`,
    uid, `90000${uid.slice(-5)}`.slice(0, 12));
}
async function seedPolicy(uid) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO insurance_policies (patient_uid, policy_number, status, tenant_id)
     VALUES ($1::uuid, $2, 'active', $3::uuid) RETURNING id`,
    uid, `POL-GRAPH-${uid.slice(-6)}-${Math.floor(Number(uid.slice(-3), 16))}`, TENANT);
  return rows[0].id;
}

beforeAll(async () => {
  await seedUser(A_UID); await seedUser(B_UID);
  policyA = await seedPolicy(A_UID);
  policyB = await seedPolicy(B_UID);
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM tpa_claims WHERE patient_uid IN ($1::uuid,$2::uuid)`, A_UID, B_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM insurance_preauth WHERE patient_uid IN ($1::uuid,$2::uuid)`, A_UID, B_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM insurance_policies WHERE id IN ($1::int,$2::int)`, policyA, policyB).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid)`, A_UID, B_UID).catch(() => {});
});

describe('insurance claim/preauth object-graph binding (Sol Ultra #1/#15)', () => {
  it('rejects a claim that references another patient\'s policy', async () => {
    await expect(claims.createClaim({
      tenantId: TENANT, policy_id: policyB, patient_uid: A_UID,
      claim_type: 'reimbursement', total_billed: 1000, claimed_amount: 1000,
    })).rejects.toMatchObject({ code: 'CLAIM_REFERENCE_PATIENT_MISMATCH' });
  });

  it('rejects a pre-auth that references another patient\'s policy', async () => {
    await expect(claims.createPreauth({
      tenantId: TENANT, policy_id: policyB, patient_uid: A_UID,
      primary_diagnosis: 'x', expected_cost: 1000,
    })).rejects.toMatchObject({ code: 'CLAIM_REFERENCE_PATIENT_MISMATCH' });
  });

  it('allows a claim that references the patient\'s own policy', async () => {
    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyA, patient_uid: A_UID,
      claim_type: 'reimbursement', total_billed: 1000, claimed_amount: 1000,
    });
    expect(claim.id).toBeDefined();
  });
});

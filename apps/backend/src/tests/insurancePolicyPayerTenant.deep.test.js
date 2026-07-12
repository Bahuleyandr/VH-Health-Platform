// Deep test for Sol Ultra audit #4: resolvePayerId/resolveTpaId returned a
// directly-supplied payer_id/tpa_id verbatim with no tenant check, so a policy
// could be bound to another tenant's payer/TPA master row. The direct id must
// now be verified to belong to the caller's tenant.
import prisma from '../lib/prisma.js';
import * as claims from '../services/insurance/claimsService.js';

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PATIENT = 'c4444444-4444-4444-8444-aaaaaaaa4a01';

let payerA;
let payerB;

beforeAll(async () => {
  // Self-sufficient second tenant: in full-suite order another suite seeds
  // it, but a scoped or reshuffled run must not depend on that.
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'payer-bind-b', 'Payer Bind B')
     ON CONFLICT (id) DO NOTHING`, TENANT_B);
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, '9000044401', 'Policy payer test', 'PATIENT', true, NOW())
     ON CONFLICT (uid) DO NOTHING`, PATIENT);
  const a = await prisma.$queryRawUnsafe(
    `INSERT INTO payers (tenant_id, payer_code, display_name) VALUES ($1::uuid, $2, 'Payer A') RETURNING id`,
    TENANT_A, `PYRA${Date.now() % 100000}`);
  payerA = a[0].id;
  const b = await prisma.$queryRawUnsafe(
    `INSERT INTO payers (tenant_id, payer_code, display_name) VALUES ($1::uuid, $2, 'Payer B') RETURNING id`,
    TENANT_B, `PYRB${Date.now() % 100000}`);
  payerB = b[0].id;
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM insurance_policies WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM payers WHERE id IN ($1::int,$2::int)`, payerA, payerB).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT).catch(() => {});
});

describe('insurance policy payer/TPA tenant binding (Sol Ultra #4)', () => {
  it('does not bind a policy to another tenant\'s payer', async () => {
    const policy = await claims.upsertPolicy({
      tenantId: TENANT_A, patient_uid: PATIENT, policy_number: `PN-${Date.now()}`, payer_id: payerB,
    });
    expect(policy.payer_id).not.toBe(payerB);
  });

  it('binds an in-tenant payer normally', async () => {
    const policy = await claims.upsertPolicy({
      tenantId: TENANT_A, patient_uid: PATIENT, policy_number: `PN2-${Date.now()}`, payer_id: payerA,
    });
    expect(policy.payer_id).toBe(payerA);
  });
});

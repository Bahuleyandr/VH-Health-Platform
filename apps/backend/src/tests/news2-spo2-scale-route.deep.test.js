import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import { withAuditBypass } from './helpers/auditBypass.js';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const TENANT = 'a4040000-0000-4000-8000-000000000001';
const PATIENT = 'a4040000-0000-4000-8000-000000000002';
const DOCTOR = 'a4040000-0000-4000-8000-000000000003';

async function cleanup() {
  await withAuditBypass(prisma, async (tx) => {
    await tx.$executeRawUnsafe(
      `DELETE FROM patient_access_audit_log WHERE tenant_id = $1::uuid`,
      TENANT,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM hipaa_access_log WHERE tenant_id = $1::uuid`,
      TENANT,
    );
  }).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    PATIENT,
    DOCTOR,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT).catch(() => {});
}

d('NEWS2 SpO2 scale route patient access', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, settings)
       VALUES ($1::uuid, 'news2-scale-route-test', 'NEWS2 Scale Route Test',
               '{"care_team_enforcement_mode":"off"}'::jsonb)`,
      TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES
         ($1::uuid, '8990400001', 'Scale Route Patient', 'PATIENT', true, 'active', $3::uuid, NOW()),
         ($2::uuid, '8990400002', 'Unrelated Scale Doctor', 'DOCTOR', true, 'active', $3::uuid, NOW())`,
      PATIENT,
      DOCTOR,
      TENANT,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('denies an unrelated clinician even when the tenant rollout mode is off', async () => {
    const response = await authClient('DOCTOR', {
      uid: DOCTOR,
      tenant_id: TENANT,
      tenantId: TENANT,
      deviceType: 'desktop',
    })
      .patch(`/api/v1/patients/${PATIENT}/news2-spo2-scale`)
      .set('Idempotency-Key', 'unrelated-scale-write')
      .send({ spo2_scale: 2 });

    expect(response.status).toBe(403);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT news2_spo2_scale FROM users WHERE uid = $1::uuid`,
      PATIENT,
    );
    expect(rows[0].news2_spo2_scale).toBe(1);
  });
});

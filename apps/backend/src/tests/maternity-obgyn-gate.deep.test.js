// Credential-hardening — OBGyn labour-ward credential gate, end-to-end.
// Proves the worked-example gate: labour-ward acts require the responsible
// obstetrician to hold an active obgyn_labour_ward_access privilege when the
// env flag is on, and are unaffected when it is off.

import prisma from '../lib/prisma.js';
import { admitToLabor, recordDelivery } from '../services/maternity/maternityService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

let pregnancyId;
let patientUid;
let credentialedUid;
let uncredentialedUid;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM maternity_deliveries
      WHERE pregnancy_id IN (SELECT id FROM maternity_pregnancies
        WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'OBGTEST Patient'))`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM maternity_labor_admissions
      WHERE pregnancy_id IN (SELECT id FROM maternity_pregnancies
        WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'OBGTEST Patient'))`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM maternity_pregnancies
      WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'OBGTEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM staff_credentials
      WHERE staff_uid IN (SELECT uid FROM users WHERE name IN ('OBGTEST OBGyn', 'OBGTEST Locum'))`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE name IN ('OBGTEST Patient', 'OBGTEST OBGyn', 'OBGTEST Locum')`,
  ).catch(() => {});
}

async function seedUser(name, role, phoneSuffix) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1, $2, $3, true, $4::uuid, NOW()) RETURNING uid`,
    `+9199${phoneSuffix}${String(Date.now() % 100000).padStart(5, '0')}`,
    name, role, DEFAULT_TENANT_ID,
  );
  return rows[0].uid;
}

d('OBGyn labour-ward credential gate (worked example)', () => {
  const original = process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED;

  beforeAll(async () => {
    await cleanup();
    patientUid = await seedUser('OBGTEST Patient', 'PATIENT', '30');
    credentialedUid = await seedUser('OBGTEST OBGyn', 'DOCTOR', '31');
    uncredentialedUid = await seedUser('OBGTEST Locum', 'DOCTOR', '32');

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO maternity_pregnancies (patient_uid, lmp_date, edd_date, status, tenant_id)
       VALUES ($1::uuid, CURRENT_DATE - 260, CURRENT_DATE + 20, 'ongoing', $2::uuid) RETURNING id`,
      patientUid, DEFAULT_TENANT_ID,
    );
    pregnancyId = p[0].id;

    // Grant the OBGyn credential to the credentialed obstetrician (active).
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff_credentials
         (tenant_id, staff_uid, credential_type, name, status, privilege_catalog_id, valid_until)
       SELECT $1::uuid, $2::uuid, 'privilege', 'obgyn_labour_ward_access', 'active', pc.id, CURRENT_DATE + 365
         FROM privilege_catalog pc
        WHERE pc.tenant_id = $1::uuid
          AND pc.privilege_key = 'obgyn_labour_ward_access'
          AND pc.status = 'active'`,
      DEFAULT_TENANT_ID, credentialedUid,
    );
  });

  afterAll(async () => {
    await cleanup();
    if (original === undefined) delete process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED;
    else process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED = original;
    await prisma.$disconnect();
  });

  test('flag OFF: any obstetrician may be admitted (role-based access unchanged)', async () => {
    delete process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED;
    const admit = await admitToLabor({
      tenantId: DEFAULT_TENANT_ID,
      pregnancy_id: pregnancyId,
      attending_obstetrician: uncredentialedUid,
      admission_reason: 'labour',
    });
    expect(admit.id).toBeDefined();
  });

  test('flag ON: uncredentialed obstetrician is blocked, credentialed one passes', async () => {
    process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED = 'true';
    await expect(admitToLabor({
      tenantId: DEFAULT_TENANT_ID,
      pregnancy_id: pregnancyId,
      attending_obstetrician: uncredentialedUid,
      admission_reason: 'labour',
    })).rejects.toMatchObject({ code: 'CLINICAL_PRIVILEGE_REQUIRED' });

    const admit = await admitToLabor({
      tenantId: DEFAULT_TENANT_ID,
      pregnancy_id: pregnancyId,
      attending_obstetrician: credentialedUid,
      admission_reason: 'labour',
    });
    expect(admit.id).toBeDefined();
  });

  test('flag ON: a responsible obstetrician must be named', async () => {
    process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED = 'true';
    await expect(admitToLabor({
      tenantId: DEFAULT_TENANT_ID,
      pregnancy_id: pregnancyId,
      admission_reason: 'labour',
    })).rejects.toMatchObject({ code: 'OBGYN_RESPONSIBLE_OBSTETRICIAN_REQUIRED' });
  });

  test('delivery gate: uncredentialed delivered_by is blocked when ON', async () => {
    process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED = 'true';
    await expect(recordDelivery({
      tenantId: DEFAULT_TENANT_ID,
      pregnancy_id: pregnancyId,
      delivery_datetime: new Date(Date.now() - 3600 * 1000).toISOString(),
      delivery_mode: 'nvd',
      delivered_by: uncredentialedUid,
    })).rejects.toMatchObject({ code: 'CLINICAL_PRIVILEGE_REQUIRED' });
  });
});

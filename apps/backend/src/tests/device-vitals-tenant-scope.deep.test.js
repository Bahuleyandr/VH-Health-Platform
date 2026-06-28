// Device vitals tenant scoping (CAN-045).
//
// ingestDeviceVitals no longer falls back to a hardcoded default tenant: it
// requires the caller's tenant and resolves the patient WITHIN that tenant, so
// a monitor feed for tenant A can't attach vitals to a tenant-B patient.
import prisma from '../lib/prisma.js';
import { ingestDeviceVitals } from '../services/emr/deviceVitalsService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_B = 'c0de0045-0000-4000-8000-00000000b001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000001'; // default ≠ B
const PATIENT_B = 'c0de0045-0000-4000-8000-0000000007b1';

const oru = (uid) => [
  'MSH|^~\\&|CAN045MON|ICU||VHHEALTH|20260610120000||ORU^R01|CAN045|P|2.5',
  `PID|1||${uid}||CAN045^Patient`,
  'OBR|1|||VITALS',
  'OBX|1|NM|8867-4^Heart rate||101|/min|||||F',
].join('\r');

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM lab_interface_messages WHERE raw_message LIKE '%CAN045MON%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM vitals_chart WHERE patient_uid = $1::uuid`, PATIENT_B).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_B).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_B).catch(() => {});
}

d('Device vitals tenant scoping (CAN-045)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(`INSERT INTO tenants (id, slug, name) VALUES ($1::uuid,'dv-can045-b','DV B') ON CONFLICT (id) DO NOTHING`, TENANT_B);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid,$2::uuid,'+919000045701','CAN045 Patient','PATIENT',true,NOW())`, PATIENT_B, TENANT_B);
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('refuses ingest with no tenant (no default fallback)', async () => {
    await expect(ingestDeviceVitals({ message: oru(PATIENT_B) }, {}))
      .rejects.toMatchObject({ code: 'DEVICE_VITALS_NO_TENANT' });
  });

  it('refuses a tenant-B patient ingested under another tenant', async () => {
    await expect(ingestDeviceVitals({ message: oru(PATIENT_B), tenantId: OTHER_TENANT }, {}))
      .rejects.toMatchObject({ code: 'DEVICE_VITALS_PATIENT_NOT_FOUND' });
  });
  // The same-tenant happy path is covered end-to-end by device-vitals.deep.test.js.
});

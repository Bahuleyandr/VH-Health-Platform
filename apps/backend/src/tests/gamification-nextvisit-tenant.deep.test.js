// Next-visit progress tenant scope (CAN-019).
//
// getNextVisitProgress(phone) queried appointments by phone with no tenant
// filter, and a phone is unique only per tenant (mig 333) — so a patient's
// dashboard "next visit" card could surface another tenant's appointment. It now
// takes a tenantId and scopes both appointment reads. RLS is OFF in the test env,
// so this explicit predicate is what scopes the result.
import { getNextVisitProgress } from '../services/gamification/pointService.js';
import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PHONE = '+919000119701';

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM appointments WHERE phone = $1`, PHONE).catch(() => {});
}

d('Next-visit progress tenant scope (CAN-019)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'can019-tenant-b', 'CAN-019 Tenant B') ON CONFLICT (id) DO NOTHING`,
      TENANT_B);
    await prisma.$executeRawUnsafe(
      `INSERT INTO appointments (phone, patient_name, appointment_date, appointment_time, status, tenant_id, updated_at)
       VALUES ($1, 'NextVisit Patient', CURRENT_DATE + INTERVAL '7 days', '10:00', 'SCHEDULED', $2::uuid, NOW())`,
      PHONE, TENANT_B);
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('does not surface a tenant-B appointment under tenant A', async () => {
    const result = await getNextVisitProgress(PHONE, TENANT_A);
    expect(result).not.toBeNull();
    expect(result.nextAppointment).toBeNull();
  });

  it('surfaces the appointment under its own tenant', async () => {
    const result = await getNextVisitProgress(PHONE, TENANT_B);
    expect(result.nextAppointment).not.toBeNull();
  });
});

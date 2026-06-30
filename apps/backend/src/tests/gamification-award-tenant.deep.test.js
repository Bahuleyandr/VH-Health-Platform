// Appointment-points award tenant scope (CAN-019).
//
// awardAppointmentPoints/awardOnTimeBonus resolved the rewarded user with
// `SELECT uid FROM users WHERE phone = $1` and no tenant filter. These hooks run
// from event/background contexts where the RLS AsyncLocalStorage isn't seeded,
// and a phone is unique only per tenant (mig 333) — so the lookup could resolve
// a user in the wrong tenant. The resolution is now scoped by the appointment's
// tenant_id: an award whose appointment names tenant A must not resolve a
// tenant-B phone holder.
import { awardAppointmentPoints } from '../services/gamification/pointService.js';
import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const HOLDER = 'c0de0019-00b0-4000-8000-0000000000b1';
const PHONE = '+919000019701';

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM health_point_ledger WHERE user_uid = $1::uuid`, HOLDER).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, HOLDER).catch(() => {});
}

d('Appointment-points award tenant scope (CAN-019)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'can019-tenant-b', 'CAN-019 Tenant B') ON CONFLICT (id) DO NOTHING`,
      TENANT_B);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid,$2::uuid,$3,'Gamify Holder','PATIENT',true,NOW())`, HOLDER, TENANT_B, PHONE);
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('an award whose appointment is in tenant A does not reward a tenant-B phone holder', async () => {
    const result = await awardAppointmentPoints({ phone: PHONE, tenant_id: TENANT_A, id: 'can019-cross' });
    expect(result).toBeNull(); // no user resolved in tenant A → no award
  });

  it('an award whose appointment is in tenant B rewards the holder', async () => {
    const result = await awardAppointmentPoints({ phone: PHONE, tenant_id: TENANT_B, id: 'can019-same' });
    expect(result).not.toBeNull();
  });
});

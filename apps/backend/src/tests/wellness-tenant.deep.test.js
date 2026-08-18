// Wellness-service tenant scope (CAN-019/012 completeness).
//
// wellnessService read the health_point_ledger / appointments / step_sessions /
// vitals by user_uid or phone with no tenant filter — the same patterns the
// pointService change scoped. They now thread an optional tenantId. RLS is OFF in
// the test env, so this proves getCheckInStreak (a representative DAILY_CHECKIN
// ledger read) is tenant-scoped.
import { getCheckInStreak, hasCheckedInToday } from '../services/gamification/wellnessService.js';
import prisma from '../lib/prisma.js';
import { istDateString } from '../utils/dateUtils.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER = 'c0de0a19-00b0-4000-8000-0000000000b1';
// P7: check-in day keys are the IST (Asia/Kolkata) calendar day.
const TODAY = istDateString();

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM health_point_ledger WHERE user_uid = $1::uuid`, USER).catch(() => {});
}

d('Wellness-service tenant scope (CAN-019/012)', () => {
  beforeAll(async () => {
    await clean();
    // Fresh CI DBs don't have the non-default tenant; create it idempotently.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'can019-012-wellness-tenant-b', 'CAN-019/012 Wellness Tenant B') ON CONFLICT (id) DO NOTHING`,
      TENANT_B);
    // A DAILY_CHECKIN entry for today, in tenant B.
    await prisma.$executeRawUnsafe(
      `INSERT INTO health_point_ledger (user_uid, points, activity_type, activity_ref_id, description, earned_at, tenant_id)
       VALUES ($1::uuid, 10, 'DAILY_CHECKIN', $2, 'seed', NOW(), $3::uuid)`,
      USER, TODAY, TENANT_B);
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('getCheckInStreak / hasCheckedInToday under the wrong tenant see nothing', async () => {
    expect(await getCheckInStreak(USER, TENANT_A)).toBe(0);
    expect(await hasCheckedInToday(USER, TENANT_A)).toBe(false);
  });

  it('under the user\'s own tenant they see the check-in', async () => {
    expect(await getCheckInStreak(USER, TENANT_B)).toBeGreaterThanOrEqual(1);
    expect(await hasCheckedInToday(USER, TENANT_B)).toBe(true);
  });
});

// Step-reward attestation (CAN-012).
//
// awardStepPoints summed ALL of a day's step_sessions, so a user-typed /
// self-declared step entry could farm the STEP_DAILY_GOAL reward. Reward
// eligibility is now an explicit fail-safe column (step_sessions.reward_eligible,
// migration 348, DEFAULT false): only rows attested by a trusted device path
// (in-app pedometer /steps/session/start, health-platform /steps/health-sync)
// count toward the reward. A naive source<>'manual' filter was wrong — the
// in-app pedometer legitimately uses source='manual' — so this is orthogonal to
// source. RLS is OFF in the test env (the tenantId arg drives the tenant scope).
import { awardStepPoints } from '../services/gamification/pointService.js';
import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const DEVICE_USER = 'c0de0a48-00a0-4000-8000-0000000000a1'; // attested in-app pedometer
const TYPED_USER = 'c0de0a48-00b0-4000-8000-0000000000b1';  // future self-declared entry
const MIXED_USER = 'c0de0a48-00c0-4000-8000-0000000000c1';  // both kinds in one day
const TODAY = new Date().toISOString().split('T')[0];
const STARTED_AT = `${TODAY} 12:00:00`; // noon-UTC today → in awardStepPoints' day window
const USERS = [DEVICE_USER, TYPED_USER, MIXED_USER];

async function clean() {
  for (const u of USERS) {
    await prisma.$executeRawUnsafe(`DELETE FROM health_point_ledger WHERE user_uid = $1::uuid`, u).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM step_sessions WHERE user_uid = $1::uuid`, u).catch(() => {});
  }
}

// rewardEligible mirrors what the real writers stamp: device paths → true,
// a (future) user-typed entry → false (the fail-safe default).
async function seedSession(userUid, steps, rewardEligible) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO step_sessions (user_uid, started_at, steps, is_active, source, reward_eligible, tenant_id)
     VALUES ($1::uuid, $2::timestamp, $3::int, false, 'manual', $4::boolean, $5::uuid)`,
    userUid, STARTED_AT, steps, rewardEligible, TENANT_B);
}

d('Step-reward attestation (CAN-012)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'can012-tenant-b', 'CAN-012 Tenant B') ON CONFLICT (id) DO NOTHING`,
      TENANT_B);
    await seedSession(DEVICE_USER, 12000, true);  // device-measured, over goal
    await seedSession(TYPED_USER, 12000, false);  // self-declared, over goal
    await seedSession(MIXED_USER, 5000, true);    // attested but under goal
    await seedSession(MIXED_USER, 10000, false);  // self-declared padding (must NOT count)
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('a device-attested session over goal EARNS', async () => {
    const result = await awardStepPoints(DEVICE_USER, 8000, TENANT_B);
    expect(result).not.toBeNull();
  });

  it('a self-declared (non-attested) session over goal does NOT earn', async () => {
    const result = await awardStepPoints(TYPED_USER, 8000, TENANT_B);
    expect(result).toBeNull();
  });

  it('self-declared steps cannot pad an attested total to reach the goal', async () => {
    // 5000 attested + 10000 self-declared; only the 5000 counts → under 8000 goal.
    const result = await awardStepPoints(MIXED_USER, 8000, TENANT_B);
    expect(result).toBeNull();
  });
});

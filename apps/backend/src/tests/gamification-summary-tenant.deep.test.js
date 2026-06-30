// Health-point summary + step-reward tenant scope (CAN-012).
//
// (1) getUserPointSummary read the health_point_ledger / claims by user_uid with
//     no tenant filter. It now scopes by tenant when resolvable, so a summary
//     computed under the wrong tenant sees zero points.
// (2) awardStepPoints now scopes its step_sessions sum by tenant, so step rows
//     in another tenant don't count toward the reward.
// RLS is OFF in the test env, so the explicit predicates are what scope these.
import { getUserPointSummary, awardStepPoints } from '../services/gamification/pointService.js';
import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const LEDGER_USER = 'c0de0a12-00b0-4000-8000-0000000000b1';
const STEP_USER = 'c0de0a12-00c0-4000-8000-0000000000c1';
const TODAY = new Date().toISOString().split('T')[0];

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM health_point_ledger WHERE user_uid IN ($1::uuid,$2::uuid)`, LEDGER_USER, STEP_USER).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM step_sessions WHERE user_uid = $1::uuid`, STEP_USER).catch(() => {});
}

d('Health-point summary tenant scope + step attestation (CAN-012)', () => {
  beforeAll(async () => {
    await clean();
    // TENANT_B is a non-default tenant; ensure it exists so the FK-bearing
    // ledger/step rows below can reference it on a fresh CI DB.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'can012-tenant-b', 'CAN-012 Tenant B') ON CONFLICT (id) DO NOTHING`,
      TENANT_B);
    // Ledger rows for LEDGER_USER all live in tenant B.
    await prisma.$executeRawUnsafe(
      `INSERT INTO health_point_ledger (user_uid, points, activity_type, activity_ref_id, description, tenant_id)
       VALUES ($1::uuid, 50, 'TEST_A', 'r1', 'seed', $2::uuid),
              ($1::uuid, 30, 'TEST_B', 'r2', 'seed', $2::uuid)`,
      LEDGER_USER, TENANT_B);
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('getUserPointSummary under the wrong tenant sees zero points', async () => {
    const summaryA = await getUserPointSummary(LEDGER_USER, TENANT_A);
    expect(summaryA.totalPoints).toBe(0);
    const summaryB = await getUserPointSummary(LEDGER_USER, TENANT_B);
    expect(summaryB.totalPoints).toBe(80);
  });

  it('awardStepPoints scopes the step sum by tenant', async () => {
    // started_at is a tz-naive timestamp; awardStepPoints matches on
    // DATE(started_at AT TIME ZONE 'UTC') = <JS-UTC-today>, so seed noon-UTC on
    // today's date to land in-window regardless of the server timezone.
    const startedAt = `${TODAY} 12:00:00`;

    // A goal-meeting session in tenant B (in-app pedometer rows are source='manual').
    await prisma.$executeRawUnsafe(
      `INSERT INTO step_sessions (user_uid, started_at, steps, is_active, source, reward_eligible, tenant_id)
       VALUES ($1::uuid, $3::timestamp, 12000, false, 'manual', true, $2::uuid)`, STEP_USER, TENANT_B, startedAt);

    // Scored under tenant A → the tenant-B session is excluded → no award.
    const crossTenant = await awardStepPoints(STEP_USER, 8000, TENANT_A);
    expect(crossTenant).toBeNull();

    // Scored under its own tenant → the session counts → award.
    const sameTenant = await awardStepPoints(STEP_USER, 8000, TENANT_B);
    expect(sameTenant).not.toBeNull();
  });
});

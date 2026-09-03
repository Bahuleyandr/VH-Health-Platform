// The live tenant-RLS posture probe must report what its field names say.
//
// `restrictiveForcedTables` feeds the boot log line that tells an operator how
// many FORCE-RLS tables reject unscoped writes (see preAuthTenantContextMiddleware
// for why that matters). Counting pg_policies ROWS overstates it: a table that
// carries two RESTRICTIVE policies (billing_credit_notes and
// clinical_continuity_replay_receipts do, from their migrations) is counted
// twice. The number is only consumed as `> 0` and in that log line, so nothing
// behaves differently, but a field named "tables" must count tables.
//
// Skipped when no DATABASE_URL/TEST_DATABASE_URL is configured, like the other
// *.deep.test.js suites.

import prisma, { tenantRlsRolePosture } from '../lib/prisma.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

d('tenant RLS posture probe', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('restrictiveForcedTables counts distinct FORCE-RLS tables with a RESTRICTIVE policy, not policy rows', async () => {
    const [{ policy_rows: policyRows, tables }] = await prisma.$queryRawUnsafe(`
      SELECT count(*)::int AS policy_rows, count(DISTINCT c.oid)::int AS tables
        FROM pg_policies p
        JOIN pg_class c     ON c.relname = p.tablename
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = p.schemaname
       WHERE p.schemaname = 'public'
         AND p.permissive = 'RESTRICTIVE'
         AND c.relforcerowsecurity`);

    const posture = await tenantRlsRolePosture();

    expect(posture.error).toBeUndefined();
    // The schema itself makes the distinction observable: at least one table
    // carries more than one RESTRICTIVE policy, so rows and tables differ.
    expect(tables).toBeGreaterThan(0);
    expect(policyRows).toBeGreaterThan(tables);
    expect(posture.restrictiveForcedTables).toBe(tables);
  }, 30_000);
});

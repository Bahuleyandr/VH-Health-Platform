// FU1 — deep (enforced-RLS) regression for global workflow SLA rule visibility.
//
// ROOT CAUSE this test now guards:
//   The seeded `critical_result_ack` SLA rule is a GLOBAL rule
//   (workflow_sla_rules.tenant_id IS NULL). The generic tenant_isolation policy
//   used to hide that row once app.current_tenant_id was pinned, so any
//   startWorkflowSla call inside setTenantTx(tenantId) could silently find no
//   rule. Migration 352 makes global defaults visible under a concrete tenant
//   GUC while tenant-specific override rows remain tenant-scoped.
//
// This test exercises the ENFORCED-RLS behaviour end-to-end against the real DB,
// reusing the non-owner rls_test_app harness from tenant-rls.deep.test.js:
//
//   * as rls_test_app WITH a concrete-tenant GUC  -> global rule visible
//   * as rls_test_app WITHOUT the GUC             -> the rule is visible
//   * owner / GUC-unset                           -> visible
//
// Why a non-owner role: Postgres exempts table OWNERS from RLS UNLESS the table
// is FORCE-RLS. workflow_sla_rules IS force-RLS, so even the owner is subject to
// the policy; we still pipe through the dedicated rls_test_app role to mirror
// production (the app connects as a non-owner, non-BYPASSRLS role) and to match
// the existing deep-RLS harness exactly.

import prisma from '../lib/prisma.js';

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const describeIfDb = hasDatabaseUrl ? describe : describe.skip;

const RULE_CODE = 'critical_result_ack';
const TENANT_A = '00000000-0000-4000-8000-000000000001'; // DEFAULT_TENANT_ID
const APP_ROLE = 'rls_test_app';

// Owner-path helper (mirrors tenant-rls.deep.test.js). The owner read runs with
// the GUC unset, so the tenant_isolation policy is permissive and the global
// NULL-tenant rule is visible — the same condition the producer's singleton
// read relies on.
async function ownerQuery(text, params = []) {
  if (/^\s*(SELECT|WITH)\b/i.test(text) || /\bRETURNING\b/i.test(text)) {
    const rows = await prisma.$queryRawUnsafe(text, ...params);
    const arr = Array.isArray(rows) ? rows : [];
    return { rows: arr, rowCount: arr.length };
  }
  const rowCount = await prisma.$executeRawUnsafe(text, ...params);
  return { rows: [], rowCount: Number(rowCount) || 0 };
}

// Run a query as the non-owner APP_ROLE with a concrete-tenant GUC, scoped to a
// single transaction (SET LOCAL ROLE + set_config(..., true) auto-clear at
// COMMIT). Mirrors asAppRole in tenant-rls.deep.test.js.
async function asAppRole(text, params, tenantId) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      tenantId,
    );
    const rows = await tx.$queryRawUnsafe(text, ...params);
    return Array.isArray(rows) ? rows : [];
  });
}

// Same role, GUC unset — the permissive path.
async function asAppRoleNoGuc(text, params) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
    const rows = await tx.$queryRawUnsafe(text, ...params);
    return Array.isArray(rows) ? rows : [];
  });
}

describeIfDb('Results-inbox SLA rule RLS (FU1 — global critical_result_ack visible under tenant GUC)', () => {
  let rlsForced = false;
  let globalRulePresent = false;

  beforeAll(async () => {
    // Create the non-owner application role + grant the minimum needed to read
    // the table. Idempotent (mirrors tenant-rls.deep.test.js).
    await ownerQuery(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} NOLOGIN;
        END IF;
      END $$;
    `);
    await ownerQuery(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await ownerQuery(`GRANT SELECT ON workflow_sla_rules TO ${APP_ROLE}`);

    // Precondition probes — the root-cause demo is only valid if the table is
    // force-RLS and the global rule actually exists.
    const forced = await ownerQuery(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'workflow_sla_rules'`,
    );
    rlsForced = forced.rows[0]?.relforcerowsecurity === true;

    const rule = await ownerQuery(
      `SELECT id, tenant_id FROM workflow_sla_rules WHERE rule_code = $1 AND tenant_id IS NULL`,
      [RULE_CODE],
    );
    globalRulePresent = rule.rowCount >= 1;
  });

  it('precondition: workflow_sla_rules is force-RLS and the global critical_result_ack rule exists', () => {
    // If either precondition fails, the hiding demo below is meaningless — fail
    // loudly rather than asserting a vacuous truth.
    expect(rlsForced).toBe(true);
    expect(globalRulePresent).toBe(true);
  });

  it('shows the global rule to a non-owner role when a concrete-tenant GUC is set', async () => {
    const rows = await asAppRole(
      `SELECT id, tenant_id FROM workflow_sla_rules WHERE rule_code = $1`,
      [RULE_CODE],
      TENANT_A,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.tenant_id == null)).toBe(true);
  });

  it('shows the global rule to the same role when the GUC is unset (permissive)', async () => {
    const rows = await asAppRoleNoGuc(
      `SELECT id, tenant_id FROM workflow_sla_rules WHERE rule_code = $1`,
      [RULE_CODE],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // It is genuinely the GLOBAL (NULL-tenant) row.
    expect(rows.some((r) => r.tenant_id == null)).toBe(true);
  });

  it('shows the global rule on the plain singleton / GUC-unset path too', async () => {
    const result = await ownerQuery(
      `SELECT id, tenant_id FROM workflow_sla_rules WHERE rule_code = $1`,
      [RULE_CODE],
    );
    expect(result.rowCount).toBeGreaterThanOrEqual(1);
    expect(result.rows.some((r) => r.tenant_id == null)).toBe(true);
  });

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });
});

if (!hasDatabaseUrl) {
  console.warn(
    'resultsInboxSlaRuleRls.deep.test.js skipped: neither DATABASE_URL nor TEST_DATABASE_URL is set.',
  );
}

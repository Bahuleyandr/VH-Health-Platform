// Tenant-RLS posture + fail-closed behaviour pin for audit_logs (migration 335).
//
// Migration 335_audit_activity_logs_tenant_rls.sql installed Pattern-A tenant
// isolation (tenant_id + GUC-reading DEFAULT + FK + ENABLE/FORCE RLS + the
// canonical tenant_isolation policy) on NINE audit/activity-log tables via a
// dynamic `EXECUTE format(... %I ...)` loop. Because the DDL is dynamic, a
// literal `git grep 'audit_logs' | grep 'ROW LEVEL SECURITY|POLICY|FORCE'`
// finds NOTHING for these tables — which misled a 2026-07-30 security review
// into concluding audit_logs had no RLS at all. This suite turns the posture
// into a CI-enforced fact so the invariant is provable without reading
// dynamic SQL (and so a future table rebuild that silently drops the policy
// fails loudly).
//
// Scope split with sibling suites:
//   * audit-append-only.deep.test.js pins the migration-324 append-only guard
//     (trigger presence on the audit family + UPDATE/DELETE blocked, proven on
//     clinical_audit_events).
//   * tenant-rls-w2-schema.deep.test.js proves W2 Pattern-A behaviour on a
//     representative non-audit table (departments).
//   * THIS suite pins ENABLE/FORCE + policy shape for all nine migration-335
//     tables, and proves the cross-tenant fail-closed negatives with direct
//     SQL on audit_logs itself — the table the clinical-continuity action
//     registry (C4.2) will write policy-decision metadata to.
//
// Deliberate semantics being pinned (do NOT "fix" these without an owner
// decision — see migration 304's header: the unset/''/'bypass' branches are
// the house Pattern A, relied on by migrations' own provenance INSERTs,
// system/cron paths, and SUPER_ADMIN cross-tenant audit reads):
//   * GUC unset  -> permissive (legacy/system paths keep working).
//   * GUC 'bypass' -> permissive (audited SUPER_ADMIN cross-tenant path).
//   * GUC = tenant uuid -> strict: reads see only that tenant, writes must
//     land in that tenant (WITH CHECK), cross-tenant rows are invisible to
//     UPDATE/DELETE.
//
// Why SET LOCAL ROLE: the test connection is a superuser (or qa_writer);
// Postgres exempts superusers/BYPASSRLS from policies, so we switch to the
// sealed NOSUPERUSER NOBYPASSRLS role inside each transaction — the same
// posture the prod app role has (mirrors audit-append-only.deep.test.js).
//
// Requires a reachable Postgres (DATABASE_URL). Skipped if none configured.

import prisma from '../lib/prisma.js';

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const APP_ROLE = process.env.AUDIT_APPEND_ONLY_TEST_ROLE || 'rls_test_app';

// The full migration-335 table set.
const M335_TABLES = [
  'admin_activity_logs', 'audit_log', 'audit_logs', 'file_access_logs',
  'file_metadata', 'hr_activity_logs', 'medical_activity_logs',
  'notification_outbox', 'pharmacy_activity_logs',
];

const TENANT_A = 'a1a1a335-0000-4000-8000-0000000000aa';
const TENANT_B = 'b1b1b335-0000-4000-8000-0000000000bb';

// Tag rows so cleanup is surgical and never touches sibling-suite audit rows.
const MARK = `AUDITRLS-${process.pid}-${Date.now()}`;

let seededIds = { a: null, b: null };

async function appRoleAvailable() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
    APP_ROLE,
  );
  return rows.length > 0 && rows[0].rolsuper === false && rows[0].rolbypassrls === false;
}

// Run `fn(tx)` inside a transaction as the sealed app role with the tenant
// GUC set (or unset/'bypass' when tenantId is null/'bypass') — the direct-SQL
// equivalent of what setTenant() + the runtime role do in prod.
function asAppRole(tenantId, fn) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
    if (tenantId !== null) {
      await tx.$queryRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1, true)`, tenantId,
      );
    }
    return fn(tx);
  });
}

async function cleanup() {
  // audit_logs is append-only (migration 324); use the documented
  // transaction-local maintenance bypass so cleanup also works when the
  // connection is not a superuser (e.g. qa_writer on the shared QA cluster).
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.audit_bypass', 'on', true)`);
    await tx.$executeRawUnsafe(`DELETE FROM audit_logs WHERE action LIKE 'AUDITRLS-%'`);
  }).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, TENANT_A, TENANT_B,
  ).catch(() => {});
}

d('audit_logs tenant RLS posture + fail-closed behaviour (migration 335)', () => {
  let roleOk = false;

  beforeAll(async () => {
    roleOk = await appRoleAvailable();
    await cleanup();

    for (const [id, slug, name] of [
      [TENANT_A, `auditrls-a-${process.pid}`, 'AuditRLS Tenant A'],
      [TENANT_B, `auditrls-b-${process.pid}`, 'AuditRLS Tenant B'],
    ]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        id, slug, name,
      );
    }

    // One audit row per tenant, inserted as the connecting role with the GUC
    // unset: the permissive branch honours the explicit tenant_id.
    const seed = async (tenant) => (await prisma.$queryRawUnsafe(
      `INSERT INTO audit_logs (action, resource, resource_id, tenant_id)
       VALUES ($1, 'auditrls_test', $2, $3::uuid) RETURNING id`,
      `${MARK}.seed`, MARK, tenant,
    ))[0].id;
    seededIds = { a: await seed(TENANT_A), b: await seed(TENANT_B) };
  }, 30000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  }, 30000);

  // -------------------------------------------------------------------------
  // PART 1 — catalog posture (no sealed role needed).
  // -------------------------------------------------------------------------
  describe('catalog posture of the nine migration-335 tables', () => {
    test('audit_logs exists and every existing m335 table has ENABLE + FORCE RLS', async () => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
            AND c.relname = ANY($1::text[])`,
        M335_TABLES,
      );
      const byName = new Map(rows.map((r) => [r.table_name, r]));
      // The core table of this suite must exist — absence would silently
      // hollow out the pin.
      expect(byName.has('audit_logs')).toBe(true);
      for (const [name, r] of byName) {
        expect({ table: name, rls: r.rls }).toEqual({ table: name, rls: true });
        expect({ table: name, forced: r.forced }).toEqual({ table: name, forced: true });
      }
    });

    test('every existing m335 table carries the canonical tenant_isolation policy', async () => {
      const policies = await prisma.$queryRawUnsafe(
        `SELECT tablename, policyname, permissive, cmd, qual, with_check
           FROM pg_policies
          WHERE schemaname = 'public' AND tablename = ANY($1::text[])
            AND policyname = 'tenant_isolation'`,
        M335_TABLES,
      );
      const existing = await prisma.$queryRawUnsafe(
        `SELECT c.relname AS table_name
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
            AND c.relname = ANY($1::text[])`,
        M335_TABLES,
      );
      const policyByTable = new Map(policies.map((p) => [p.tablename, p]));
      for (const { table_name: name } of existing) {
        const p = policyByTable.get(name);
        expect({ table: name, hasPolicy: Boolean(p) }).toEqual({ table: name, hasPolicy: true });
        expect(p.permissive).toBe('PERMISSIVE');
        expect(p.cmd).toBe('ALL');
        // Canonical Pattern-A branches, on both read and write sides.
        for (const expr of [p.qual, p.with_check]) {
          expect(expr).toContain(`current_setting('app.current_tenant_id'`);
          expect(expr).toContain(`'bypass'`);
          expect(expr).toContain('app_current_tenant_id_uuid()');
        }
      }
    });

    test('audit_logs.tenant_id is NOT NULL with the GUC-reading default and the tenants FK', async () => {
      const [col] = await prisma.$queryRawUnsafe(
        `SELECT is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'audit_logs'
            AND column_name = 'tenant_id'`,
      );
      expect(col).toBeTruthy();
      expect(col.is_nullable).toBe('NO');
      expect(col.column_default).toContain('COALESCE');
      expect(col.column_default).toContain(`current_setting('app.current_tenant_id'`);
      expect(col.column_default).toContain(`'bypass'`);

      const fk = await prisma.$queryRawUnsafe(
        `SELECT confrelid::regclass::text AS ref
           FROM pg_constraint
          WHERE conname = 'fk_audit_logs_tenant'
            AND conrelid = 'public.audit_logs'::regclass AND contype = 'f'`,
      );
      expect(fk).toHaveLength(1);
      expect(fk[0].ref).toBe('tenants');
    });
  });

  // -------------------------------------------------------------------------
  // PART 2 — direct-SQL fail-closed behaviour as the sealed app role.
  // -------------------------------------------------------------------------
  describe('cross-tenant negatives on audit_logs (sealed non-owner role)', () => {
    test('tenant-A context sees ONLY tenant-A rows; tenant-B symmetric', async () => {
      if (!roleOk) { console.warn(`Skipping: app role ${APP_ROLE} unavailable`); return; }
      const seen = (tenant) => asAppRole(tenant, (tx) => tx.$queryRawUnsafe(
        `SELECT tenant_id::text AS tenant_id FROM audit_logs
          WHERE action = $1 ORDER BY id`, `${MARK}.seed`,
      ));
      const a = await seen(TENANT_A);
      expect(a).toHaveLength(1);
      expect(a[0].tenant_id).toBe(TENANT_A);
      const b = await seen(TENANT_B);
      expect(b).toHaveLength(1);
      expect(b[0].tenant_id).toBe(TENANT_B);
    });

    test('INSERT with an explicit FOREIGN tenant_id is rejected by WITH CHECK', async () => {
      if (!roleOk) { console.warn(`Skipping: ${APP_ROLE} unavailable`); return; }
      await expect(
        asAppRole(TENANT_A, (tx) => tx.$executeRawUnsafe(
          `INSERT INTO audit_logs (action, resource, resource_id, tenant_id)
           VALUES ($1, 'auditrls_test', $2, $3::uuid)`,
          `${MARK}.xtenant`, MARK, TENANT_B,
        )),
      ).rejects.toThrow(/row-level security/i);
    });

    test('INSERT without tenant_id lands in the ACTIVE tenant via the GUC-reading default', async () => {
      if (!roleOk) { console.warn(`Skipping: ${APP_ROLE} unavailable`); return; }
      // This is the exact guarantee tenant-blind writers (utils/logAudit.js
      // today, the C4.2 continuity action registry tomorrow) rely on: they
      // never set tenant_id; the column default stamps the active tenant.
      const rows = await asAppRole(TENANT_A, (tx) => tx.$queryRawUnsafe(
        `INSERT INTO audit_logs (action, resource, resource_id)
         VALUES ($1, 'auditrls_test', $2) RETURNING tenant_id::text AS tenant_id`,
        `${MARK}.defaulted`, MARK,
      ));
      expect(rows[0].tenant_id).toBe(TENANT_A);
    });

    test('UPDATE / DELETE aimed at a FOREIGN tenant row match ZERO rows (invisible under USING)', async () => {
      if (!roleOk) { console.warn(`Skipping: ${APP_ROLE} unavailable`); return; }
      // The append-only trigger never even fires: RLS filters the target row
      // out first, so cross-tenant tampering is a no-op, not an exception.
      const updated = await asAppRole(TENANT_A, (tx) => tx.$executeRawUnsafe(
        `UPDATE audit_logs SET resource = 'tampered' WHERE id = $1`, seededIds.b,
      ));
      expect(updated).toBe(0);
      const deleted = await asAppRole(TENANT_A, (tx) => tx.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE id = $1`, seededIds.b,
      ));
      expect(deleted).toBe(0);
      const still = await prisma.$queryRawUnsafe(
        `SELECT resource FROM audit_logs WHERE id = $1`, seededIds.b,
      );
      expect(still).toHaveLength(1);
      expect(still[0].resource).toBe('auditrls_test');
    });

    test('same-tenant UPDATE on audit_logs is blocked by the append-only guard (migration 324)', async () => {
      if (!roleOk) { console.warn(`Skipping: ${APP_ROLE} unavailable`); return; }
      // Visible row (same tenant) -> RLS passes -> the 324 trigger fires.
      await expect(
        asAppRole(TENANT_A, (tx) => tx.$executeRawUnsafe(
          `UPDATE audit_logs SET resource = 'tampered' WHERE id = $1`, seededIds.a,
        )),
      ).rejects.toThrow(/append-only/i);
    });

    test(`GUC 'bypass' (audited SUPER_ADMIN path) sees BOTH tenants`, async () => {
      if (!roleOk) { console.warn(`Skipping: ${APP_ROLE} unavailable`); return; }
      const rows = await asAppRole('bypass', (tx) => tx.$queryRawUnsafe(
        `SELECT DISTINCT tenant_id::text AS tenant_id FROM audit_logs WHERE action = $1`,
        `${MARK}.seed`,
      ));
      expect(rows.map((r) => r.tenant_id).sort()).toEqual([TENANT_A, TENANT_B]);
    });

    test('unset GUC stays permissive (deliberate Pattern A — migrations/system paths)', async () => {
      if (!roleOk) { console.warn(`Skipping: ${APP_ROLE} unavailable`); return; }
      // Pinned on purpose: migrations' provenance INSERTs and untenanted
      // system paths run with the GUC unset and MUST keep working. Tightening
      // this branch is an owner decision (see migration 304's header), not a
      // drive-by "fix".
      const rows = await asAppRole(null, (tx) => tx.$queryRawUnsafe(
        `SELECT DISTINCT tenant_id::text AS tenant_id FROM audit_logs WHERE action = $1`,
        `${MARK}.seed`,
      ));
      expect(rows.map((r) => r.tenant_id).sort()).toEqual([TENANT_A, TENANT_B]);
    });
  });
});

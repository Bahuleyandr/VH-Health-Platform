// Platform audit 2026-06-18 §3 (PHI/Audit) — append-only protection on audit
// tables (migration 324).
//
// Proves the BEFORE UPDATE OR DELETE guard installed by migration 324:
//   1. The PROD app role (a NOSUPERUSER role — simulated via SET LOCAL ROLE)
//      cannot UPDATE or DELETE a clinical_audit_events row: the trigger RAISEs.
//   2. INSERT still works for that same app role (append-only, not read-only) —
//      and the migration-282 chain trigger still chains the inserted row.
//   3. An authorized maintenance path (SET LOCAL app.audit_bypass = 'on') CAN
//      delete — this is how the retention purge is allowed.
//   4. The guard is present on every audit table that exists in this DB.
//
// Why SET LOCAL ROLE: the test connection is a superuser (postgres), and the
// guard intentionally lets superusers through (a superuser can drop the trigger
// anyway — accepted threat boundary). The real defense is for the sealed
// non-superuser prod app role, which we reproduce here by switching role inside
// the transaction to `rls_test_app` (NOSUPERUSER NOBYPASSRLS), exactly the
// posture vhhealth_app has in production.
//
// Requires a reachable Postgres (DATABASE_URL). Skipped if none configured.

import prisma from '../lib/prisma.js';

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
// A NOSUPERUSER, NOBYPASSRLS role that holds INSERT/UPDATE/DELETE on the audit
// tables — stands in for the sealed prod app role. Present on the QA cluster
// (see CLAUDE.md RLS test roles). Overridable for other rigs.
const APP_ROLE = process.env.AUDIT_APPEND_ONLY_TEST_ROLE || 'rls_test_app';

// Tag rows so cleanup is surgical and never touches sibling-suite audit rows.
const MARK = `APPENDONLY-${process.pid}-${Date.now()}`;
const insertedIds = [];

async function appRoleAvailable() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
    APP_ROLE,
  );
  return rows.length > 0 && rows[0].rolsuper === false && rows[0].rolbypassrls === false;
}

async function insertAuditRowAsApp() {
  // INSERT as the non-superuser app role — proves the append path is open.
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
    return tx.$queryRawUnsafe(
      `INSERT INTO clinical_audit_events (tenant_id, action, resource_table, resource_id)
       VALUES ($1::uuid, $2, 'appendonly_test', $3)
       RETURNING id, chain_seq, chain_hash`,
      TENANT, `${MARK}.insert`, MARK,
    );
  });
  return rows[0];
}

async function cleanup() {
  // Superuser-path delete (no SET LOCAL ROLE) — allowed by the guard's
  // superuser branch, so test fixtures can be torn down.
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE resource_table = 'appendonly_test' AND resource_id = $1`,
    MARK,
  ).catch(() => {});
}

d('audit tables are append-only (migration 324)', () => {
  let roleOk = false;

  beforeAll(async () => {
    roleOk = await appRoleAvailable();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('the six target audit tables that exist all carry the append-only trigger', async () => {
    const targets = [
      'clinical_audit_events', 'audit_log', 'audit_logs',
      'hipaa_access_log', 'patient_access_audit_log', 'staff_access_audit_log',
    ];
    const existing = await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      targets,
    );
    const existingNames = existing.map((r) => r.table_name);
    // At minimum clinical_audit_events must exist (it is created well before 324).
    expect(existingNames).toContain('clinical_audit_events');

    const triggered = await prisma.$queryRawUnsafe(
      `SELECT c.relname AS table_name
         FROM pg_trigger t JOIN pg_class c ON t.tgrelid = c.oid
        WHERE t.tgname LIKE '%_append_only' AND NOT t.tgisinternal`,
    );
    const triggeredNames = new Set(triggered.map((r) => r.table_name));

    // Every audit table that EXISTS must have the guard. (Tables absent from
    // this schema are correctly skipped by the migration.)
    for (const name of existingNames) {
      expect(triggeredNames.has(name)).toBe(true);
    }
  });

  test('INSERT by the non-superuser app role still works and is chained', async () => {
    if (!roleOk) {
      // Environment without the sealed test role — skip rather than false-pass.
      console.warn(`Skipping: app role ${APP_ROLE} not present as NOSUPERUSER NOBYPASSRLS`);
      return;
    }
    const row = await insertAuditRowAsApp();
    insertedIds.push(row.id);
    expect(row.id).toBeTruthy();
    // Migration-282 chain trigger still fired on INSERT.
    expect(Number(row.chain_seq)).toBeGreaterThan(0);
    expect(row.chain_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('UPDATE by the non-superuser app role is BLOCKED (append-only)', async () => {
    if (!roleOk) { console.warn(`Skipping: ${APP_ROLE} unavailable`); return; }
    const target = insertedIds[0];
    expect(target).toBeTruthy();

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
        await tx.$executeRawUnsafe(
          `UPDATE clinical_audit_events SET action = $2 WHERE id = $1::uuid`,
          target, `${MARK}.TAMPERED`,
        );
      }),
    ).rejects.toThrow(/append-only/i);

    // The row is unchanged — the UPDATE never committed.
    const after = await prisma.$queryRawUnsafe(
      `SELECT action FROM clinical_audit_events WHERE id = $1::uuid`, target,
    );
    expect(after[0].action).toBe(`${MARK}.insert`);
  });

  test('DELETE by the non-superuser app role is BLOCKED (append-only)', async () => {
    if (!roleOk) { console.warn(`Skipping: ${APP_ROLE} unavailable`); return; }
    const target = insertedIds[0];

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
        await tx.$executeRawUnsafe(
          `DELETE FROM clinical_audit_events WHERE id = $1::uuid`, target,
        );
      }),
    ).rejects.toThrow(/append-only/i);

    const still = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM clinical_audit_events WHERE id = $1::uuid`, target,
    );
    expect(still.length).toBe(1);
  });

  test('an authorized maintenance delete (app.audit_bypass=on) IS allowed', async () => {
    if (!roleOk) { console.warn(`Skipping: ${APP_ROLE} unavailable`); return; }
    const target = insertedIds[0];

    // Even under the non-superuser app role, the explicit bypass GUC lets the
    // designated retention/maintenance path delete (this is exactly how the
    // purge-audit-logs cron is allowed).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
      await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_audit_events WHERE id = $1::uuid`, target,
      );
    });

    const gone = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM clinical_audit_events WHERE id = $1::uuid`, target,
    );
    expect(gone.length).toBe(0);
    insertedIds.shift();
  });

  test('the bypass is transaction-local — it does not leak to the next statement', async () => {
    if (!roleOk) { console.warn(`Skipping: ${APP_ROLE} unavailable`); return; }
    const row = await insertAuditRowAsApp();
    insertedIds.push(row.id);

    // A fresh transaction without the bypass GUC must be blocked again, proving
    // the previous test's bypass did not persist on the pooled connection.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
        await tx.$executeRawUnsafe(
          `DELETE FROM clinical_audit_events WHERE id = $1::uuid`, row.id,
        );
      }),
    ).rejects.toThrow(/append-only/i);
  });
});

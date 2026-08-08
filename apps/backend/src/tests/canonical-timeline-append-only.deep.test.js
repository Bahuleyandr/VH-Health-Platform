// 2026-07-28 canonical-timeline review — append-only protection on
// clinical_timeline_events (migration 599).
//
// The root CLAUDE.md / docs/CANONICAL_CLINICAL_TIMELINE.md invariant makes
// clinical_timeline_events one half of the canonical clinical record. The
// other half, clinical_audit_events, has been append-only at the DB layer
// since migration 324 — but the timeline half was only protected indirectly:
// downstream tables hold ON DELETE RESTRICT composite FKs (so REFERENCED rows
// could not be deleted), plus three row-scoped guards (581 lab-ack receipts,
// 584 pathway-creation companions, 595 S4 owner dependencies). Unreferenced,
// unscoped rows could still be DELETEd and ANY row could be UPDATEd by the
// app role. Migration 599 closes that gap by attaching the same shared
// audit_append_only_guard() BEFORE UPDATE OR DELETE trigger to the table.
//
// Proves (mirror of audit-append-only.deep.test.js):
//   1. trg_clinical_timeline_events_append_only is installed and wired to
//      audit_append_only_guard().
//   2. INSERT by the sealed non-superuser app role still works (append-only,
//      not read-only).
//   3. UPDATE and DELETE by that role WITHOUT app.audit_bypass are blocked.
//   4. SET LOCAL app.audit_bypass = 'on' allows an explicit maintenance
//      delete, and the bypass is transaction-local (no pooled-connection
//      leak).
//
// Why SET LOCAL ROLE: the test connection is a superuser, and the guard
// intentionally lets superusers through (accepted threat boundary — a
// superuser can drop the trigger anyway; this is also what keeps the many
// existing fixture-cleanup `DELETE FROM clinical_timeline_events` sites
// working). The sealed prod app role posture (NOSUPERUSER NOBYPASSRLS,
// like vhhealth_app) is reproduced via rls_test_app.
//
// Requires a reachable Postgres (DATABASE_URL). Skipped if none configured.

import { randomUUID } from 'crypto';
import prisma from '../lib/prisma.js';
import { recordTimelineEvent } from '../services/clinical/canonicalClinicalPlatformService.js';

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
// Same role + override knob the migration-324 guard test uses.
const APP_ROLE = process.env.AUDIT_APPEND_ONLY_TEST_ROLE || 'rls_test_app';

// Tag rows so cleanup is surgical and never touches sibling-suite timeline rows.
const MARK = `TL-APPENDONLY-${process.pid}-${Date.now()}`;
let seq = 0;
const insertedIds = [];

async function appRoleAvailable() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
    APP_ROLE,
  );
  return rows.length > 0 && rows[0].rolsuper === false && rows[0].rolbypassrls === false;
}

async function insertTimelineRowAsApp() {
  // INSERT as the non-superuser app role — proves the append path is open.
  // A neutral event_type/source_table keeps the row outside the scoped 581/
  // 584/595 guard families and outside any projector's event selection.
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
    return tx.$queryRawUnsafe(
      `INSERT INTO clinical_timeline_events
         (tenant_id, patient_uid, event_type, source_table, source_id,
          clinical_summary, idempotency_key)
       VALUES ($1::uuid, $2::uuid, 'append_only_probe', 'appendonly_test', $3,
               $4, $5)
       RETURNING id, clinical_summary`,
      TENANT, randomUUID(), MARK, `${MARK}.insert`, `${MARK}.${++seq}`,
    );
  });
  return rows[0];
}

async function cleanup() {
  // Superuser-path delete (no SET LOCAL ROLE) — allowed by the guard's
  // superuser branch, so test fixtures can be torn down.
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events
      WHERE source_table = 'appendonly_test' AND source_id = $1`,
    MARK,
  ).catch(() => {});
}

d('clinical_timeline_events is append-only (migration 599)', () => {
  let roleOk = false;

  beforeAll(async () => {
    roleOk = await appRoleAvailable();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('the append-only guard trigger is installed and wired to audit_append_only_guard', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT t.tgname, p.proname
         FROM pg_trigger t
         JOIN pg_class c ON t.tgrelid = c.oid
         JOIN pg_proc p ON t.tgfoid = p.oid
        WHERE c.relname = 'clinical_timeline_events'
          AND t.tgname = 'trg_clinical_timeline_events_append_only'
          AND NOT t.tgisinternal`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].proname).toBe('audit_append_only_guard');
  });

  test('INSERT by the non-superuser app role still works (append path open)', async () => {
    if (!roleOk) {
      // Environment without the sealed test role — skip rather than false-pass.
      console.warn(`Skipping: app role ${APP_ROLE} not present as NOSUPERUSER NOBYPASSRLS`);
      return;
    }
    const row = await insertTimelineRowAsApp();
    insertedIds.push(row.id);
    expect(row.id).toBeTruthy();
    expect(row.clinical_summary).toBe(`${MARK}.insert`);
  });

  test('UPDATE by the non-superuser app role is BLOCKED without the bypass GUC', async () => {
    if (!roleOk) { console.warn(`Skipping: ${APP_ROLE} unavailable`); return; }
    const target = insertedIds[0];
    expect(target).toBeTruthy();

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
        await tx.$executeRawUnsafe(
          `UPDATE clinical_timeline_events SET clinical_summary = $2 WHERE id = $1::uuid`,
          target, `${MARK}.TAMPERED`,
        );
      }),
    ).rejects.toThrow(/append-only/i);

    // The row is unchanged — the UPDATE never committed.
    const after = await prisma.$queryRawUnsafe(
      `SELECT clinical_summary FROM clinical_timeline_events WHERE id = $1::uuid`, target,
    );
    expect(after[0].clinical_summary).toBe(`${MARK}.insert`);
  });

  test('DELETE by the non-superuser app role is BLOCKED without the bypass GUC', async () => {
    if (!roleOk) { console.warn(`Skipping: ${APP_ROLE} unavailable`); return; }
    const target = insertedIds[0];

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
        await tx.$executeRawUnsafe(
          `DELETE FROM clinical_timeline_events WHERE id = $1::uuid`, target,
        );
      }),
    ).rejects.toThrow(/append-only/i);

    const still = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM clinical_timeline_events WHERE id = $1::uuid`, target,
    );
    expect(still.length).toBe(1);
  });

  test('an authorized maintenance delete (app.audit_bypass=on) IS allowed', async () => {
    if (!roleOk) { console.warn(`Skipping: ${APP_ROLE} unavailable`); return; }
    const target = insertedIds[0];

    // Even under the non-superuser app role, the explicit bypass GUC lets a
    // designated maintenance path delete — the same escape hatch the audit
    // tables grant the retention purge. No production code path mutates
    // clinical_timeline_events today; this proves the hatch works if a
    // documented maintenance job ever needs it.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
      await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_timeline_events WHERE id = $1::uuid`, target,
      );
    });

    const gone = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM clinical_timeline_events WHERE id = $1::uuid`, target,
    );
    expect(gone.length).toBe(0);
    insertedIds.shift();
  });

  test('the bypass is transaction-local — it does not leak to the next statement', async () => {
    if (!roleOk) { console.warn(`Skipping: ${APP_ROLE} unavailable`); return; }
    const row = await insertTimelineRowAsApp();
    insertedIds.push(row.id);

    // A fresh transaction without the bypass GUC must be blocked again, proving
    // the previous test's bypass did not persist on the pooled connection.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
        await tx.$executeRawUnsafe(
          `DELETE FROM clinical_timeline_events WHERE id = $1::uuid`, row.id,
        );
      }),
    ).rejects.toThrow(/append-only/i);
  });

  test('recordTimelineEvent absorbs a duplicate idempotency key under the sealed app role', async () => {
    if (!roleOk) { console.warn(`Skipping: ${APP_ROLE} unavailable`); return; }

    // Regression for the ON CONFLICT DO UPDATE form: even a no-op DO UPDATE
    // executes an UPDATE on the conflicting row, fires this suite's BEFORE
    // UPDATE guard for the non-superuser role, and aborts the whole enclosing
    // clinical transaction. Superuser test connections are exempt from the
    // guard, which is why this must run under SET LOCAL ROLE to catch it.
    const idempotencyKey = `${MARK}.dup.${++seq}`;
    const event = {
      tenantId: TENANT,
      patientUid: randomUUID(),
      eventType: 'append_only_probe',
      sourceTable: 'appendonly_test',
      sourceId: MARK,
      summary: `${MARK}.duplicate-write`,
      idempotencyKey,
    };

    const { first, second } = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
      const a = await recordTimelineEvent(event, { db: tx });
      const b = await recordTimelineEvent(event, { db: tx });
      return { first: a, second: b };
    });

    expect(first?.id).toBeTruthy();
    expect(second?.id).toBe(first.id); // conflict reads the existing row back
    insertedIds.push(first.id);

    const count = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM clinical_timeline_events WHERE idempotency_key = $1`,
      idempotencyKey,
    );
    expect(count[0].n).toBe(1);
  });
});

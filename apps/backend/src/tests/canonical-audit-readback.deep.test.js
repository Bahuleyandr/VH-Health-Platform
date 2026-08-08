// Phase-3 follow-up (S6-01 sibling): concurrent-readback race on the
// clinical_audit_events idempotent writer.
//
// recordClinicalAuditEvent uses the single-statement CTE
// `INSERT … ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
// DO NOTHING` + UNION-ALL readback. Under Read Committed, when a concurrent
// transaction holds the conflicting row uncommitted, DO NOTHING suppresses
// this insert after the conflict wait — but the now-committed row is invisible
// to the statement's snapshot, so the CTE returns no row and the writer used
// to return null (callers with requireAudit then threw
// CANONICAL_AUDIT_REQUIRED for a row that exists). Mirror of the timeline-side
// fix + race test (canonical-timeline-append-only.deep.test.js): a second
// statement gets a fresh snapshot and reads the winner's row back.
//
// Note the audit-specific mechanics this pins:
//   - the conflict target is the PARTIAL unique index
//     idx_clinical_audit_events_idempotency (… WHERE idempotency_key IS NOT
//     NULL), unlike the timeline's full unique constraint;
//   - the per-tenant audit chain trigger serialises concurrent inserts on a
//     pg_advisory_xact_lock, so the loser parks there until the winner
//     commits — the readback race is identical.
//
// Also pins the pre-RLS tenant funnel hardening: a writer invoked WITHOUT an
// explicit tenant inside setTenantTx(tenant B) must stamp tenant B — never
// DEFAULT_TENANT_ID.
//
// Why SET LOCAL ROLE: dev/QA/CI connect as superuser, which the migration-324
// append-only guard exempts — the sealed prod posture is reproduced via the
// NOSUPERUSER NOBYPASSRLS rls_test_app role (warn-and-skip when missing).
//
// Requires a reachable Postgres (DATABASE_URL). Skipped if none configured.

import { randomUUID } from 'crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  recordClinicalAuditEvent,
  recordMedicationSafetyReviews,
  recordTimelineEvent,
} from '../services/clinical/canonicalClinicalPlatformService.js';

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const APP_ROLE = process.env.AUDIT_APPEND_ONLY_TEST_ROLE || 'rls_test_app';

// Tag rows so cleanup is surgical and never touches sibling-suite audit rows.
const MARK = `AUDIT-READBACK-${process.pid}-${Date.now()}`;
let seq = 0;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function appRoleAvailable() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
    APP_ROLE,
  );
  return rows.length > 0 && rows[0].rolsuper === false && rows[0].rolbypassrls === false;
}

async function cleanup() {
  // Superuser-path deletes (no SET LOCAL ROLE) — allowed by the append-only
  // guard's superuser branch, so test fixtures can be torn down.
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE resource_table = 'audit_readback_test'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE source_table = 'audit_readback_test'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_safety_reviews WHERE finding_code = $1`,
    MARK,
  ).catch(() => {});
}

d('recordClinicalAuditEvent concurrent readback + tenant stamping', () => {
  let roleOk = false;

  beforeAll(async () => {
    roleOk = await appRoleAvailable();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('reads back a concurrently committed duplicate audit row', async () => {
    if (!roleOk) { console.warn(`Skipping: ${APP_ROLE} unavailable`); return; }

    const idempotencyKey = `${MARK}.concurrent.${++seq}`;
    const event = {
      tenantId: TENANT,
      patientUid: randomUUID(),
      action: 'audit_readback_probe',
      resourceTable: 'audit_readback_test',
      resourceId: MARK,
      idempotencyKey,
    };
    const inserted = deferred();
    const allowCommit = deferred();

    const winner = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
      const row = await recordClinicalAuditEvent(event, { db: tx });
      inserted.resolve(row);
      await allowCommit.promise;
      return row;
    }, { timeout: 30_000, maxWait: 10_000 });

    const first = await inserted.promise;
    const loser = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
      return recordClinicalAuditEvent(event, { db: tx });
    }, { timeout: 30_000, maxWait: 10_000 });
    loser.catch(() => {});

    // Ensure the loser has reached the conflict wait (here: the audit chain
    // trigger's per-tenant advisory xact lock held by the winner) before the
    // winner is allowed to commit.
    await new Promise((resolve) => setTimeout(resolve, 750));
    allowCommit.resolve();

    const [committed, second] = await Promise.all([winner, loser]);
    expect(first?.id).toBeTruthy();
    expect(committed.id).toBe(first.id);
    expect(second?.id).toBe(first.id); // fresh-snapshot fallback read the winner back

    const count = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM clinical_audit_events WHERE idempotency_key = $1`,
      idempotencyKey,
    );
    expect(count[0].n).toBe(1);
  }, 60_000);

  test('writers without an explicit tenant stamp the transaction tenant, not the default', async () => {
    const tenantB = randomUUID();
    const patientUid = randomUUID();
    const priorDefaultTenant = process.env.ALLOW_DEFAULT_TENANT;
    process.env.ALLOW_DEFAULT_TENANT = 'false';
    let audit;
    let timeline;
    let reviews;
    try {
      ({ audit, timeline, reviews } = await setTenantTx(tenantB, async (tx) => {
        const auditRow = await recordClinicalAuditEvent({
          // No tenantId on purpose: the transaction-local GUC must win even
          // when default-tenant fallback is disabled.
          patientUid,
          action: 'audit_readback_probe',
          resourceTable: 'audit_readback_test',
          resourceId: MARK,
          idempotencyKey: `${MARK}.guc.audit.${++seq}`,
        }, { db: tx });
        const timelineRow = await recordTimelineEvent({
          patientUid,
          eventType: 'audit_readback_probe',
          sourceTable: 'audit_readback_test',
          sourceId: MARK,
          idempotencyKey: `${MARK}.guc.timeline.${seq}`,
        }, { db: tx });
        const reviewRows = await recordMedicationSafetyReviews({
          patientUid,
          safety: {
            safe: false,
            blockers: [{ type: 'guc_probe', code: MARK, message: 'GUC tenant probe' }],
            warnings: [],
          },
          actorUid: patientUid,
        }, { db: tx });
        return { audit: auditRow, timeline: timelineRow, reviews: reviewRows };
      }));
    } finally {
      if (priorDefaultTenant === undefined) delete process.env.ALLOW_DEFAULT_TENANT;
      else process.env.ALLOW_DEFAULT_TENANT = priorDefaultTenant;
    }

    expect(audit?.tenant_id).toBe(tenantB);
    expect(timeline?.tenant_id).toBe(tenantB);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].tenant_id).toBe(tenantB);
  });

  test('an explicit tenant still wins over the transaction tenant', async () => {
    const tenantB = randomUUID();
    const audit = await setTenantTx(tenantB, async (tx) => recordClinicalAuditEvent({
      tenantId: TENANT,
      patientUid: randomUUID(),
      action: 'audit_readback_probe',
      resourceTable: 'audit_readback_test',
      resourceId: MARK,
      idempotencyKey: `${MARK}.explicit.${++seq}`,
    }, { db: tx }));

    expect(audit?.tenant_id).toBe(TENANT);
  });
});

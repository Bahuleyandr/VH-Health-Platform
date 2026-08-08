// S5-01 (Phase-3 deep review): CDS alert acknowledge/override must satisfy the
// canonical invariant (docs/CANONICAL_CLINICAL_TIMELINE.md) — the detail
// update (cds_alerts), the clinical_timeline_events row, the
// clinical_audit_events row, and (for overrides) the
// medication_safety_reviews row all commit in ONE transaction. Previously the
// canonical emit ran post-commit best-effort (failures swallowed) and
// overrides never wrote medication_safety_reviews.
//
// Proves:
//   1. override ack → cds_alerts flip + timeline + audit + overridden
//      medication_safety_reviews rows exist after commit, all stamped with the
//      alert's (non-default) tenant — the tenant mis-stamp regression.
//   2. plain ack → timeline + audit, no medication_safety_reviews row.
//   3. a failed canonical emit rolls the acknowledgement back (nothing
//      commits) instead of committing an ack with no canonical trail.
//
// Requires a reachable Postgres (DATABASE_URL). Skipped if none configured.

import { randomUUID } from 'crypto';
import prisma from '../lib/prisma.js';
import { acknowledgeAlert } from '../services/emr/cdsEngine.js';

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
const MARK = `CDS-ACK-ATOMIC-${process.pid}-${Date.now()}`;

const TENANT_B = randomUUID();
const ACTOR = randomUUID();

async function insertAlert({ patientUid, title }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO cds_alerts
       (tenant_id, patient_uid, alert_type, severity, title, description, source_data, acknowledged)
     VALUES ($1::uuid, $2::uuid, 'allergy', 'critical', $3, $4, '{"foo":"bar"}'::jsonb, false)
     RETURNING id`,
    TENANT_B, patientUid, title, MARK,
  );
  return rows[0].id;
}

async function countRows(sql, ...params) {
  const rows = await prisma.$queryRawUnsafe(sql, ...params);
  return rows[0].n;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_safety_reviews WHERE tenant_id = $1::uuid`, TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`, TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`, TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM cds_alerts WHERE tenant_id = $1::uuid`, TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS trg_test_cds_ack_emit_fail ON clinical_timeline_events`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DROP FUNCTION IF EXISTS test_cds_ack_emit_fail()`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`, TENANT_B,
  ).catch(() => {});
}

d('CDS alert ack/override canonical atomicity (S5-01)', () => {
  beforeAll(async () => {
    // Second (non-default) tenant — cds_alerts carries an FK to tenants.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B, `cds-ack-test-${Date.now()}`, 'CDS ack atomicity test tenant',
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('override ack commits detail + timeline + audit + medication_safety_reviews under the alert tenant', async () => {
    const patientUid = randomUUID();
    const alertId = await insertAlert({ patientUid, title: 'Penicillin allergy conflict' });

    const result = await acknowledgeAlert(alertId, ACTOR, 'clinically necessary', TENANT_B);

    // Response contract preserved.
    expect(result.acknowledged).toBe(true);
    expect(result.acknowledged_by).toBe(ACTOR);
    expect(result.override_reason).toBe('clinically necessary');
    expect(result.source_data.override_reason).toBe('clinically necessary');

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT tenant_id, event_type, payload FROM clinical_timeline_events
        WHERE idempotency_key = $1`,
      `cds_alerts:${alertId}:acknowledged`,
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0].tenant_id).toBe(TENANT_B);
    expect(timeline[0].tenant_id).not.toBe(DEFAULT_TENANT);
    expect(timeline[0].event_type).toBe('cds.alert_acknowledged');
    expect(timeline[0].payload.override_reason).toBe('clinically necessary');

    const audit = await prisma.$queryRawUnsafe(
      `SELECT tenant_id, action FROM clinical_audit_events WHERE idempotency_key = $1`,
      `cds_alerts:${alertId}:audit:acknowledged`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].tenant_id).toBe(TENANT_B);
    expect(audit[0].tenant_id).not.toBe(DEFAULT_TENANT);

    const reviews = await prisma.$queryRawUnsafe(
      `SELECT tenant_id, status, override_required, override_reason, overridden_by, review_type
         FROM medication_safety_reviews
        WHERE patient_uid = $1::uuid`,
      patientUid,
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0].tenant_id).toBe(TENANT_B);
    expect(reviews[0].status).toBe('overridden');
    expect(reviews[0].override_required).toBe(true);
    expect(reviews[0].override_reason).toBe('clinically necessary');
    expect(reviews[0].overridden_by).toBe(ACTOR);
    expect(reviews[0].review_type).toBe('cds_alert_override');
  }, 30_000);

  test('plain ack commits timeline + audit and no medication_safety_reviews row', async () => {
    const patientUid = randomUUID();
    const alertId = await insertAlert({ patientUid, title: 'Duplicate order' });

    const result = await acknowledgeAlert(alertId, ACTOR, null, TENANT_B);
    expect(result.acknowledged).toBe(true);
    expect(result.override_reason).toBeNull();

    expect(await countRows(
      `SELECT COUNT(*)::int AS n FROM clinical_timeline_events WHERE idempotency_key = $1`,
      `cds_alerts:${alertId}:acknowledged`,
    )).toBe(1);
    expect(await countRows(
      `SELECT COUNT(*)::int AS n FROM clinical_audit_events WHERE idempotency_key = $1`,
      `cds_alerts:${alertId}:audit:acknowledged`,
    )).toBe(1);
    expect(await countRows(
      `SELECT COUNT(*)::int AS n FROM medication_safety_reviews WHERE patient_uid = $1::uuid`,
      patientUid,
    )).toBe(0);
  }, 30_000);

  test('a failed canonical emit rolls the acknowledgement back', async () => {
    const patientUid = randomUUID();
    const alertId = await insertAlert({ patientUid, title: 'Emit failure probe' });

    // Force the in-tx timeline insert for THIS alert to fail at the DB layer.
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION test_cds_ack_emit_fail() RETURNS trigger AS $fn$
       BEGIN
         IF NEW.idempotency_key = 'cds_alerts:${Number(alertId)}:acknowledged' THEN
           RAISE EXCEPTION 'forced canonical emit failure (test)';
         END IF;
         RETURN NEW;
       END $fn$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER trg_test_cds_ack_emit_fail
       BEFORE INSERT ON clinical_timeline_events
       FOR EACH ROW EXECUTE FUNCTION test_cds_ack_emit_fail()`,
    );

    try {
      await expect(acknowledgeAlert(alertId, ACTOR, 'override during outage', TENANT_B))
        .rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS trg_test_cds_ack_emit_fail ON clinical_timeline_events`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS test_cds_ack_emit_fail()`,
      );
    }

    // Nothing committed: the ack rolled back with the failed emit.
    const alert = await prisma.$queryRawUnsafe(
      `SELECT acknowledged, ack_by FROM cds_alerts WHERE id = $1::int`,
      Number(alertId),
    );
    expect(alert[0].acknowledged).toBe(false);
    expect(alert[0].ack_by).toBeNull();
    expect(await countRows(
      `SELECT COUNT(*)::int AS n FROM clinical_timeline_events WHERE idempotency_key = $1`,
      `cds_alerts:${alertId}:acknowledged`,
    )).toBe(0);
    expect(await countRows(
      `SELECT COUNT(*)::int AS n FROM clinical_audit_events WHERE idempotency_key = $1`,
      `cds_alerts:${alertId}:audit:acknowledged`,
    )).toBe(0);
    expect(await countRows(
      `SELECT COUNT(*)::int AS n FROM medication_safety_reviews WHERE patient_uid = $1::uuid`,
      patientUid,
    )).toBe(0);
  }, 30_000);
});

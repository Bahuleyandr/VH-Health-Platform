// NL-14 P2 — deep DB tests for the durable resuscitation record (migrations
// 513–517). Proves the DATABASE-level invariants that back spec §4.3:
//
//   1. resuscitation_event_timeline is append-only — the mig-514 trigger
//      blocks UPDATE and DELETE regardless of caller.
//   2. Finalization is blocked at the DB CHECK when the team leader or
//      recorder is missing (the service gate is the friendly layer; this is
//      the backstop).
//   3. One MAR administration can back at most ONE resus medication link —
//      the mig-516 partial unique index is the no-double-administration
//      accounting backstop.
//   4. Tenant isolation: under a non-owner role with the tenant GUC set,
//      another tenant's resuscitation events are invisible (RLS
//      ENABLE+FORCE + tenant_isolation policy).
//
// Runs against DATABASE_URL with this branch's migrations applied (skipped
// when no DB is configured, same as the other *.deep tests).

import prisma from '../lib/prisma.js';

async function ownerQuery(text, params = []) {
  if (/^\s*(SELECT|WITH)\b/i.test(text) || /\bRETURNING\b/i.test(text)) {
    const rows = await prisma.$queryRawUnsafe(text, ...params);
    const arr = Array.isArray(rows) ? rows : [];
    return { rows: arr, rowCount: arr.length };
  }
  const rowCount = await prisma.$executeRawUnsafe(text, ...params);
  return { rows: [], rowCount: Number(rowCount) || 0 };
}

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const describeIfDb = hasDatabaseUrl ? describe : describe.skip;

const TENANT_A = '00000000-0000-4000-8000-000000000001'; // DEFAULT_TENANT_ID
const TENANT_B = '00000000-0000-4000-8000-0000000000c3';
const APP_ROLE = 'rls_test_app';
const TAG = 'resus-deep-test';

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

describeIfDb('Resuscitation durable record invariants (migrations 513-517)', () => {
  let patientUid = null;
  let eventA = null; // tenant A event id
  let eventB = null; // tenant B event id
  let marId = null;

  beforeAll(async () => {
    await ownerQuery(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_test_app') THEN
          CREATE ROLE rls_test_app NOLOGIN;
        END IF;
      END $$;
    `);
    await ownerQuery(`GRANT USAGE ON SCHEMA public TO rls_test_app`);
    await ownerQuery(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON resuscitation_events, resuscitation_event_timeline, resuscitation_medication_links TO rls_test_app`
    );
    await ownerQuery(`GRANT SELECT ON tenants, users TO rls_test_app`);
    await ownerQuery(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rls_test_app`);

    await ownerQuery(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'resus-deep-b', 'Resus Deep Test Tenant B', 'IN', 'DPDP', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_B]
    );

    const patient = await ownerQuery(
      `SELECT uid FROM users WHERE role = 'PATIENT' ORDER BY id LIMIT 1`
    );
    patientUid = patient.rows[0]?.uid ?? null;
    if (!patientUid) {
      const created = await ownerQuery(
        `INSERT INTO users (uid, name, phone, role, updated_at)
         VALUES (gen_random_uuid(), 'Resus Deep Patient', '+919999009900', 'PATIENT', NOW())
         RETURNING uid`
      );
      patientUid = created.rows[0].uid;
    }

    // Clean prior runs: timeline/link rows are trigger/FK-protected, so strip
    // in dependency order with the trigger disabled for cleanup only.
    await ownerQuery(`ALTER TABLE resuscitation_event_timeline DISABLE TRIGGER trg_resuscitation_timeline_append_only`);
    await ownerQuery(
      `DELETE FROM resuscitation_medication_links
        WHERE resuscitation_event_id IN (SELECT id FROM resuscitation_events WHERE reason LIKE $1)`,
      [`${TAG}%`]
    );
    await ownerQuery(
      `DELETE FROM resuscitation_event_timeline
        WHERE resuscitation_event_id IN (SELECT id FROM resuscitation_events WHERE reason LIKE $1)`,
      [`${TAG}%`]
    );
    await ownerQuery(`ALTER TABLE resuscitation_event_timeline ENABLE TRIGGER trg_resuscitation_timeline_append_only`);
    await ownerQuery(`DELETE FROM resuscitation_events WHERE reason LIKE $1`, [`${TAG}%`]);
    await ownerQuery(
      `DELETE FROM medication_administrations WHERE medication_name = $1`,
      [`${TAG}-epinephrine`]
    );

    const evA = await ownerQuery(
      `INSERT INTO resuscitation_events
         (tenant_id, patient_uid, event_kind, trigger_source, ward_snapshot, bed_snapshot, reason)
       VALUES ($1::uuid, $2::uuid, 'code_blue', 'explicit_staff', 'ICU-A', 'B1', $3)
       RETURNING id`,
      [TENANT_A, patientUid, `${TAG}-a`]
    );
    eventA = Number(evA.rows[0].id);

    const evB = await ownerQuery(
      `INSERT INTO resuscitation_events
         (tenant_id, patient_uid, event_kind, trigger_source, ward_snapshot, bed_snapshot, reason)
       VALUES ($1::uuid, $2::uuid, 'code_blue', 'explicit_staff', 'ICU-B', 'B2', $3)
       RETURNING id`,
      [TENANT_B, patientUid, `${TAG}-b`]
    );
    eventB = Number(evB.rows[0].id);

    await ownerQuery(
      `INSERT INTO resuscitation_event_timeline
         (tenant_id, resuscitation_event_id, patient_uid, seq, entry_type, details)
       VALUES ($1::uuid, $2, $3::uuid, 1, 'compressions_started', '{"tag":"resus-deep-test"}'::jsonb)`,
      [TENANT_A, eventA, patientUid]
    );

    const mar = await ownerQuery(
      `INSERT INTO medication_administrations
         (tenant_id, patient_uid, medication_name, dose, route, status, administered_at, scheduled_time)
       VALUES ($1::uuid, $2::uuid, $3, '1 mg', 'IV', 'administered', NOW(), NOW())
       RETURNING id`,
      [TENANT_A, patientUid, `${TAG}-epinephrine`]
    );
    marId = Number(mar.rows[0].id);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('timeline UPDATE is blocked by the append-only trigger', async () => {
    await expect(
      ownerQuery(
        `UPDATE resuscitation_event_timeline SET rhythm = 'vf' WHERE resuscitation_event_id = $1`,
        [eventA]
      )
    ).rejects.toThrow(/append-only/i);
  });

  test('timeline DELETE is blocked by the append-only trigger', async () => {
    await expect(
      ownerQuery(
        `DELETE FROM resuscitation_event_timeline WHERE resuscitation_event_id = $1`,
        [eventA]
      )
    ).rejects.toThrow(/append-only/i);
  });

  test('finalize without team leader/recorder is blocked by the DB CHECK', async () => {
    await expect(
      ownerQuery(
        `UPDATE resuscitation_events
            SET status = 'finalized', ended_at = NOW(), outcome = 'rosc',
                finalized_at = NOW(), finalized_by = $2::uuid
          WHERE id = $1`,
        [eventA, patientUid]
      )
    ).rejects.toThrow(/finalize_gate|check constraint/i);
  });

  test('one MAR administration can back at most one resus medication link', async () => {
    await ownerQuery(
      `INSERT INTO resuscitation_medication_links
         (tenant_id, resuscitation_event_id, patient_uid, link_kind,
          mar_administration_id, medication_kind, medication_name, reconciliation_status)
       VALUES ($1::uuid, $2, $3::uuid, 'mar_administration', $4, 'medication', $5, 'not_required')`,
      [TENANT_A, eventA, patientUid, marId, `${TAG}-epinephrine`]
    );
    await expect(
      ownerQuery(
        `INSERT INTO resuscitation_medication_links
           (tenant_id, resuscitation_event_id, patient_uid, link_kind,
            mar_administration_id, medication_kind, medication_name, reconciliation_status)
         VALUES ($1::uuid, $2, $3::uuid, 'mar_administration', $4, 'medication', $5, 'not_required')`,
        [TENANT_A, eventA, patientUid, marId, `${TAG}-epinephrine`]
      )
    ).rejects.toThrow(/ux_resuscitation_med_links_mar|unique/i);
  });

  test('tenant GUC scoping hides other tenants\' resuscitation events (RLS)', async () => {
    const asA = await asAppRole(
      `SELECT id, reason FROM resuscitation_events WHERE reason LIKE $1 ORDER BY id`,
      [`${TAG}%`],
      TENANT_A
    );
    expect(asA.map((r) => Number(r.id))).toContain(eventA);
    expect(asA.map((r) => Number(r.id))).not.toContain(eventB);

    const asB = await asAppRole(
      `SELECT id, reason FROM resuscitation_events WHERE reason LIKE $1 ORDER BY id`,
      [`${TAG}%`],
      TENANT_B
    );
    expect(asB.map((r) => Number(r.id))).toContain(eventB);
    expect(asB.map((r) => Number(r.id))).not.toContain(eventA);
  });

  test('cross-tenant INSERT is rejected by the RLS WITH CHECK', async () => {
    await expect(
      asAppRole(
        `INSERT INTO resuscitation_events
           (tenant_id, patient_uid, event_kind, trigger_source, reason)
         VALUES ($1::uuid, $2::uuid, 'code_blue', 'explicit_staff', $3)
         RETURNING id`,
        [TENANT_B, patientUid, `${TAG}-wrong-tenant`],
        TENANT_A
      )
    ).rejects.toThrow(/row-level security|violates/i);
  });
});

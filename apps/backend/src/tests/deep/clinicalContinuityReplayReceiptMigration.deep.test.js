import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/605_clinical_continuity_replay_receipts.sql', import.meta.url),
  'utf8'
);
const RLS_ROLE = 'c5_replay_rls_test';

async function expectDatabaseFailure(client, operation, expected = {}) {
  await client.query('SAVEPOINT expected_c5_replay_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_c5_replay_failure');
  await client.query('RELEASE SAVEPOINT expected_c5_replay_failure');
  expect(failure).toBeDefined();
  if (expected.code) expect(failure.code).toBe(expected.code);
  if (expected.constraint) expect(failure.constraint).toBe(expected.constraint);
  if (expected.message) expect(failure.message).toContain(expected.message);
}

function receiptCandidate(fixture, overrides = {}) {
  const capturedAt = new Date(Date.now() - 60 * 60_000);
  return {
    tenant_id: fixture.tenantId,
    client_event_id: randomUUID(),
    source_kind: 'electronic_queue',
    facility_id: fixture.facilityId,
    incident_id: null,
    paper_item_id: null,
    original_idempotency_key: `c5-${randomUUID()}`,
    action_id: 'emr.nursing_note.draft.store',
    binding_id: 'emr.note_draft.store/v1',
    http_method: 'PUT',
    schema_id: 'emr.nursing_note.draft.store/v1',
    schema_version: 1,
    schema_checksum: '1'.repeat(64),
    client_command_fingerprint: '2'.repeat(64),
    receipt_fingerprint: '3'.repeat(64),
    payload_hash: '4'.repeat(64),
    capture_actor_uid: fixture.staffUid,
    capture_role: 'NURSING_STAFF',
    patient_id: fixture.patientId,
    patient_uid: fixture.patientUid,
    appointment_id: null,
    encounter_id: null,
    admission_id: null,
    unit_id: null,
    device_id: randomUUID(),
    device_posture: 'desktop',
    capture_session_id: randomUUID(),
    occurred_at: new Date(capturedAt.getTime() - 1000).toISOString(),
    captured_at: capturedAt.toISOString(),
    queued_at: new Date(capturedAt.getTime() + 1000).toISOString(),
    expires_at: new Date(capturedAt.getTime() + 6 * 60 * 60_000).toISOString(),
    clock_evidence_hash: '5'.repeat(64),
    cached_sources_hash: '6'.repeat(64),
    source_cache_version: '1',
    app_version: '1.2.3',
    envelope_schema_version: 1,
    queue_schema_version: 1,
    action_version: 1,
    action_checksum: '7'.repeat(64),
    policy_id: randomUUID(),
    policy_version: '1',
    policy_checksum: '8'.repeat(64),
    policy_signing_key_id: 'c5-test-policy-key',
    policy_effective_from: new Date(capturedAt.getTime() - 60 * 60_000).toISOString(),
    policy_effective_until: new Date(capturedAt.getTime() + 12 * 60 * 60_000).toISOString(),
    policy_supersedes_id: null,
    policy_revocation_epoch: '1',
    registry_version: '1',
    registry_checksum: '9'.repeat(64),
    minimum_app_version: '1.0.0',
    base_revision: '0',
    base_etag: null,
    ordering_key: `patient:${fixture.patientUid}`,
    ordering_key_digest: 'a'.repeat(64),
    sequence_no: '1',
    predecessor_client_event_id: null,
    supersession_generation: 0,
    human_review_required: false,
    ...overrides
  };
}

async function claim(client, candidate) {
  const result = await client.query(
    `SELECT clinical_continuity_replay_receipt_claim(
       $1::uuid, $2::jsonb
     ) AS claimed`,
    [candidate.tenant_id, JSON.stringify(candidate)]
  );
  return result.rows[0].claimed;
}

async function insertReceiptAsMigrationOwner(client, candidate) {
  const receivedAt = new Date();
  const transaction = await client.query('SELECT txid_current()::text AS id');
  const row = {
    ...candidate,
    claim_txid: transaction.rows[0].id,
    detailed_evidence_until: new Date(receivedAt.getTime() + 365 * 24 * 60 * 60_000).toISOString(),
    disposition: 'claimed',
    outcome_code: null,
    received_at: receivedAt.toISOString(),
    recorded_at: null,
    replay_eligibility_until: candidate.expires_at,
    retention_policy_id: 'C-D10-2026-07-31',
    tombstone_until: new Date(receivedAt.getTime() + 2555 * 24 * 60 * 60_000).toISOString()
  };
  return client.query(
    `INSERT INTO clinical_continuity_replay_receipts
     SELECT (jsonb_populate_record(
       NULL::clinical_continuity_replay_receipts,
       $1::jsonb
     )).*
     RETURNING client_event_id::text`,
    [JSON.stringify(row)]
  );
}

describe('migration 605 static replay-receipt contract', () => {
  test('is the only migration 605 and carries the immutable C5.1 primitives', () => {
    expect(
      readdirSync(new URL('../../migrations/', import.meta.url)).filter(name =>
        name.startsWith('605_')
      )
    ).toEqual(['605_clinical_continuity_replay_receipts.sql']);
    expect(migrationSql).toContain('FORCE ROW LEVEL SECURITY');
    expect(migrationSql).toContain('AS RESTRICTIVE');
    expect(migrationSql).toContain("current_setting('app.current_tenant_id', true) <> 'bypass'");
    expect(migrationSql).toContain('clinical_continuity_replay_receipt_claim');
    expect(migrationSql).toContain('clinical_continuity_replay_receipt_finalize');
    expect(migrationSql).toContain('C-D10-2026-07-31');
    expect(migrationSql).toContain("INTERVAL '365 days'");
    expect(migrationSql).toContain("INTERVAL '2555 days'");
    expect(migrationSql).toContain('uq_cc_replay_receipt_paper_identity');
    expect(migrationSql).toContain('ux_appointments_tenant_id_id_patient_for_cc_replay');
    expect(migrationSql).toContain('chk_cc_replay_claim_eligibility');
    expect(migrationSql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.clinical_continuity_replay_receipts/
    );
  });
});

describeIfDb('migration 605 database replay-receipt contract', () => {
  const client = new Client({ connectionString: databaseUrl });
  const fixture = {
    tenantId: randomUUID(),
    facilityId: 1900000000 + Math.floor(Math.random() * 1000000),
    staffUid: randomUUID(),
    patientUid: randomUUID(),
    otherPatientUid: randomUUID()
  };

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'C5.1 replay receipt deep test')`,
      [fixture.tenantId, `c5-replay-${randomUUID()}`]
    );
    await client.query(
      `INSERT INTO facilities (id, tenant_id, facility_code, display_name, timezone)
       VALUES ($1::integer, $2::uuid, $3, 'C5.1 replay facility', 'Asia/Kolkata')`,
      [fixture.facilityId, fixture.tenantId, `C5-${randomUUID()}`]
    );
    const users = [
      [fixture.staffUid, 'NURSING_STAFF', `+9181${String(fixture.facilityId).slice(-8)}`],
      [fixture.patientUid, 'PATIENT', `+9182${String(fixture.facilityId).slice(-8)}`],
      [fixture.otherPatientUid, 'PATIENT', `+9183${String(fixture.facilityId).slice(-8)}`]
    ];
    for (const [uid, role, phone] of users) {
      await client.query(
        `INSERT INTO users (
           uid, tenant_id, phone, name, role, is_active, status,
           is_deleted, registered_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'C5 replay fixture', $4,
           TRUE, 'active', FALSE, NOW(), NOW()
         )`,
        [uid, fixture.tenantId, phone, role]
      );
    }
    const ids = await client.query(
      `SELECT uid::text, id FROM users
        WHERE tenant_id = $1::uuid
          AND uid IN ($2::uuid, $3::uuid)`,
      [fixture.tenantId, fixture.patientUid, fixture.otherPatientUid]
    );
    fixture.patientId = Number(ids.rows.find(row => row.uid === fixture.patientUid).id);
    fixture.otherPatientId = Number(ids.rows.find(row => row.uid === fixture.otherPatientUid).id);
    const appointment = await client.query(
      `INSERT INTO appointments (
         tenant_id, phone, patient_id, doctor_name,
         appointment_date, appointment_time, updated_at
       ) VALUES (
         $1::uuid, '+919999999999', $2::integer, 'C5 doctor',
         CURRENT_DATE, '09:00', NOW()
       ) RETURNING id`,
      [fixture.tenantId, fixture.patientId]
    );
    fixture.appointmentId = Number(appointment.rows[0].id);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_ROLE}') THEN
          CREATE ROLE ${RLS_ROLE} NOLOGIN;
        END IF;
      END $$
    `);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await client.query(`GRANT SELECT ON clinical_continuity_replay_receipts TO ${RLS_ROLE}`);
    await client.query(
      `GRANT EXECUTE ON FUNCTION clinical_continuity_replay_receipt_claim(UUID, JSONB)
       TO ${RLS_ROLE}`
    );
    await client.query(
      `GRANT EXECUTE ON FUNCTION clinical_continuity_replay_receipt_finalize(UUID, UUID, VARCHAR, VARCHAR)
       TO ${RLS_ROLE}`
    );
  });

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('claims, records evidence and an attempt, finalizes once, and preserves C-D10 horizons', async () => {
    const candidate = receiptCandidate(fixture);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [fixture.tenantId]);
    expect(await claim(client, candidate)).toBe(true);
    expect(await claim(client, candidate)).toBe(false);

    const draft = await client.query(
      `INSERT INTO note_drafts (
         tenant_id, author_uid, patient_uid, note_type, content
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'nursing_assessment', '{}'::jsonb)
       RETURNING id::text, revision::text, updated_at`,
      [fixture.tenantId, fixture.staffUid, fixture.patientUid]
    );
    await client.query(
      `INSERT INTO clinical_continuity_replay_effect_evidence (
         tenant_id, client_event_id, note_draft_id, outcome_code,
         draft_revision, draft_updated_at
       ) VALUES ($1::uuid, $2::uuid, $3::bigint, 'draft_stored', $4::bigint, $5)`,
      [
        fixture.tenantId,
        candidate.client_event_id,
        draft.rows[0].id,
        draft.rows[0].revision,
        draft.rows[0].updated_at
      ]
    );
    await client.query(
      `INSERT INTO clinical_continuity_replay_attempts (
         tenant_id, client_event_id, receipt_client_event_id,
         replay_actor_uid, replay_role, attempt_class, reason_code, result
       ) VALUES (
         $1::uuid, $2::uuid, $2::uuid, $3::uuid, 'NURSING_STAFF',
         'first_apply', 'CONTINUITY_REPLAY_DRAFT_STORED', 'applied'
       )`,
      [fixture.tenantId, candidate.client_event_id, fixture.staffUid]
    );
    const finalized = await client.query(
      `SELECT clinical_continuity_replay_receipt_finalize(
         $1::uuid, $2::uuid, 'applied', 'draft_stored'
       ) AS finalized`,
      [fixture.tenantId, candidate.client_event_id]
    );
    expect(finalized.rows[0].finalized).toBe(true);

    const row = await client.query(
      `SELECT disposition, outcome_code,
              detailed_evidence_until - received_at AS detail_horizon,
              tombstone_until - received_at AS tombstone_horizon,
              replay_eligibility_until = expires_at AS replay_matches_expiry
         FROM clinical_continuity_replay_receipts
        WHERE tenant_id = $1::uuid AND client_event_id = $2::uuid`,
      [fixture.tenantId, candidate.client_event_id]
    );
    expect(row.rows[0]).toMatchObject({
      disposition: 'applied',
      outcome_code: 'draft_stored',
      replay_matches_expiry: true
    });
    expect(row.rows[0].detail_horizon.days).toBe(365);
    expect(row.rows[0].tombstone_horizon.days).toBe(2555);
    expect(await claim(client, candidate)).toBe(false);

    await expectDatabaseFailure(
      client,
      () =>
        client.query(
          `UPDATE clinical_continuity_replay_receipts
            SET outcome_code = 'changed'
          WHERE tenant_id = $1::uuid AND client_event_id = $2::uuid`,
          [fixture.tenantId, candidate.client_event_id]
        ),
      { constraint: 'chk_cc_replay_receipt_immutable' }
    );
    await expectDatabaseFailure(
      client,
      () =>
        client.query(
          `DELETE FROM clinical_continuity_replay_effect_evidence
          WHERE tenant_id = $1::uuid AND client_event_id = $2::uuid`,
          [fixture.tenantId, candidate.client_event_id]
        ),
      { constraint: 'chk_cc_replay_append_only' }
    );
  });

  test('binds an appointment to the same patient at the database layer', async () => {
    const valid = receiptCandidate(fixture, {
      action_id: 'emr.op_note.draft.store',
      schema_id: 'emr.op_note.draft.store/v1',
      appointment_id: fixture.appointmentId
    });
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [fixture.tenantId]);
    expect(await claim(client, valid)).toBe(true);

    const wrongPatient = receiptCandidate(fixture, {
      action_id: 'emr.op_note.draft.store',
      schema_id: 'emr.op_note.draft.store/v1',
      appointment_id: fixture.appointmentId,
      patient_id: fixture.otherPatientId,
      patient_uid: fixture.otherPatientUid
    });
    await expectDatabaseFailure(client, () => claim(client, wrongPatient), {
      constraint: 'fk_cc_replay_receipt_appointment'
    });
  });

  test('keeps the source dimension extensible while deduplicating paper identity', async () => {
    const incidentId = randomUUID();
    const paperItemId = `paper-${randomUUID()}`;
    const first = receiptCandidate(fixture, {
      source_kind: 'paper_back_entry',
      incident_id: incidentId,
      paper_item_id: paperItemId
    });
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [fixture.tenantId]);
    await insertReceiptAsMigrationOwner(client, first);
    await expectDatabaseFailure(
      client,
      () =>
        insertReceiptAsMigrationOwner(
          client,
          receiptCandidate(fixture, {
            source_kind: 'paper_back_entry',
            incident_id: incidentId,
            paper_item_id: paperItemId
          })
        ),
      { constraint: 'uq_cc_replay_receipt_paper_identity' }
    );
  });

  test('the runtime claim boundary rejects paper, expired, and review-required commands', async () => {
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [fixture.tenantId]);
    for (const candidate of [
      receiptCandidate(fixture, {
        source_kind: 'paper_back_entry',
        incident_id: randomUUID(),
        paper_item_id: `paper-${randomUUID()}`
      }),
      receiptCandidate(fixture, {
        expires_at: new Date(Date.now() - 1000).toISOString()
      }),
      receiptCandidate(fixture, { human_review_required: true })
    ]) {
      await expectDatabaseFailure(client, () => claim(client, candidate), {
        constraint: 'chk_cc_replay_claim_eligibility'
      });
    }
  });

  test('default-denies unset, empty, bypass, and wrong tenant contexts under a non-owner role', async () => {
    const visible = receiptCandidate(fixture);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [fixture.tenantId]);
    expect(await claim(client, visible)).toBe(true);

    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    for (const context of [null, '', 'bypass', randomUUID()]) {
      if (context === null) {
        await client.query("SELECT set_config('app.current_tenant_id', NULL, true)");
      } else {
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [context]);
      }
      const result = await client.query(
        'SELECT COUNT(*)::int AS count FROM clinical_continuity_replay_receipts'
      );
      expect(result.rows[0].count).toBe(0);
    }
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [fixture.tenantId]);
    const allowed = await client.query(
      `SELECT client_event_id::text
         FROM clinical_continuity_replay_receipts
        WHERE client_event_id = $1::uuid`,
      [visible.client_event_id]
    );
    expect(allowed.rows).toHaveLength(1);

    await client.query("SELECT set_config('app.current_tenant_id', 'bypass', true)");
    await expectDatabaseFailure(client, () => claim(client, receiptCandidate(fixture)), {
      code: '42501',
      message: 'explicit tenant context required'
    });
    await client.query('RESET ROLE');
  });

  test('runtime roles can read and execute narrow functions but cannot mutate receipts directly', async () => {
    const rows = await client.query(
      `SELECT role_name,
              has_table_privilege(role_name, 'clinical_continuity_replay_receipts', 'SELECT') AS can_select,
              has_table_privilege(role_name, 'clinical_continuity_replay_receipts', 'INSERT') AS can_insert,
              has_table_privilege(role_name, 'clinical_continuity_replay_receipts', 'UPDATE') AS can_update,
              has_table_privilege(role_name, 'clinical_continuity_replay_receipts', 'DELETE') AS can_delete,
              has_function_privilege(
                role_name,
                'clinical_continuity_replay_receipt_claim(uuid,jsonb)',
                'EXECUTE'
              ) AS can_claim
         FROM (VALUES ('vhhealth_app'), ('vhhealth_runtime')) AS roles(role_name)
        WHERE to_regrole(role_name) IS NOT NULL`
    );
    for (const row of rows.rows) {
      expect(row).toMatchObject({
        can_select: true,
        can_insert: false,
        can_update: false,
        can_delete: false,
        can_claim: true
      });
    }
  });
});

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/616_imaging_study_link_recovery.sql', import.meta.url),
  'utf8',
);
const RLS_ROLE = 'c6_1e_i06_study_link_rls';

function ownerDatabaseUrl(value) {
  if (!value) return value;
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

function sha256(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

async function expectFailure(client, operation, expected) {
  await client.query('SAVEPOINT expected_i06_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_i06_failure');
  await client.query('RELEASE SAVEPOINT expected_i06_failure');
  expect(failure).toBeDefined();
  expect(failure).toMatchObject(expected);
  return failure;
}

describeIfDb('migration 616 I06 study-link recovery', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const patientUid = randomUUID();
  const otherPatientUid = randomUUID();
  const actorUid = randomUUID();
  const otherActorUid = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let orderId;
  let actorOrderId;
  let malformedOrderId;
  let otherOrderId;
  let valid;
  let actorCross;
  let cross;
  let malformed;
  let receiptId;

  async function createInbox({ rowTenantId, rowOrderId, uid, hash, label }) {
    const partition = `radiology-order:${rowOrderId}:study-link`;
    const predecessor = `${label}-token-10`;
    const token = `${label}-token-11`;
    const duplicate = `i06:study-link:${rowOrderId}:${uid}:${hash}`;
    const offsets = await client.query(
      `INSERT INTO event_consumer_offsets
         (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
          direction, source_partition, consumer_key, generation, cursor_kind,
          high_water_position, high_water_token, retained_from_position,
          retained_from_token, recovery_state, policy_version, policy_signature,
          retention_policy, retention_until, historical_cutoff_event_id,
          backfill_cursor_event_id)
       VALUES
         ('external_interface', $1::uuid, 'tenant', NULL, 'I06', 'inbound',
          $2::text, 'external:I06', 1, 'monotonic_position_and_predecessor',
          10, $3::text, 10, $3::text, 'replaying', 'c-d8-v1',
          $4::text, 'clinical-imaging-730d', NOW() + INTERVAL '730 days', NULL, NULL)
       RETURNING offset_id::text`,
      [rowTenantId, partition, predecessor, `i06-${label}-${suffix}`],
    );
    const inbox = await client.query(
      `INSERT INTO pathway_projector_inbox
         (scope_kind, tenant_id, consumer_key, generation, offset_id, facility_id,
          interface_family, direction, source_partition, source_position,
          source_token, predecessor_token, duplicate_key, command_fingerprint,
          occurred_at, received_at, recorded_at, arrival_class,
          effect_disposition, status, next_attempt_at, policy_version,
          policy_signature, retention_policy, retention_until)
       VALUES
          ('external_interface', $1::uuid, 'external:I06', 1, $2::uuid, NULL,
          'I06', 'inbound', $3::text, 11, $4::text, $5::text, $6::text,
          repeat('a', 64), NOW(), NOW(), NOW(), 'recovery_backlog',
          'late_pending_only', 'pending', NOW(), 'c-d8-v1', $7::text,
          'clinical-imaging-730d', NOW() + INTERVAL '730 days')
       RETURNING inbox_id::text`,
      [rowTenantId, offsets.rows[0].offset_id, partition, token, predecessor, duplicate,
        `i06-${label}-${suffix}`],
    );
    return {
      partition,
      predecessor,
      token,
      duplicate,
      inboxId: inbox.rows[0].inbox_id,
      offsetId: offsets.rows[0].offset_id,
      uid,
      hash,
    };
  }

  function insertReceiptSql() {
    return `INSERT INTO imaging_study_link_recovery_receipts
      (tenant_id, radiology_order_id, patient_uid, study_instance_uid,
       accession_number, source_system, observed_at, payload_ciphertext,
       payload_sha256, payload_bytes, source_partition, source_position,
       source_token, predecessor_token, duplicate_key, recovery_inbox_id,
       recovery_interface_family, owner_actor_uid, owner_reason, evidence)
    VALUES
      ($1::uuid, $2::integer, $3::uuid, $4::text, $5::text, 'pacs-raw-test',
       NOW(), 'ciphertext-fixture', $6::char(64), 128, $7::text, 11,
       $8::text, $9::text, $10::text, $11::uuid, 'I06', $12::uuid,
       'Owner-reviewed raw PostgreSQL fixture',
       '{"byte_parity_verified":true,"order_link_changed":false,"timeline_event_created":false}'::jsonb)
    RETURNING id::text`;
  }

  function receiptParams({ rowTenantId = tenantId, rowOrderId = orderId,
    rowPatientUid = patientUid, rowActorUid = actorUid, fixture = valid } = {}) {
    return [
      rowTenantId,
      rowOrderId,
      rowPatientUid,
      fixture.uid,
      `RAD-${rowOrderId}`,
      fixture.hash,
      fixture.partition,
      fixture.token,
      fixture.predecessor,
      fixture.duplicate,
      fixture.inboxId,
      rowActorUid,
    ];
  }

  beforeAll(async () => {
    await client.connect();
    await client.query(`
      DO $role$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_ROLE}') THEN
          CREATE ROLE ${RLS_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END
      $role$;
    `);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await client.query(`GRANT SELECT ON imaging_study_link_recovery_receipts TO ${RLS_ROLE}`);
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $3::text, 'I06 migration tenant'),
              ($2::uuid, $4::text, 'I06 migration other tenant')`,
      [tenantId, otherTenantId, `i06-migration-${suffix}`, `i06-migration-other-${suffix}`],
    );
    await client.query(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $5::uuid, $7::text, 'I06 patient', 'PATIENT', true, 'active', NOW()),
         ($2::uuid, $6::uuid, $8::text, 'I06 other patient', 'PATIENT', true, 'active', NOW()),
         ($3::uuid, $5::uuid, $9::text, 'I06 actor', 'RADIOLOGIST', true, 'active', NOW()),
         ($4::uuid, $6::uuid, $10::text, 'I06 other actor', 'RADIOLOGIST', true, 'active', NOW())`,
      [patientUid, otherPatientUid, actorUid, otherActorUid, tenantId, otherTenantId,
        `91${suffix.slice(0, 10)}`, `92${suffix.slice(0, 10)}`,
        `93${suffix.slice(0, 10)}`, `94${suffix.slice(0, 10)}`],
    );
    const orders = await client.query(
      `INSERT INTO radiology_orders
         (tenant_id, patient_uid, modality, body_part, clinical_indication,
          priority, status, ordered_by, pacs_study_instance_uid)
       VALUES
         ($1::uuid, $2::uuid, 'CT', 'Chest', 'I06 raw pending proof',
          'routine', 'ordered', $3::uuid, NULL),
         ($1::uuid, $2::uuid, 'US', 'Abdomen', 'I06 raw malformed-hash proof',
          'routine', 'ordered', $3::uuid, NULL),
         ($1::uuid, $2::uuid, 'XR', 'Chest', 'I06 raw cross-actor proof',
          'routine', 'ordered', $3::uuid, NULL),
         ($4::uuid, $5::uuid, 'MR', 'Brain', 'I06 raw cross-tenant proof',
          'urgent', 'ordered', $6::uuid, '1.2.826.0.1.3680043.8.498.600')
       RETURNING tenant_id::text, id, modality`,
      [tenantId, patientUid, actorUid, otherTenantId, otherPatientUid, otherActorUid],
    );
    orderId = Number(orders.rows.find(row => row.tenant_id === tenantId && row.modality === 'CT').id);
    malformedOrderId = Number(
      orders.rows.find(row => row.tenant_id === tenantId && row.modality === 'US').id,
    );
    actorOrderId = Number(
      orders.rows.find(row => row.tenant_id === tenantId && row.modality === 'XR').id,
    );
    otherOrderId = Number(orders.rows.find(row => row.tenant_id === otherTenantId).id);
    const uid = `1.2.826.0.1.3680043.8.498.616.${orderId}`;
    const hash = sha256(`i06-valid-${suffix}`);
    valid = await createInbox({ rowTenantId: tenantId, rowOrderId: orderId, uid, hash, label: 'valid' });
    cross = await createInbox({
      rowTenantId: tenantId,
      rowOrderId: otherOrderId,
      uid: `1.2.826.0.1.3680043.8.498.616.${otherOrderId}`,
      hash: sha256(`i06-cross-${suffix}`),
      label: 'cross',
    });
    actorCross = await createInbox({
      rowTenantId: tenantId,
      rowOrderId: actorOrderId,
      uid: `1.2.826.0.1.3680043.8.498.616.${actorOrderId}`,
      hash: sha256(`i06-actor-cross-${suffix}`),
      label: 'actor-cross',
    });
    const receipt = await client.query(insertReceiptSql(), receiptParams());
    receiptId = receipt.rows[0].id;
    malformed = await createInbox({
      rowTenantId: tenantId,
      rowOrderId: malformedOrderId,
      uid: `1.2.826.0.1.3680043.8.498.616.${malformedOrderId}`,
      hash: 'A'.repeat(64),
      label: 'malformed',
    });
  });

  afterAll(async () => {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('derives migration 616 after the frozen adapter ledger and keeps reads cursor-free', () => {
    const names = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter(name => /^\d+.*\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    const index = names.indexOf('616_imaging_study_link_recovery.sql');
    expect(index).toBeGreaterThan(0);
    expect(names[index - 1]).toBe('615_interop_engine_other_adapter.sql');
    expect(names.slice(index + 1).every(name => Number.parseInt(name, 10) > 616)).toBe(true);
    expect(migrationSql).toContain('Worklist and metadata reads remain synchronous and cursor-free');
    expect(migrationSql).not.toContain('interop_replay_guard');
  });

  test('installs composite provenance, append-only triggers, and restrictive tenant RLS', async () => {
    const constraints = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'imaging_study_link_recovery_receipts'::regclass
          AND conname IN (
            'fk_imaging_study_link_receipts_order',
            'fk_imaging_study_link_receipts_inbox',
            'fk_imaging_study_link_receipts_owner',
            'chk_imaging_study_link_receipts_payload_sha'
          ) ORDER BY conname`,
    );
    expect(constraints.rows.map(row => row.conname)).toEqual([
      'chk_imaging_study_link_receipts_payload_sha',
      'fk_imaging_study_link_receipts_inbox',
      'fk_imaging_study_link_receipts_order',
      'fk_imaging_study_link_receipts_owner',
    ]);
    const triggers = await client.query(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'imaging_study_link_recovery_receipts'::regclass
          AND NOT tgisinternal ORDER BY tgname`,
    );
    expect(triggers.rows.map(row => row.tgname)).toEqual([
      'imaging_study_link_receipt_append_only',
      'validate_imaging_study_link_recovery_receipt',
    ]);
    const policies = await client.query(
      `SELECT policyname, permissive FROM pg_policies
        WHERE tablename = 'imaging_study_link_recovery_receipts'
        ORDER BY policyname`,
    );
    expect(policies.rows).toEqual([
      { policyname: 'imaging_study_link_receipts_explicit_context', permissive: 'RESTRICTIVE' },
      { policyname: 'tenant_isolation', permissive: 'PERMISSIVE' },
    ]);
  });

  test('default-denies absent, empty, bypass, and wrong-tenant raw contexts', async () => {
    const absentClient = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    await absentClient.connect();
    try {
      await absentClient.query(`SET ROLE ${RLS_ROLE}`);
      const absent = await absentClient.query(
        'SELECT COUNT(*)::integer AS count FROM imaging_study_link_recovery_receipts',
      );
      expect(absent.rows[0].count).toBe(0);
    } finally {
      await absentClient.end();
    }
    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    try {
      for (const context of ['', 'bypass', otherTenantId]) {
        await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [context]);
        const hidden = await client.query(
          'SELECT COUNT(*)::integer AS count FROM imaging_study_link_recovery_receipts WHERE tenant_id = $1::uuid',
          [tenantId],
        );
        expect(hidden.rows[0].count).toBe(0);
      }
      await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
      const visible = await client.query(
        'SELECT id FROM imaging_study_link_recovery_receipts WHERE id = $1::bigint',
        [receiptId],
      );
      expect(visible.rowCount).toBe(1);
    } finally {
      await client.query('RESET ROLE');
    }
  });

  test('rejects cross-tenant order identity and drifted pending-inbox provenance', async () => {
    await expectFailure(client, () => client.query(
      insertReceiptSql(),
      receiptParams({
        rowOrderId: otherOrderId,
        rowPatientUid: otherPatientUid,
        fixture: cross,
      }),
    ), { code: '23503', constraint: 'fk_imaging_study_link_receipts_order' });
    await expectFailure(client, () => client.query(
      insertReceiptSql(),
      receiptParams({
        rowOrderId: actorOrderId,
        rowActorUid: otherActorUid,
        fixture: actorCross,
      }),
    ), { code: '23503', constraint: 'fk_imaging_study_link_receipts_owner' });
    const drifted = receiptParams({ fixture: valid });
    drifted[6] = `${valid.partition}:drifted`;
    await expectFailure(client, () => client.query(insertReceiptSql(), drifted), {
      code: '23514',
      constraint: 'chk_imaging_study_link_receipt_recovery_provenance',
    });
  });

  test('rejects malformed hashes and keeps receipts append-only', async () => {
    await expectFailure(client, () => client.query(
      insertReceiptSql(),
      receiptParams({ rowOrderId: malformedOrderId, fixture: malformed }),
    ), { code: '23514', constraint: 'chk_imaging_study_link_receipts_payload_sha' });
    await expectFailure(client, () => client.query(
      `UPDATE imaging_study_link_recovery_receipts
          SET evidence = evidence || '{"tampered":true}'::jsonb
        WHERE id = $1::bigint`,
      [receiptId],
    ), { code: '23514', constraint: 'chk_imaging_study_link_receipt_append_only' });
    await expectFailure(client, () => client.query(
      'DELETE FROM imaging_study_link_recovery_receipts WHERE id = $1::bigint',
      [receiptId],
    ), { code: '23514', constraint: 'chk_imaging_study_link_receipt_append_only' });
  });

  test('raw pending evidence changes neither missing nor existing study links', async () => {
    const rows = await client.query(
      `SELECT tenant_id::text, pacs_study_instance_uid FROM radiology_orders
        WHERE (tenant_id = $1::uuid AND id = $2::integer)
           OR (tenant_id = $3::uuid AND id = $4::integer)
        ORDER BY tenant_id`,
      [tenantId, orderId, otherTenantId, otherOrderId],
    );
    expect(rows.rows.find(row => row.tenant_id === tenantId).pacs_study_instance_uid).toBeNull();
    expect(rows.rows.find(row => row.tenant_id === otherTenantId).pacs_study_instance_uid)
      .toBe('1.2.826.0.1.3680043.8.498.600');
    const timeline = await client.query(
      `SELECT COUNT(*)::integer AS count FROM clinical_timeline_events
        WHERE (tenant_id = $1::uuid AND source_id = $2::text)
           OR (tenant_id = $3::uuid AND source_id = $4::text)`,
      [tenantId, String(orderId), otherTenantId, String(otherOrderId)],
    );
    expect(timeline.rows[0].count).toBe(0);
  });
});

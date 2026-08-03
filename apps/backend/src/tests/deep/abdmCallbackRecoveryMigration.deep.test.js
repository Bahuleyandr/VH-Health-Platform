import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/618_abdm_callback_recovery.sql', import.meta.url),
  'utf8',
);
const RLS_ROLE = 'c6_1f_i16_abdm_rls';

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
  return createHash('sha256').update(value).digest('hex');
}

async function expectFailure(client, operation, expected) {
  await client.query('SAVEPOINT expected_i16_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_i16_failure');
  await client.query('RELEASE SAVEPOINT expected_i16_failure');
  expect(failure).toBeDefined();
  expect(failure).toMatchObject(expected);
  return failure;
}

describeIfDb('migration 618 I16 ABDM recovery integrity', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const actorUid = randomUUID();
  const otherActorUid = randomUUID();
  const patientUid = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const transactionId = `raw-i16-${suffix}`;
  const body = Buffer.from(`{"transactionId":"${transactionId}"}`, 'utf8');
  const bodyHash = sha256(body);
  const authHash = sha256(`auth-${suffix}`);
  let dataRequestId;
  let eventId;
  let inboxId;

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
    await client.query(`GRANT SELECT ON abdm_webhook_events, abdm_data_requests TO ${RLS_ROLE}`);
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $3::text, 'I16 raw tenant'),
              ($2::uuid, $4::text, 'I16 raw other tenant')`,
      [tenantId, otherTenantId, `i16-raw-${suffix}`, `i16-raw-other-${suffix}`],
    );
    await client.query(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $4::uuid, $5::text, 'I16 raw owner', 'ADMIN', true, 'active', NOW()),
         ($2::uuid, $4::uuid, $6::text, 'I16 raw patient', 'PATIENT', true, 'active', NOW()),
         ($3::uuid, $7::uuid, $8::text, 'I16 other owner', 'ADMIN', true, 'active', NOW())`,
      [actorUid, patientUid, otherActorUid, tenantId,
        `93${suffix.slice(0, 10)}`, `94${suffix.slice(0, 10)}`, otherTenantId,
        `95${suffix.slice(0, 10)}`],
    );
    const request = await client.query(
      `INSERT INTO abdm_data_requests
         (transaction_id, consent_id, patient_uid, tenant_id, hi_types, status, created_at)
       VALUES ($1::text, $2::text, $3::uuid, $4::uuid, ARRAY['Prescription'], 'PROCESSING', NOW())
       RETURNING id`,
      [transactionId, `consent-${suffix}`, patientUid, tenantId],
    );
    dataRequestId = request.rows[0].id;
    const event = await client.query(
      `INSERT INTO abdm_webhook_events
         (tenant_id, external_event_id, event_type, source, signature_verified,
          payload, status, environment, metadata, receipt_source, callback_path,
          provider_identity_kind, provider_identity_value, raw_body_ciphertext,
          raw_body_sha256, raw_body_bytes, auth_binding_sha256, authenticated_at,
          related_data_request_id, processed_at)
       VALUES
         ($1::uuid, $2::text, 'health_info_on_request', 'abdm_public_callback', TRUE,
          $3::jsonb, 'processed', 'sandbox', '{}'::jsonb,
          'live_authenticated_callback', '/health-info/on-request',
          'transactionId', $2::text, 'ciphertext', $4::char(64), $5::integer,
          $6::char(64), NOW(), $7::integer, NOW())
       RETURNING id`,
      [tenantId, transactionId, JSON.stringify({ transactionId }), bodyHash,
        body.length, authHash, dataRequestId],
    );
    eventId = event.rows[0].id;
    const offset = await client.query(
      `INSERT INTO event_consumer_offsets
         (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
          direction, source_partition, consumer_key, generation, cursor_kind,
          high_water_position, high_water_token, retained_from_position,
          retained_from_token, recovery_state, policy_version, policy_signature,
          retention_policy, retention_until, historical_cutoff_event_id,
          backfill_cursor_event_id)
       VALUES
         ('external_interface', $1::uuid, 'tenant', NULL, 'I16', 'inbound',
          'abdm:sandbox:inbound', 'external:I16', 1,
          'owner_reconciled_provider_transaction', 10, 'owner-10', 10,
          'owner-10', 'replaying', 'i16-owner-v1', $2::text,
          'abdm-exchange-2555d', NOW() + INTERVAL '2555 days', NULL, NULL)
       RETURNING offset_id::text`,
      [tenantId, `i16-${suffix}`],
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
         ('external_interface', $1::uuid, 'external:I16', 1, $2::uuid, NULL,
          'I16', 'inbound', 'abdm:sandbox:inbound', 11, 'owner-11',
          'owner-10', $3::text, repeat('a', 64), NOW(), NOW(), NOW(),
          'recovery_backlog', 'late_pending_only', 'pending', NOW(),
          'i16-owner-v1', $4::text, 'abdm-exchange-2555d',
          NOW() + INTERVAL '2555 days')
       RETURNING inbox_id::text`,
      [tenantId, offset.rows[0].offset_id, `i16:transactionId:${transactionId}`,
        `i16-${suffix}`],
    );
    inboxId = inbox.rows[0].inbox_id;
  });

  afterAll(async () => {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('follows migration 617 and does not reuse the pre-auth replay guard as a cursor', () => {
    const names = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter(name => /^\d+.*\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    const index = names.indexOf('618_abdm_callback_recovery.sql');
    expect(names[index - 1]).toBe('617_scim_identity_recovery.sql');
    expect(migrationSql).not.toContain('interop_replay_guard');
    expect(migrationSql).toContain('existing abdm_webhook_events ledger');
    expect(migrationSql).toContain('Section 6.8 RLS posture');
    expect(migrationSql).toContain('FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)');
    expect(migrationSql).toContain('assert_abdm_i16_request_claim');
    expect(migrationSql).toContain('automatic resume or delivery executor');
  });

  test('rejects malformed exact-byte evidence and cross-tenant recovery owners', async () => {
    await expectFailure(client, () => client.query(
      `INSERT INTO abdm_webhook_events
         (tenant_id, external_event_id, event_type, signature_verified, payload,
          status, environment, receipt_source, callback_path,
          provider_identity_kind, provider_identity_value, raw_body_ciphertext,
          raw_body_sha256, raw_body_bytes, auth_binding_sha256, authenticated_at)
       VALUES
         ($1::uuid, $2::text, 'health_info_on_request', TRUE, '{}'::jsonb,
          'pending', 'production', 'live_authenticated_callback',
          '/health-info/on-request', 'transactionId', $2::text, 'ciphertext',
          $3::char(64), 20, $4::char(64), NOW())`,
      [tenantId, `bad-hash-${suffix}`, 'A'.repeat(64), authHash],
    ), { code: '23514', constraint: 'chk_abdm_webhook_events_i16_receipt_shape' });

    await expectFailure(client, () => client.query(
      `UPDATE abdm_data_requests
          SET status = 'RECOVERY_PENDING_REVIEW', recovery_inbox_id = $3::uuid,
              recovery_interface_family = 'I16', recovery_owner_uid = $4::uuid,
              recovery_owner_reason = 'cross tenant owner',
              recovery_disposition = 'investigate', recovery_claimed_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, dataRequestId, inboxId, otherActorUid],
    ), { code: '23503' });
  });

  test('accepts the same-tenant claim, rejects provenance drift, and prevents resume', async () => {
    await client.query(
      `UPDATE abdm_data_requests
          SET status = 'RECOVERY_PENDING_REVIEW', recovery_inbox_id = $3::uuid,
              recovery_interface_family = 'I16', recovery_owner_uid = $4::uuid,
              recovery_owner_reason = 'same tenant owner claim',
              recovery_disposition = 'investigate', recovery_claimed_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, dataRequestId, inboxId, actorUid],
    );
    await expectFailure(client, () => client.query(
      `UPDATE abdm_webhook_events
          SET status = 'recovery_pending', processed_at = NULL,
              recovery_inbox_id = $3::uuid, recovery_interface_family = 'I16',
              recovery_owner_uid = $4::uuid,
              recovery_owner_reason = 'raw owner claim',
              recovery_disposition = 'investigate',
              source_partition = 'abdm:production:inbound', source_position = 11,
              source_token = 'owner-11', predecessor_token = 'owner-10',
              duplicate_key = $5::text
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, eventId, inboxId, actorUid, `i16:transactionId:${transactionId}`],
    ), { code: '23514', constraint: 'chk_abdm_i16_recovery_inbox_binding' });
    await client.query(
      `UPDATE abdm_webhook_events
          SET status = 'recovery_pending', processed_at = NULL,
              recovery_inbox_id = $3::uuid, recovery_interface_family = 'I16',
              recovery_owner_uid = $4::uuid,
              recovery_owner_reason = 'raw owner claim',
              recovery_disposition = 'investigate',
              source_partition = 'abdm:sandbox:inbound', source_position = 11,
              source_token = 'owner-11', predecessor_token = 'owner-10',
              duplicate_key = $5::text
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, eventId, inboxId, actorUid, `i16:transactionId:${transactionId}`],
    );
    await expectFailure(client, () => client.query(
      `UPDATE abdm_data_requests SET status = 'PROCESSING'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, dataRequestId],
    ), { code: '23514', constraint: 'chk_abdm_i16_request_claim_immutable' });
    await expectFailure(client, () => client.query(
      `DELETE FROM abdm_webhook_events WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, eventId],
    ), { code: '23514', constraint: 'chk_abdm_i16_receipt_append_only' });
  });

  test('denies recovery rows to absent, empty, bypass, and wrong-tenant RLS contexts', async () => {
    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    for (const context of [null, '', 'bypass', otherTenantId]) {
      if (context === null) await client.query("SELECT set_config('app.current_tenant_id', NULL, true)");
      else await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [context]);
      const events = await client.query(
        'SELECT COUNT(*)::integer AS count FROM abdm_webhook_events WHERE recovery_inbox_id IS NOT NULL',
      );
      const requests = await client.query(
        'SELECT COUNT(*)::integer AS count FROM abdm_data_requests WHERE recovery_inbox_id IS NOT NULL',
      );
      expect(events.rows[0].count).toBe(0);
      expect(requests.rows[0].count).toBe(0);
    }
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    const visible = await client.query(
      `SELECT event.id AS event_id, request.id AS request_id
         FROM abdm_webhook_events event
         JOIN abdm_data_requests request
           ON request.tenant_id = event.tenant_id
          AND request.id = event.related_data_request_id
        WHERE event.recovery_inbox_id IS NOT NULL`,
    );
    expect(visible.rows).toEqual([{ event_id: eventId, request_id: dataRequestId }]);
    await client.query('RESET ROLE');
  });
});

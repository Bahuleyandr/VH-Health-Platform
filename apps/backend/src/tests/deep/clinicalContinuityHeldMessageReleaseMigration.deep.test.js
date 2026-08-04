import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/624_clinical_continuity_held_message_release.sql', import.meta.url),
  'utf8',
);
const SQL_ROLE = 'c5_2_held_release_sql_test';

function ownerDatabaseUrl(value) {
  if (!value) return value;
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

async function expectFailure(client, operation, constraint) {
  await client.query('SAVEPOINT expected_held_release_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_held_release_failure');
  await client.query('RELEASE SAVEPOINT expected_held_release_failure');
  expect(failure).toBeDefined();
  expect(failure).toMatchObject({ code: '23514', constraint });
}

describeIfDb('migration 624 C5.2 held-message release executor', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const actorUid = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let hl7MessageId;
  let interopMessageId;
  let nhcxMessageId;

  beforeAll(async () => {
    await client.connect();
    await client.query(`
      DO $role$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SQL_ROLE}') THEN
          CREATE ROLE ${SQL_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END
      $role$;
    `);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${SQL_ROLE}`);
    await client.query(
      `GRANT SELECT, UPDATE ON hl7_outbound_messages, interop_messages, nhcx_messages,
         clinical_continuity_replay_receipts,
         clinical_continuity_replay_effect_evidence TO ${SQL_ROLE}`,
    );
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'C5.2 held release raw SQL tenant')`,
      [tenantId, `c52-held-${suffix}`],
    );
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    await client.query(
      `INSERT INTO users (
         uid, tenant_id, phone, name, role, is_active, status,
         is_deleted, registered_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::text, 'Held release SQL owner', 'ADMIN',
         TRUE, 'active', FALSE, NOW(), NOW()
       )`,
      [actorUid, tenantId, `+917${Math.floor(100000000 + Math.random() * 899999999)}`],
    );

    const subscription = await client.query(
      `INSERT INTO hl7_feed_subscriptions
         (tenant_id, name, endpoint_url, message_types)
       VALUES ($1::uuid, $2::text, 'https://example.test/hl7', ARRAY['ADT^A01']::text[])
       RETURNING id`,
      [tenantId, `held-${suffix}`],
    );
    const hl7 = await client.query(
      `INSERT INTO hl7_outbound_messages
         (tenant_id, subscription_id, message_type, message_control_id,
          hl7_payload, source_table, source_id, source_event_key, payload_sha256,
          ledger_version, status, transport_state, acknowledgement_state, send_authority)
       VALUES ($1::uuid, $2::integer, 'ADT^A01', $3::text, $4::text,
               'admissions', $5::text, $6::text,
               encode(digest(convert_to($4::text, 'UTF8'), 'sha256'), 'hex'),
               1, 'reconciliation_required', 'lease_expiry_unknown', 'missing',
               'held_owner_reconciliation')
       RETURNING id`,
      [tenantId, subscription.rows[0].id, `CTRL-${suffix}`, `MSH|^~\\&|VH|${suffix}`,
        suffix, `admissions:${suffix}`],
    );
    hl7MessageId = hl7.rows[0].id;

    const system = await client.query(
      `INSERT INTO interop_systems
         (tenant_id, system_key, display_name, kind, direction, status)
       VALUES ($1::uuid, $2::text, 'Held target', 'vh_backend', 'bidirectional', 'active')
       RETURNING id`,
      [tenantId, `held-system-${suffix}`],
    );
    const channel = await client.query(
      `INSERT INTO interop_channels
         (tenant_id, channel_key, display_name, source_system_id, target_system_id,
          direction, connector_kind, protocol, status, auth_kind)
       VALUES ($1::uuid, $2::text, 'Held channel', $3::integer, $3::integer,
               'outbound', 'http_outbound', 'hl7v2', 'active', 'none')
       RETURNING id`,
      [tenantId, `held-channel-${suffix}`, system.rows[0].id],
    );
    const version = await client.query(
      `INSERT INTO interop_channel_versions
         (tenant_id, channel_id, version_number, status)
       VALUES ($1::uuid, $2::integer, 1, 'active') RETURNING id`,
      [tenantId, channel.rows[0].id],
    );
    await client.query(
      `UPDATE interop_channels
          SET active_version_id = $3::integer
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, channel.rows[0].id, version.rows[0].id],
    );
    const interop = await client.query(
      `INSERT INTO interop_messages
         (tenant_id, channel_id, channel_version_id, direction, protocol,
          message_type, external_control_id, dedupe_key, payload_hash,
          raw_payload_ciphertext, status, arrival_class, effect_disposition,
          send_authority, owner_reconciliation_required)
       VALUES ($1::uuid, $2::integer, $3::integer, 'outbound', 'hl7v2',
               'ADT^A01', $4::text, $5::text, repeat('b', 64),
               'held-ciphertext', 'quarantined', 'legacy_unverified',
               'late_pending_only', 'held', true)
       RETURNING id`,
      [tenantId, channel.rows[0].id, version.rows[0].id, `I05-${suffix}`, `i05-${suffix}`],
    );
    interopMessageId = interop.rows[0].id;

    const nhcx = await client.query(
      `INSERT INTO nhcx_messages
         (tenant_id, environment, direction, cycle, endpoint,
          participant_code_self, hcx_api_call_id, hcx_correlation_id,
          hcx_workflow_id, payload_hash, payload_ciphertext, status,
          next_retry_at, created_at, updated_at)
       VALUES ($1::uuid, 'sandbox', 'outbound', 'claim', 'claim/submit',
               'VH-I19', $2::text, $3::text, $4::text, repeat('c', 64),
               'held-nhcx-ciphertext', 'failed', NOW(),
               NOW() - INTERVAL '20 minutes', NOW())
       RETURNING id::text`,
      [tenantId, `api-${suffix}`, `corr-${suffix}`, `workflow-${suffix}`],
    );
    nhcxMessageId = nhcx.rows[0].id;
    const offset = await client.query(
      `INSERT INTO event_consumer_offsets
         (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
          direction, source_partition, consumer_key, generation, cursor_kind,
          high_water_position, high_water_token, retained_from_position,
          retained_from_token, recovery_state, policy_version, policy_signature,
          retention_policy, retention_until, historical_cutoff_event_id,
          backfill_cursor_event_id)
       VALUES ('external_interface', $1::uuid, 'tenant', NULL, 'I19', 'outbound',
               'nhcx:sandbox:outbound:claim/submit', 'external:I19', 1,
               'monotonic_position_and_predecessor', $2::bigint - 1, 'predecessor',
               $2::bigint - 1, 'predecessor', 'replaying', 'held-v1', $3::text,
               'nhcx-exchange-2555d', NOW() + INTERVAL '2555 days', NULL, NULL)
       RETURNING offset_id::text`,
      [tenantId, nhcxMessageId, `held-${suffix}`],
    );
    const inbox = await client.query(
      `INSERT INTO pathway_projector_inbox
         (scope_kind, tenant_id, consumer_key, generation, offset_id, facility_id,
          interface_family, direction, source_partition, source_position,
          source_token, predecessor_token, duplicate_key, command_fingerprint,
          occurred_at, received_at, recorded_at, arrival_class,
          effect_disposition, status, next_attempt_at, policy_version,
          policy_signature, retention_policy, retention_until)
       VALUES ('external_interface', $1::uuid, 'external:I19', 1, $2::uuid, NULL,
               'I19', 'outbound', 'nhcx:sandbox:outbound:claim/submit', $3::bigint,
               'source', 'predecessor', $4::text, repeat('d', 64),
               NOW() - INTERVAL '20 minutes', NOW(), NOW(), 'recovery_backlog',
               'late_pending_only', 'pending', NOW(), 'held-v1', $5::text,
               'nhcx-exchange-2555d', NOW() + INTERVAL '2555 days')
       RETURNING inbox_id::text`,
      [tenantId, offset.rows[0].offset_id, nhcxMessageId,
        `i19:outbound:api-${suffix}`, `held-${suffix}`],
    );
    await client.query(
      `UPDATE nhcx_messages
          SET recovery_inbox_id = $3::uuid, recovery_interface_family = 'I19',
              recovery_owner_uid = $5::uuid,
              recovery_owner_reason = 'Owner requested review',
              recovery_disposition = 'manual_redrive_requested',
              recovery_claimed_at = NOW(), recovery_prior_status = status,
              recovery_evidence = '{"manual":true}'::jsonb,
              source_partition = 'nhcx:sandbox:outbound:claim/submit',
              source_position = id, source_token = 'source',
              predecessor_token = 'predecessor',
              duplicate_key = $4::text, status = 'recovery_pending',
              next_retry_at = NULL
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [tenantId, nhcxMessageId, inbox.rows[0].inbox_id,
        `i19:outbound:api-${suffix}`, actorUid],
    );
  });

  afterAll(async () => {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('occupies fresh slot 624 and exposes only typed per-message functions', () => {
    const names = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter(name => /^\d+.*\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    expect(names.at(-1)).toBe('624_clinical_continuity_held_message_release.sql');
    expect(migrationSql).toContain('clinical_continuity_held_message_release');
    expect(migrationSql).toContain('clinical_continuity_held_release_attest');
    expect(migrationSql).not.toContain('I18\'');
    expect(migrationSql).not.toMatch(/predicate[_ -]bulk|release[_ -]batch/i);
  });

  test('keeps I18 unclassified by default and outside the receipt family constraint', async () => {
    const defaultValue = await client.query(
      `SELECT column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'webhook_subscriptions'
          AND column_name = 'downstream_effect_classification'`,
    );
    expect(defaultValue.rows[0].column_default).toContain('unclassified');
    const familyConstraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname = 'chk_cc_replay_receipt_source_shape'`,
    );
    expect(familyConstraint.rows[0].definition).toContain("'I04'");
    expect(familyConstraint.rows[0].definition).toContain("'I05'");
    expect(familyConstraint.rows[0].definition).toContain("'I19'");
    expect(familyConstraint.rows[0].definition).not.toContain("'I18'");
  });

  test('a privileged application role cannot forge release by direct source SQL', async () => {
    await client.query(`SET LOCAL ROLE ${SQL_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    try {
      await expectFailure(client, () => client.query(
        `UPDATE hl7_outbound_messages
            SET status = 'queued', send_authority = 'authorized',
                owner_release_actor_uid = $3::uuid,
                owner_release_reason = 'forged direct SQL release',
                owner_released_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        [tenantId, hl7MessageId, actorUid],
      ), 'chk_hl7_outbound_held_release_receipt');
      await expectFailure(client, () => client.query(
        `UPDATE interop_messages
            SET status = 'queued', send_authority = 'owner_authorized',
                owner_reconciliation_required = false
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        [tenantId, interopMessageId],
      ), 'chk_interop_message_held_release_receipt');
      await expectFailure(client, () => client.query(
        `UPDATE nhcx_messages SET status = 'pending'
          WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        [tenantId, nhcxMessageId],
      ), 'chk_nhcx_i19_held_release_receipt');
    } finally {
      await client.query('RESET ROLE');
    }
    const states = await client.query(
      `SELECT
         (SELECT status || ':' || send_authority FROM hl7_outbound_messages
           WHERE tenant_id = $1::uuid AND id = $2::integer) AS i04,
         (SELECT status || ':' || send_authority FROM interop_messages
           WHERE tenant_id = $1::uuid AND id = $3::integer) AS i05,
         (SELECT status FROM nhcx_messages
           WHERE tenant_id = $1::uuid AND id = $4::bigint) AS i19`,
      [tenantId, hl7MessageId, interopMessageId, nhcxMessageId],
    );
    expect(states.rows[0]).toEqual({
      i04: 'reconciliation_required:held_owner_reconciliation',
      i05: 'quarantined:held',
      i19: 'recovery_pending',
    });
  });

  test('release functions are fixed-search-path definers with no PUBLIC execution', async () => {
    const functions = await client.query(
      `SELECT p.proname, p.prosecdef,
              array_to_string(p.proconfig, ',') AS config,
              COALESCE(p.proacl::text, '') AS acl
         FROM pg_proc AS p
         JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN (
            'clinical_continuity_held_message_snapshot',
            'clinical_continuity_held_release_attest',
            'clinical_continuity_held_message_release'
          )`,
    );
    expect(functions.rows).toHaveLength(3);
    for (const row of functions.rows) {
      expect(row.prosecdef).toBe(true);
      expect(row.config).toContain('search_path=pg_catalog, pg_temp');
      expect(row.acl).not.toMatch(/(?:\{|,)=X\//);
    }
  });
});

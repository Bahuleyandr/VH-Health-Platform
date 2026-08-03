import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/619_nhcx_message_recovery.sql', import.meta.url),
  'utf8',
);
const RLS_ROLE = 'c6_1f_i19_nhcx_rls';

function ownerDatabaseUrl(value) {
  if (!value) return value;
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

async function expectFailure(client, operation, expected) {
  await client.query('SAVEPOINT expected_i19_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_i19_failure');
  await client.query('RELEASE SAVEPOINT expected_i19_failure');
  expect(failure).toBeDefined();
  expect(failure).toMatchObject(expected);
  return failure;
}

describeIfDb('migration 619 I19 NHCX recovery integrity', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const actorUid = randomUUID();
  const otherActorUid = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let outboundMessageId;
  let inboundMessageId;
  let freshInboundMessageId;
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
    await client.query(`GRANT SELECT ON nhcx_messages TO ${RLS_ROLE}`);
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $3::text, 'I19 raw tenant'),
              ($2::uuid, $4::text, 'I19 raw other tenant')`,
      [tenantId, otherTenantId, `i19-raw-${suffix}`, `i19-raw-other-${suffix}`],
    );
    await client.query(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $3::uuid, $4::text, 'I19 owner', 'ADMIN', true, 'active', NOW()),
         ($2::uuid, $5::uuid, $6::text, 'I19 other owner', 'ADMIN', true, 'active', NOW())`,
      [actorUid, otherActorUid, tenantId, `96${suffix.slice(0, 10)}`,
        otherTenantId, `97${suffix.slice(0, 10)}`],
    );
    const outbound = await client.query(
      `INSERT INTO nhcx_messages
         (tenant_id, environment, direction, cycle, endpoint,
          participant_code_self, hcx_api_call_id, hcx_correlation_id,
          hcx_workflow_id, payload_hash, payload_ciphertext, status,
          next_retry_at, created_at, updated_at)
       VALUES
         ($1::uuid, 'sandbox', 'outbound', 'claim', 'claim/submit',
          'VH-I19', $2::text, $3::text, $4::text, repeat('a', 64),
          'exact-i19-ciphertext', 'failed', NOW(), NOW() - INTERVAL '20 minutes', NOW())
       RETURNING id::text`,
      [tenantId, `api-${suffix}`, `corr-${suffix}`, `workflow-${suffix}`],
    );
    outboundMessageId = outbound.rows[0].id;
    const offset = await client.query(
      `INSERT INTO event_consumer_offsets
         (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
          direction, source_partition, consumer_key, generation, cursor_kind,
          high_water_position, high_water_token, retained_from_position,
          retained_from_token, recovery_state, policy_version, policy_signature,
          retention_policy, retention_until, historical_cutoff_event_id,
          backfill_cursor_event_id)
       VALUES
         ('external_interface', $1::uuid, 'tenant', NULL, 'I19', 'outbound',
          'nhcx:sandbox:outbound:claim/submit', 'external:I19', 1,
          'monotonic_position_and_predecessor', $2::bigint - 1, 'owner-predecessor',
          $2::bigint - 1, 'owner-predecessor', 'replaying', 'i19-owner-v1',
          $3::text, 'nhcx-exchange-2555d', NOW() + INTERVAL '2555 days', NULL, NULL)
       RETURNING offset_id::text`,
      [tenantId, outboundMessageId, `i19-${suffix}`],
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
         ('external_interface', $1::uuid, 'external:I19', 1, $2::uuid, NULL,
          'I19', 'outbound', 'nhcx:sandbox:outbound:claim/submit', $3::bigint,
          'owner-source', 'owner-predecessor', $4::text, repeat('b', 64),
          NOW() - INTERVAL '20 minutes', NOW(), NOW(), 'recovery_backlog',
          'late_pending_only', 'pending', NOW(), 'i19-owner-v1', $5::text,
          'nhcx-exchange-2555d', NOW() + INTERVAL '2555 days')
       RETURNING inbox_id::text`,
      [tenantId, offset.rows[0].offset_id, outboundMessageId,
        `i19:outbound:api-${suffix}`, `i19-${suffix}`],
    );
    inboxId = inbox.rows[0].inbox_id;
    const inbound = await client.query(
      `INSERT INTO nhcx_messages
         (tenant_id, environment, direction, cycle, endpoint,
          participant_code_self, hcx_api_call_id, hcx_correlation_id,
          hcx_workflow_id, payload_hash, payload_ciphertext, status,
          signature_verified, inbound_claim_token, inbound_claimed_at,
          created_at, updated_at)
       VALUES
         ($1::uuid, 'sandbox', 'inbound', 'preauth', 'preauth/on_submit',
          'VH-I19', $2::text, $3::text, $4::text, repeat('c', 64),
          'inbound-ciphertext', 'processing', TRUE, $5::uuid,
          NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes', NOW())
       RETURNING id::text`,
      [tenantId, `in-api-${suffix}`, `in-corr-${suffix}`, `in-workflow-${suffix}`, randomUUID()],
    );
    inboundMessageId = inbound.rows[0].id;
    const fresh = await client.query(
      `INSERT INTO nhcx_messages
         (tenant_id, environment, direction, cycle, endpoint,
          participant_code_self, hcx_api_call_id, payload_hash, status,
          payload_ciphertext, signature_verified, inbound_claim_token,
          inbound_claimed_at, created_at, updated_at)
       VALUES
         ($1::uuid, 'sandbox', 'inbound', 'claim', 'claim/on_submit',
          'VH-I19', $2::text, repeat('d', 64), 'processing',
          'fresh-inbound-ciphertext', TRUE, $3::uuid, NOW(), NOW(), NOW())
       RETURNING id::text`,
      [tenantId, `fresh-api-${suffix}`, randomUUID()],
    );
    freshInboundMessageId = fresh.rows[0].id;
  });

  afterAll(async () => {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('follows migration 618 and keeps inbound identity distinct from a cursor', () => {
    const names = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter(name => /^\d+.*\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    const index = names.indexOf('619_nhcx_message_recovery.sql');
    expect(names[index - 1]).toBe('618_abdm_callback_recovery.sql');
    expect(migrationSql).not.toContain('interop_replay_guard');
    expect(migrationSql).toContain('Inbound callbacks expose no provider');
    expect(migrationSql).toContain('transport sequence, so');
    expect(migrationSql).toContain('correlation/workflow/API-call values remain durable');
    expect(migrationSql).toContain('FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)');
    expect(migrationSql).toContain('Section 6.8 RLS posture');
    expect(migrationSql).toContain('Payment notices');
  });

  test('rejects cross-tenant owners and canonical-inbox provenance drift', async () => {
    await expectFailure(client, () => client.query(
      `UPDATE nhcx_messages
          SET status = 'recovery_pending', next_retry_at = NULL,
              recovery_inbox_id = $3::uuid, recovery_interface_family = 'I19',
              recovery_owner_uid = $4::uuid, recovery_owner_reason = 'cross tenant owner',
              recovery_disposition = 'investigate', recovery_claimed_at = NOW(),
              recovery_prior_status = status, recovery_evidence = '{}'::jsonb,
              source_partition = 'nhcx:sandbox:outbound:claim/submit',
              source_position = id, source_token = 'owner-source',
              predecessor_token = 'owner-predecessor', duplicate_key = $5::text
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [tenantId, outboundMessageId, inboxId, otherActorUid, `i19:outbound:api-${suffix}`],
    ), { code: '23503', constraint: 'fk_nhcx_messages_recovery_owner' });

    await expectFailure(client, () => client.query(
      `UPDATE nhcx_messages
          SET status = 'recovery_pending', next_retry_at = NULL,
              recovery_inbox_id = $3::uuid, recovery_interface_family = 'I19',
              recovery_owner_uid = $4::uuid, recovery_owner_reason = 'drifted position',
              recovery_disposition = 'investigate', recovery_claimed_at = NOW(),
              recovery_prior_status = status, recovery_evidence = '{}'::jsonb,
              source_partition = 'nhcx:sandbox:outbound:claim/submit',
              source_position = id + 1, source_token = 'owner-source',
              predecessor_token = 'owner-predecessor', duplicate_key = $5::text
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [tenantId, outboundMessageId, inboxId, actorUid, `i19:outbound:api-${suffix}`],
    ), { code: '23514', constraint: 'chk_nhcx_i19_recovery_inbox_binding' });
  });

  test('freezes exact outbound evidence and makes the disposition immutable', async () => {
    await client.query(
      `UPDATE nhcx_messages
          SET status = 'recovery_pending', next_retry_at = NULL,
              recovery_inbox_id = $3::uuid, recovery_interface_family = 'I19',
              recovery_owner_uid = $4::uuid, recovery_owner_reason = 'same tenant owner',
              recovery_disposition = 'investigate', recovery_claimed_at = NOW(),
              recovery_prior_status = status,
              recovery_evidence = '{"exact_ciphertext_byte_parity_verified":true}'::jsonb,
              source_partition = 'nhcx:sandbox:outbound:claim/submit',
              source_position = id, source_token = 'owner-source',
              predecessor_token = 'owner-predecessor', duplicate_key = $5::text
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [tenantId, outboundMessageId, inboxId, actorUid, `i19:outbound:api-${suffix}`],
    );
    await expectFailure(client, () => client.query(
      `UPDATE nhcx_messages SET status = 'pending'
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [tenantId, outboundMessageId],
    ), { code: '23514', constraint: 'chk_nhcx_i19_recovery_immutable' });
    await expectFailure(client, () => client.query(
      `DELETE FROM nhcx_messages WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [tenantId, outboundMessageId],
    ), { code: '23514', constraint: 'chk_nhcx_i19_recovery_immutable' });
  });

  test('claims stale inbound processing without replay and rejects fresh or payment claims', async () => {
    await expectFailure(client, () => client.query(
      `UPDATE nhcx_messages SET payload_ciphertext = 'rewritten-ciphertext'
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [tenantId, freshInboundMessageId],
    ), { code: '23514', constraint: 'chk_nhcx_i19_inbound_claim_immutable' });
    await client.query(
      `UPDATE nhcx_messages
          SET status = 'recovery_pending', inbound_owner_uid = $3::uuid,
              inbound_owner_reason = 'stale processing owner claim',
              inbound_owner_disposition = 'investigate',
              inbound_owner_claimed_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [tenantId, inboundMessageId, actorUid],
    );
    await expectFailure(client, () => client.query(
      `UPDATE nhcx_messages
          SET status = 'recovery_pending', inbound_owner_uid = $3::uuid,
              inbound_owner_reason = 'not stale',
              inbound_owner_disposition = 'investigate',
              inbound_owner_claimed_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [tenantId, freshInboundMessageId, actorUid],
    ), { code: '23514', constraint: 'chk_nhcx_i19_inbound_claim_transition' });
    await expectFailure(client, () => client.query(
      `INSERT INTO nhcx_messages
         (tenant_id, environment, direction, cycle, endpoint,
          participant_code_self, hcx_api_call_id, payload_hash, status,
          inbound_claim_token, inbound_claimed_at)
       VALUES
         ($1::uuid, 'sandbox', 'inbound', 'payment_notice', 'paymentnotice/request',
          'VH-I19', $2::text, repeat('e', 64), 'processing', $3::uuid, NOW())`,
      [tenantId, `payment-api-${suffix}`, randomUUID()],
    ), { code: '23514', constraint: 'chk_nhcx_messages_i19_inbound_claim_shape' });
    await expectFailure(client, () => client.query(
      `UPDATE nhcx_messages SET status = 'processing'
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [tenantId, inboundMessageId],
    ), { code: '23514', constraint: 'chk_nhcx_i19_inbound_recovery_immutable' });
  });

  test('denies owner-recovery rows to absent, empty, bypass, and wrong-tenant RLS contexts', async () => {
    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    for (const context of [null, '', 'bypass', otherTenantId]) {
      if (context === null) await client.query("SELECT set_config('app.current_tenant_id', NULL, true)");
      else await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [context]);
      const rows = await client.query(
        `SELECT COUNT(*)::integer AS count FROM nhcx_messages
          WHERE recovery_inbox_id IS NOT NULL OR inbound_owner_uid IS NOT NULL`,
      );
      expect(rows.rows[0].count).toBe(0);
    }
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    const visible = await client.query(
      `SELECT id::text FROM nhcx_messages
        WHERE recovery_inbox_id IS NOT NULL OR inbound_owner_uid IS NOT NULL
        ORDER BY id`,
    );
    expect(visible.rows).toHaveLength(2);
    expect(visible.rows).toEqual(expect.arrayContaining([
      { id: outboundMessageId },
      { id: inboundMessageId },
    ]));
    await client.query('RESET ROLE');
  });
});

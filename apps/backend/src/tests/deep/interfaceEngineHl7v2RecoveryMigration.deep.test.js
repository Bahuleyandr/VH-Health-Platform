import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/611_interop_engine_hl7v2_recovery.sql', import.meta.url),
  'utf8',
);
const RLS_ROLE = 'c6_1e_i05_hl7v2_rls_test';

describe('migration 611 I05 HL7v2 recovery source', () => {
  test('does not rewrite existing interface-message rows', () => {
    expect(migrationSql).not.toMatch(
      /^\s*(?:UPDATE|DELETE FROM|INSERT INTO)\s+public\.interop_messages\b/im,
    );
  });
});

function migrationOwnerDatabaseUrl(value) {
  if (!value) return value;
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

async function expectFailure(client, operation, expected) {
  await client.query('SAVEPOINT expected_i05_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_i05_failure');
  await client.query('RELEASE SAVEPOINT expected_i05_failure');
  expect(failure).toBeDefined();
  expect(failure).toMatchObject(expected);
  return failure;
}

describeIfDb('migration 611 I05 HL7v2 recovery', () => {
  const client = new Client({ connectionString: migrationOwnerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const payload = `MSH|^~\\&|VH|HOSPITAL|REMOTE|HOSPITAL|20260802120000||ADT^A01|CTRL-${suffix}|P|2.5\rPID|1||patient-${suffix}`;
  let systemId;
  let channelId;
  let versionId;
  let otherSystemId;
  let otherChannelId;
  let otherVersionId;
  let inboundMessageId;
  let outboundMessageId;
  let liveMessageId;
  let receiptId;

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
    await client.query(
      `GRANT SELECT ON interop_systems, interop_channels,
         interop_channel_versions, interop_messages, interop_message_attempts,
         interop_transform_tests, interop_replay_batches, interop_worker_leases,
         interop_backend_delivery_receipts TO ${RLS_ROLE}`,
    );
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $3::text, 'C6.1-E I05 migration tenant'),
              ($2::uuid, $4::text, 'C6.1-E I05 other tenant')`,
      [tenantId, otherTenantId, `c61e-i05-${suffix}`, `c61e-i05-other-${suffix}`],
    );

    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    const systems = await client.query(
      `INSERT INTO interop_systems
         (tenant_id, system_key, display_name, kind, direction, status)
       VALUES ($1::uuid, $2::text, 'I05 target', 'vh_backend', 'bidirectional', 'active')
       RETURNING id`,
      [tenantId, `target-${suffix}`],
    );
    systemId = systems.rows[0].id;
    const channels = await client.query(
      `INSERT INTO interop_channels
         (tenant_id, channel_key, display_name, source_system_id, target_system_id,
          direction, connector_kind, protocol, status, auth_kind)
       VALUES ($1::uuid, $2::text, 'I05 HL7v2', $3::integer, $3::integer,
               'bidirectional', 'internal_backend', 'hl7v2', 'active', 'internal')
       RETURNING id`,
      [tenantId, `channel-${suffix}`, systemId],
    );
    channelId = channels.rows[0].id;
    const versions = await client.query(
      `INSERT INTO interop_channel_versions
         (tenant_id, channel_id, version_number, status)
       VALUES ($1::uuid, $2::integer, 1, 'active') RETURNING id`,
      [tenantId, channelId],
    );
    versionId = versions.rows[0].id;

    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [otherTenantId]);
    const otherSystems = await client.query(
      `INSERT INTO interop_systems
         (tenant_id, system_key, display_name, kind, direction, status)
       VALUES ($1::uuid, $2::text, 'Other I05 target', 'vh_backend', 'bidirectional', 'active')
       RETURNING id`,
      [otherTenantId, `other-target-${suffix}`],
    );
    otherSystemId = otherSystems.rows[0].id;
    const otherChannels = await client.query(
      `INSERT INTO interop_channels
         (tenant_id, channel_key, display_name, source_system_id, target_system_id,
          direction, connector_kind, protocol, status, auth_kind)
       VALUES ($1::uuid, $2::text, 'Other I05 HL7v2', $3::integer, $3::integer,
               'bidirectional', 'internal_backend', 'hl7v2', 'active', 'internal')
       RETURNING id`,
      [otherTenantId, `other-channel-${suffix}`, otherSystemId],
    );
    otherChannelId = otherChannels.rows[0].id;
    const otherVersions = await client.query(
      `INSERT INTO interop_channel_versions
         (tenant_id, channel_id, version_number, status)
       VALUES ($1::uuid, $2::integer, 1, 'active') RETURNING id`,
      [otherTenantId, otherChannelId],
    );
    otherVersionId = otherVersions.rows[0].id;

    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    const messages = await client.query(
      `INSERT INTO interop_messages
         (tenant_id, channel_id, channel_version_id, direction, protocol,
          message_type, external_control_id, dedupe_key, payload_hash,
          raw_payload_ciphertext, status, arrival_class, effect_disposition,
          send_authority, owner_reconciliation_required)
       VALUES
         ($1::uuid, $2::integer, $3::integer, 'inbound', 'hl7v2', 'ADT^A01',
          $4::text, $5::text,
          encode(digest(convert_to($6::text, 'UTF8'), 'sha256'), 'hex'),
          'ciphertext-inbound', 'quarantined', 'legacy_unverified',
          'late_pending_only', 'held', true),
         ($1::uuid, $2::integer, $3::integer, 'outbound', 'hl7v2', 'ADT^A01',
          $7::text, $8::text,
          encode(digest(convert_to($6::text, 'UTF8'), 'sha256'), 'hex'),
          'ciphertext-outbound', 'quarantined', 'legacy_unverified',
          'late_pending_only', 'held', true),
         ($1::uuid, $2::integer, $3::integer, 'inbound', 'hl7v2', 'ADT^A01',
          $9::text, $10::text,
          encode(digest(convert_to($6::text, 'UTF8'), 'sha256'), 'hex'),
          'ciphertext-live', 'received', 'live', 'live', 'live_authorized', false)
       RETURNING id, direction, arrival_class`,
      [tenantId, channelId, versionId, `IN-${suffix}`, `in-${suffix}`, payload,
        `OUT-${suffix}`, `out-${suffix}`, `LIVE-${suffix}`, `live-${suffix}`],
    );
    inboundMessageId = messages.rows.find(row => row.direction === 'inbound' && row.arrival_class === 'legacy_unverified').id;
    outboundMessageId = messages.rows.find(row => row.direction === 'outbound').id;
    liveMessageId = messages.rows.find(row => row.arrival_class === 'live').id;
    const receipts = await client.query(
      `INSERT INTO interop_backend_delivery_receipts
         (tenant_id, message_id, channel_id, channel_version_id, protocol,
          direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
          receipt_status, evidence)
       VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, 'hl7v2',
               'inbound', 'backend.interop.preview', 'vhhealth.i05.hl7v2/v1',
               encode(digest(convert_to($5::text, 'UTF8'), 'sha256'), 'hex'),
               octet_length(convert_to($5::text, 'UTF8')), 'accepted',
               '{"byte_parity_verified":true}'::jsonb)
       RETURNING id::text`,
      [tenantId, liveMessageId, channelId, versionId, payload],
    );
    receiptId = receipts.rows[0].id;
  });

  afterAll(async () => {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('derives migration 611 after the frozen E1 ledger and does not repurpose the pre-auth replay guard', () => {
    const names = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter(name => /^\d+.*\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    const migrationIndex = names.indexOf('611_interop_engine_hl7v2_recovery.sql');
    expect(migrationIndex).toBeGreaterThan(0);
    expect(names[migrationIndex - 1]).toBe('610_hl7_outbound_recovery.sql');
    expect(names.slice(migrationIndex + 1).every(name => Number.parseInt(name, 10) > 611)).toBe(true);
    expect(migrationSql).toContain('adapt the generic interface-engine ledger in place');
    expect(migrationSql).not.toContain('interop_replay_guard');
  });

  test('layers fail-closed RLS over the adapted ledger and receipt', async () => {
    const tables = [
      'interop_systems', 'interop_channels', 'interop_channel_versions',
      'interop_messages', 'interop_message_attempts', 'interop_transform_tests',
      'interop_replay_batches', 'interop_worker_leases',
      'interop_backend_delivery_receipts',
    ];
    const policies = await client.query(
      `SELECT tablename, policyname, permissive FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [tables],
    );
    for (const table of tables) {
      expect(policies.rows).toContainEqual(expect.objectContaining({
        tablename: table,
        policyname: 'interop_explicit_context',
        permissive: 'RESTRICTIVE',
      }));
    }
    expect(policies.rows).toContainEqual(expect.objectContaining({
      tablename: 'interop_backend_delivery_receipts',
      policyname: 'tenant_isolation',
    }));
  });

  test('default-denies absent, empty, bypass, and wrong-tenant raw contexts', async () => {
    const absentClient = new Client({ connectionString: migrationOwnerDatabaseUrl(databaseUrl) });
    await absentClient.connect();
    try {
      await absentClient.query(`SET ROLE ${RLS_ROLE}`);
      const absent = await absentClient.query('SELECT COUNT(*)::integer AS count FROM interop_messages');
      expect(absent.rows[0].count).toBe(0);
    } finally {
      await absentClient.end();
    }
    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    try {
      for (const context of ['', 'bypass', otherTenantId]) {
        await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [context]);
        const hidden = await client.query(
          `SELECT COUNT(*)::integer AS count FROM interop_messages
            WHERE tenant_id = $1::uuid`,
          [tenantId],
        );
        expect(hidden.rows[0].count).toBe(0);
      }
      await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
      const visible = await client.query(
        'SELECT id FROM interop_messages WHERE id = $1::integer',
        [liveMessageId],
      );
      expect(visible.rowCount).toBe(1);
    } finally {
      await client.query('RESET ROLE');
    }
  });

  test('enforces composite tenant FKs on new rows despite retained historical orphans', async () => {
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    await expectFailure(client, () => client.query(
      `INSERT INTO interop_messages
         (tenant_id, channel_id, channel_version_id, direction, protocol,
          dedupe_key, payload_hash, status, arrival_class, effect_disposition,
          send_authority, owner_reconciliation_required)
       VALUES ($1::uuid, $2::integer, $3::integer, 'inbound', 'hl7v2',
               $4::text, repeat('a', 64), 'received', 'live', 'live',
               'live_authorized', false)`,
      [tenantId, otherChannelId, otherVersionId, `cross-${suffix}`],
    ), { code: '23503', constraint: 'fk_interop_messages_channel_tenant' });
  });

  test('suppresses late inbound delivery and late outbound send independently', async () => {
    await expectFailure(client, () => client.query(
      `UPDATE interop_messages SET status = 'delivered'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, inboundMessageId],
    ), { code: '23514', constraint: 'chk_interop_message_late_effect_suppression' });
    await expectFailure(client, () => client.query(
      `UPDATE interop_messages SET status = 'queued'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, outboundMessageId],
    ), { code: '23514', constraint: 'chk_interop_message_late_effect_suppression' });
  });

  test('requires a live send-authority lease and fences stale outbound claims', async () => {
    const claimToken = randomUUID();
    const messages = await client.query(
      `INSERT INTO interop_messages
         (tenant_id, channel_id, channel_version_id, direction, protocol,
          message_type, external_control_id, dedupe_key, payload_hash,
          raw_payload_ciphertext, status, arrival_class, effect_disposition,
          send_authority, owner_reconciliation_required)
       VALUES ($1::uuid, $2::integer, $3::integer, 'outbound', 'hl7v2',
               'ADT^A01', $4::text, $5::text,
               encode(digest(convert_to($6::text, 'UTF8'), 'sha256'), 'hex'),
               'ciphertext-claim', 'queued', 'live', 'live',
               'live_authorized', false)
       RETURNING id`,
      [tenantId, channelId, versionId, `CLAIM-${suffix}`, `claim-${suffix}`, payload],
    );
    const messageId = messages.rows[0].id;
    const claimed = await client.query(
      `UPDATE interop_messages
          SET status = 'delivering', delivery_claim_token = $3::uuid,
              delivery_claim_generation = delivery_claim_generation + 1,
              delivery_claimed_at = NOW(),
              delivery_lease_expires_at = NOW() + INTERVAL '2 minutes'
        WHERE tenant_id = $1::uuid AND id = $2::integer AND status = 'queued'
        RETURNING delivery_claim_generation`,
      [tenantId, messageId, claimToken],
    );
    expect(claimed.rows[0].delivery_claim_generation).toBe(1);
    const stale = await client.query(
      `UPDATE interop_messages
          SET status = 'delivered', delivery_claim_token = NULL,
              delivery_claimed_at = NULL, delivery_lease_expires_at = NULL
        WHERE tenant_id = $1::uuid AND id = $2::integer
          AND delivery_claim_token = $3::uuid`,
      [tenantId, messageId, randomUUID()],
    );
    expect(stale.rowCount).toBe(0);
    const heldClaim = await client.query(
      `SELECT status, delivery_claim_token::text
         FROM interop_messages WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, messageId],
    );
    expect(heldClaim.rows[0]).toEqual({ status: 'delivering', delivery_claim_token: claimToken });
  });

  test('enforces byte/hash parity and append-only attempts and protocol receipts', async () => {
    await expectFailure(client, () => client.query(
      `INSERT INTO interop_backend_delivery_receipts
         (tenant_id, message_id, channel_id, channel_version_id, protocol,
          direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
          receipt_status)
       VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, 'hl7v2',
                'inbound', 'backend.interop.preview', 'vhhealth.i05.hl7v2/v1',
               repeat('0', 64), 1, 'accepted')`,
      [tenantId, liveMessageId, channelId, versionId],
    ), { code: '23514', constraint: 'chk_interop_backend_receipt_message_parity' });
    await expectFailure(client, () => client.query(
      `UPDATE interop_backend_delivery_receipts SET payload_bytes = payload_bytes + 1
        WHERE id = $1::bigint`,
      [receiptId],
    ), { code: '23514', constraint: 'chk_interop_delivery_evidence_append_only' });
    const attempts = await client.query(
      `INSERT INTO interop_message_attempts
         (tenant_id, message_id, channel_version_id, attempt_number,
          phase, status, finished_at, metrics)
       VALUES ($1::uuid, $2::integer, $3::integer, 1,
               'deliver_backend', 'ok', NOW(), '{}'::jsonb)
       RETURNING id`,
      [tenantId, liveMessageId, versionId],
    );
    await expectFailure(client, () => client.query(
      `UPDATE interop_message_attempts SET status = 'failed'
        WHERE id = $1::integer`,
      [attempts.rows[0].id],
    ), { code: '23514', constraint: 'chk_interop_delivery_evidence_append_only' });
  });

  test('keeps adapter activation limited to the landed database contract', async () => {
    await expectFailure(client, () => client.query(
      `INSERT INTO interop_backend_delivery_receipts
         (tenant_id, message_id, channel_id, channel_version_id, protocol,
          direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
          receipt_status)
       VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, 'hl7v2',
               'inbound', 'backend.unregistered', 'vhhealth.i05.hl7v2/v1',
               (SELECT payload_hash FROM interop_messages WHERE id = $2::integer),
               1, 'accepted')`,
      [tenantId, liveMessageId, channelId, versionId],
    ), { code: '23514', constraint: 'chk_interop_backend_receipts_adapter_direction' });
    await expectFailure(client, () => client.query(
      `WITH json_message AS (
         INSERT INTO interop_messages
           (tenant_id, channel_id, channel_version_id, direction, protocol,
            dedupe_key, payload_hash, status, arrival_class, effect_disposition,
            send_authority, owner_reconciliation_required)
         VALUES ($1::uuid, $2::integer, $3::integer, 'inbound', 'json',
                 $4::text, repeat('a', 64), 'received', 'live', 'live',
                 'live_authorized', false)
         RETURNING id
       )
       INSERT INTO interop_backend_delivery_receipts
         (tenant_id, message_id, channel_id, channel_version_id, protocol,
          direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
          receipt_status)
       SELECT $1::uuid, json_message.id, $2::integer, $3::integer, 'json',
               'inbound', 'backend.interop.json', 'vhhealth.i05.json/v1',
               repeat('a', 64), 1, 'accepted'
         FROM json_message`,
      [tenantId, channelId, versionId, `json-${suffix}`],
    ), { code: '23514', constraint: 'chk_interop_backend_receipts_adapter_direction' });
    expect(otherSystemId).toBeGreaterThan(0);
  });
});

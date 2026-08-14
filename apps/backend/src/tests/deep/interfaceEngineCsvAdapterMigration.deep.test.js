import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/612_interop_engine_csv_adapter.sql', import.meta.url),
  'utf8',
);
const RLS_ROLE = 'c6_1e_i05_csv_rls_test';

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
  await client.query('SAVEPOINT expected_csv_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_csv_failure');
  await client.query('RELEASE SAVEPOINT expected_csv_failure');
  expect(failure).toBeDefined();
  expect(failure).toMatchObject(expected);
  return failure;
}

describeIfDb('migration 612 I05 CSV adapter', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const payload = `patient_id,name\r\np-${suffix},"Asha, Rao"`;
  let channelId;
  let versionId;
  let otherChannelId;
  let otherVersionId;
  let liveMessageId;
  let lateInboundId;
  let lateOutboundId;
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
    await client.query(`GRANT SELECT ON interop_messages, interop_backend_delivery_receipts TO ${RLS_ROLE}`);
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $3::text, 'I05 CSV migration tenant'),
              ($2::uuid, $4::text, 'I05 CSV other tenant')`,
      [tenantId, otherTenantId, `i05-csv-${suffix}`, `i05-csv-other-${suffix}`],
    );

    async function createChannel(tenant, key) {
      await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenant]);
      const systems = await client.query(
        `INSERT INTO interop_systems
           (tenant_id, system_key, display_name, kind, direction, status)
         VALUES ($1::uuid, $2::text, 'CSV target', 'vh_backend', 'bidirectional', 'active') RETURNING id`,
        [tenant, `${key}-system`],
      );
      // Deliberately NOT activated — see the note in
      // src/tests/helpers/interfaceEngineAdapterMigrationContract.js. Migration
      // 665 (re-planted by 670) only accepts an active channel for a connector
      // the runtime drives, and `internal_backend` has no driver. This suite
      // asserts migration 612's ledger and receipt constraints, none of which
      // read channel status. Activation is asserted in
      // src/tests/deep/interfaceEngineRuntimeActivation.deep.test.js.
      const channels = await client.query(
        `INSERT INTO interop_channels
           (tenant_id, channel_key, display_name, source_system_id, target_system_id,
            direction, connector_kind, protocol, status, auth_kind)
         VALUES ($1::uuid, $2::text, 'CSV channel', $3::integer, $3::integer,
                 'bidirectional', 'internal_backend', 'csv', 'draft', 'internal') RETURNING id`,
        [tenant, key, systems.rows[0].id],
      );
      const versions = await client.query(
        `INSERT INTO interop_channel_versions (tenant_id, channel_id, version_number, status)
         VALUES ($1::uuid, $2::integer, 1, 'candidate') RETURNING id`,
        [tenant, channels.rows[0].id],
      );
      return [channels.rows[0].id, versions.rows[0].id];
    }

    [channelId, versionId] = await createChannel(tenantId, `csv-${suffix}`);
    [otherChannelId, otherVersionId] = await createChannel(otherTenantId, `csv-other-${suffix}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    const messages = await client.query(
      `INSERT INTO interop_messages
         (tenant_id, channel_id, channel_version_id, direction, protocol,
          dedupe_key, payload_hash, raw_payload_ciphertext, status, arrival_class,
          effect_disposition, send_authority, owner_reconciliation_required)
       VALUES
         ($1::uuid, $2::integer, $3::integer, 'inbound', 'csv', $4::text,
          encode(digest(convert_to($7::text, 'UTF8'), 'sha256'), 'hex'), 'cipher-live',
          'received', 'live', 'live', 'live_authorized', false),
         ($1::uuid, $2::integer, $3::integer, 'inbound', 'csv', $5::text,
          encode(digest(convert_to($7::text, 'UTF8'), 'sha256'), 'hex'), 'cipher-late-in',
          'quarantined', 'recovery_backlog', 'late_pending_only', 'held', true),
         ($1::uuid, $2::integer, $3::integer, 'outbound', 'csv', $6::text,
          encode(digest(convert_to($7::text, 'UTF8'), 'sha256'), 'hex'), 'cipher-late-out',
          'quarantined', 'recovery_backlog', 'late_pending_only', 'held', true)
       RETURNING id, direction, arrival_class`,
      [tenantId, channelId, versionId, `live-${suffix}`, `late-in-${suffix}`, `late-out-${suffix}`, payload],
    );
    liveMessageId = messages.rows.find(row => row.arrival_class === 'live').id;
    lateInboundId = messages.rows.find(row => row.direction === 'inbound' && row.arrival_class !== 'live').id;
    lateOutboundId = messages.rows.find(row => row.direction === 'outbound').id;
    const receipts = await client.query(
      `INSERT INTO interop_backend_delivery_receipts
         (tenant_id, message_id, channel_id, channel_version_id, protocol,
          direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
          receipt_status, evidence)
       VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, 'csv',
               'inbound', 'backend.interop.csv', 'vhhealth.i05.csv/v1',
               encode(digest(convert_to($5::text, 'UTF8'), 'sha256'), 'hex'),
               octet_length(convert_to($5::text, 'UTF8')), 'accepted',
               '{"byte_parity_verified":true}'::jsonb) RETURNING id::text`,
      [tenantId, liveMessageId, channelId, versionId, payload],
    );
    receiptId = receipts.rows[0].id;
  });

  afterAll(async () => {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('derives migration 612 after HL7v2 without repurposing the pre-auth replay fence', () => {
    const names = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter(name => /^\d+.*\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    const index = names.indexOf('612_interop_engine_csv_adapter.sql');
    expect(index).toBeGreaterThan(0);
    expect(names[index - 1]).toBe('611_interop_engine_hl7v2_recovery.sql');
    expect(names.slice(index + 1).every(name => Number.parseInt(name, 10) > 612)).toBe(true);
    expect(migrationSql).toContain('activate exactly one additional protocol adapter');
    expect(migrationSql).not.toContain('interop_replay_guard');
  });

  test('default-denies absent, empty, bypass, and wrong-tenant raw contexts', async () => {
    const absentClient = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
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
          'SELECT COUNT(*)::integer AS count FROM interop_messages WHERE tenant_id = $1::uuid',
          [tenantId],
        );
        expect(hidden.rows[0].count).toBe(0);
      }
      await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
      const visible = await client.query('SELECT id FROM interop_messages WHERE id = $1::integer', [liveMessageId]);
      expect(visible.rowCount).toBe(1);
    } finally {
      await client.query('RESET ROLE');
    }
  });

  test('enforces tenant provenance, exact protocol adapters, byte parity, and append-only evidence', async () => {
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    await expectFailure(client, () => client.query(
      `INSERT INTO interop_messages
         (tenant_id, channel_id, channel_version_id, direction, protocol,
          dedupe_key, payload_hash, status, arrival_class, effect_disposition,
          send_authority, owner_reconciliation_required)
       VALUES ($1::uuid, $2::integer, $3::integer, 'inbound', 'csv', $4::text,
               repeat('a', 64), 'received', 'live', 'live', 'live_authorized', false)`,
      [tenantId, otherChannelId, otherVersionId, `cross-${suffix}`],
    ), { code: '23503', constraint: 'fk_interop_messages_channel_tenant' });
    for (const [protocol, adapter] of [['xml', 'backend.interop.xml'], ['csv', 'backend.interop.preview']]) {
      await expectFailure(client, () => client.query(
        `INSERT INTO interop_backend_delivery_receipts
           (tenant_id, message_id, channel_id, channel_version_id, protocol,
            direction, adapter_key, adapter_version, payload_sha256, payload_bytes, receipt_status)
         VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, $5::text,
                 'inbound', $6::text, 'invalid/v1',
                 (SELECT payload_hash FROM interop_messages WHERE id = $2::integer),
                 1, 'accepted')`,
        [tenantId, liveMessageId, channelId, versionId, protocol, adapter],
      ), { code: '23514' });
    }
    await expectFailure(client, () => client.query(
      `INSERT INTO interop_backend_delivery_receipts
         (tenant_id, message_id, channel_id, channel_version_id, protocol,
          direction, adapter_key, adapter_version, payload_sha256, payload_bytes, receipt_status)
       VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, 'csv',
               'inbound', 'backend.interop.csv', 'vhhealth.i05.csv/v1', repeat('0', 64), 1, 'accepted')`,
      [tenantId, liveMessageId, channelId, versionId],
    ), { code: '23514', constraint: 'chk_interop_backend_receipt_message_parity' });
    await expectFailure(client, () => client.query(
      'UPDATE interop_backend_delivery_receipts SET evidence = evidence || \'{"tampered":true}\'::jsonb WHERE id = $1::bigint',
      [receiptId],
    ), { code: '23514', constraint: 'chk_interop_delivery_evidence_append_only' });
  });

  test('suppresses late inbound effects and late outbound sends independently', async () => {
    // Two independent guards refuse a late inbound `delivered`, and migration
    // 665's is now the one that speaks first: BEFORE-row triggers fire in name
    // order, so `assert_interop_message_delivery_evidence` runs ahead of 611's
    // `validate_interop_message_recovery_transition`. It refuses because no
    // accepted same-message receipt exists — and for a `late_pending_only`
    // message one cannot exist, since `validate_interop_backend_receipt`
    // requires the applied owner-release proof before it will accept one. The
    // late-effect fence is asserted directly on `replayed` below, a status
    // 665's evidence guard does not cover, so both guards stay pinned.
    await expectFailure(client, () => client.query(
      'UPDATE interop_messages SET status = \'delivered\' WHERE tenant_id = $1::uuid AND id = $2::integer',
      [tenantId, lateInboundId],
    ), { code: '23514', constraint: 'chk_interop_delivery_acceptance_evidence' });
    await expectFailure(client, () => client.query(
      'UPDATE interop_messages SET status = \'replayed\' WHERE tenant_id = $1::uuid AND id = $2::integer',
      [tenantId, lateInboundId],
    ), { code: '23514', constraint: 'chk_interop_message_late_effect_suppression' });
    await expectFailure(client, () => client.query(
      'UPDATE interop_messages SET status = \'queued\' WHERE tenant_id = $1::uuid AND id = $2::integer',
      [tenantId, lateOutboundId],
    ), { code: '23514', constraint: 'chk_interop_message_late_effect_suppression' });
  });
});

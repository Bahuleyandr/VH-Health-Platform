import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

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
  await client.query('SAVEPOINT expected_adapter_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_adapter_failure');
  await client.query('RELEASE SAVEPOINT expected_adapter_failure');
  expect(failure).toBeDefined();
  expect(failure).toMatchObject(expected);
}

export function defineI05AdapterMigrationContract({
  migrationNumber,
  migrationFilename,
  previousMigrationFilename,
  protocol,
  inboundAdapterKey,
  externalAdapterKey,
  adapterVersion,
  unsupportedProtocol,
} = {}) {
  const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  const describeIfDb = databaseUrl ? describe : describe.skip;
  const migrationSql = readFileSync(new URL(`../../migrations/${migrationFilename}`, import.meta.url), 'utf8');
  const rlsRole = `c61e_i05_${protocol.replaceAll('_', '')}_${migrationNumber}`;

  describeIfDb(`migration ${migrationNumber} I05 ${protocol} adapter`, () => {
    const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const payload = JSON.stringify({ protocol, id: suffix, values: [1, 2] });
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
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${rlsRole}') THEN
            CREATE ROLE ${rlsRole} NOLOGIN NOSUPERUSER NOBYPASSRLS;
          END IF;
        END
        $role$;
      `);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${rlsRole}`);
      await client.query(`GRANT SELECT ON interop_messages, interop_backend_delivery_receipts TO ${rlsRole}`);
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO tenants (id, slug, name)
         VALUES ($1::uuid, $3::text, 'I05 adapter migration tenant'),
                ($2::uuid, $4::text, 'I05 adapter other tenant')`,
        [tenantId, otherTenantId, `i05-${protocol}-${suffix}`, `i05-${protocol}-other-${suffix}`],
      );

      async function createChannel(tenant, key) {
        await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenant]);
        const systems = await client.query(
          `INSERT INTO interop_systems
             (tenant_id, system_key, display_name, kind, direction, status)
           VALUES ($1::uuid, $2::text, 'I05 adapter target', 'vh_backend', 'bidirectional', 'active')
           RETURNING id`,
          [tenant, `${key}-system`],
        );
        const channels = await client.query(
          `INSERT INTO interop_channels
             (tenant_id, channel_key, display_name, source_system_id, target_system_id,
              direction, connector_kind, protocol, status, auth_kind)
           VALUES ($1::uuid, $2::text, 'I05 adapter channel', $3::integer, $3::integer,
                   'bidirectional', 'internal_backend', $4::text, 'active', 'internal')
           RETURNING id`,
          [tenant, key, systems.rows[0].id, protocol],
        );
        const versions = await client.query(
          `INSERT INTO interop_channel_versions (tenant_id, channel_id, version_number, status)
           VALUES ($1::uuid, $2::integer, 1, 'active') RETURNING id`,
          [tenant, channels.rows[0].id],
        );
        return [channels.rows[0].id, versions.rows[0].id];
      }

      [channelId, versionId] = await createChannel(tenantId, `${protocol}-${suffix}`);
      [otherChannelId, otherVersionId] = await createChannel(otherTenantId, `${protocol}-other-${suffix}`);
      await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
      const messages = await client.query(
        `INSERT INTO interop_messages
           (tenant_id, channel_id, channel_version_id, direction, protocol,
            dedupe_key, payload_hash, raw_payload_ciphertext, status, arrival_class,
            effect_disposition, send_authority, owner_reconciliation_required)
         VALUES
           ($1::uuid, $2::integer, $3::integer, 'inbound', $4::text, $5::text,
            encode(digest(convert_to($8::text, 'UTF8'), 'sha256'), 'hex'), 'cipher-live',
            'received', 'live', 'live', 'live_authorized', false),
           ($1::uuid, $2::integer, $3::integer, 'inbound', $4::text, $6::text,
            encode(digest(convert_to($8::text, 'UTF8'), 'sha256'), 'hex'), 'cipher-late-in',
            'quarantined', 'recovery_backlog', 'late_pending_only', 'held', true),
           ($1::uuid, $2::integer, $3::integer, 'outbound', $4::text, $7::text,
            encode(digest(convert_to($8::text, 'UTF8'), 'sha256'), 'hex'), 'cipher-late-out',
            'quarantined', 'recovery_backlog', 'late_pending_only', 'held', true)
         RETURNING id, direction, arrival_class`,
        [tenantId, channelId, versionId, protocol, `live-${suffix}`, `late-in-${suffix}`, `late-out-${suffix}`, payload],
      );
      liveMessageId = messages.rows.find(row => row.arrival_class === 'live').id;
      lateInboundId = messages.rows.find(row => row.direction === 'inbound' && row.arrival_class !== 'live').id;
      lateOutboundId = messages.rows.find(row => row.direction === 'outbound').id;
      const receipts = await client.query(
        `INSERT INTO interop_backend_delivery_receipts
           (tenant_id, message_id, channel_id, channel_version_id, protocol,
            direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
            receipt_status, evidence)
         VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, $5::text,
                 'inbound', $6::text, $7::text,
                 encode(digest(convert_to($8::text, 'UTF8'), 'sha256'), 'hex'),
                 octet_length(convert_to($8::text, 'UTF8')), 'accepted',
                 '{"byte_parity_verified":true}'::jsonb) RETURNING id::text`,
        [tenantId, liveMessageId, channelId, versionId, protocol, inboundAdapterKey, adapterVersion, payload],
      );
      receiptId = receipts.rows[0].id;
    });

    afterAll(async () => {
      await client.query('RESET ROLE').catch(() => {});
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    });

    test(`derives migration ${migrationNumber} from its frozen predecessor without replay-guard reuse`, () => {
      const names = readdirSync(new URL('../../migrations/', import.meta.url))
        .filter(name => /^\d+.*\.sql$/.test(name))
        .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
      const index = names.indexOf(migrationFilename);
      expect(index).toBeGreaterThan(0);
      expect(names[index - 1]).toBe(previousMigrationFilename);
      expect(names.slice(index + 1).every(name => Number.parseInt(name, 10) > migrationNumber)).toBe(true);
      expect(migrationSql).toContain('activate exactly one additional protocol adapter');
      expect(migrationSql).not.toContain('interop_replay_guard');
    });

    test('default-denies absent, empty, bypass, and wrong-tenant raw contexts', async () => {
      const absentClient = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
      await absentClient.connect();
      try {
        await absentClient.query(`SET ROLE ${rlsRole}`);
        const absent = await absentClient.query('SELECT COUNT(*)::integer AS count FROM interop_messages');
        expect(absent.rows[0].count).toBe(0);
      } finally {
        await absentClient.end();
      }
      await client.query(`SET LOCAL ROLE ${rlsRole}`);
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

    test('enforces tenant provenance, exact adapter keys, byte parity, and append-only evidence', async () => {
      await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
      await expectFailure(client, () => client.query(
        `INSERT INTO interop_messages
           (tenant_id, channel_id, channel_version_id, direction, protocol,
            dedupe_key, payload_hash, status, arrival_class, effect_disposition,
            send_authority, owner_reconciliation_required)
         VALUES ($1::uuid, $2::integer, $3::integer, 'inbound', $4::text, $5::text,
                 repeat('a', 64), 'received', 'live', 'live', 'live_authorized', false)`,
        [tenantId, otherChannelId, otherVersionId, protocol, `cross-${suffix}`],
      ), { code: '23503', constraint: 'fk_interop_messages_channel_tenant' });
      for (const [receiptProtocol, adapter] of [
        [unsupportedProtocol, `backend.interop.${unsupportedProtocol}`],
        [protocol, `${inboundAdapterKey}.wrong`],
        [protocol, externalAdapterKey],
      ]) {
        await expectFailure(client, () => client.query(
          `INSERT INTO interop_backend_delivery_receipts
             (tenant_id, message_id, channel_id, channel_version_id, protocol,
              direction, adapter_key, adapter_version, payload_sha256, payload_bytes, receipt_status)
           VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, $5::text,
                   'inbound', $6::text, $7::text,
                   (SELECT payload_hash FROM interop_messages WHERE id = $2::integer), 1, 'accepted')`,
          [tenantId, liveMessageId, channelId, versionId, receiptProtocol, adapter, adapterVersion],
        ), { code: '23514' });
      }
      await expectFailure(client, () => client.query(
        `INSERT INTO interop_backend_delivery_receipts
           (tenant_id, message_id, channel_id, channel_version_id, protocol,
            direction, adapter_key, adapter_version, payload_sha256, payload_bytes, receipt_status)
         VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, $5::text,
                 'inbound', $6::text, $7::text, repeat('0', 64), 1, 'accepted')`,
        [tenantId, liveMessageId, channelId, versionId, protocol, inboundAdapterKey, adapterVersion],
      ), { code: '23514', constraint: 'chk_interop_backend_receipt_message_parity' });
      await expectFailure(client, () => client.query(
        'UPDATE interop_backend_delivery_receipts SET evidence = evidence || \'{"tampered":true}\'::jsonb WHERE id = $1::bigint',
        [receiptId],
      ), { code: '23514', constraint: 'chk_interop_delivery_evidence_append_only' });
    });

    test('suppresses late inbound effects and late outbound sends independently', async () => {
      await expectFailure(client, () => client.query(
        'UPDATE interop_messages SET status = \'delivered\' WHERE tenant_id = $1::uuid AND id = $2::integer',
        [tenantId, lateInboundId],
      ), { code: '23514', constraint: 'chk_interop_message_late_effect_suppression' });
      await expectFailure(client, () => client.query(
        'UPDATE interop_messages SET status = \'queued\' WHERE tenant_id = $1::uuid AND id = $2::integer',
        [tenantId, lateOutboundId],
      ), { code: '23514', constraint: 'chk_interop_message_late_effect_suppression' });
    });
  });
}

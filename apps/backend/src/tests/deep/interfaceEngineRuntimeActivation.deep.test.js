// Live-database coverage for the interface-engine activation law.
//
// Migrations 665 (`assert_interop_runtime_activation`,
// `assert_interop_channel_active_runtime`) and 670 (which re-plants both around
// `interop_canonical_backend_adapters`) decide which interop rows may claim
// `status = 'active'`. Until now the only test of either was
// src/tests/unit/interfaceEngineRuntimeMigration.test.js, which greps the .sql
// text — it would pass unchanged if the triggers were never installed, or
// installed on the wrong table. This suite asserts the behaviour against a real
// Postgres, which is also what licenses every other I05 suite to stop claiming
// activation in its fixtures.
//
// The law, and why each clause is a patient-safety statement rather than a
// schema preference:
//
//   * Only `http_inbound` and `http_outbound` may be active. Those are the two
//     connectors with a driver — `receiveHttpHl7Message` and
//     `dispatchOutboundMessages`. `internal_backend`, `mllp_listener`,
//     `file_sftp_poll` and `manual_upload` have none, so an `active` row would
//     tell an operator a feed is running that nothing is running.
//     `assertConnectorCanActivate` (services/interfaceEngine/runtimePolicy.js)
//     refuses the same set on the admin path; these triggers stop a direct-SQL
//     writer from disagreeing with it.
//   * An active channel must already point at an active version. Activation is
//     one statement in `activateChannelVersion`, never a window in which the
//     channel is live with nothing behind it.
//   * An active inbound version needs a REGISTERED CANONICAL backend adapter.
//     hl7v2 has none (670): its only registered inbound adapter is
//     `backend.interop.preview`, which records a preview receipt, performs no
//     clinical write, and leaves the message at `transformed`. So inbound
//     activation is currently unavailable and says so, instead of approving a
//     channel that cannot produce a clinical effect.
//
// Everything here runs inside one transaction that is rolled back.

import { randomUUID } from 'node:crypto';

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

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('interface-engine runtime activation law (migrations 665 + 670)', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let systemId;
  let counter = 0;

  async function attempt(operation) {
    await client.query('SAVEPOINT activation_probe');
    let failure;
    let value;
    try {
      value = await operation();
    } catch (error) {
      failure = error;
    }
    if (failure) await client.query('ROLLBACK TO SAVEPOINT activation_probe');
    await client.query('RELEASE SAVEPOINT activation_probe');
    return { failure, value };
  }

  async function createChannel({
    connectorKind,
    protocol,
    direction,
    authKind,
    senderIdentifier = null,
    status = 'draft',
  }) {
    counter += 1;
    const rows = await client.query(
      `INSERT INTO interop_channels
         (tenant_id, channel_key, display_name, source_system_id, target_system_id,
          direction, connector_kind, protocol, status, auth_kind, auth_sender_identifier)
       VALUES ($1::uuid, $2::text, 'activation probe', $3::integer, $3::integer,
               $4::text, $5::text, $6::text, $7::text, $8::text, $9::text)
       RETURNING id`,
      [tenantId, `probe-${counter}-${suffix}`, systemId, direction, connectorKind,
        protocol, status, authKind, senderIdentifier],
    );
    return rows.rows[0].id;
  }

  async function createVersion({ channelId, status, adapter = null, endpointUrl = null }) {
    const rows = await client.query(
      `INSERT INTO interop_channel_versions
         (tenant_id, channel_id, version_number, status, connector_config,
          routing_policy, transform_dsl)
       VALUES ($1::uuid, $2::integer, 1, $3::text,
               CASE WHEN $4::text IS NULL THEN '{}'::jsonb
                    ELSE jsonb_build_object('endpointUrl', $4::text) END,
               CASE WHEN $5::text IS NULL THEN '{}'::jsonb
                    ELSE jsonb_build_object('adapter', $5::text) END,
               '{}'::jsonb)
       RETURNING id`,
      [tenantId, channelId, status, endpointUrl, adapter],
    );
    return rows.rows[0].id;
  }

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'interface-engine activation tenant')`,
      [tenantId, `ie-activation-${suffix}`],
    );
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
    const systems = await client.query(
      `INSERT INTO interop_systems
         (tenant_id, system_key, display_name, kind, direction, status, allowed_source_ips)
       VALUES ($1::uuid, $2::text, 'activation probe target', 'vh_backend',
               'bidirectional', 'active', ARRAY['198.51.100.0/24'])
       RETURNING id`,
      [tenantId, `activation-target-${suffix}`],
    );
    systemId = systems.rows[0].id;
  });

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test.each([
    ['internal_backend', 'csv', 'bidirectional', 'internal'],
    ['mllp_listener', 'hl7v2', 'inbound', 'internal'],
    ['file_sftp_poll', 'csv', 'inbound', 'internal'],
    ['manual_upload', 'csv', 'inbound', 'internal'],
  ])('refuses to activate a %s version — no runtime drives it', async (
    connectorKind, protocol, direction, authKind,
  ) => {
    const channelId = await createChannel({ connectorKind, protocol, direction, authKind });
    const { failure } = await attempt(() => createVersion({
      channelId,
      status: 'active',
      adapter: `backend.interop.${protocol}`,
    }));
    expect(failure).toMatchObject({
      code: '23514',
      constraint: 'chk_interop_runtime_activation',
      message: 'interface-engine connector runtime is not implemented',
    });
  });

  test('refuses to activate an internal_backend channel even with a version behind it', async () => {
    const channelId = await createChannel({
      connectorKind: 'internal_backend',
      protocol: 'csv',
      direction: 'bidirectional',
      authKind: 'internal',
    });
    const versionId = await createVersion({ channelId, status: 'candidate' });
    const { failure } = await attempt(() => client.query(
      `UPDATE interop_channels SET status = 'active', active_version_id = $3::integer
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, channelId, versionId],
    ));
    expect(failure).toMatchObject({
      code: '23514',
      constraint: 'chk_interop_channel_active_runtime',
      message: 'active interface-engine channel lacks an implemented active version',
    });
  });

  test('refuses an active channel that does not yet point at an active version', async () => {
    const channelId = await createChannel({
      connectorKind: 'http_outbound',
      protocol: 'hl7v2',
      direction: 'outbound',
      authKind: 'none',
    });
    const noVersion = await attempt(() => client.query(
      `UPDATE interop_channels SET status = 'active'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, channelId],
    ));
    expect(noVersion.failure).toMatchObject({
      code: '23514',
      constraint: 'chk_interop_channel_active_runtime',
      message: 'active interface-engine channel lacks an implemented active version',
    });

    const draftVersionId = await createVersion({
      channelId,
      status: 'candidate',
      endpointUrl: 'https://activation-probe.example.test/hl7',
    });
    const inactiveVersion = await attempt(() => client.query(
      `UPDATE interop_channels SET status = 'active', active_version_id = $3::integer
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, channelId, draftVersionId],
    ));
    expect(inactiveVersion.failure).toMatchObject({
      code: '23514',
      constraint: 'chk_interop_channel_active_runtime',
      message: 'active interface-engine channel must reference its active version',
    });
  });

  test('refuses an active http_outbound version with no endpoint URL', async () => {
    const channelId = await createChannel({
      connectorKind: 'http_outbound',
      protocol: 'hl7v2',
      direction: 'outbound',
      authKind: 'none',
    });
    const { failure } = await attempt(() => createVersion({ channelId, status: 'active' }));
    expect(failure).toMatchObject({
      code: '23514',
      constraint: 'chk_interop_runtime_outbound_endpoint',
      message: 'active http_outbound versions require an endpoint URL',
    });
  });

  test('activates http_outbound in the order activateChannelVersion performs', async () => {
    const channelId = await createChannel({
      connectorKind: 'http_outbound',
      protocol: 'hl7v2',
      direction: 'outbound',
      authKind: 'none',
    });
    const versionId = await createVersion({
      channelId,
      status: 'active',
      endpointUrl: 'https://activation-probe.example.test/hl7',
    });
    const activated = await attempt(() => client.query(
      `UPDATE interop_channels SET status = 'active', active_version_id = $3::integer
        WHERE tenant_id = $1::uuid AND id = $2::integer
        RETURNING status, active_version_id`,
      [tenantId, channelId, versionId],
    ));
    expect(activated.failure).toBeUndefined();
    expect(activated.value.rows[0]).toMatchObject({ status: 'active', active_version_id: versionId });
  });

  test('refuses hl7v2 inbound activation outright — no canonical backend adapter exists', async () => {
    const channelId = await createChannel({
      connectorKind: 'http_inbound',
      protocol: 'hl7v2',
      direction: 'inbound',
      authKind: 'tenant_interop_secret',
      senderIdentifier: `probe-sender-${suffix}`,
    });

    // The preview adapter is refused by name: it writes a `previewed` receipt
    // and performs no clinical write.
    const preview = await attempt(() => createVersion({
      channelId,
      status: 'active',
      adapter: 'backend.interop.preview',
    }));
    expect(preview.failure).toMatchObject({
      code: '23514',
      constraint: 'chk_interop_runtime_preview_activation',
      message: 'preview-only inbound versions cannot be activated',
    });

    // Everything else is refused because hl7v2 has NO registered canonical
    // adapter at all — this is the hole migration 670 closed, where any
    // non-preview string used to be waved through.
    for (const adapter of [null, 'backend.interop.csv', 'backend.made.up']) {
      const { failure } = await attempt(() => createVersion({
        channelId,
        status: 'active',
        adapter,
      }));
      expect(failure).toMatchObject({
        code: '23514',
        constraint: 'chk_interop_runtime_canonical_adapter',
      });
      expect(failure.message).toBe(
        'inbound activation is unavailable: no canonical backend adapter is registered for this protocol',
      );
    }
  });

  test('the canonical adapter registry matches the JS adapters it mirrors', async () => {
    const rows = await client.query(
      `SELECT protocol,
              public.interop_canonical_backend_adapters(protocol) AS adapters
         FROM unnest(ARRAY['hl7v2', 'csv', 'json', 'fhir_json', 'other', 'nonexistent']) AS protocol`,
    );
    const registry = Object.fromEntries(rows.rows.map(row => [row.protocol, row.adapters]));
    expect(registry).toEqual({
      hl7v2: [],
      csv: ['backend.interop.csv'],
      json: ['backend.interop.json'],
      fhir_json: ['backend.interop.fhir-json'],
      other: ['backend.interop.other-envelope'],
      nonexistent: [],
    });
  });
});

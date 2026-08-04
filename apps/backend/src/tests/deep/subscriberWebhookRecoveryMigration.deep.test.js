import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/620_subscriber_webhook_recovery.sql', import.meta.url),
  'utf8',
);

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
  await client.query('SAVEPOINT expected_i18_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_i18_failure');
  await client.query('RELEASE SAVEPOINT expected_i18_failure');
  expect(failure).toBeDefined();
  expect(failure).toMatchObject(expected);
  return failure;
}

describeIfDb('migration 620 I18 subscriber webhook recovery integrity', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const actorUid = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let subscriptionId;
  let deliveryId;
  let eventId;
  let payloadHash;
  let inboxId;

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1::text, true)`, [tenantId]);
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'I18 raw PostgreSQL tenant')`,
      [tenantId, `i18-raw-${suffix}`],
    );
    await client.query(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::text, 'I18 owner', 'ADMIN', true, 'active', NOW())`,
      [actorUid, tenantId, `95${suffix.slice(0, 10)}`],
    );
    const integration = await client.query(
      `INSERT INTO integrations (tenant_id, name, integration_type, status)
       VALUES ($1::uuid, $2::text, 'webhook', 'active') RETURNING id`,
      [tenantId, `i18-integration-${suffix}`],
    );
    const subscription = await client.query(
      `INSERT INTO webhook_subscriptions
         (tenant_id, integration_id, event_type, endpoint_url,
          signing_algorithm, is_active)
       VALUES ($1::uuid, $2::integer, 'i18.test', 'https://example.test/i18',
               'none', TRUE)
       RETURNING id`,
      [tenantId, integration.rows[0].id],
    );
    subscriptionId = subscription.rows[0].id;
    const event = await client.query(
      `INSERT INTO event_outbox
         (tenant_id, event_type, aggregate_type, payload, status,
          available_at, occurred_at, occurred_at_source, created_at, delivered_at)
       VALUES ($1::uuid, 'i18.test', 'i18_fixture', $2::jsonb, 'delivered',
               NOW(), NOW() - INTERVAL '20 minutes', 'explicit',
               NOW() - INTERVAL '20 minutes', NOW())
       RETURNING id::text, occurred_at::text,
                 encode(digest(payload::text, 'sha256'), 'hex') AS payload_sha256`,
      [tenantId, JSON.stringify({ stable: 'i18' })],
    );
    eventId = event.rows[0].id;
    payloadHash = event.rows[0].payload_sha256;
    const delivery = await client.query(
      `INSERT INTO webhook_deliveries
         (tenant_id, subscription_id, event_outbox_id, event_type, payload,
          status, attempt_number, source_kind, source_identity,
          source_position, payload_sha256)
       VALUES ($1::uuid, $2::integer, $3::bigint, 'i18.test', $4::jsonb,
               'succeeded', 1, 'event_outbox', 'event_outbox:' || $3::bigint::text,
               $3::bigint, $5::char(64))
       RETURNING id`,
      [tenantId, subscriptionId, eventId, JSON.stringify({ stable: 'i18' }), payloadHash],
    );
    deliveryId = delivery.rows[0].id;
    const offset = await client.query(
      `INSERT INTO event_consumer_offsets
         (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
          direction, source_partition, consumer_key, generation, cursor_kind,
          high_water_position, high_water_token, retained_from_position,
          retained_from_token, recovery_state, policy_version, policy_signature,
          retention_policy, retention_until, historical_cutoff_event_id,
          backfill_cursor_event_id)
       VALUES
         ('external_interface', $1::uuid, 'tenant', NULL, 'I18', 'outbound',
          $2::text, $3::text, 1, 'monotonic_position_and_predecessor',
          $4::bigint - 1, 'owner-predecessor', $4::bigint - 1,
          'owner-predecessor', 'replaying', 'i18-owner-v1', $5::text,
          'webhook-evidence-2555d', NOW() + INTERVAL '2555 days', NULL, NULL)
       RETURNING offset_id::text`,
      [tenantId, `webhook-subscription:${subscriptionId}:outbound`,
        `external:I18:${suffix}`, eventId, `i18-${suffix}`],
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
         ('external_interface', $1::uuid, $2::text, 1, $3::uuid, NULL,
          'I18', 'outbound', $4::text, $5::bigint, 'owner-source',
          'owner-predecessor', $6::text, repeat('b', 64),
          $7::timestamptz, NOW(), NOW(), 'recovery_backlog',
          'late_pending_only', 'pending', NOW(), 'i18-owner-v1', $8::text,
          'webhook-evidence-2555d', NOW() + INTERVAL '2555 days')
       RETURNING inbox_id::text`,
      [tenantId, `external:I18:${suffix}`, offset.rows[0].offset_id,
        `webhook-subscription:${subscriptionId}:outbound`, eventId,
        `i18:${subscriptionId}:event_outbox:${eventId}:${payloadHash}`,
        event.rows[0].occurred_at, `i18-${suffix}`],
    );
    inboxId = inbox.rows[0].inbox_id;
  });

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('follows migration 619 and retains all existing webhook tables', () => {
    const names = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter(name => /^\d+.*\.sql$/.test(name)).sort();
    expect(names.at(-1)).toBe('620_subscriber_webhook_recovery.sql');
    expect(migrationSql).not.toMatch(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(?:webhook_subscriptions|webhook_deliveries)/i);
    expect(migrationSql).toContain("event_outbox.status='delivered' continues to mean fan-out");
  });

  test('rejects ad-hoc source identity reuse even when the payload fingerprint changes', async () => {
    await client.query(
      `INSERT INTO webhook_deliveries
         (tenant_id, subscription_id, event_type, payload, status,
          source_kind, source_identity, payload_sha256)
       VALUES ($1::uuid, $2::integer, 'i18.test', '{}'::jsonb, 'pending',
               'adhoc', 'owner-source-1', repeat('c', 64))`,
      [tenantId, subscriptionId],
    );
    await expectFailure(client, () => client.query(
      `INSERT INTO webhook_deliveries
         (tenant_id, subscription_id, event_type, payload, status,
          source_kind, source_identity, payload_sha256)
       VALUES ($1::uuid, $2::integer, 'i18.test', '{"changed":true}'::jsonb,
               'pending', 'adhoc', 'owner-source-1', repeat('d', 64))`,
      [tenantId, subscriptionId],
    ), { code: '23505' });
  });

  test('rejects forged positive acknowledgement without an owner contract', async () => {
    await expectFailure(client, () => client.query(
      `UPDATE webhook_deliveries
          SET acknowledgement_state = 'positive',
              acknowledgement_evidence = '{"http_status":200}'::jsonb,
              acknowledged_at = NOW()
        WHERE id = $1::integer`,
      [deliveryId],
    ), { code: '23514' });
  });

  test('binds held evidence to the exact canonical inbox and makes it immutable', async () => {
    await client.query(
      `UPDATE webhook_deliveries
          SET send_authority = 'held_owner_reconciliation', next_retry_at = NULL,
              recovery_inbox_id = $2::uuid, recovery_interface_family = 'I18',
              recovery_owner_uid = $3::uuid,
              recovery_owner_reason = 'Owner-reviewed I18 raw fixture',
              recovery_evidence = '{"exact_payload_fingerprint_verified":true}'::jsonb,
              effect_disposition = 'late_pending_only'
        WHERE id = $1::integer`,
      [deliveryId, inboxId, actorUid],
    );
    await expectFailure(client, () => client.query(
      `UPDATE webhook_deliveries SET recovery_owner_reason = 'rewritten' WHERE id = $1::integer`,
      [deliveryId],
    ), { code: '23514' });
    await expectFailure(client, () => client.query(
      `DELETE FROM webhook_deliveries WHERE id = $1::integer`,
      [deliveryId],
    ), { code: '23514' });
  });
});

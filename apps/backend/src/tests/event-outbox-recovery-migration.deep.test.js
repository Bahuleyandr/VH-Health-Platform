import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../migrations/588_event_outbox_recovery_hardening.sql', import.meta.url),
  'utf8',
);
const prismaSchema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');

const FROZEN_MIGRATIONS = {
  '578_pathway_projector_inbox.sql': [10265, '2660b1546692ef8f7f685b88946f9836e35281f1f29c9db92ea582cc9d022e16'],
  '579_workflow_runtime_hardening.sql': [7618, '544f05896a4cc53216c29d1ceb307d00d69ffdff964398587eeb03013356652f'],
  '580_care_pathway_execution_spine.sql': [253110, '08a4c5999194f9a11d5be46a450aa5a935258bde347944d1a40454e49f991534'],
  '581_lab_critical_alert_generations.sql': [113292, 'f85eda5b76dfd05699fdbdc9a8f6a5f8b12a39e1e0929d001944ecb5cbca6da3'],
  '582_lab_oru_replay_idempotency.sql': [66045, 'c70070ad84e5673eb3036bb5a73bbca6070486de0af487e8ee87aa4a1fd0514e'],
  '583_lab_astm_atomic_replay.sql': [181391, '347ae413947d1a2b2a1924f43512197a7cff8b5bc78adf84f163e97fd4336261'],
  '584_care_pathway_governance_pinning.sql': [75505, '597b523c408761db20bc6cc286007c7bf3e3dd2d5ac3bbbd78f679b3c1019363'],
  '585_care_pathway_exclusive_owner_integrity.sql': [41422, 'db6fd812dd40b168468b4d7b33eaa49fba7216ba01c57f8e2c3117d8ac839cae'],
  '586_care_pathway_owner_acceptance.sql': [44168, '07c44ff3f686eb5e481466c288ea4582a93fee70e1e85226a743cc01bdcde288'],
  '587_care_pathway_reconciliation_evidence.sql': [6308, 'd341d84194a16f49b5af4ac8ea81cd60e32271b10aa3a1af04d58d44a500f068'],
};

async function expectFailure(client, operation, code, constraint) {
  await client.query('SAVEPOINT expected_outbox_recovery_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_outbox_recovery_failure');
  expect(failure).toMatchObject({ code });
  if (constraint) expect(failure.constraint || failure.message).toContain(constraint);
}

describe('migration 588 static outbox recovery contract', () => {
  test('keeps migrations 578 through 587 byte-for-byte frozen', () => {
    for (const [name, [bytes, checksum]] of Object.entries(FROZEN_MIGRATIONS)) {
      const contents = readFileSync(new URL(`../migrations/${name}`, import.meta.url));
      expect(contents.byteLength).toBe(bytes);
      expect(createHash('sha256').update(contents).digest('hex')).toBe(checksum);
    }
  });

  test('reserves exactly one migration 588 and declares the controlled-cutover contract', () => {
    const names = readdirSync(new URL('../migrations/', import.meta.url))
      .filter((name) => name.startsWith('588_'));
    expect(names).toEqual(['588_event_outbox_recovery_hardening.sql']);
    expect(migrationSql).toContain("SET LOCAL lock_timeout = '10s'");
    expect(migrationSql).toContain("SET LOCAL statement_timeout = '120s'");
    expect(migrationSql).toMatch(/migration 588 event_outbox preflight failed:[\s\S]+samples=/);
    expect(migrationSql).toMatch(/migration 588 webhook delivery duplicate preflight failed:[\s\S]+samples=/);
    expect(migrationSql).toMatch(/migration 588 active webhook filter preflight failed:[\s\S]+samples=/);
    expect(migrationSql).toContain('migration_588_recovered_unleased_processing');
    expect(migrationSql).toContain('migration_588_recovered_unleased_in_flight');
    expect(migrationSql).toContain("'OUTBOX_RECOVERY_MIGRATION_APPLIED'");
    expect(migrationSql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?pathway_projector_inbox\b/i);
    expect(migrationSql).not.toMatch(/CREATE\s+TRIGGER[\s\S]+ON\s+event_outbox/i);
  });

  test('pins Prisma parity for leases, redrive counters, BIGINT bridge, and partial indexes', () => {
    expect(prismaSchema).toMatch(/model event_outbox[\s\S]+lease_owner\s+String\?[\s\S]+lease_expires_at\s+DateTime\?[\s\S]+redrive_count\s+Int/);
    expect(prismaSchema).toMatch(/model webhook_deliveries[\s\S]+event_outbox_id\s+BigInt\?[\s\S]+lease_owner\s+String\?[\s\S]+redrive_count\s+Int/);
    expect(prismaSchema).toContain('map: "idx_event_outbox_stale_processing"');
    expect(prismaSchema).toContain('map: "idx_webhook_deliveries_stale_in_flight"');
    expect(prismaSchema).toContain('map: "ux_webhook_deliveries_source_subscription"');
  });
});

describeWithDatabase('migration 588 database outbox recovery contract', () => {
  let client;
  let tenantId;
  let integrationId;
  let subscriptionId;
  let eventId;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');
    tenantId = randomUUID();
    await client.query(
      'INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2::text, $3::text)',
      [tenantId, `migration-588-${randomUUID()}`, 'Migration 588 test'],
    );
    const integration = await client.query(
      `INSERT INTO integrations (tenant_id, name, integration_type, status)
       VALUES ($1::uuid, $2::text, 'webhook', 'active') RETURNING id`,
      [tenantId, `migration-588-${randomUUID()}`],
    );
    integrationId = integration.rows[0].id;
    const subscription = await client.query(
      `INSERT INTO webhook_subscriptions
         (tenant_id, integration_id, event_type, endpoint_url, signing_algorithm, is_active)
       VALUES ($1::uuid, $2::integer, 'test.migration.588', 'https://example.test/hook', 'none', TRUE)
       RETURNING id`,
      [tenantId, integrationId],
    );
    subscriptionId = subscription.rows[0].id;
    const event = await client.query(
      `INSERT INTO event_outbox
         (tenant_id, event_type, aggregate_type, payload, status, available_at, created_at)
       VALUES ($1::uuid, 'test.migration.588', 'test', '{}'::jsonb, 'pending', NOW(), NOW())
       RETURNING id::text`,
      [tenantId],
    );
    eventId = event.rows[0].id;
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  test('installs exact columns, checks, and partial indexes without a webhook source FK', async () => {
    const columns = await client.query(
      `SELECT table_name, column_name, data_type, udt_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('event_outbox', 'webhook_deliveries')
          AND column_name IN ('event_outbox_id', 'lease_owner', 'lease_expires_at', 'redrive_count')
        ORDER BY table_name, column_name`,
    );
    expect(columns.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ table_name: 'event_outbox', column_name: 'lease_owner', data_type: 'uuid' }),
      expect.objectContaining({ table_name: 'event_outbox', column_name: 'lease_expires_at', data_type: 'timestamp with time zone' }),
      expect.objectContaining({ table_name: 'event_outbox', column_name: 'redrive_count', data_type: 'integer' }),
      expect.objectContaining({ table_name: 'webhook_deliveries', column_name: 'event_outbox_id', data_type: 'bigint' }),
      expect.objectContaining({ table_name: 'webhook_deliveries', column_name: 'lease_owner', data_type: 'uuid' }),
      expect.objectContaining({ table_name: 'webhook_deliveries', column_name: 'lease_expires_at', data_type: 'timestamp with time zone' }),
      expect.objectContaining({ table_name: 'webhook_deliveries', column_name: 'redrive_count', data_type: 'integer' }),
    ]));
    const constraints = await client.query(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid IN ('event_outbox'::regclass, 'webhook_deliveries'::regclass)
        ORDER BY conname`,
    );
    expect(constraints.rows.map((row) => row.conname)).toEqual(expect.arrayContaining([
      'event_outbox_status_check',
      'event_outbox_attempts_nonnegative_check',
      'event_outbox_redrive_count_nonnegative_check',
      'event_outbox_lease_pair_check',
      'event_outbox_processing_lease_check',
      'webhook_deliveries_attempt_nonnegative_check',
      'webhook_deliveries_redrive_count_nonnegative_check',
      'webhook_deliveries_lease_pair_check',
      'webhook_deliveries_in_flight_lease_check',
    ]));
    const indexes = await client.query(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'idx_event_outbox_stale_processing',
            'idx_webhook_deliveries_stale_in_flight',
            'ux_webhook_deliveries_source_subscription'
          )`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      'idx_event_outbox_stale_processing',
      'idx_webhook_deliveries_stale_in_flight',
      'ux_webhook_deliveries_source_subscription',
    ]));
    expect(indexes.rows.find((row) => row.indexname === 'ux_webhook_deliveries_source_subscription').indexdef)
      .toMatch(/UNIQUE[\s\S]+event_outbox_id IS NOT NULL[\s\S]+subscription_id IS NOT NULL/);
    const bridgeFks = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'webhook_deliveries'::regclass
          AND contype = 'f'
          AND pg_get_constraintdef(oid) ILIKE '%event_outbox%'`,
    );
    expect(bridgeFks.rows).toHaveLength(0);
  });

  test('keeps the projector insert-only trigger unchanged and adds no source-update trigger', async () => {
    const triggers = await client.query(
      `SELECT tgname, pg_get_triggerdef(oid) AS definition
         FROM pg_trigger
        WHERE tgrelid = 'event_outbox'::regclass AND NOT tgisinternal
        ORDER BY tgname`,
    );
    expect(triggers.rows).toHaveLength(1);
    expect(triggers.rows[0].tgname).toBe('pathway_projector_enqueue_new_event');
    expect(triggers.rows[0].definition).toContain('AFTER INSERT');
    expect(triggers.rows[0].definition).not.toContain('UPDATE');
  });

  test('rejects incoherent lease states and negative counters', async () => {
    await expectFailure(
      client,
      () => client.query(
        `INSERT INTO event_outbox
           (tenant_id, event_type, aggregate_type, payload, status, attempts,
            available_at, lease_owner, created_at)
         VALUES ($1::uuid, 'invalid.lease', 'test', '{}'::jsonb, 'processing', 1,
                 NOW(), $2::uuid, NOW())`,
        [tenantId, randomUUID()],
      ),
      '23514',
      'event_outbox_lease_pair_check',
    );
    await expectFailure(
      client,
      () => client.query(
        `INSERT INTO event_outbox
           (tenant_id, event_type, aggregate_type, payload, status, attempts,
            available_at, created_at)
         VALUES ($1::uuid, 'invalid.processing', 'test', '{}'::jsonb, 'processing', 1,
                 NOW(), NOW())`,
        [tenantId],
      ),
      '23514',
      'event_outbox_processing_lease_check',
    );
    await expectFailure(
      client,
      () => client.query(
        `INSERT INTO webhook_deliveries
           (tenant_id, subscription_id, event_type, payload, status, attempt_number,
            next_retry_at, redrive_count)
         VALUES ($1::uuid, $2::integer, 'invalid.counter', '{}'::jsonb,
                 'pending', 0, NOW(), -1)`,
        [tenantId, subscriptionId],
      ),
      '23514',
      'webhook_deliveries_redrive_count_nonnegative_check',
    );
  });

  test('enforces unique source/subscription fan-out while retaining nullable ad-hoc deliveries', async () => {
    await client.query(
      `INSERT INTO webhook_deliveries
         (tenant_id, subscription_id, event_outbox_id, event_type, payload,
          status, attempt_number, next_retry_at)
       VALUES ($1::uuid, $2::integer, $3::bigint, 'test.migration.588', '{}'::jsonb,
               'pending', 0, NOW())`,
      [tenantId, subscriptionId, eventId],
    );
    await expectFailure(
      client,
      () => client.query(
        `INSERT INTO webhook_deliveries
           (tenant_id, subscription_id, event_outbox_id, event_type, payload,
            status, attempt_number, next_retry_at)
         VALUES ($1::uuid, $2::integer, $3::bigint, 'test.migration.588', '{}'::jsonb,
                 'pending', 0, NOW())`,
        [tenantId, subscriptionId, eventId],
      ),
      '23505',
      'ux_webhook_deliveries_source_subscription',
    );
    await expect(client.query(
      `INSERT INTO webhook_deliveries
         (tenant_id, subscription_id, event_outbox_id, event_type, payload,
          status, attempt_number, next_retry_at)
       VALUES ($1::uuid, $2::integer, NULL, 'test.adhoc.588', '{}'::jsonb, 'pending', 0, NOW()),
              ($1::uuid, $2::integer, NULL, 'test.adhoc.588', '{}'::jsonb, 'pending', 0, NOW())`,
      [tenantId, subscriptionId],
    )).resolves.toMatchObject({ rowCount: 2 });
  });
});

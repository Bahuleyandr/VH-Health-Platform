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
  '578_pathway_projector_inbox.sql': [10009, '3929ecadded11b7cdf6cac34f62290bd70f937a765d062eab6137355ed19fde4'],
  '579_workflow_runtime_hardening.sql': [7369, '5bccaf46f7143f50e854d7e7cb8de74a0e8ad7c68f2db32907c354d4af6c1ba8'],
  '580_care_pathway_execution_spine.sql': [246628, 'a41495fc511bd5238fe548e9185a1461715b47aa54607c7f42ff8ad79edaa979'],
  '581_lab_critical_alert_generations.sql': [110528, '43afb83d57e50e738540addcc02875c35826884b3d9d4d7b31bbaebb77b61cb4'],
  '582_lab_oru_replay_idempotency.sql': [64558, 'f0cea6e6ea63f9cf5932acbd99ee9508a2e838d3715d09b969aed99e3a0e41f0'],
  '583_lab_astm_atomic_replay.sql': [177245, '7d1abe4238fa95d4bafbea9e86052df8c53ca8361fefdcf407ea9e44e10919f1'],
  '584_care_pathway_governance_pinning.sql': [73446, 'f799232a9007cb3a69dea11d7131c96913578e94bb8c62b9c1b6106921c31eb7'],
  '585_care_pathway_exclusive_owner_integrity.sql': [40234, 'ecb84da8a3e2dae58ee9df644f16878f597255c1cbb778d582601affd29c9c9a'],
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
      const contents = readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');
      expect(Buffer.byteLength(contents, 'utf8')).toBe(bytes);
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
      `SELECT trigger_row.tgname, pg_get_triggerdef(trigger_row.oid) AS definition
         FROM pg_trigger trigger_row
         JOIN pg_proc trigger_function ON trigger_function.oid = trigger_row.tgfoid
        WHERE trigger_row.tgrelid = 'event_outbox'::regclass
          AND NOT trigger_row.tgisinternal
          AND trigger_function.proname = 'pathway_projector_enqueue_new_event'
        ORDER BY trigger_row.tgname`,
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

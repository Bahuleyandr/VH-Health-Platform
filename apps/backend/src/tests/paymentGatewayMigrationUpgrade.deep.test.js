// Retained-database proof for published migration 697 followed by additive
// migration 708. Runs in an isolated schema inside the configured test DB.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
const published697 = readFileSync(
  new URL('../migrations/697_payment_gateway_refunds.sql', import.meta.url), 'utf8',
);
const upgrade708 = readFileSync(
  new URL('../migrations/708_payment_gateway_refund_security_upgrade.sql', import.meta.url), 'utf8',
);

d('payment gateway retained migration 697 → 708', () => {
  let client;
  let schema;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    schema = `refund_upgrade_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE tenants (id UUID PRIMARY KEY);
      CREATE TABLE billing_refunds (id SERIAL PRIMARY KEY);
      CREATE TABLE payment_gateway_orders (id SERIAL PRIMARY KEY);
      CREATE FUNCTION app_current_tenant_id_uuid() RETURNS UUID
      LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    `);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query('RESET search_path').catch(() => {});
    if (schema) await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end().catch(() => {});
  });

  it('upgrades retained rows safely, converges on rerun, and enables reconciliation writes', async () => {
    await client.query(published697);
    const tenantId = randomUUID();
    await client.query('INSERT INTO tenants (id) VALUES ($1)', [tenantId]);
    const order = await client.query('INSERT INTO payment_gateway_orders DEFAULT VALUES RETURNING id');
    const refundA = await client.query('INSERT INTO billing_refunds DEFAULT VALUES RETURNING id');
    const refundB = await client.query('INSERT INTO billing_refunds DEFAULT VALUES RETURNING id');
    const retained = await client.query(
      `INSERT INTO payment_gateway_refunds
         (tenant_id, provider, environment, gateway_order_id, billing_refund_id,
          provider_payment_id, amount, currency, status)
       VALUES ($1, 'razorpay', 'production', $2, $3, 'pay_retained_a', 25, 'INR', 'initiated'),
              ($1, 'razorpay', 'production', $2, $4, 'pay_retained_b', 15, 'INR', 'pending')
       RETURNING id, status`,
      [tenantId, order.rows[0].id, refundA.rows[0].id, refundB.rows[0].id],
    );

    await client.query(upgrade708);
    await client.query(upgrade708);

    const rows = await client.query(
      `SELECT id, status, provider_idempotency_key, failure_code
         FROM payment_gateway_refunds ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        id: retained.rows[0].id,
        status: 'requires_reconciliation',
        provider_idempotency_key: `pgr_legacy_${retained.rows[0].id}`,
        failure_code: 'legacy_intent_hold',
      }),
      expect.objectContaining({
        id: retained.rows[1].id,
        status: 'pending',
        provider_idempotency_key: `pgr_legacy_${retained.rows[1].id}`,
      }),
    ]);
    const statusColumn = await client.query(
      `SELECT character_maximum_length, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'payment_gateway_refunds'
          AND column_name = 'status'`,
      [schema],
    );
    expect(statusColumn.rows[0]).toEqual({ character_maximum_length: 30, is_nullable: 'NO' });
    const keyColumn = await client.query(
      `SELECT character_maximum_length, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'payment_gateway_refunds'
          AND column_name = 'provider_idempotency_key'`,
      [schema],
    );
    expect(keyColumn.rows[0]).toEqual({ character_maximum_length: 120, is_nullable: 'NO' });
    const definitions = await client.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'payment_gateway_refunds'`,
      [schema],
    );
    const indexSql = definitions.rows.map(row => row.indexdef).join('\n');
    expect(indexSql).toContain('ux_pg_refund_provider_idempotency');
    expect(indexSql).toContain('requires_reconciliation');
  });
});

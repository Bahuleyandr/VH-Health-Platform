// Retained-database proof for published migration 697 followed by additive
// migrations 708, published 712-713, and forward-only 715. Runs in an
// isolated schema inside the configured test DB.

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
const upgrade712 = readFileSync(
  new URL('../migrations/712_payment_gateway_operational_safety.sql', import.meta.url), 'utf8',
);
const upgrade713 = readFileSync(
  new URL('../migrations/713_payment_gateway_settlement_integrity.sql', import.meta.url), 'utf8',
);
const upgrade715 = readFileSync(
  new URL('../migrations/715_payment_gateway_order_reconciliation_actor.sql', import.meta.url), 'utf8',
);

d('payment gateway retained migration 697 → 708 → published 712-713 → 715', () => {
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
      CREATE TABLE users (
        tenant_id UUID NOT NULL,
        uid UUID NOT NULL,
        UNIQUE (tenant_id, uid)
      );
      CREATE TABLE billing_refunds (
        id SERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL,
        approval_status VARCHAR(20) NOT NULL DEFAULT 'APPROVED',
        paid_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE payment_gateway_provider_configs (
        id SERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL,
        provider VARCHAR(30) NOT NULL DEFAULT 'dry_run',
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        key_id VARCHAR(120),
        key_secret_ciphertext TEXT,
        webhook_secret_ciphertext TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE payment_gateway_orders (
        id SERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL,
        provider_config_id INTEGER,
        status VARCHAR(26) NOT NULL DEFAULT 'created',
        reconciled_at TIMESTAMPTZ,
        reconciliation_note VARCHAR(500),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
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
    const actorUid = randomUUID();
    const otherTenantId = randomUUID();
    const otherTenantActorUid = randomUUID();
    await client.query('INSERT INTO tenants (id) VALUES ($1), ($2)', [tenantId, otherTenantId]);
    await client.query(
      `INSERT INTO users (tenant_id, uid)
       VALUES ($1, $2), ($3, $4)`,
      [tenantId, actorUid, otherTenantId, otherTenantActorUid],
    );
    const config = await client.query(
      'INSERT INTO payment_gateway_provider_configs (tenant_id) VALUES ($1) RETURNING id',
      [tenantId],
    );
    const incompleteLiveConfig = await client.query(
      `INSERT INTO payment_gateway_provider_configs
         (tenant_id, provider, enabled, key_id, key_secret_ciphertext)
       VALUES ($1, 'razorpay', TRUE, 'rzp_retained', 'encrypted-key')
       RETURNING id`,
      [tenantId],
    );
    const order = await client.query(
      `INSERT INTO payment_gateway_orders (tenant_id, provider_config_id)
       VALUES ($1, $2) RETURNING id`,
      [tenantId, config.rows[0].id],
    );
    const refundA = await client.query(
      'INSERT INTO billing_refunds (tenant_id) VALUES ($1) RETURNING id', [tenantId],
    );
    const refundB = await client.query(
      'INSERT INTO billing_refunds (tenant_id) VALUES ($1) RETURNING id', [tenantId],
    );
    const refundC = await client.query(
      `INSERT INTO billing_refunds (tenant_id, approval_status, paid_at)
       VALUES ($1, 'PAID', NOW()) RETURNING id`,
      [tenantId],
    );
    const retained = await client.query(
      `INSERT INTO payment_gateway_refunds
         (tenant_id, provider, environment, gateway_order_id, billing_refund_id,
          provider_payment_id, amount, currency, status)
       VALUES ($1, 'razorpay', 'production', $2, $3, 'pay_retained_a', 25, 'INR', 'initiated'),
              ($1, 'razorpay', 'production', $2, $4, 'pay_retained_b', 15, 'INR', 'pending'),
              ($1, 'razorpay', 'production', $2, $5, 'pay_retained_c', 10, 'INR', 'pending')
       RETURNING id, status`,
      [tenantId, order.rows[0].id, refundA.rows[0].id, refundB.rows[0].id, refundC.rows[0].id],
    );

    await client.query(upgrade708);
    await client.query(upgrade708);
    await client.query(upgrade712);
    await client.query(upgrade712);

    // Migration 712 allowed actorless resolution. 713 must preserve its
    // material as legacy evidence but reopen the unresolved refund.
    await client.query(
      `UPDATE payment_gateway_refunds
          SET reconciled_at = NOW(),
              reconciliation_note = 'Legacy actorless retained resolution'
        WHERE id = $1`,
      [retained.rows[0].id],
    );

    await client.query(upgrade713);
    await client.query(upgrade713);

    // Published 694-713 allowed an order resolution stamp without an actor.
    // 715 preserves that material in metadata and reopens the order.
    await client.query(
      `UPDATE payment_gateway_orders
          SET status = 'requires_reconciliation',
              reconciled_at = NOW(),
              reconciliation_note = 'Legacy actorless retained order resolution'
        WHERE id = $1`,
      [order.rows[0].id],
    );
    await client.query(upgrade715);
    await client.query(upgrade715);

    const rows = await client.query(
      `SELECT id, status, provider_idempotency_key, failure_code,
              webhook_credential_version, reconciled_at, reconciliation_note,
              reconciled_by, metadata
         FROM payment_gateway_refunds ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        id: retained.rows[0].id,
        status: 'requires_reconciliation',
        provider_idempotency_key: `pgr_legacy_${retained.rows[0].id}`,
        failure_code: 'legacy_intent_hold',
        webhook_credential_version: 1,
        reconciled_at: null,
        reconciliation_note: null,
        reconciled_by: null,
        metadata: expect.objectContaining({
          legacy_actorless_reconciliation: expect.objectContaining({
            reconciliation_note: 'Legacy actorless retained resolution',
          }),
        }),
      }),
      expect.objectContaining({
        id: retained.rows[1].id,
        status: 'pending',
        provider_idempotency_key: `pgr_legacy_${retained.rows[1].id}`,
        webhook_credential_version: 1,
      }),
      expect.objectContaining({
        id: retained.rows[2].id,
        status: 'requires_reconciliation',
        provider_idempotency_key: `pgr_legacy_${retained.rows[2].id}`,
        failure_code: 'retained_manual_payout_conflict',
        webhook_credential_version: 1,
      }),
    ]);
    const retainedConfig = await client.query(
      `SELECT enabled, metadata FROM payment_gateway_provider_configs WHERE id = $1`,
      [incompleteLiveConfig.rows[0].id],
    );
    expect(retainedConfig.rows[0]).toEqual({
      enabled: false,
      metadata: { disabled_by_713: { reason: 'incomplete_live_credentials' } },
    });
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
    expect(indexSql).toContain('idx_pg_refund_reconciliation_queue');

    const authority = await client.query(
      `SELECT payout_rail, gateway_refund_id, payout_rail_claimed_at
         FROM billing_refunds WHERE id = $1`,
      [retained.rows[1].billing_refund_id || refundB.rows[0].id],
    );
    expect(authority.rows[0]).toEqual(expect.objectContaining({
      payout_rail: 'gateway',
      gateway_refund_id: retained.rows[1].id,
    }));
    expect(authority.rows[0].payout_rail_claimed_at).not.toBeNull();
    await expect(client.query(
      `UPDATE billing_refunds SET gateway_refund_id = $1 WHERE id = $2`,
      [retained.rows[0].id + 1_000_000, refundB.rows[0].id],
    )).rejects.toMatchObject({ code: '23503' });
    await expect(client.query(
      `DELETE FROM payment_gateway_refunds WHERE id = $1`,
      [retained.rows[1].id],
    )).rejects.toMatchObject({
      // ON DELETE RESTRICT violations raise SQLSTATE 23503
      // (foreign_key_violation) on PostgreSQL <= 17 but the SQL-standard
      // 23001 (restrict_violation) on PostgreSQL 18+ — CI/prod run pg17
      // today, but the pg18 qualification canary (pg18-canary.yml) runs
      // this suite on pg18, so accept both and pin the constraint
      // identity instead.
      code: expect.stringMatching(/^23(?:503|001)$/),
      constraint: 'fk_billing_refund_gateway_execution',
    });

    const retainedManualAuthority = await client.query(
      `SELECT payout_rail, gateway_refund_id, payout_rail_claimed_at
         FROM billing_refunds WHERE id = $1`,
      [refundC.rows[0].id],
    );
    expect(retainedManualAuthority.rows[0]).toEqual(expect.objectContaining({
      payout_rail: 'manual',
      gateway_refund_id: null,
    }));
    expect(retainedManualAuthority.rows[0].payout_rail_claimed_at).not.toBeNull();

    const retainedOrder = await client.query(
      `SELECT status, reconciled_at, reconciliation_note, reconciled_by, metadata
         FROM payment_gateway_orders WHERE id = $1`,
      [order.rows[0].id],
    );
    expect(retainedOrder.rows[0]).toEqual(expect.objectContaining({
      status: 'requires_reconciliation',
      reconciled_at: null,
      reconciliation_note: null,
      reconciled_by: null,
      metadata: expect.objectContaining({
        legacy_actorless_reconciliation: expect.objectContaining({
          reconciliation_note: 'Legacy actorless retained order resolution',
        }),
      }),
    }));
    await expect(client.query(
      `UPDATE payment_gateway_orders
          SET reconciled_at = NOW(),
              reconciliation_note = 'Missing authenticated actor evidence'
        WHERE id = $1`,
      [order.rows[0].id],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(client.query(
      `UPDATE payment_gateway_orders
          SET reconciled_at = NOW(),
              reconciliation_note = 'Cross-tenant authenticated actor evidence',
              reconciled_by = $1::uuid
        WHERE id = $2`,
      [otherTenantActorUid, order.rows[0].id],
    )).rejects.toMatchObject({ code: '23503' });
    const resolvedOrder = await client.query(
      `UPDATE payment_gateway_orders
          SET reconciled_at = NOW(),
              reconciliation_note = 'Verified retained gateway order manually',
              reconciled_by = $1::uuid
        WHERE id = $2
        RETURNING reconciled_at, reconciliation_note, reconciled_by`,
      [actorUid, order.rows[0].id],
    );
    expect(resolvedOrder.rows[0]).toEqual(expect.objectContaining({
      reconciliation_note: 'Verified retained gateway order manually',
      reconciled_by: actorUid,
    }));
    expect(resolvedOrder.rows[0].reconciled_at).not.toBeNull();
    await expect(client.query(
      `UPDATE payment_gateway_orders SET status = 'failed' WHERE id = $1`,
      [order.rows[0].id],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(client.query(
      `UPDATE payment_gateway_refunds
          SET reconciled_at = NOW(),
              reconciliation_note = 'Missing authenticated actor evidence'
        WHERE id = $1`,
      [retained.rows[0].id],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(client.query(
      `UPDATE payment_gateway_refunds
          SET reconciled_at = NOW(),
              reconciliation_note = 'Unknown cross-tenant actor evidence',
              reconciled_by = $1::uuid
        WHERE id = $2`,
      [otherTenantActorUid, retained.rows[0].id],
    )).rejects.toMatchObject({ code: '23503' });

    const resolved = await client.query(
      `UPDATE payment_gateway_refunds
          SET reconciled_at = NOW(),
              reconciliation_note = 'Verified retained provider refund manually',
              reconciled_by = $1::uuid
        WHERE id = $2
        RETURNING reconciled_at, reconciliation_note, reconciled_by`,
      [actorUid, retained.rows[0].id],
    );
    expect(resolved.rows[0].reconciled_at).not.toBeNull();
    expect(resolved.rows[0].reconciliation_note).toContain('retained provider refund');
    await expect(client.query(
      `UPDATE payment_gateway_refunds SET status = 'failed' WHERE id = $1`,
      [retained.rows[0].id],
    )).rejects.toMatchObject({ code: '23514' });
  });
});

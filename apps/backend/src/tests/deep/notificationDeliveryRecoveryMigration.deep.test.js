import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/609_notification_delivery_recovery.sql', import.meta.url),
  'utf8',
);
const RLS_ROLE = 'c6_1d_notification_rls_test';

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
  await client.query('SAVEPOINT expected_c6_1d_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_c6_1d_failure');
  await client.query('RELEASE SAVEPOINT expected_c6_1d_failure');
  expect(failure).toBeDefined();
  expect(failure).toMatchObject(expected);
  return failure;
}

describeIfDb('migration 609 notification delivery recovery', () => {
  const client = new Client({ connectionString: migrationOwnerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const claimToken = randomUUID();
  const lateClaimToken = randomUUID();
  let claimedOutboxId;
  let lateClaimedOutboxId;
  let suppressedOutboxId;
  let failedOutboxId;
  let attemptId;
  let receiptId;

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $3::text, 'C6.1-D migration tenant'),
              ($2::uuid, $4::text, 'C6.1-D migration other tenant')`,
      [tenantId, otherTenantId, `c61d-${suffix}`, `c61d-other-${suffix}`],
    );
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
      `GRANT SELECT ON notification_outbox, notification_delivery_attempts,
         notification_provider_receipts, notification_delivery_cursors
       TO ${RLS_ROLE}`,
    );

    const rows = await client.query(
      `INSERT INTO notification_outbox
         (tenant_id, type, channel, source_event_key, recipient_key,
          template_version, rendered_intent_hash, title, body, payload, status)
       VALUES
         ($1::uuid, 'push', 'push', $2::text, 'id:patient-1', 'result.v1',
          repeat('a', 64), 'Claimed', 'Claimed body', '{}'::jsonb, 'PENDING'),
         ($1::uuid, 'push', 'push', $3::text, 'id:patient-2', 'result.v1',
          repeat('b', 64), 'Suppressed', 'Suppressed body', '{}'::jsonb, 'SUPPRESSED'),
         ($1::uuid, 'email', 'email', $4::text, 'id:patient-3', 'result.v1',
          repeat('c', 64), 'Failed', 'Failed body', '{}'::jsonb, 'FAILED'),
         ($1::uuid, 'push', 'push', $5::text, 'id:patient-4', 'result.v1',
          repeat('d', 64), 'Late attempt', 'Late attempt body', '{}'::jsonb, 'PENDING')
       RETURNING id, status, source_event_key`,
      [
        tenantId,
        `claimed-${suffix}`,
        `suppressed-${suffix}`,
        `failed-${suffix}`,
        `late-claimed-${suffix}`,
      ],
    );
    claimedOutboxId = rows.rows.find(row => row.source_event_key === `claimed-${suffix}`).id;
    lateClaimedOutboxId = rows.rows.find(row => row.source_event_key === `late-claimed-${suffix}`).id;
    suppressedOutboxId = rows.rows.find(row => row.status === 'SUPPRESSED').id;
    failedOutboxId = rows.rows.find(row => row.status === 'FAILED').id;
    await client.query(
      `UPDATE notification_outbox
          SET status = 'CLAIMED', claim_token = $3::uuid, claim_generation = 1,
              claimed_at = NOW(), lease_expires_at = NOW() + INTERVAL '2 minutes'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, claimedOutboxId, claimToken],
    );
    await client.query(
      `UPDATE notification_outbox
          SET status = 'CLAIMED', claim_token = $3::uuid, claim_generation = 1,
              claimed_at = NOW(), lease_expires_at = NOW() + INTERVAL '2 minutes'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, lateClaimedOutboxId, lateClaimToken],
    );
    const attempts = await client.query(
      `INSERT INTO notification_delivery_attempts
         (tenant_id, notification_outbox_id, channel, claim_token,
          claim_generation, attempt_number, provider, rendered_intent_hash)
       VALUES ($1::uuid, $2::integer, 'push', $3::uuid, 1, 1,
               'firebase_fcm', repeat('a', 64))
       RETURNING attempt_id::text`,
      [tenantId, claimedOutboxId, claimToken],
    );
    attemptId = attempts.rows[0].attempt_id;
    const receipts = await client.query(
      `INSERT INTO notification_provider_receipts
         (tenant_id, attempt_id, notification_outbox_id, channel, outcome,
          receipt_source, provider_code, evidence)
       VALUES ($1::uuid, $2::uuid, $3::integer, 'push', 'uncertain',
               'transport_failure', 'ECONNRESET', '{"phase":"response_wait"}'::jsonb)
       RETURNING receipt_id::text`,
      [tenantId, attemptId, claimedOutboxId],
    );
    receiptId = receipts.rows[0].receipt_id;
    await client.query(
      `INSERT INTO notification_delivery_cursors (tenant_id, channel)
       VALUES ($1::uuid, 'push')`,
      [tenantId],
    );
    await client.query(
      `UPDATE notification_delivery_cursors
          SET state = 'paused_uncertain', blocked_outbox_id = $2::integer
        WHERE tenant_id = $1::uuid AND channel = 'push'`,
      [tenantId, claimedOutboxId],
    );
  });

  afterAll(async () => {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('freezes migrations through 608 and owns migration 609', () => {
    const names = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter(name => /^\d+.*\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    const migrationIndex = names.indexOf('609_notification_delivery_recovery.sql');
    expect(migrationIndex).toBeGreaterThan(0);
    expect(names[migrationIndex - 1]).toMatch(/^608(?:_|\.)/);
    expect(names.slice(migrationIndex + 1).every(name => Number.parseInt(name, 10) > 609)).toBe(true);
    expect(migrationSql).toContain('Provider evidence, permission to send, and cursor position');
    expect(migrationSql).not.toContain('clinicalContinuityPolicyService');
  });

  test('installs separate ledgers, persisted leases, append-only guards, and restrictive RLS', async () => {
    const columns = await client.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            (table_name = 'notification_outbox' AND column_name IN
              ('channel', 'source_event_key', 'recipient_key', 'template_version',
               'rendered_intent_hash', 'claim_token', 'claim_generation',
               'claimed_at', 'lease_expires_at'))
            OR table_name IN ('notification_delivery_attempts',
              'notification_provider_receipts', 'notification_delivery_cursors')
          )`,
    );
    expect(new Set(columns.rows.map(row => row.table_name))).toEqual(new Set([
      'notification_outbox',
      'notification_delivery_attempts',
      'notification_provider_receipts',
      'notification_delivery_cursors',
    ]));
    const policies = await client.query(
      `SELECT tablename, policyname, permissive
         FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('notification_outbox', 'notification_delivery_attempts',
            'notification_provider_receipts', 'notification_delivery_cursors')
        ORDER BY tablename, policyname`,
    );
    for (const table of ['notification_outbox', 'notification_delivery_attempts',
      'notification_provider_receipts', 'notification_delivery_cursors']) {
      expect(policies.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ tablename: table, policyname: 'tenant_isolation', permissive: 'PERMISSIVE' }),
        expect.objectContaining({ tablename: table, permissive: 'RESTRICTIVE' }),
      ]));
    }
  });

  test('default-denies absent, empty, bypass, and wrong tenant raw PostgreSQL contexts', async () => {
    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    for (const context of [null, '', 'bypass', otherTenantId]) {
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1::text, true)",
        [context],
      );
      for (const table of ['notification_outbox', 'notification_delivery_attempts',
        'notification_provider_receipts', 'notification_delivery_cursors']) {
        const hidden = await client.query(`SELECT COUNT(*)::integer AS count FROM ${table}`);
        expect(hidden.rows[0].count).toBe(0);
      }
    }
    await client.query(
      "SELECT set_config('app.current_tenant_id', $1::text, true)",
      [tenantId],
    );
    const visible = await client.query(
      `SELECT id FROM notification_outbox WHERE id = $1::integer`,
      [claimedOutboxId],
    );
    expect(visible.rowCount).toBe(1);
    await client.query('RESET ROLE');
  });

  test('keeps attempts and receipts append-only under raw PostgreSQL writes', async () => {
    await expectFailure(client, () => client.query(
      `UPDATE notification_delivery_attempts
          SET provider = 'changed'
        WHERE attempt_id = $1::uuid`,
      [attemptId],
    ), { code: '23514', constraint: 'chk_notification_delivery_evidence_append_only' });
    await expectFailure(client, () => client.query(
      `DELETE FROM notification_provider_receipts WHERE receipt_id = $1::uuid`,
      [receiptId],
    ), { code: '23514', constraint: 'chk_notification_delivery_evidence_append_only' });
  });

  test('cascades evidence-free intents but retains tenants once provider evidence exists', async () => {
    const deleteActions = await client.query(
      `SELECT conname, confdeltype
         FROM pg_constraint
        WHERE conname IN ('fk_notification_outbox_tenant',
          'fk_notification_delivery_attempt_outbox',
          'fk_notification_provider_receipt_attempt')`,
    );
    expect(Object.fromEntries(deleteActions.rows.map(row => [row.conname, row.confdeltype])))
      .toEqual({
        fk_notification_delivery_attempt_outbox: 'a',
        fk_notification_outbox_tenant: 'c',
        fk_notification_provider_receipt_attempt: 'a',
    });

    const transientTenantId = randomUUID();
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'C6.1-D transient notification tenant')`,
      [transientTenantId, `c61d-transient-${suffix}`],
    );
    const transient = await client.query(
      `INSERT INTO notification_outbox
         (tenant_id, type, channel, source_event_key, recipient_key,
          template_version, rendered_intent_hash, title, body, payload, status)
       VALUES ($1::uuid, 'push', 'push', $2::text, 'id:transient',
               'transient.v1', repeat('e', 64), 'Transient', 'Transient body',
               '{}'::jsonb, 'PENDING')
       RETURNING id`,
      [transientTenantId, `transient-${suffix}`],
    );
    const transientOutboxId = transient.rows[0].id;
    await client.query(`DELETE FROM tenants WHERE id = $1::uuid`, [transientTenantId]);
    const deletedIntent = await client.query(
      `SELECT id FROM notification_outbox WHERE id = $1::integer`,
      [transientOutboxId],
    );
    expect(deletedIntent.rowCount).toBe(0);

    await expectFailure(client, () => client.query(
      `DELETE FROM tenants WHERE id = $1::uuid`,
      [tenantId],
    ), { code: '23503' });
  });

  test('late_pending_only allows provider facts and cursor state while blocking every send-permission mutation', async () => {
    await client.query(
      "SELECT set_config('app.current_tenant_id', $1::text, true)",
      [tenantId],
    );
    await client.query(
      "SELECT set_config('app.external_recovery_effect_disposition', 'late_pending_only', true)",
    );

    const lateAttempt = await client.query(
      `INSERT INTO notification_delivery_attempts
         (tenant_id, notification_outbox_id, channel, claim_token,
          claim_generation, attempt_number, provider, rendered_intent_hash)
       VALUES ($1::uuid, $2::integer, 'push', $3::uuid, 1, 1,
               'firebase_fcm', repeat('d', 64))
       RETURNING attempt_id::text`,
      [tenantId, lateClaimedOutboxId, lateClaimToken],
    );
    const lateReceipt = await client.query(
      `INSERT INTO notification_provider_receipts
         (tenant_id, attempt_id, notification_outbox_id, channel, outcome,
          receipt_source, provider_code, evidence)
       VALUES ($1::uuid, $2::uuid, $3::integer, 'push', 'rejected',
               'provider_response', 'invalid_token', '{"provider":"fcm"}'::jsonb)
       RETURNING receipt_id::text`,
      [tenantId, lateAttempt.rows[0].attempt_id, lateClaimedOutboxId],
    );
    expect(lateReceipt.rowCount).toBe(1);
    const cursor = await client.query(
      `UPDATE notification_delivery_cursors
          SET state = 'paused_rejected', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND channel = 'push'
        RETURNING state, last_contiguous_outbox_id`,
      [tenantId],
    );
    expect(cursor.rows).toEqual([{ state: 'paused_rejected', last_contiguous_outbox_id: null }]);

    const guarded = [
      () => client.query(
        `INSERT INTO notification_outbox
           (tenant_id, type, title, body, payload, status)
         VALUES ($1::uuid, 'push', 'Late intent', 'Never notify', '{}'::jsonb, 'PENDING')`,
        [tenantId],
      ),
      () => client.query(
        `UPDATE notification_outbox
            SET status = 'CLAIMED', claim_token = gen_random_uuid(),
                claim_generation = claim_generation + 1, claimed_at = NOW(),
                lease_expires_at = NOW() + INTERVAL '2 minutes'
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        [tenantId, failedOutboxId],
      ),
      () => client.query(
        `UPDATE notification_outbox
            SET status = 'PENDING', claim_token = NULL, claimed_at = NULL,
                lease_expires_at = NULL
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        [tenantId, claimedOutboxId],
      ),
      () => client.query(
        `UPDATE notification_outbox SET status = 'PENDING'
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        [tenantId, suppressedOutboxId],
      ),
    ];
    for (const operation of guarded) {
      await expectFailure(client, operation, {
        code: '23514',
        constraint: 'chk_external_recovery_late_effect_guard',
      });
    }
    await client.query(
      "SELECT set_config('app.external_recovery_effect_disposition', '', true)",
    );
  });

  test('never advances a cursor on rejected or uncertain evidence', async () => {
    const cursor = await client.query(
      `SELECT last_contiguous_outbox_id, state, blocked_outbox_id
         FROM notification_delivery_cursors
        WHERE tenant_id = $1::uuid AND channel = 'push'`,
      [tenantId],
    );
    expect(cursor.rows).toEqual([{
      last_contiguous_outbox_id: null,
      state: 'paused_rejected',
      blocked_outbox_id: claimedOutboxId,
    }]);
    await expectFailure(client, () => client.query(
      `UPDATE notification_delivery_cursors
          SET last_contiguous_outbox_id = $2::integer, state = 'ready',
              blocked_outbox_id = NULL, inflight_outbox_id = NULL
        WHERE tenant_id = $1::uuid AND channel = 'push'`,
      [tenantId, claimedOutboxId],
    ), { code: '23514', constraint: 'chk_notification_delivery_cursor_positive_receipt' });
  });
});

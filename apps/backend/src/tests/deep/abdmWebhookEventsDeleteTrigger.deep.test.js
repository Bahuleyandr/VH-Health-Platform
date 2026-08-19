// Migration 719 (fix_abdm_webhook_delete_trigger_noop): migration 618's
// assert_abdm_i16_receipt_immutable() ended with an unconditional
// `RETURN NEW`, which is NULL in a BEFORE DELETE trigger — so DELETEs of
// legacy abdm_webhook_events rows (receipt_source IS NULL) were SILENTLY
// SKIPPED (DELETE reported 0 rows, no error, row retained). The fix keeps
// the I16 receipt append-only contract byte-for-byte (DELETE of a
// receipt-sourced row still raises 23514/chk_abdm_i16_receipt_append_only,
// pinned by abdmCallbackRecoveryMigration.deep.test.js and re-pinned here)
// and adds an explicit `RETURN OLD` DELETE fall-through so non-receipt rows
// actually delete — restoring 618's own stated scope ("the historical live
// access contract is not silently rewritten").

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const migrationsDirUrl = new URL('../../migrations/', import.meta.url);
const migrationNames = readdirSync(migrationsDirUrl)
  .filter(name => /^\d+.*\.sql$/.test(name))
  .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
// Located by stable suffix, not slot number — the integrator may renumber.
const fixName = migrationNames.find(name =>
  /^\d+_fix_abdm_webhook_delete_trigger_noop\.sql$/.test(name),
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
  await client.query('SAVEPOINT expected_719_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_719_failure');
  await client.query('RELEASE SAVEPOINT expected_719_failure');
  expect(failure).toBeDefined();
  expect(failure).toMatchObject(expected);
  return failure;
}

describeIfDb('abdm_webhook_events delete trigger fix (migration 719)', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'Webhook delete trigger tenant')`,
      [tenantId, `wh-del-719-${suffix}`],
    );
  });

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('the fix migration exists, sequences after 618, and returns OLD on the delete fall-through', () => {
    expect(fixName).toBeDefined();
    expect(migrationNames).toContain('618_abdm_callback_recovery.sql');
    expect(
      migrationNames.indexOf(fixName) >
        migrationNames.indexOf('618_abdm_callback_recovery.sql'),
    ).toBe(true);
    const sql = readFileSync(new URL(fixName, migrationsDirUrl), 'utf8');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.assert_abdm_i16_receipt_immutable()');
    expect(sql).toContain('RETURN OLD');
    expect(sql).toContain('chk_abdm_i16_receipt_append_only');
  });

  test('a legacy (non-receipt) webhook event row actually deletes — the 618 silent no-op is gone', async () => {
    const inserted = await client.query(
      `INSERT INTO abdm_webhook_events
         (tenant_id, external_event_id, event_type, source, signature_verified,
          payload, status, environment, metadata)
       VALUES
         ($1::uuid, $2::text, 'consent_notification', 'abdm_public_callback',
          FALSE, '{}'::jsonb, 'processed', 'sandbox', '{}'::jsonb)
       RETURNING id`,
      [tenantId, `legacy-719-${suffix}`],
    );
    const legacyId = inserted.rows[0].id;

    const deleted = await client.query(
      `DELETE FROM abdm_webhook_events
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, legacyId],
    );
    // On unfixed main this is 0: the BEFORE DELETE trigger returned NULL
    // (RETURN NEW under DELETE) and the row silently survived.
    expect(deleted.rowCount).toBe(1);

    const remaining = await client.query(
      `SELECT id FROM abdm_webhook_events
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, legacyId],
    );
    expect(remaining.rows).toEqual([]);
  });

  test('an I16 receipt row is still append-only: DELETE raises 23514', async () => {
    const externalEventId = `receipt-719-${suffix}`;
    const inserted = await client.query(
      `INSERT INTO abdm_webhook_events
         (tenant_id, external_event_id, event_type, signature_verified, payload,
          status, environment, metadata, receipt_source, callback_path,
          provider_identity_kind, provider_identity_value, raw_body_ciphertext,
          raw_body_sha256, raw_body_bytes, auth_binding_sha256, authenticated_at,
          processed_at)
       VALUES
         ($1::uuid, $2::text, 'consent_on_notify', TRUE, '{}'::jsonb,
          'processed', 'sandbox', '{}'::jsonb,
          'live_authenticated_callback', '/consent/on-notify',
          'consentRequestId', $2::text, 'ciphertext',
          $3::char(64), 24, $4::char(64), NOW(), NOW())
       RETURNING id`,
      [tenantId, externalEventId, 'a'.repeat(64), 'b'.repeat(64)],
    );
    const receiptId = inserted.rows[0].id;

    await expectFailure(client, () => client.query(
      `DELETE FROM abdm_webhook_events
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, receiptId],
    ), { code: '23514', constraint: 'chk_abdm_i16_receipt_append_only' });

    const stillThere = await client.query(
      `SELECT id FROM abdm_webhook_events
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, receiptId],
    );
    expect(stillThere.rows).toHaveLength(1);
  });

  test('receipt UPDATE immutability survived the function recreate', async () => {
    const externalEventId = `receipt-upd-719-${suffix}`;
    const inserted = await client.query(
      `INSERT INTO abdm_webhook_events
         (tenant_id, external_event_id, event_type, signature_verified, payload,
          status, environment, metadata, receipt_source, callback_path,
          provider_identity_kind, provider_identity_value, raw_body_ciphertext,
          raw_body_sha256, raw_body_bytes, auth_binding_sha256, authenticated_at,
          processed_at)
       VALUES
         ($1::uuid, $2::text, 'consent_on_notify', TRUE, '{}'::jsonb,
          'processed', 'sandbox', '{}'::jsonb,
          'live_authenticated_callback', '/consent/on-notify',
          'consentRequestId', $2::text, 'ciphertext',
          $3::char(64), 24, $4::char(64), NOW(), NOW())
       RETURNING id`,
      [tenantId, externalEventId, 'c'.repeat(64), 'd'.repeat(64)],
    );
    const receiptId = inserted.rows[0].id;

    await expectFailure(client, () => client.query(
      `UPDATE abdm_webhook_events
          SET raw_body_ciphertext = 'tampered'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, receiptId],
    ), { code: '23514', constraint: 'chk_abdm_i16_receipt_append_only' });
  });
});

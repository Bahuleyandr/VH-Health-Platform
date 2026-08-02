import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/610_hl7_outbound_recovery.sql', import.meta.url),
  'utf8',
);
const RLS_ROLE = 'c6_1e_hl7_outbound_rls_test';

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
  await client.query('SAVEPOINT expected_c6_1e_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_c6_1e_failure');
  await client.query('RELEASE SAVEPOINT expected_c6_1e_failure');
  expect(failure).toBeDefined();
  expect(failure).toMatchObject(expected);
  return failure;
}

describeIfDb('migration 610 I04 outbound HL7 recovery', () => {
  const client = new Client({ connectionString: migrationOwnerDatabaseUrl(databaseUrl) });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const payload = `MSH|^~\\&|VH|HOSPITAL|REMOTE|HOSPITAL|20260802120000||ADT^A01|CTRL-${suffix}|P|2.5\rPID|1||patient-${suffix}`;
  const response = `MSH|^~\\&|REMOTE|HOSPITAL|VH|HOSPITAL|20260802120100||ACK|ACK-${suffix}|P|2.5\rMSA|AE|CTRL-${suffix}|validation error`;
  const claimToken = randomUUID();
  let subscriptionId;
  let otherSubscriptionId;
  let messageId;
  let attemptId;
  let resultId;
  let acknowledgementId;

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $3::text, 'C6.1-E I04 migration tenant'),
              ($2::uuid, $4::text, 'C6.1-E I04 other tenant')`,
      [tenantId, otherTenantId, `c61e-i04-${suffix}`, `c61e-i04-other-${suffix}`],
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
      `GRANT SELECT ON hl7_feed_subscriptions, hl7_outbound_messages,
         hl7_outbound_transport_attempts, hl7_outbound_transport_results,
         hl7_outbound_acknowledgements, hl7_outbound_delivery_cursors
       TO ${RLS_ROLE}`,
    );
    const subscriptions = await client.query(
      `INSERT INTO hl7_feed_subscriptions
         (tenant_id, name, endpoint_url, message_types)
       VALUES ($1::uuid, $3::text, 'https://example.test/a', ARRAY['ADT^A01']::text[]),
              ($2::uuid, $4::text, 'https://example.test/b', ARRAY['ADT^A01']::text[])
       RETURNING id, tenant_id::text`,
      [tenantId, otherTenantId, `i04-${suffix}`, `i04-other-${suffix}`],
    );
    subscriptionId = subscriptions.rows.find(row => row.tenant_id === tenantId).id;
    otherSubscriptionId = subscriptions.rows.find(row => row.tenant_id === otherTenantId).id;
    const messages = await client.query(
      `INSERT INTO hl7_outbound_messages
         (tenant_id, subscription_id, message_type, message_control_id,
          hl7_payload, source_table, source_id, source_event_key,
          payload_sha256, ledger_version, status, transport_state,
          acknowledgement_state, send_authority)
       VALUES ($1::uuid, $2::integer, 'ADT^A01', $3::text, $4::text,
               'admissions', $5::text, $6::text,
               encode(digest(convert_to($4::text, 'UTF8'), 'sha256'), 'hex'),
               1, 'queued', 'not_attempted', 'pending', 'authorized')
       RETURNING id`,
      [tenantId, subscriptionId, `CTRL-${suffix}`, payload, suffix, `admissions:${suffix}`],
    );
    messageId = messages.rows[0].id;
    await client.query(
      `UPDATE hl7_outbound_messages
          SET status = 'claimed', claim_token = $3::uuid,
              claim_generation = 1, claimed_at = NOW(),
              lease_expires_at = NOW() + INTERVAL '2 minutes'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, messageId, claimToken],
    );
    const attempts = await client.query(
      `INSERT INTO hl7_outbound_transport_attempts
         (tenant_id, message_id, subscription_id, claim_token,
          claim_generation, attempt_number, payload_sha256)
       VALUES ($1::uuid, $2::integer, $3::integer, $4::uuid, 1, 1,
               encode(digest(convert_to($5::text, 'UTF8'), 'sha256'), 'hex'))
       RETURNING attempt_id::text`,
      [tenantId, messageId, subscriptionId, claimToken, payload],
    );
    attemptId = attempts.rows[0].attempt_id;
    const results = await client.query(
      `INSERT INTO hl7_outbound_transport_results
         (tenant_id, attempt_id, message_id, subscription_id, outcome,
          http_status, response_body_sha256, evidence)
       VALUES ($1::uuid, $2::uuid, $3::integer, $4::integer,
               'http_response', 200,
               encode(digest(convert_to($5::text, 'UTF8'), 'sha256'), 'hex'),
               '{"http_ok":true}'::jsonb)
       RETURNING transport_result_id::text`,
      [tenantId, attemptId, messageId, subscriptionId, response],
    );
    resultId = results.rows[0].transport_result_id;
    const acknowledgements = await client.query(
      `INSERT INTO hl7_outbound_acknowledgements
         (tenant_id, attempt_id, transport_result_id, message_id,
          subscription_id, msa_code, acknowledged_control_id,
          correlation_matches, acknowledgement_payload_sha256,
          receipt_source, evidence)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::integer,
               'AE', $6::text, true,
               encode(digest(convert_to($7::text, 'UTF8'), 'sha256'), 'hex'),
               'provider_response', '{"parsed_msa":true}'::jsonb)
       RETURNING acknowledgement_id::text`,
      [tenantId, attemptId, resultId, messageId, subscriptionId, `CTRL-${suffix}`, response],
    );
    acknowledgementId = acknowledgements.rows[0].acknowledgement_id;
    await client.query(
      `INSERT INTO hl7_outbound_delivery_cursors (tenant_id, subscription_id)
       VALUES ($1::uuid, $2::integer)`,
      [tenantId, subscriptionId],
    );
    await client.query(
      `UPDATE hl7_outbound_delivery_cursors
          SET state = 'paused_rejected', blocked_message_id = $3::integer
        WHERE tenant_id = $1::uuid AND subscription_id = $2::integer`,
      [tenantId, subscriptionId, messageId],
    );
    await client.query(
      `UPDATE hl7_outbound_messages
          SET status = 'reconciliation_required',
              transport_state = 'http_response', acknowledgement_state = 'ae',
              send_authority = 'held_owner_reconciliation',
              claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, messageId],
    );
  });

  afterAll(async () => {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test('derives migration 610 from a main line ending at 609', () => {
    const names = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter(name => /^\d+.*\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    const index = names.indexOf('610_hl7_outbound_recovery.sql');
    expect(index).toBeGreaterThan(0);
    expect(names[index - 1]).toBe('609_notification_delivery_recovery.sql');
    expect(names.slice(index + 1).every(name => Number.parseInt(name, 10) > 610)).toBe(true);
    expect(migrationSql).toContain('HTTP success is transport evidence only');
    expect(migrationSql).not.toContain('interop_replay_guard');
  });

  test('installs independent evidence/state planes with layered fail-closed RLS', async () => {
    const tables = [
      'hl7_feed_subscriptions',
      'hl7_outbound_messages',
      'hl7_outbound_transport_attempts',
      'hl7_outbound_transport_results',
      'hl7_outbound_acknowledgements',
      'hl7_outbound_delivery_cursors',
    ];
    const policies = await client.query(
      `SELECT tablename, policyname, permissive
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [tables],
    );
    for (const table of tables) {
      expect(policies.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          tablename: table,
          policyname: 'tenant_isolation',
          permissive: 'PERMISSIVE',
        }),
        expect.objectContaining({
          tablename: table,
          policyname: 'hl7_outbound_explicit_context',
          permissive: 'RESTRICTIVE',
        }),
      ]));
    }
  });

  test('default-denies absent, empty, bypass, and wrong-tenant raw PostgreSQL contexts', async () => {
    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    try {
      for (const context of [null, '', 'bypass', otherTenantId]) {
        await client.query(
          "SELECT set_config('app.current_tenant_id', COALESCE($1::text, ''), true)",
          [context],
        );
        for (const table of [
          'hl7_feed_subscriptions',
          'hl7_outbound_messages',
          'hl7_outbound_transport_attempts',
          'hl7_outbound_transport_results',
          'hl7_outbound_acknowledgements',
          'hl7_outbound_delivery_cursors',
        ]) {
          const hidden = await client.query(
            `SELECT COUNT(*)::integer AS count
               FROM ${table}
              WHERE tenant_id = $1::uuid`,
            [tenantId],
          );
          expect(hidden.rows[0].count).toBe(0);
        }
      }
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1::text, true)",
        [tenantId],
      );
      const visible = await client.query(
        'SELECT id FROM hl7_outbound_messages WHERE id = $1::integer',
        [messageId],
      );
      expect(visible.rowCount).toBe(1);
    } finally {
      await client.query('RESET ROLE');
    }
  });

  test('enforces same-tenant subscription linkage and source-message uniqueness', async () => {
    await expectFailure(client, () => client.query(
      `INSERT INTO hl7_outbound_messages
         (tenant_id, subscription_id, message_type, message_control_id,
          hl7_payload, source_event_key, payload_sha256)
       VALUES ($1::uuid, $2::integer, 'ADT^A01', $3::text, $4::text,
               $5::text, encode(digest(convert_to($4::text, 'UTF8'), 'sha256'), 'hex'))`,
      [tenantId, otherSubscriptionId, `CROSS-${suffix}`, payload, `cross:${suffix}`],
    ), { code: '23503', constraint: 'fk_hl7_outbound_messages_subscription_tenant' });

    await expectFailure(client, () => client.query(
      `INSERT INTO hl7_outbound_messages
         (tenant_id, subscription_id, message_type, message_control_id,
          hl7_payload, source_event_key, payload_sha256)
       VALUES ($1::uuid, $2::integer, 'ADT^A01', $3::text, $4::text,
               $5::text, encode(digest(convert_to($4::text, 'UTF8'), 'sha256'), 'hex'))`,
      [tenantId, subscriptionId, `SECOND-${suffix}`, payload, `admissions:${suffix}`],
    ), { code: '23505', constraint: 'ux_hl7_outbound_message_source' });
  });

  test('preserves the exact HL7 bytes and refuses a mismatched SHA-256', async () => {
    const stored = await client.query(
      `SELECT hl7_payload, payload_sha256,
              encode(digest(convert_to(hl7_payload, 'UTF8'), 'sha256'), 'hex') AS computed
         FROM hl7_outbound_messages WHERE id = $1::integer`,
      [messageId],
    );
    expect(stored.rows[0]).toMatchObject({
      hl7_payload: payload,
      payload_sha256: stored.rows[0].computed,
    });
    await expectFailure(client, () => client.query(
      `INSERT INTO hl7_outbound_messages
         (tenant_id, subscription_id, message_type, message_control_id,
          hl7_payload, source_event_key, payload_sha256)
       VALUES ($1::uuid, $2::integer, 'ADT^A01', $3::text, $4::text,
               $5::text, repeat('0', 64))`,
      [tenantId, subscriptionId, `HASH-${suffix}`, payload, `hash:${suffix}`],
    ), { code: '23514', constraint: 'chk_hl7_outbound_message_payload_hash' });
  });

  test('keeps transport and parsed acknowledgement evidence append-only', async () => {
    await expectFailure(client, () => client.query(
      `UPDATE hl7_outbound_transport_results SET http_status = 201
        WHERE transport_result_id = $1::uuid`,
      [resultId],
    ), { code: '23514', constraint: 'chk_hl7_outbound_evidence_append_only' });
    await expectFailure(client, () => client.query(
      'DELETE FROM hl7_outbound_acknowledgements WHERE acknowledgement_id = $1::uuid',
      [acknowledgementId],
    ), { code: '23514', constraint: 'chk_hl7_outbound_evidence_append_only' });
  });

  test('HTTP 200 and MSA|AE cannot mark sent or advance the per-subscription cursor', async () => {
    await expectFailure(client, () => client.query(
      `UPDATE hl7_outbound_messages
          SET status = 'sent', acknowledgement_state = 'aa',
              claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, messageId],
    ), { code: '23514', constraint: 'chk_hl7_outbound_sent_positive_ack' });
    await expectFailure(client, () => client.query(
      `UPDATE hl7_outbound_delivery_cursors
          SET last_contiguous_message_id = $3::integer,
              state = 'ready', blocked_message_id = NULL,
              inflight_message_id = NULL
        WHERE tenant_id = $1::uuid AND subscription_id = $2::integer`,
      [tenantId, subscriptionId, messageId],
    ), { code: '23514', constraint: 'chk_hl7_outbound_cursor_positive_ack' });
  });

  test('late_pending_only blocks send creation/re-arm while parsed evidence remains insertable', async () => {
    const lateControlId = `LATE-EVIDENCE-${suffix}`;
    const latePayload = payload.replace(`CTRL-${suffix}`, lateControlId);
    const lateMessage = await client.query(
      `INSERT INTO hl7_outbound_messages
         (tenant_id, subscription_id, message_type, message_control_id,
          hl7_payload, source_event_key, payload_sha256)
       VALUES ($1::uuid, $2::integer, 'ADT^A01', $3::text, $4::text,
               $5::text, encode(digest(convert_to($4::text, 'UTF8'), 'sha256'), 'hex'))
       RETURNING id`,
      [tenantId, subscriptionId, lateControlId, latePayload, `late-evidence:${suffix}`],
    );
    const lateClaimToken = randomUUID();
    await client.query(
      `UPDATE hl7_outbound_messages
          SET status = 'claimed', claim_token = $3::uuid,
              claim_generation = 1, claimed_at = NOW(),
              lease_expires_at = NOW() + INTERVAL '2 minutes'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, lateMessage.rows[0].id, lateClaimToken],
    );
    const lateAttempt = await client.query(
      `INSERT INTO hl7_outbound_transport_attempts
         (tenant_id, message_id, subscription_id, claim_token,
          claim_generation, attempt_number, payload_sha256)
       VALUES ($1::uuid, $2::integer, $3::integer, $4::uuid, 1, 1,
               encode(digest(convert_to($5::text, 'UTF8'), 'sha256'), 'hex'))
       RETURNING attempt_id::text`,
      [tenantId, lateMessage.rows[0].id, subscriptionId, lateClaimToken, latePayload],
    );
    await client.query(
      "SELECT set_config('app.external_recovery_effect_disposition', 'late_pending_only', true)",
    );
    await expectFailure(client, () => client.query(
      `INSERT INTO hl7_outbound_messages
         (tenant_id, subscription_id, message_type, message_control_id,
          hl7_payload, source_event_key, payload_sha256)
       VALUES ($1::uuid, $2::integer, 'ADT^A01', $3::text, $4::text,
               $5::text, encode(digest(convert_to($4::text, 'UTF8'), 'sha256'), 'hex'))`,
      [tenantId, subscriptionId, `LATE-${suffix}`, payload, `late:${suffix}`],
    ), { code: '23514', constraint: 'chk_hl7_outbound_late_send_suppression' });
    await expectFailure(client, () => client.query(
      `UPDATE hl7_outbound_messages
          SET send_authority = 'authorized', status = 'queued',
              owner_release_actor_uid = $3::uuid,
              owner_release_reason = 'owner release without inbox',
              owner_released_at = NOW(), claim_token = NULL,
              claimed_at = NULL, lease_expires_at = NULL
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, messageId, randomUUID()],
    ), { code: '23514', constraint: 'chk_hl7_outbound_late_owner_release_provenance' });

    const lateResponse = response.replace('AE', 'AR').replace(`CTRL-${suffix}`, lateControlId);
    const lateResult = await client.query(
      `INSERT INTO hl7_outbound_transport_results
         (tenant_id, attempt_id, message_id, subscription_id, outcome,
          http_status, response_body_sha256, evidence)
       VALUES ($1::uuid, $2::uuid, $3::integer, $4::integer,
               'http_response', 200,
               encode(digest(convert_to($5::text, 'UTF8'), 'sha256'), 'hex'),
               '{"late_fact":true}'::jsonb)
       RETURNING transport_result_id::text`,
      [tenantId, lateAttempt.rows[0].attempt_id, lateMessage.rows[0].id,
        subscriptionId, lateResponse],
    );
    const evidence = await client.query(
      `INSERT INTO hl7_outbound_acknowledgements
         (tenant_id, attempt_id, transport_result_id, message_id,
          subscription_id, msa_code, acknowledged_control_id,
          correlation_matches, acknowledgement_payload_sha256,
          receipt_source, evidence)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::integer,
               'AR', $6::text, true, repeat('f', 64),
               'provider_response', '{"late_fact":true}'::jsonb)
       RETURNING acknowledgement_id`,
      [tenantId, lateAttempt.rows[0].attempt_id, lateResult.rows[0].transport_result_id,
        lateMessage.rows[0].id, subscriptionId, lateControlId],
    );
    expect(evidence.rowCount).toBe(1);
    await client.query(
      "SELECT set_config('app.external_recovery_effect_disposition', '', true)",
    );
  });
});

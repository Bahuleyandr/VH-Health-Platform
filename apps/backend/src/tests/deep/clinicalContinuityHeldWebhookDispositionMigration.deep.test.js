import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const RLS_ROLE = 'c5_2_pr2_629_rls_test';

async function expectDatabaseFailure(client, operation, { code, constraint = null }) {
  await client.query('SAVEPOINT expected_c5_2_pr2_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_c5_2_pr2_failure');
  await client.query('RELEASE SAVEPOINT expected_c5_2_pr2_failure');
  expect(failure).toBeDefined();
  expect(failure.code).toBe(code);
  if (constraint) expect(failure.constraint).toBe(constraint);
}

describeIfDb('migration 629 C5.2 held-webhook raw-PostgreSQL drills', () => {
  const client = new Client({ connectionString: databaseUrl });
  const fixture = {
    tenantId: randomUUID(),
    wrongTenantId: randomUUID(),
    actorUid: randomUUID(),
    patientUid: randomUUID(),
    factId: randomUUID(),
    suffix: randomUUID().replaceAll('-', '').slice(0, 12),
  };

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'C5.2 PR-2 migration tenant')`,
      [fixture.tenantId, `c52-pr2-${fixture.suffix}`],
    );
    for (const [uid, role, suffix] of [
      [fixture.actorUid, 'ADMIN', 'actor'],
      [fixture.patientUid, 'PATIENT', 'patient'],
    ]) {
      await client.query(
        `INSERT INTO users
           (uid, tenant_id, phone, email, name, role, is_active, status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::text, $4::text,
                 $5::text, $6::text, TRUE, 'active', NOW())`,
        [uid, fixture.tenantId, `93${randomUUID().replaceAll('-', '').slice(0, 10)}`,
          `${suffix}-${fixture.suffix}@example.test`, `C5.2 ${suffix}`, role],
      );
    }
    const integration = await client.query(
      `INSERT INTO integrations (tenant_id, name, integration_type, status)
       VALUES ($1::uuid, $2::text, 'webhook', 'active') RETURNING id`,
      [fixture.tenantId, `c52-pr2-${fixture.suffix}`],
    );
    const subscription = await client.query(
      `INSERT INTO webhook_subscriptions
         (tenant_id, integration_id, event_type, endpoint_url,
          signing_algorithm, is_active, downstream_effect_classification,
          acknowledgement_contract, acknowledgement_config,
          recovery_contract_owner_uid, recovery_contract_owner_reason,
          recovery_contract_classified_at)
       VALUES ($1::uuid, $2::integer,
               'clinical_continuity.paper_fact.recorded',
               'https://subscriber.example.test/c52-pr2', 'none', TRUE,
               'clinical_or_operational_effect', 'response_header_sha256',
               '{"header_name":"x-c52-ack"}'::jsonb, $3::uuid,
               'Blast radius classified; release authority remains absent.', NOW())
       RETURNING id`,
      [fixture.tenantId, integration.rows[0].id, fixture.actorUid],
    );
    fixture.subscriptionId = subscription.rows[0].id;

    const lateSource = await client.query(
      `INSERT INTO event_outbox
         (tenant_id, event_type, aggregate_type, aggregate_id, patient_uid,
          payload, status, available_at, occurred_at, occurred_at_source, created_at)
       VALUES ($1::uuid, 'clinical_continuity.paper_fact.recorded',
               'clinical_continuity_retrospective_fact', $2::uuid::text, $3::uuid,
               '{"effect_disposition":"late_pending_only"}'::jsonb,
               'pending', NOW(), NOW() - INTERVAL '20 minutes', 'explicit', NOW())
       RETURNING id::text, occurred_at::text,
                 encode(digest(payload::text, 'sha256'), 'hex') AS payload_sha256`,
      [fixture.tenantId, fixture.factId, fixture.patientUid],
    );
    fixture.lateSourceId = lateSource.rows[0].id;
    fixture.payloadHash = lateSource.rows[0].payload_sha256;
    fixture.occurredAt = lateSource.rows[0].occurred_at;

    const offset = await client.query(
      `INSERT INTO event_consumer_offsets
         (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
          direction, source_partition, consumer_key, generation, cursor_kind,
          high_water_position, high_water_token, retained_from_position,
          retained_from_token, recovery_state, policy_version, policy_signature,
          retention_policy, retention_until, historical_cutoff_event_id,
          backfill_cursor_event_id)
       VALUES ('external_interface', $1::uuid, 'tenant', NULL, 'I18', 'outbound',
               $2::text, $3::text, 1, 'monotonic_position_and_predecessor',
               $4::bigint - 1, 'owner-predecessor', $4::bigint - 1,
               'owner-predecessor', 'replaying', 'c52-pr2-v1', $5::text,
               'webhook-evidence-2555d', NOW() + INTERVAL '2555 days', NULL, NULL)
       RETURNING offset_id::text`,
      [fixture.tenantId, `webhook-subscription:${fixture.subscriptionId}:outbound`,
        `external:I18:c52-pr2:${fixture.suffix}`, fixture.lateSourceId,
        `c52-pr2-${fixture.suffix}`],
    );
    const inbox = await client.query(
      `INSERT INTO pathway_projector_inbox
         (scope_kind, tenant_id, consumer_key, generation, offset_id, facility_id,
          interface_family, direction, source_partition, source_position,
          source_token, predecessor_token, duplicate_key, command_fingerprint,
          occurred_at, received_at, recorded_at, arrival_class,
          effect_disposition, status, next_attempt_at, policy_version,
          policy_signature, retention_policy, retention_until)
       VALUES ('external_interface', $1::uuid, $2::text, 1, $3::uuid, NULL,
               'I18', 'outbound', $4::text, $5::bigint, 'owner-source',
               'owner-predecessor', $6::text, repeat('b', 64),
               $7::timestamptz, NOW(), NOW(), 'recovery_backlog',
               'late_pending_only', 'pending', NOW(), 'c52-pr2-v1', $8::text,
               'webhook-evidence-2555d', NOW() + INTERVAL '2555 days')
       RETURNING inbox_id::text`,
      [fixture.tenantId, `external:I18:c52-pr2:${fixture.suffix}`,
        offset.rows[0].offset_id, `webhook-subscription:${fixture.subscriptionId}:outbound`,
        fixture.lateSourceId,
        `i18:${fixture.subscriptionId}:event_outbox:${fixture.lateSourceId}:${fixture.payloadHash}`,
        fixture.occurredAt, `c52-pr2-${fixture.suffix}`],
    );
    await client.query(
      `UPDATE event_outbox
          SET recovery_inbox_id = $3::uuid,
              recovery_fingerprint = repeat('b', 64),
              recovery_effect_disposition = 'late_pending_only'
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [fixture.tenantId, fixture.lateSourceId, inbox.rows[0].inbox_id],
    );

    const held = await client.query(
      `INSERT INTO webhook_deliveries
         (tenant_id, subscription_id, event_outbox_id, event_type, payload,
          status, attempt_number, next_retry_at, request_id, source_kind,
          source_identity, source_position, payload_sha256,
          downstream_effect_classification, acknowledgement_contract,
          acknowledgement_config, acknowledgement_state,
          send_authority, effect_disposition)
       VALUES ($1::uuid, $2::integer, $3::bigint,
               'clinical_continuity.paper_fact.recorded',
               '{"effect_disposition":"late_pending_only"}'::jsonb,
               'pending', 0, NULL, $4::text, 'event_outbox',
               'event_outbox:' || $3::bigint::text, $3::bigint, $5::char(64),
               'clinical_or_operational_effect', 'response_header_sha256',
               '{"header_name":"x-c52-ack"}'::jsonb, 'pending',
               'held_owner_reconciliation', 'late_pending_only')
       RETURNING id`,
      [fixture.tenantId, fixture.subscriptionId, fixture.lateSourceId,
        `c52-pr2-${fixture.suffix}`, fixture.payloadHash],
    );
    fixture.heldDeliveryId = held.rows[0].id;

    const ordinary = await client.query(
      `INSERT INTO event_outbox
         (tenant_id, event_type, aggregate_type, payload, status,
          available_at, occurred_at, occurred_at_source, created_at)
       VALUES ($1::uuid, 'clinical_continuity.paper_fact.recorded',
               'ordinary_fixture', '{}'::jsonb, 'pending', NOW(), NOW(),
               'explicit', NOW()) RETURNING id::text`,
      [fixture.tenantId],
    );
    fixture.ordinarySourceId = ordinary.rows[0].id;

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_ROLE}') THEN
          CREATE ROLE ${RLS_ROLE} NOLOGIN;
        END IF;
      END $$
    `);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON event_outbox TO ${RLS_ROLE}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_deliveries TO ${RLS_ROLE}`);
    await client.query(`GRANT USAGE, SELECT ON SEQUENCE event_outbox_id_seq TO ${RLS_ROLE}`);
    await client.query(`GRANT USAGE, SELECT ON SEQUENCE webhook_deliveries_id_seq TO ${RLS_ROLE}`);
  });

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  test.each([
    ['unset', null],
    ['empty', ''],
    ['bypass', 'bypass'],
    ['wrong tenant', fixture.wrongTenantId],
  ])('denies a late non-inbox outbox INSERT under %s context', async (_label, context) => {
    await expectDatabaseFailure(client, async () => {
      await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
      if (context !== null) {
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [context]);
      }
      if (context === null) {
        const hidden = await client.query(
          `SELECT id FROM webhook_deliveries
            WHERE tenant_id = $1::uuid AND id = $2::integer`,
          [fixture.tenantId, fixture.heldDeliveryId],
        );
        expect(hidden.rows).toHaveLength(0);
      }
      await client.query(
        `INSERT INTO event_outbox
           (tenant_id, event_type, aggregate_type, aggregate_id, patient_uid,
            payload, status, available_at, occurred_at, occurred_at_source, created_at,
            recovery_effect_disposition)
         VALUES ($1::uuid, 'clinical_continuity.paper_fact.recorded',
                 'clinical_continuity_retrospective_fact', $2::uuid::text, $3::uuid,
                 '{}'::jsonb, 'pending', NOW(), NOW(), 'explicit', NOW(),
                 'late_pending_only')`,
        [fixture.tenantId, randomUUID(), fixture.patientUid],
      );
    }, { code: '42501' });
    await client.query('RESET ROLE');
  });

  test('fails closed on malformed tenant context without writing or revealing held evidence', async () => {
    await expectDatabaseFailure(client, async () => {
      await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
      await client.query("SELECT set_config('app.current_tenant_id', 'not-a-uuid', true)");
      await client.query(
        `INSERT INTO event_outbox
           (tenant_id, event_type, aggregate_type, aggregate_id, patient_uid,
            payload, status, available_at, occurred_at, occurred_at_source, created_at,
            recovery_effect_disposition)
         VALUES ($1::uuid, 'clinical_continuity.paper_fact.recorded',
                 'clinical_continuity_retrospective_fact', $2::uuid::text, $3::uuid,
                 '{}'::jsonb, 'pending', NOW(), NOW(), 'explicit', NOW(),
                 'late_pending_only')`,
        [fixture.tenantId, randomUUID(), fixture.patientUid],
      );
    }, { code: '22P02' });
    await client.query('RESET ROLE');

    await expectDatabaseFailure(client, async () => {
      await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
      await client.query("SELECT set_config('app.current_tenant_id', 'not-a-uuid', true)");
      await client.query(
        `SELECT id FROM webhook_deliveries
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        [fixture.tenantId, fixture.heldDeliveryId],
      );
    }, { code: '22P02' });
    await client.query('RESET ROLE');
  });

  test('rejects exact-tenant late outbox authority without the C5.2 fact and C5.1 effect evidence', async () => {
    await expectDatabaseFailure(client, async () => {
      await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [fixture.tenantId]);
      await client.query(
        `INSERT INTO event_outbox
           (tenant_id, event_type, aggregate_type, aggregate_id, patient_uid,
            payload, status, available_at, occurred_at, occurred_at_source, created_at,
            recovery_effect_disposition)
         VALUES ($1::uuid, 'clinical_continuity.paper_fact.recorded',
                 'clinical_continuity_retrospective_fact', $2::uuid::text, $3::uuid,
                 '{}'::jsonb, 'pending', NOW(), NOW(), 'explicit', NOW(),
                 'late_pending_only')`,
        [fixture.tenantId, randomUUID(), fixture.patientUid],
      );
      await client.query('SET CONSTRAINTS cc_paper_outbox_binding IMMEDIATE');
    }, { code: '23514', constraint: 'chk_cc_paper_outbox_binding' });
    await client.query('RESET ROLE');
  });

  test('rejects held authority on a null/live source and live authority on a late source', async () => {
    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [fixture.tenantId]);
    await expectDatabaseFailure(client, () => client.query(
      `INSERT INTO webhook_deliveries
         (tenant_id, subscription_id, event_outbox_id, event_type, payload,
          status, attempt_number, next_retry_at, request_id, source_kind,
          source_identity, source_position, payload_sha256,
          send_authority, effect_disposition)
       VALUES ($1::uuid, $2::integer, $3::bigint,
               'clinical_continuity.paper_fact.recorded', '{}'::jsonb,
               'pending', 0, NULL, $4::text, 'event_outbox',
               'event_outbox:' || $3::bigint::text, $3::bigint,
               encode(digest('{}'::jsonb::text, 'sha256'), 'hex'),
               'held_owner_reconciliation', 'late_pending_only')`,
      [fixture.tenantId, fixture.subscriptionId, fixture.ordinarySourceId, randomUUID()],
    ), { code: '23514', constraint: 'chk_webhook_i18_source_disposition_binding' });
    await expectDatabaseFailure(client, () => client.query(
      `INSERT INTO webhook_deliveries
         (tenant_id, subscription_id, event_outbox_id, event_type, payload,
          status, attempt_number, next_retry_at, request_id, source_kind,
          source_identity, source_position, payload_sha256)
       VALUES ($1::uuid, $2::integer, $3::bigint,
               'clinical_continuity.paper_fact.recorded',
               '{"effect_disposition":"late_pending_only"}'::jsonb,
               'pending', 0, NOW(), $4::text, 'event_outbox',
               'event_outbox:' || $3::bigint::text, $3::bigint, $5::char(64))`,
      [fixture.tenantId, fixture.subscriptionId, fixture.lateSourceId,
        randomUUID(), fixture.payloadHash],
    ), { code: '23514', constraint: 'chk_webhook_i18_source_disposition_binding' });
    await client.query('RESET ROLE');
  });

  test('refuses direct rearm/delete and never leases the held delivery', async () => {
    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [fixture.tenantId]);
    await expectDatabaseFailure(client, () => client.query(
      `UPDATE webhook_deliveries
          SET send_authority = 'live_authorized', effect_disposition = 'live',
              next_retry_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.heldDeliveryId],
    ), { code: '23514', constraint: 'chk_webhook_i18_source_disposition_binding' });
    await expectDatabaseFailure(client, () => client.query(
      `DELETE FROM webhook_deliveries
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.heldDeliveryId],
    ), { code: '23514', constraint: 'chk_webhook_i18_source_held_immutable' });
    const claimed = await client.query(
      `UPDATE webhook_deliveries
          SET status = 'in_flight', attempt_number = attempt_number + 1,
              lease_owner = $3::uuid, lease_expires_at = NOW() + INTERVAL '1 minute'
        WHERE tenant_id = $1::uuid AND id = $2::integer
          AND status IN ('pending', 'failed')
          AND send_authority = 'live_authorized'
          AND next_retry_at <= NOW()
      RETURNING id`,
      [fixture.tenantId, fixture.heldDeliveryId, randomUUID()],
    );
    expect(claimed.rows).toHaveLength(0);
    const state = await client.query(
      `SELECT status, attempt_number, next_retry_at, lease_owner,
              send_authority, effect_disposition,
              downstream_effect_classification
         FROM webhook_deliveries
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.heldDeliveryId],
    );
    expect(state.rows[0]).toMatchObject({
      status: 'pending',
      attempt_number: 0,
      next_retry_at: null,
      lease_owner: null,
      send_authority: 'held_owner_reconciliation',
      effect_disposition: 'late_pending_only',
      downstream_effect_classification: 'clinical_or_operational_effect',
    });
    await client.query('RESET ROLE');
  });

  test.each([
    ['empty', ''],
    ['bypass', 'bypass'],
    ['wrong tenant', fixture.wrongTenantId],
  ])('hides held I18 evidence under %s context', async (_label, context) => {
    await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [context]);
    const rows = await client.query(
      `SELECT id FROM webhook_deliveries
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.heldDeliveryId],
    );
    expect(rows.rows).toHaveLength(0);
    await client.query('RESET ROLE');
  });
});

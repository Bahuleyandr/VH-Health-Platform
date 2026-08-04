import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import {
  capturePendingSecurityAuditEvents,
  enqueueSiemDeliveries,
  upsertSiemExportTarget,
} from '../../services/security/siemExportService.js';
import {
  I25_CUTOVER_CRASH_BOUNDARIES,
  performSiemCanonicalCutover,
} from '../../services/security/siemCanonicalCutoverService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

function ownerDatabaseUrl(value) {
  if (!value) return value;
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

function cutoverInput(tenantId, cutoff, crashAt = null) {
  return {
    tenantId,
    expectedCutoffSourceId: cutoff,
    generation: 1,
    policyVersion: 'i25-canonical-v1',
    policySignature: `i25-test-${tenantId}`,
    retentionPolicy: 'siem-evidence-2555d',
    retentionUntil: '2033-08-04T00:00:00.000Z',
    crashAt,
  };
}

async function insertTenantAndOwner(client, label) {
  const tenantId = randomUUID();
  const actorUid = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  await client.query(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2::text, $3::text)`,
    [tenantId, `i25-${label}-${suffix}`, `I25 ${label} tenant`],
  );
  await client.query(
    `INSERT INTO users
       (uid, tenant_id, phone, name, role, is_active, status, updated_at)
     VALUES
       ($1::uuid, $2::uuid, $3::text, $4::text, 'ADMIN', true, 'active', NOW())`,
    [actorUid, tenantId, `91${suffix.slice(0, 10)}`, `I25 ${label} owner`],
  );
  return { tenantId, actorUid, suffix };
}

async function insertSecurityAuditRows(client, tenantId, actorUid, suffix, count) {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const result = await client.query(
      `INSERT INTO audit_log
         (uid, tenant_id, action, resource, resource_id, metadata,
          ip_address, user_name, user_role, method, path, module,
          status_code, success, user_agent, actor_uid, request_summary)
       VALUES
         (gen_random_uuid(), $1::uuid, $2::text, 'session', $3::text,
          $4::jsonb, '203.0.113.25', 'I25 owner', 'ADMIN', 'POST',
          '/auth/session', 'security', 401, false, 'i25-deep-test',
          $5::uuid, $6::text)
       RETURNING id`,
      [tenantId, index === 0 ? 'LOGIN_FAILED' : 'ACCOUNT_LOCKED',
        `${suffix}-${index}`, JSON.stringify({ outcome: 'blocked', request_id: `${suffix}-${index}` }),
        actorUid, `I25 security fixture ${index}`],
    );
    ids.push(result.rows[0].id);
  }
  return ids;
}

async function expectPgFailure(client, operation, expectedConstraint) {
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
  if (expectedConstraint) expect(failure.constraint).toBe(expectedConstraint);
  return failure;
}

describeIfDb('I25 canonical SIEM cutover', () => {
  const client = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
  let tenantId;
  let actorUid;
  let cutoff;
  let sourceIds;
  let completeTarget;
  let partialTarget;
  let beforeCounts;

  beforeAll(async () => {
    await client.connect();
    const identity = await insertTenantAndOwner(client, 'cutover');
    tenantId = identity.tenantId;
    actorUid = identity.actorUid;
    sourceIds = await insertSecurityAuditRows(
      client,
      tenantId,
      actorUid,
      identity.suffix,
      2,
    );
    cutoff = sourceIds.at(-1);

    const captured = await capturePendingSecurityAuditEvents({ tenantId, batchSize: 10 });
    expect(captured).toMatchObject({ captured_count: 2, last_source_id: cutoff });

    completeTarget = await upsertSiemExportTarget({
      tenantId,
      targetKey: `complete-${identity.suffix}`,
      displayName: 'I25 complete acknowledgement target',
      transport: 'webhook',
      status: 'active',
      minSeverity: 'high',
      endpointUrl: 'https://siem.example/complete',
      actorUid,
      acknowledgementContract: 'webhook_http_2xx_ingested',
      acknowledgementOwnerReason: 'The owner contract defines HTTP 2xx as durable SIEM ingestion.',
      acknowledgementOwnerEvidence: { contract_reference: 'i25-deep-complete-v1' },
    });
    partialTarget = await upsertSiemExportTarget({
      tenantId,
      targetKey: `partial-${identity.suffix}`,
      displayName: 'I25 partial acknowledgement target',
      transport: 'webhook',
      status: 'active',
      minSeverity: 'high',
      endpointUrl: 'https://siem.example/partial',
      actorUid,
      acknowledgementContract: 'webhook_receipt_header',
      acknowledgementConfig: { header_name: 'X-SIEM-Receipt', expected_value: 'accepted' },
      acknowledgementOwnerReason: 'The owner contract requires an exact receipt header.',
      acknowledgementOwnerEvidence: { contract_reference: 'i25-deep-partial-v1' },
    });
    expect(await enqueueSiemDeliveries({ tenantId, batchSize: 20 }))
      .toMatchObject({ targets: 2, enqueued: 4 });

    await client.query(
      `UPDATE siem_export_delivery_attempts
          SET status = 'succeeded', acknowledgement_state = 'positive',
              acknowledgement_evidence = '{"owner_contract_verified":true}'::jsonb,
              acknowledged_at = NOW(), completed_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1::uuid AND target_id = $2::bigint`,
      [tenantId, String(completeTarget.id)],
    );
    await client.query(
      `UPDATE siem_export_delivery_attempts
          SET status = 'succeeded', acknowledgement_state = 'positive',
              acknowledgement_evidence = '{"receipt_header_verified":true}'::jsonb,
              acknowledged_at = NOW(), completed_at = NOW(), updated_at = NOW()
        WHERE id = (
          SELECT d.id
            FROM siem_export_delivery_attempts d
            JOIN siem_export_events e ON e.id = d.event_id
           WHERE d.tenant_id = $1::uuid AND d.target_id = $2::bigint
           ORDER BY e.source_id::bigint ASC
           LIMIT 1
        )`,
      [tenantId, String(partialTarget.id)],
    );
    await client.query(
      `UPDATE siem_export_events
          SET export_status = 'succeeded', updated_at = NOW()
        WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    const counts = await client.query(
      `SELECT
         (SELECT COUNT(*)::integer FROM siem_export_cursors WHERE tenant_id = $1::uuid) AS cursors,
         (SELECT COUNT(*)::integer FROM siem_export_events WHERE tenant_id = $1::uuid) AS events,
         (SELECT COUNT(*)::integer FROM siem_export_delivery_attempts WHERE tenant_id = $1::uuid) AS attempts`,
      [tenantId],
    );
    beforeCounts = counts.rows[0];
  });

  afterAll(async () => {
    await client.end();
  });

  test('rejects an in-flight claim that has no expiring lease fence', async () => {
    await expectPgFailure(client, () => client.query(
      `INSERT INTO siem_export_delivery_attempts
         (tenant_id, event_id, target_id, transport, attempt_number, status,
          payload_snapshot, payload_sha256, request_id, started_at)
       SELECT e.tenant_id, e.id, $2::bigint, 'webhook', 99, 'in_flight',
              e.minimized_payload, e.payload_sha256, gen_random_uuid()::text, NOW()
         FROM siem_export_events e
        WHERE e.tenant_id = $1::uuid
        ORDER BY e.source_id::bigint ASC LIMIT 1`,
      [tenantId, String(completeTarget.id)],
    ), 'chk_siem_export_delivery_attempts_lease');
  });

  test('rolls back every registered crash boundary with zero canonical rows', async () => {
    for (const boundary of I25_CUTOVER_CRASH_BOUNDARIES) {
      await expect(performSiemCanonicalCutover(cutoverInput(tenantId, cutoff, boundary)))
        .rejects.toThrow(`I25_CRASH_INJECTION:${boundary}`);
      const state = await client.query(
        `SELECT
           (SELECT COUNT(*)::integer FROM event_consumer_offsets
             WHERE tenant_id = $1::uuid AND interface_family = 'I25') AS offsets,
           (SELECT writer_state FROM siem_export_cursors
             WHERE tenant_id = $1::uuid AND source_name = 'audit_log'
               AND cursor_key = 'security') AS writer_state`,
        [tenantId],
      );
      expect(state.rows[0]).toEqual({ offsets: 0, writer_state: 'legacy_capture' });
    }
  });

  test('cuts over non-destructively, ignores shared export_status, and pauses activation', async () => {
    const result = await performSiemCanonicalCutover(cutoverInput(tenantId, cutoff));
    expect(result).toMatchObject({
      tenant_id: tenantId,
      cutoff_source_id: cutoff,
      writer_state: 'canonical_offsets',
      recovery_state: 'paused',
      capture_schedule_decision: 'owner_activation_required',
      activation_performed: false,
    });
    expect(result.delivery_offsets).toHaveLength(2);
    expect(result.delivery_offsets.find(row => row.targetId === String(completeTarget.id)))
      .toMatchObject({ complete: true, highWaterPosition: cutoff, firstUnproven: null });
    expect(result.delivery_offsets.find(row => row.targetId === String(partialTarget.id)))
      .toMatchObject({
        complete: false,
        highWaterPosition: sourceIds[0],
        firstUnproven: sourceIds[1],
      });

    const evidence = await client.query(
      `SELECT
         (SELECT COUNT(*)::integer FROM event_consumer_offsets
           WHERE tenant_id = $1::uuid AND interface_family = 'I25'
             AND recovery_state = 'paused') AS paused_offsets,
         (SELECT COUNT(*)::integer FROM siem_export_cursors WHERE tenant_id = $1::uuid) AS cursors,
         (SELECT COUNT(*)::integer FROM siem_export_events WHERE tenant_id = $1::uuid) AS events,
         (SELECT COUNT(*)::integer FROM siem_export_delivery_attempts WHERE tenant_id = $1::uuid) AS attempts,
         (SELECT writer_state FROM siem_export_cursors
           WHERE tenant_id = $1::uuid AND source_name = 'audit_log'
             AND cursor_key = 'security') AS writer_state`,
      [tenantId],
    );
    expect(evidence.rows[0]).toEqual({
      paused_offsets: 3,
      ...beforeCounts,
      writer_state: 'canonical_offsets',
    });
    await expect(capturePendingSecurityAuditEvents({ tenantId, batchSize: 10 }))
      .rejects.toThrow('paused pending separate scheduler activation');
    await expectPgFailure(client, () => client.query(
      `UPDATE siem_export_cursors SET metadata = metadata || '{"rewrite":true}'::jsonb
        WHERE tenant_id = $1::uuid AND source_name = 'audit_log' AND cursor_key = 'security'`,
      [tenantId],
    ), 'chk_siem_i25_legacy_cursor_frozen');
  });

  test('aborts a capture SHA mismatch with zero partial canonical rows', async () => {
    const identity = await insertTenantAndOwner(client, 'negative');
    const ids = await insertSecurityAuditRows(
      client,
      identity.tenantId,
      identity.actorUid,
      identity.suffix,
      1,
    );
    await capturePendingSecurityAuditEvents({ tenantId: identity.tenantId, batchSize: 10 });
    await client.query(
      `UPDATE siem_export_events SET payload_sha256 = repeat('f', 64)
        WHERE tenant_id = $1::uuid`,
      [identity.tenantId],
    );

    await expect(performSiemCanonicalCutover(cutoverInput(identity.tenantId, ids[0])))
      .rejects.toThrow('captured payload SHA-256 completeness failed');
    const state = await client.query(
      `SELECT
         (SELECT COUNT(*)::integer FROM event_consumer_offsets
           WHERE tenant_id = $1::uuid AND interface_family = 'I25') AS offsets,
         (SELECT writer_state FROM siem_export_cursors
           WHERE tenant_id = $1::uuid AND source_name = 'audit_log'
             AND cursor_key = 'security') AS writer_state`,
      [identity.tenantId],
    );
    expect(state.rows[0]).toEqual({ offsets: 0, writer_state: 'legacy_capture' });
  });

  test('binds exact late attempt provenance as immutable held owner work', async () => {
    const identity = await insertTenantAndOwner(client, 'recovery');
    await insertSecurityAuditRows(
      client,
      identity.tenantId,
      identity.actorUid,
      identity.suffix,
      1,
    );
    await capturePendingSecurityAuditEvents({ tenantId: identity.tenantId, batchSize: 10 });
    const target = await upsertSiemExportTarget({
      tenantId: identity.tenantId,
      targetKey: `recovery-${identity.suffix}`,
      displayName: 'I25 held recovery target',
      transport: 'webhook',
      status: 'active',
      endpointUrl: 'https://siem.example/recovery',
      actorUid: identity.actorUid,
      acknowledgementContract: 'webhook_receipt_header',
      acknowledgementConfig: { header_name: 'X-SIEM-Receipt', expected_value: 'accepted' },
      acknowledgementOwnerReason: 'The owner requires an exact durable-ingestion receipt.',
      acknowledgementOwnerEvidence: { contract_reference: 'i25-deep-recovery-v1' },
    });
    await enqueueSiemDeliveries({ tenantId: identity.tenantId, batchSize: 10 });
    const attemptResult = await client.query(
      `UPDATE siem_export_delivery_attempts d
          SET status = 'failed', acknowledgement_state = 'uncertain',
              acknowledgement_evidence = '{"receipt_missing":true}'::jsonb,
              completed_at = NOW(), updated_at = NOW()
         FROM siem_export_events e
        WHERE d.tenant_id = $1::uuid AND d.target_id = $2::bigint
          AND e.id = d.event_id
      RETURNING d.id, d.event_id, d.target_id, d.attempt_number,
                d.payload_sha256::text, d.status, d.acknowledgement_state,
                d.created_at, e.source_id`,
      [identity.tenantId, String(target.id)],
    );
    const attempt = attemptResult.rows[0];
    const partition = `siem:audit_log:security:target:${attempt.target_id}`;
    const duplicateKey = `i25:${attempt.event_id}:${attempt.target_id}:${attempt.attempt_number}:${attempt.payload_sha256}`;
    const offsetResult = await client.query(
      `INSERT INTO event_consumer_offsets
         (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
          direction, source_partition, consumer_key, generation, cursor_kind,
          high_water_position, high_water_token, retained_from_position,
          retained_from_token, recovery_state, policy_version, policy_signature,
          retention_policy, retention_until, historical_cutoff_event_id,
          backfill_cursor_event_id)
       VALUES
         ('external_interface', $1::uuid, 'tenant', NULL, 'I25', 'outbound',
          $2::text, $3::text, 7, 'per_target_positive_ack',
          $4::bigint - 1, $5::text, $4::bigint - 1, $5::text,
          'replaying', 'i25-owner-v1', $6::text,
          'siem-evidence-2555d', NOW() + INTERVAL '2555 days', NULL, NULL)
       RETURNING offset_id::text`,
      [identity.tenantId, partition, `external:I25:recovery:${identity.suffix}`,
        attempt.source_id, `audit_log:${Number(attempt.source_id) - 1}:positive_ack`,
        `i25-${identity.suffix}`],
    );
    const inboxResult = await client.query(
      `INSERT INTO pathway_projector_inbox
         (scope_kind, tenant_id, consumer_key, generation, offset_id, facility_id,
          interface_family, direction, source_partition, source_position,
          source_token, predecessor_token, duplicate_key, command_fingerprint,
          occurred_at, received_at, recorded_at, arrival_class,
          effect_disposition, status, next_attempt_at, policy_version,
          policy_signature, retention_policy, retention_until)
       VALUES
         ('external_interface', $1::uuid, $2::text, 7, $3::uuid, NULL,
          'I25', 'outbound', $4::text, $5::bigint, $6::text, $7::text,
          $8::text, repeat('c', 64), $9::timestamptz, NOW(), NOW(),
          'recovery_backlog', 'late_pending_only', 'pending', NOW(),
          'i25-owner-v1', $10::text, 'siem-evidence-2555d',
          NOW() + INTERVAL '2555 days')
       RETURNING inbox_id::text`,
      [identity.tenantId, `external:I25:recovery:${identity.suffix}`,
        offsetResult.rows[0].offset_id, partition, attempt.source_id,
        `attempt:${attempt.id}`, `audit_log:${Number(attempt.source_id) - 1}:positive_ack`,
        duplicateKey, attempt.created_at, `i25-${identity.suffix}`],
    );
    const inboxId = inboxResult.rows[0].inbox_id;

    const held = await client.query(
      `UPDATE siem_export_delivery_attempts
          SET recovery_inbox_id = $3::uuid,
              recovery_interface_family = 'I25',
              recovery_owner_uid = $4::uuid,
              recovery_owner_reason = 'Owner is reconciling the missing SIEM receipt.',
              recovery_evidence = '{"exact_attempt_verified":true}'::jsonb,
              send_authority = 'held_owner_reconciliation',
              effect_disposition = 'late_pending_only'
        WHERE tenant_id = $1::uuid AND id = $2::bigint
      RETURNING id, status, acknowledgement_state, send_authority,
                effect_disposition, recovery_inbox_id::text`,
      [identity.tenantId, attempt.id, inboxId, identity.actorUid],
    );
    expect(held.rows[0]).toMatchObject({
      status: 'failed',
      acknowledgement_state: 'uncertain',
      send_authority: 'held_owner_reconciliation',
      effect_disposition: 'late_pending_only',
      recovery_inbox_id: inboxId,
    });
    await expectPgFailure(client, () => client.query(
      `UPDATE siem_export_delivery_attempts
          SET recovery_owner_reason = 'rewritten owner evidence'
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [identity.tenantId, attempt.id],
    ), 'chk_siem_i25_recovery_immutable');
  });
});

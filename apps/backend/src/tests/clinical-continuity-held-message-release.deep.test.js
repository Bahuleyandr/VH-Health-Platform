import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { jest } from '@jest/globals';

const policyId = randomUUID();

jest.unstable_mockModule('../services/downtime/clinicalContinuityPolicyService.js', () => ({
  loadActiveClinicalContinuityPolicyForFacilityTx: jest.fn(async () => ({
    id: policyId,
    policyVersion: '1',
    policyChecksum: '8'.repeat(64),
    policySigningKeyId: 'held-release-test-key',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveUntil: '2027-01-01T00:00:00.000Z',
    supersedesPolicyId: null,
    revocationEpoch: '0',
    actionRegistryVersion: '1',
    actionRegistryChecksum: '9'.repeat(64),
    policyDocument: { minimumAppVersion: 'continuity-reconciliation/v1' },
  })),
}));

jest.unstable_mockModule('../services/nhcx/nhcxTenantConfigService.js', () => ({
  loadNHCXRuntimeConfig: jest.fn(async () => ({
    enabled: true,
    effectiveEnabled: true,
    gatewayBaseUrl: 'https://nhcx.example.test/v0.9',
    missing: [],
  })),
}));

const { default: prisma, setTenantTx } = await import('../lib/prisma.js');
const { hashCanonicalValue } = await import('../services/downtime/continuityPackCanonical.js');
const { queueFeedMessage } = await import('../services/hl7/hl7OutboundService.js');
const { createTask } = await import('../services/workflow/taskService.js');
const {
  attestClinicalContinuityHeldMessageRelease,
  bindClinicalContinuityHeldMessage,
  releaseClinicalContinuityHeldMessage,
} = await import('../services/downtime/clinicalContinuityHeldReleaseService.js');

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('C5.2 held-message release atomic contract', () => {
  const fixture = {
    tenantId: randomUUID(),
    facilityId: 1750000000 + Math.floor(Math.random() * 1000000),
    actorUid: randomUUID(),
    safetyLeadUid: randomUUID(),
    deviceId: randomUUID(),
    contextId: randomUUID(),
    incidentId: randomUUID(),
    packetId: randomUUID(),
    requirementId: randomUUID(),
    i04RequirementId: randomUUID(),
    requestId: randomUUID(),
    i04RequestId: randomUUID(),
  };
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const sourcePartition = 'nhcx:sandbox:outbound:claim/submit';
  let messageId;
  let sourceFingerprint;
  let bound;
  let i04MessageId;
  let i04SourceFingerprint;
  let i04Bound;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'Held-release I19 tenant')`,
      fixture.tenantId,
      `held-release-i19-${suffix}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO facilities (id, tenant_id, facility_code, display_name, timezone)
       VALUES ($1::integer, $2::uuid, $3::text, 'Held release facility', 'Asia/Kolkata')`,
      fixture.facilityId,
      fixture.tenantId,
      `HRI19-${suffix}`,
    );
    for (const [uid, role, label] of [
      [fixture.actorUid, 'ADMIN', 'owner'],
      [fixture.safetyLeadUid, 'CMO', 'safety'],
    ]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (
           uid, tenant_id, phone, name, role, is_active, status,
           is_deleted, registered_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
           TRUE, 'active', FALSE, NOW(), NOW()
         )`,
        uid,
        fixture.tenantId,
        `+917${Math.floor(100000000 + Math.random() * 899999999)}`,
        `Held release ${label}`,
        role,
      );
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_continuity_incident_packets (
         id, tenant_id, facility_id, reserved_incident_id,
         range_prefix, range_first, range_last, packet_key_id,
         packet_key_version, canonical_payload_hash, signature,
         valid_from, valid_until, contact_sheet_version
       ) VALUES (
         $1::uuid, $2::uuid, $3::integer, $4::uuid,
         'HRI19-', 1, 99, 'held-release-key',
         '1', repeat('a', 64), 'fixture-signature',
         NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day', '1'
       )`,
      fixture.packetId,
      fixture.tenantId,
      fixture.facilityId,
      fixture.incidentId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_continuity_incidents (
         id, tenant_id, facility_id, packet_id, commander_uid,
         commander_role, lifecycle_state, declared_at, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::integer, $4::uuid, $5::uuid,
         'ADMIN', 'reconciling', NOW() - INTERVAL '30 minutes', $5::uuid, $5::uuid
       )`,
      fixture.incidentId,
      fixture.tenantId,
      fixture.facilityId,
      fixture.packetId,
      fixture.actorUid,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_continuity_reconciliation_config (
         tenant_id, facility_id, fallback_principal, clinical_safety_lead_uid,
         needs_review_owner_principal, identity_owner_principal,
         interface_owner_principal, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::integer, 'role:clinical_safety_lead', $3::uuid,
         'role:admin', 'role:admin', 'role:admin', $4::uuid, $4::uuid
       )`,
      fixture.tenantId,
      fixture.facilityId,
      fixture.safetyLeadUid,
      fixture.actorUid,
    );

    const nhcx = await prisma.$queryRawUnsafe(
      `INSERT INTO nhcx_messages (
         tenant_id, environment, direction, cycle, endpoint,
         participant_code_self, hcx_api_call_id, hcx_correlation_id,
         hcx_workflow_id, payload_hash, payload_ciphertext, status,
         next_retry_at, created_at, updated_at
       ) VALUES (
         $1::uuid, 'sandbox', 'outbound', 'claim', 'claim/submit',
         'VH-I19', $2::text, $3::text, $4::text, repeat('c', 64),
         'held-nhcx-ciphertext', 'failed', NOW(),
         NOW() - INTERVAL '20 minutes', NOW()
       ) RETURNING id::text`,
      fixture.tenantId,
      `api-${suffix}`,
      `corr-${suffix}`,
      `workflow-${suffix}`,
    );
    messageId = nhcx[0].id;
    const offset = await prisma.$queryRawUnsafe(
      `INSERT INTO event_consumer_offsets (
         scope_kind, tenant_id, facility_scope, facility_id, interface_family,
         direction, source_partition, consumer_key, generation, cursor_kind,
         high_water_position, high_water_token, retained_from_position,
         retained_from_token, recovery_state, policy_version, policy_signature,
         retention_policy, retention_until, backfill_cursor_event_id
       ) VALUES (
         'external_interface', $1::uuid, 'tenant', NULL, 'I19',
         'outbound', $2::text, 'external:I19', 1,
         'monotonic_position_and_predecessor', $3::bigint - 1, 'predecessor',
         $3::bigint - 1, 'predecessor', 'replaying', 'held-v1', $4::text,
         'nhcx-exchange-2555d', NOW() + INTERVAL '2555 days', NULL
       ) RETURNING offset_id::text`,
      fixture.tenantId,
      sourcePartition,
      messageId,
      `held-${suffix}`,
    );
    const inbox = await prisma.$queryRawUnsafe(
      `INSERT INTO pathway_projector_inbox (
         scope_kind, tenant_id, consumer_key, generation, offset_id, facility_id,
         interface_family, direction, source_partition, source_position,
         source_token, predecessor_token, duplicate_key, command_fingerprint,
         occurred_at, received_at, recorded_at, arrival_class,
         effect_disposition, status, next_attempt_at, policy_version,
         policy_signature, retention_policy, retention_until
       ) VALUES (
         'external_interface', $1::uuid, 'external:I19', 1, $2::uuid, NULL,
         'I19', 'outbound', $3::text, $4::bigint,
         'source', 'predecessor', $5::text, repeat('d', 64),
         NOW() - INTERVAL '20 minutes', NOW(), NOW(), 'recovery_backlog',
         'late_pending_only', 'pending', NOW(), 'held-v1', $6::text,
         'nhcx-exchange-2555d', NOW() + INTERVAL '2555 days'
       ) RETURNING inbox_id::text`,
      fixture.tenantId,
      offset[0].offset_id,
      sourcePartition,
      messageId,
      `i19:outbound:api-${suffix}`,
      `held-${suffix}`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE nhcx_messages
          SET recovery_inbox_id = $3::uuid, recovery_interface_family = 'I19',
              recovery_owner_uid = $6::uuid,
              recovery_owner_reason = 'Owner requested review',
              recovery_disposition = 'manual_redrive_requested',
              recovery_claimed_at = NOW(), recovery_prior_status = status,
              recovery_evidence = '{"manual":true}'::jsonb,
              source_partition = $4::text, source_position = id,
              source_token = 'source', predecessor_token = 'predecessor',
              duplicate_key = $5::text, status = 'recovery_pending',
              next_retry_at = NULL
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      fixture.tenantId,
      messageId,
      inbox[0].inbox_id,
      sourcePartition,
      `i19:outbound:api-${suffix}`,
      fixture.actorUid,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_continuity_incident_interfaces (
         id, tenant_id, facility_id, incident_id, offset_id,
         interface_family, direction, source_partition, disposition,
         owner_principal, assigned_to_uid, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::integer, $4::uuid, $5::uuid,
         'I19', 'outbound', $6::text, 'pending',
         'role:admin', $7::uuid, $7::uuid
       )`,
      fixture.requirementId,
      fixture.tenantId,
      fixture.facilityId,
      fixture.incidentId,
      offset[0].offset_id,
      sourcePartition,
      fixture.actorUid,
    );

    const snapshot = await setTenantTx(fixture.tenantId, async tx => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT public.clinical_continuity_held_message_snapshot(
           $1::uuid, 'I19', $2::bigint
         ) AS snapshot`,
        fixture.tenantId,
        messageId,
      );
      return rows[0].snapshot;
    });
    sourceFingerprint = hashCanonicalValue(snapshot);
    bound = await bindClinicalContinuityHeldMessage({
      tenantId: fixture.tenantId,
      facilityId: fixture.facilityId,
      actorUid: fixture.actorUid,
      actorRole: 'ADMIN',
      requestId: fixture.requestId,
      incidentId: fixture.incidentId,
      parsed: {
        incidentInterfaceId: fixture.requirementId,
        interfaceFamily: 'I19',
        messageId: Number(messageId),
        expectedIncidentInterfaceVersion: 1,
        sourceStateFingerprint: sourceFingerprint,
      },
    });

    const subscription = await prisma.$queryRawUnsafe(
      `INSERT INTO hl7_feed_subscriptions (
         tenant_id, name, endpoint_url, message_types, created_by
       ) VALUES (
         $1::uuid, $2::text, 'https://example.test/held-release',
         ARRAY['ADT^A01']::text[], $3::uuid
       ) RETURNING id`,
      fixture.tenantId,
      `Held-release I04 ${suffix}`,
      fixture.actorUid,
    );
    const controlId = `I04-HELD-${suffix}`;
    await queueFeedMessage({
      tenantId: fixture.tenantId,
      messageType: 'ADT^A01',
      hl7Payload: [
        `MSH|^~\\&|VHHEALTH|VH_HOSPITALS|DOWNSTREAM|HOSPITAL|20260804120000||ADT^A01|${controlId}|P|2.5`,
        'PID|1|||Held^Release',
      ].join('\r'),
      sourceTable: 'held_release_deep_test',
      sourceId: suffix,
    });
    const i04Message = await prisma.$queryRawUnsafe(
      `UPDATE hl7_outbound_messages
          SET status = 'reconciliation_required',
              send_authority = 'held_owner_reconciliation'
        WHERE tenant_id = $1::uuid AND subscription_id = $2::integer
          AND message_control_id = $3::text
        RETURNING id`,
      fixture.tenantId,
      subscription[0].id,
      controlId,
    );
    i04MessageId = i04Message[0].id;
    const i04Partition = `subscription:${subscription[0].id}`;
    const i04Offset = await prisma.$queryRawUnsafe(
      `INSERT INTO event_consumer_offsets (
         scope_kind, tenant_id, facility_scope, facility_id, interface_family,
         direction, source_partition, consumer_key, generation, cursor_kind,
         high_water_position, high_water_token, retained_from_position,
         retained_from_token, recovery_state, policy_version, policy_signature,
         retention_policy, retention_until, backfill_cursor_event_id
       ) VALUES (
         'external_interface', $1::uuid, 'tenant', NULL, 'I04',
         'outbound', $2::text, 'external:I04', 1,
         'monotonic_position_and_predecessor', $3::bigint - 1, $4::text,
         $3::bigint - 1, $4::text, 'replaying', 'held-v1', $5::text,
         'hl7-delivery-evidence-owner-governed', NOW() + INTERVAL '2555 days', NULL
       ) RETURNING offset_id::text`,
      fixture.tenantId,
      i04Partition,
      i04MessageId,
      `i04-token-${i04MessageId - 1}`,
      `held-i04-${suffix}`,
    );
    const i04Inbox = await prisma.$queryRawUnsafe(
      `INSERT INTO pathway_projector_inbox (
         scope_kind, tenant_id, consumer_key, generation, offset_id, facility_id,
         interface_family, direction, source_partition, source_position,
         source_token, predecessor_token, duplicate_key, command_fingerprint,
         occurred_at, received_at, recorded_at, arrival_class,
         effect_disposition, status, next_attempt_at, policy_version,
         policy_signature, retention_policy, retention_until
       ) VALUES (
         'external_interface', $1::uuid, 'external:I04', 1, $2::uuid, NULL,
         'I04', 'outbound', $3::text, $4::bigint,
         $5::text, $6::text, $7::text, repeat('e', 64),
         NOW() - INTERVAL '20 minutes', NOW(), NOW(), 'recovery_backlog',
         'late_pending_only', 'pending', NOW(), 'held-v1', $8::text,
         'hl7-delivery-evidence-owner-governed', NOW() + INTERVAL '2555 days'
       ) RETURNING inbox_id::text`,
      fixture.tenantId,
      i04Offset[0].offset_id,
      i04Partition,
      i04MessageId,
      `i04-token-${i04MessageId}`,
      `i04-token-${i04MessageId - 1}`,
      `i04:${fixture.tenantId}:${subscription[0].id}:${i04MessageId}`,
      `held-i04-${suffix}`,
    );
    const i04RecoveryTask = await createTask({
      tenantId: fixture.tenantId,
      taskKind: 'review',
      title: 'Review held I04 outbound recovery evidence',
      description: 'The external recovery ledger retained this message for owner review.',
      relatedResourceType: 'hl7_outbound_message',
      relatedResourceId: String(i04MessageId),
      priority: 'normal',
      assignedToUid: fixture.actorUid,
      createdBy: fixture.actorUid,
      slaCompletionSemantics: 'none',
      metadata: {
        contract: 'late_pending_only',
        interface_family: 'I04',
        recovery_inbox_id: i04Inbox[0].inbox_id,
      },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE pathway_projector_inbox
          SET status = 'handled', pending_task_id = $3::integer,
              outcome_code = 'i04_owner_review_pending', outcome_at = NOW()
        WHERE tenant_id = $1::uuid AND inbox_id = $2::uuid`,
      fixture.tenantId,
      i04Inbox[0].inbox_id,
      i04RecoveryTask.id,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE hl7_outbound_messages
          SET recovery_inbox_id = $3::uuid,
              recovery_interface_family = 'I04'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      fixture.tenantId,
      i04MessageId,
      i04Inbox[0].inbox_id,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_continuity_incident_interfaces (
         id, tenant_id, facility_id, incident_id, offset_id,
         interface_family, direction, source_partition, disposition,
         owner_principal, assigned_to_uid, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::integer, $4::uuid, $5::uuid,
         'I04', 'outbound', $6::text, 'pending',
         'role:admin', $7::uuid, $7::uuid
       )`,
      fixture.i04RequirementId,
      fixture.tenantId,
      fixture.facilityId,
      fixture.incidentId,
      i04Offset[0].offset_id,
      i04Partition,
      fixture.actorUid,
    );
    const i04Snapshot = await setTenantTx(fixture.tenantId, async tx => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT public.clinical_continuity_held_message_snapshot(
           $1::uuid, 'I04', $2::bigint
         ) AS snapshot`,
        fixture.tenantId,
        i04MessageId,
      );
      return rows[0].snapshot;
    });
    i04SourceFingerprint = hashCanonicalValue(i04Snapshot);
    i04Bound = await bindClinicalContinuityHeldMessage({
      tenantId: fixture.tenantId,
      facilityId: fixture.facilityId,
      actorUid: fixture.actorUid,
      actorRole: 'ADMIN',
      requestId: fixture.i04RequestId,
      incidentId: fixture.incidentId,
      parsed: {
        incidentInterfaceId: fixture.i04RequirementId,
        interfaceFamily: 'I04',
        messageId: Number(i04MessageId),
        expectedIncidentInterfaceVersion: 1,
        sourceStateFingerprint: i04SourceFingerprint,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('applies once, returns the prior result on duplicate, and persists drift evidence', async () => {
    const parsed = {
      expectedVersion: Number(bound.item.version),
      releaseReasonCode: 'owner_recovery_evidence_reconciled',
      releaseReasonDetail: 'Owner evidence and NHCX runtime readiness were reconciled.',
      sourceStateFingerprint: sourceFingerprint,
      safetyAttestationId: null,
    };
    const command = {
      tenantId: fixture.tenantId,
      facilityId: fixture.facilityId,
      actorUid: fixture.actorUid,
      actorRole: 'ADMIN',
      requestId: fixture.requestId,
      itemId: bound.item.id,
      parsed,
      facilityContext: { deviceId: fixture.deviceId, contextId: fixture.contextId },
      appVersion: 'held-release-deep-test',
      devicePosture: 'managed',
      idempotencyKey: 'i19-held-release-once',
    };

    const applied = await releaseClinicalContinuityHeldMessage(command);
    expect(applied).toMatchObject({
      disposition: 'applied',
      outcome_code: 'held_message_send_authority_rearmed',
      network_send_performed: false,
      prior_authority_state: { status: 'recovery_pending' },
      next_authority_state: { status: 'pending' },
    });
    const duplicate = await releaseClinicalContinuityHeldMessage(command);
    expect(duplicate).toMatchObject({
      disposition: 'exact_duplicate',
      receipt_id: applied.receipt_id,
      outcome_code: 'held_message_send_authority_rearmed',
      network_send_performed: false,
    });
    await expect(releaseClinicalContinuityHeldMessage({
      ...command,
      parsed: {
        ...parsed,
        releaseReasonDetail: 'Different owner evidence must fail as fingerprint drift.',
      },
      idempotencyKey: 'i19-held-release-drift',
    })).rejects.toMatchObject({ code: 'CONTINUITY_HELD_RELEASE_FINGERPRINT_MISMATCH' });

    const evidence = await setTenantTx(fixture.tenantId, async tx => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT message.status, message.attempt_count,
                message.owner_release_client_event_id::text,
                item.disposition AS item_disposition,
                task.status AS task_status,
                receipt.disposition AS receipt_disposition,
                receipt.outcome_code,
                effect.network_send_performed,
                effect.clinical_timeline_event_id,
                effect.workflow_sla_instance_id,
                effect.notification_outbox_id,
                effect.event_outbox_id,
                effect.retrospective_event_outbox_id,
                COUNT(attempt.id)::integer AS mismatch_attempts
           FROM nhcx_messages AS message
           JOIN clinical_continuity_reconciliation_items AS item
             ON item.tenant_id = message.tenant_id
            AND item.nhcx_message_id = message.id
           JOIN tasks AS task ON task.tenant_id = item.tenant_id AND task.id = item.task_id
           JOIN clinical_continuity_replay_receipts AS receipt
             ON receipt.tenant_id = message.tenant_id
            AND receipt.client_event_id = message.owner_release_client_event_id
           JOIN clinical_continuity_replay_effect_evidence AS effect
             ON effect.tenant_id = receipt.tenant_id
            AND effect.client_event_id = receipt.client_event_id
           LEFT JOIN clinical_continuity_replay_attempts AS attempt
            ON attempt.tenant_id = receipt.tenant_id
            AND attempt.receipt_client_event_id = receipt.client_event_id
            AND attempt.result = 'needs_review'
          WHERE message.tenant_id = $1::uuid AND message.id = $2::bigint
          GROUP BY message.id, item.id, task.id, receipt.tenant_id,
                   receipt.client_event_id, effect.tenant_id, effect.client_event_id`,
        fixture.tenantId,
        messageId,
      );
      return rows[0];
    });
    expect(evidence).toMatchObject({
      status: 'pending',
      attempt_count: 0,
      owner_release_client_event_id: applied.receipt_id,
      item_disposition: 'resolved',
      task_status: 'completed',
      receipt_disposition: 'applied',
      outcome_code: 'held_message_send_authority_rearmed',
      network_send_performed: false,
      clinical_timeline_event_id: null,
      workflow_sla_instance_id: null,
      notification_outbox_id: null,
      event_outbox_id: null,
      retrospective_event_outbox_id: null,
      mismatch_attempts: 1,
    });
  }, 60_000);

  test('I05 dispatch keeps its live branch and requires exact recovery receipt proof', () => {
    const source = fs.readFileSync(fileURLToPath(new URL(
      '../services/interfaceEngine/interfaceEngineService.js',
      import.meta.url,
    )), 'utf8');
    expect(source).toMatch(/arrival_class = 'live'/);
    expect(source).toMatch(/send_authority = 'live_authorized'/);
    expect(source).toMatch(/arrival_class = 'recovery_backlog'/);
    expect(source).toMatch(/send_authority = 'owner_authorized'/);
    expect(source).toMatch(/receipt\.source_kind = 'held_message_release'/);
    expect(source).toMatch(/receipt\.disposition = 'applied'/);
    expect(source).toMatch(/effect\.interface_family = 'I05'/);
    expect(source).toMatch(/effect\.interop_message_id = m\.id/);
  });

  test('I04 requires a distinct safety attestation and only grants future send authority', async () => {
    const reason = {
      releaseReasonCode: 'acknowledgement_uncertainty_reviewed',
      releaseReasonDetail: 'The downstream acknowledgement uncertainty was independently reviewed.',
      sourceStateFingerprint: i04SourceFingerprint,
    };
    const releaseBase = {
      tenantId: fixture.tenantId,
      facilityId: fixture.facilityId,
      actorUid: fixture.actorUid,
      actorRole: 'ADMIN',
      requestId: fixture.i04RequestId,
      itemId: i04Bound.item.id,
      facilityContext: { deviceId: fixture.deviceId, contextId: fixture.contextId },
      appVersion: 'held-release-deep-test',
      devicePosture: 'managed',
      idempotencyKey: 'i04-held-release-two-key',
    };
    await expect(releaseClinicalContinuityHeldMessage({
      ...releaseBase,
      parsed: {
        ...reason,
        expectedVersion: Number(i04Bound.item.version),
        safetyAttestationId: null,
      },
    })).rejects.toMatchObject({ code: 'CONTINUITY_HELD_MESSAGE_ATTESTATION_REQUIRED' });

    const attestation = await attestClinicalContinuityHeldMessageRelease({
      tenantId: fixture.tenantId,
      facilityId: fixture.facilityId,
      actorUid: fixture.safetyLeadUid,
      actorRole: 'CMO',
      requestId: fixture.i04RequestId,
      itemId: i04Bound.item.id,
      parsed: {
        ...reason,
        expectedVersion: Number(i04Bound.item.version),
      },
    });
    expect(attestation.decision).toMatchObject({
      actor_uid: fixture.safetyLeadUid,
      intended_releaser_uid: fixture.actorUid,
      hold_safety_class: 'safety_critical',
      decision: 'release_attestation',
    });

    const released = await releaseClinicalContinuityHeldMessage({
      ...releaseBase,
      parsed: {
        ...reason,
        expectedVersion: Number(i04Bound.item.version) + 1,
        safetyAttestationId: attestation.decision.id,
      },
    });
    expect(released).toMatchObject({
      disposition: 'applied',
      outcome_code: 'held_message_send_authority_rearmed',
      network_send_performed: false,
      prior_authority_state: {
        status: 'reconciliation_required',
        send_authority: 'held_owner_reconciliation',
      },
      next_authority_state: { status: 'queued', send_authority: 'authorized' },
    });

    const evidence = await setTenantTx(fixture.tenantId, async tx => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT message.status, message.send_authority, message.transport_state,
                message.acknowledgement_state,
                message.owner_release_client_event_id::text,
                cursor.last_contiguous_message_id,
                COUNT(attempt.attempt_id)::integer AS attempt_count,
                effect.network_send_performed,
                effect.clinical_timeline_event_id,
                effect.workflow_sla_instance_id,
                effect.notification_outbox_id,
                effect.event_outbox_id,
                effect.retrospective_event_outbox_id
           FROM hl7_outbound_messages AS message
           LEFT JOIN hl7_outbound_delivery_cursors AS cursor
             ON cursor.tenant_id = message.tenant_id
            AND cursor.subscription_id = message.subscription_id
           LEFT JOIN hl7_outbound_transport_attempts AS attempt
             ON attempt.tenant_id = message.tenant_id
            AND attempt.message_id = message.id
           JOIN clinical_continuity_replay_effect_evidence AS effect
             ON effect.tenant_id = message.tenant_id
            AND effect.client_event_id = message.owner_release_client_event_id
          WHERE message.tenant_id = $1::uuid AND message.id = $2::integer
          GROUP BY message.id, cursor.tenant_id, cursor.subscription_id,
                   effect.tenant_id, effect.client_event_id`,
        fixture.tenantId,
        i04MessageId,
      );
      return rows[0];
    });
    expect(evidence).toMatchObject({
      status: 'queued',
      send_authority: 'authorized',
      transport_state: 'not_attempted',
      acknowledgement_state: 'pending',
      last_contiguous_message_id: null,
      attempt_count: 0,
      network_send_performed: false,
      clinical_timeline_event_id: null,
      workflow_sla_instance_id: null,
      notification_outbox_id: null,
      event_outbox_id: null,
      retrospective_event_outbox_id: null,
    });
    expect(evidence.owner_release_client_event_id).toBe(released.receipt_id);
  }, 60_000);
});

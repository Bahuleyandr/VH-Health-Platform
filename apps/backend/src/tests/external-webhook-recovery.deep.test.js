import { createHash, randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';

const { default: prisma, setTenantTx } = await import('../lib/prisma.js');
const {
  authorizeExternalRecoveryResume,
  enqueueExternalRecoveryItem,
  processNextItemTx,
  registerExternalRecoveryOffset,
} = await import('../services/integrations/externalInterfaceRecoveryService.js');
const {
  dispatchPendingDeliveries,
} = await import('../services/integrations/webhookDeliveryService.js');

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const ACTOR_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

describeIfDb('C6.1-G I18 subscriber webhook owner recovery', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'I18 webhook recovery tenant')`,
      TENANT_ID,
      `i18-webhook-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, email, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3::text, $4::text,
          'I18 owner', 'ADMIN', true, 'active', NOW())`,
      ACTOR_UID,
      TENANT_ID,
      `94${SUFFIX.slice(0, 10)}`,
      `i18-owner-${SUFFIX}@example.test`,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('binds the exact occurrence, pauses the cursor, and never dispatches the held row', async () => {
    const integration = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `INSERT INTO integrations (tenant_id, name, integration_type, status)
       VALUES ($1::uuid, $2::text, 'webhook', 'active')
       RETURNING id`,
      TENANT_ID,
      `i18-integration-${SUFFIX}`,
    ));
    const subscription = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `INSERT INTO webhook_subscriptions
         (tenant_id, integration_id, event_type, endpoint_url,
          signing_algorithm, is_active)
       VALUES ($1::uuid, $2::integer, 'i18.test',
               'https://subscriber.example.test/i18', 'none', TRUE)
       RETURNING id`,
      TENANT_ID,
      integration[0].id,
    ));
    const event = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `INSERT INTO event_outbox
         (tenant_id, event_type, aggregate_type, payload, status,
          available_at, occurred_at, occurred_at_source, created_at, delivered_at)
       VALUES ($1::uuid, 'i18.test', 'i18_fixture', $2::jsonb, 'delivered',
               NOW(), NOW() - INTERVAL '20 minutes', 'explicit',
               NOW() - INTERVAL '20 minutes', NOW())
       RETURNING id::text, occurred_at::text,
                 encode(digest(payload::text, 'sha256'), 'hex') AS payload_sha256`,
      TENANT_ID,
      JSON.stringify({ stable: 'i18', occurrence: SUFFIX }),
    ));
    const eventId = event[0].id;
    const payloadHash = event[0].payload_sha256;
    const delivery = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `INSERT INTO webhook_deliveries
         (tenant_id, subscription_id, event_outbox_id, event_type, payload,
          status, attempt_number, next_retry_at, source_kind, source_identity,
          source_position, payload_sha256)
       VALUES ($1::uuid, $2::integer, $3::bigint, 'i18.test', $4::jsonb,
               'failed', 1, NOW(), 'event_outbox',
               'event_outbox:' || $3::bigint::text, $3::bigint, $5::char(64))
       RETURNING id`,
      TENANT_ID,
      subscription[0].id,
      eventId,
      JSON.stringify({ stable: 'i18', occurrence: SUFFIX }),
      payloadHash,
    ));

    const predecessorPosition = (BigInt(eventId) - 1n).toString();
    const sourcePartition = `webhook-subscription:${subscription[0].id}:outbound`;
    const predecessorToken = `event_outbox:${predecessorPosition}`;
    const sourceToken = `event_outbox:${eventId}:${payloadHash}`;
    const duplicateKey = `i18:${subscription[0].id}:event_outbox:${eventId}:${payloadHash}`;
    const offset = await registerExternalRecoveryOffset({
      tenantId: TENANT_ID,
      interfaceFamily: 'I18',
      sourcePartition,
      initialPosition: predecessorPosition,
      initialToken: predecessorToken,
      retainedFromPosition: predecessorPosition,
      retainedFromToken: predecessorToken,
      policyVersion: 'i18-owner-v1',
      policySignature: `i18-${SUFFIX}`,
      retentionPolicy: 'webhook-evidence-2555d',
      retentionUntil: '2033-08-03T00:00:00.000Z',
    });
    await authorizeExternalRecoveryResume({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      interfaceFamily: 'I18',
      resumeCutoffPosition: eventId,
      resumeCutoffToken: sourceToken,
    });

    const occurredAt = new Date(event[0].occurred_at).toISOString();
    const rawPayload = JSON.stringify({
      schema: 'vhhealth.i18.webhook-owner-reconciliation/v1',
      subscription_id: subscription[0].id,
      event_outbox_id: eventId,
      event_type: 'i18.test',
      payload_sha256: payloadHash,
      occurred_at: occurredAt,
    });
    const operation = {
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      interfaceFamily: 'I18',
      sourcePartition,
      generation: 1,
      sourcePosition: eventId,
      sourceToken,
      predecessorToken,
      duplicateKey,
      occurredAt,
      command: {
        raw_payload: rawPayload,
        payload_sha256: sha256(Buffer.from(rawPayload, 'utf8')),
        actor_uid: ACTOR_UID,
        owner_reason: 'Owner-directed subscriber reconciliation',
        evidence: { owner_reviewed: true, source_export: 'synthetic_i18_fixture' },
      },
    };

    await enqueueExternalRecoveryItem(operation);
    const outcome = await processNextItemTx(operation);
    expect(outcome).toMatchObject({
      status: 'handled',
      outcome_code: 'i18_webhook_pending_owner_reconciliation',
      receipt_id: String(delivery[0].id),
      cursor: {
        high_water_position: predecessorPosition,
        high_water_token: predecessorToken,
        recovery_state: 'reconciliation_required_provider_state',
      },
    });

    const state = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT delivery.status, delivery.send_authority,
              delivery.acknowledgement_state, delivery.effect_disposition,
              delivery.next_retry_at, source.status AS event_outbox_status,
              inbox.status AS inbox_status, task.status AS task_status,
              task.assigned_to_role, task.workflow_sla_instance_id
         FROM webhook_deliveries AS delivery
         JOIN event_outbox AS source
           ON source.tenant_id = delivery.tenant_id
          AND source.id = delivery.event_outbox_id
         JOIN pathway_projector_inbox AS inbox
           ON inbox.tenant_id = delivery.tenant_id
          AND inbox.inbox_id = delivery.recovery_inbox_id
         JOIN tasks AS task
           ON task.tenant_id = inbox.tenant_id
          AND task.id = inbox.pending_task_id
        WHERE delivery.tenant_id = $1::uuid AND delivery.id = $2::integer`,
      TENANT_ID,
      delivery[0].id,
    ));
    expect(state[0]).toMatchObject({
      status: 'failed',
      send_authority: 'held_owner_reconciliation',
      acknowledgement_state: 'unclassified',
      effect_disposition: 'late_pending_only',
      next_retry_at: null,
      event_outbox_status: 'delivered',
      inbox_status: 'handled',
      task_status: 'open',
      assigned_to_role: 'TENANT_ADMIN',
      workflow_sla_instance_id: null,
    });

    const fetchImpl = jest.fn();
    await expect(dispatchPendingDeliveries({
      tenantId: TENANT_ID,
      fetchImpl,
    })).resolves.toMatchObject({ dispatched: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  }, 60_000);
});

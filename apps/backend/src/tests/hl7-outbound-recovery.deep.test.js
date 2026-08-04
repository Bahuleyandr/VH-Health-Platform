import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import { generateACK } from '../services/hl7/hl7Parser.js';
import { queueFeedMessage } from '../services/hl7/hl7OutboundService.js';
import {
  authorizeExternalRecoveryResume,
  enqueueExternalRecoveryItem,
  processNextItemTx,
  registerExternalRecoveryOffset,
} from '../services/integrations/externalInterfaceRecoveryService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const ACTOR_UID = randomUUID();
const PATIENT_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);

function outboundPayload(controlId) {
  return [
    `MSH|^~\\&|VHHEALTH|VH_HOSPITALS|DOWNSTREAM|HOSPITAL|20260802120000||ADT^A01|${controlId}|P|2.5`,
    `PID|1||${PATIENT_UID}||Recovery^Patient`,
  ].join('\r');
}

async function createQueuedMessage(label) {
  const subscription = await setTenantTx(TENANT_ID, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO hl7_feed_subscriptions
         (tenant_id, name, endpoint_url, message_types, created_by)
       VALUES ($1::uuid, $2::text, 'https://example.test/hl7',
               ARRAY['ADT^A01']::text[], $3::uuid)
       RETURNING id`,
      TENANT_ID, `C6.1-E ${label} ${SUFFIX}`, ACTOR_UID,
    );
    return rows[0];
  });
  const controlId = `I04-${label}-${SUFFIX}`;
  await queueFeedMessage({
    tenantId: TENANT_ID,
    messageType: 'ADT^A01',
    hl7Payload: outboundPayload(controlId),
    sourceTable: 'admissions',
    sourceId: `${label}-${SUFFIX}`,
    patientUid: PATIENT_UID,
  });
  const message = await setTenantTx(TENANT_ID, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE hl7_outbound_messages
          SET status = 'reconciliation_required',
              send_authority = 'held_owner_reconciliation'
        WHERE tenant_id = $1::uuid AND subscription_id = $2::integer
        RETURNING id, subscription_id, message_control_id`,
      TENANT_ID, subscription.id,
    );
    return rows[0];
  });
  return { ...message, controlId };
}

async function prepareRecovery(message, command) {
  const partition = `subscription:${message.subscription_id}`;
  const offset = await registerExternalRecoveryOffset({
    tenantId: TENANT_ID,
    interfaceFamily: 'I04',
    sourcePartition: partition,
    initialPosition: message.id - 1,
    initialToken: `i04-token-${message.id - 1}`,
    retainedFromPosition: message.id - 1,
    retainedFromToken: `i04-token-${message.id - 1}`,
    policyVersion: 'c-d8-v1',
    policySignature: `owner-signature-${SUFFIX}`,
    retentionPolicy: 'hl7-delivery-evidence-owner-governed',
    retentionUntil: '2029-08-02T00:00:00.000Z',
  });
  await authorizeExternalRecoveryResume({
    tenantId: TENANT_ID,
    offsetId: offset.offset_id,
    interfaceFamily: 'I04',
    resumeCutoffPosition: message.id,
    resumeCutoffToken: `i04-token-${message.id}`,
  });
  const envelope = {
    tenantId: TENANT_ID,
    offsetId: offset.offset_id,
    interfaceFamily: 'I04',
    sourcePartition: partition,
    sourcePosition: message.id,
    sourceToken: `i04-token-${message.id}`,
    predecessorToken: `i04-token-${message.id - 1}`,
    duplicateKey: `i04:${TENANT_ID}:${message.subscription_id}:${message.id}`,
    command,
  };
  await enqueueExternalRecoveryItem({
    ...envelope,
    occurredAt: '2026-08-02T09:00:00.000Z',
  });
  return { offset, envelope };
}

describeIfDb('C6.1-E I04 owner-directed outbound HL7 recovery', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'C6.1-E I04 tenant')`,
      TENANT_ID, `c61e-i04-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, email, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text,
               'C6.1-E owner', 'ADMIN', true, NOW()),
              ($5::uuid, $2::uuid, $6::text, $7::text,
               'C6.1-E patient', 'PATIENT', true, NOW())`,
      ACTOR_UID, TENANT_ID, `91${SUFFIX.slice(0, 10)}`,
      `owner-${SUFFIX}@example.test`, PATIENT_UID,
      `92${SUFFIX.slice(0, 10)}`, `patient-${SUFFIX}@example.test`,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('owner ACK reconciliation records parsed AA and advances without authorizing or performing a send', async () => {
    const message = await createQueuedMessage('ack');
    const command = {
      action: 'record_acknowledgement',
      message_id: message.id,
      raw_acknowledgement: generateACK(message.controlId, 'AA', 'accepted from downstream archive'),
      actor_uid: ACTOR_UID,
      owner_reason: 'The downstream audit export proves this exact MSH-10 was accepted.',
      evidence: { downstream_export_sha256: 'a'.repeat(64) },
    };
    const { envelope } = await prepareRecovery(message, command);

    const beforeAttempts = await setTenantTx(TENANT_ID, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::integer AS count
           FROM hl7_outbound_transport_attempts
          WHERE tenant_id = $1::uuid AND message_id = $2::integer`,
        TENANT_ID, message.id,
      );
      return rows[0].count;
    });
    const recovered = await processNextItemTx(envelope);
    expect(recovered).toMatchObject({
      status: 'handled',
      outcome_code: 'i04_msa_aa',
      cursor: {
        high_water_position: String(message.id),
        recovery_state: 'ready',
      },
    });
    expect(recovered.acknowledgement_id).toMatch(/^[0-9a-f-]{36}$/);

    const state = await setTenantTx(TENANT_ID, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT message.status, message.acknowledgement_state,
                message.send_authority, message.recovery_inbox_id::text,
                cursor.last_contiguous_message_id,
                acknowledgement.msa_code,
                acknowledgement.correlation_matches,
                COUNT(attempt.attempt_id)::integer AS attempt_count
           FROM hl7_outbound_messages AS message
           JOIN hl7_outbound_delivery_cursors AS cursor
             ON cursor.tenant_id = message.tenant_id
            AND cursor.subscription_id = message.subscription_id
           JOIN hl7_outbound_acknowledgements AS acknowledgement
             ON acknowledgement.tenant_id = message.tenant_id
            AND acknowledgement.message_id = message.id
           LEFT JOIN hl7_outbound_transport_attempts AS attempt
             ON attempt.tenant_id = message.tenant_id
            AND attempt.message_id = message.id
          WHERE message.tenant_id = $1::uuid AND message.id = $2::integer
          GROUP BY message.id, cursor.tenant_id, cursor.subscription_id,
                   acknowledgement.acknowledgement_id`,
        TENANT_ID, message.id,
      );
      return rows[0];
    });
    expect(state).toMatchObject({
      status: 'sent',
      acknowledgement_state: 'aa',
      send_authority: 'held_owner_reconciliation',
      last_contiguous_message_id: message.id,
      msa_code: 'AA',
      correlation_matches: true,
      attempt_count: beforeAttempts,
    });
    expect(state.recovery_inbox_id).toMatch(/^[0-9a-f-]{36}$/);
  }, 60_000);

  test('the retired I04 recovery authorize_send command cannot release a held message', async () => {
    const message = await createQueuedMessage('release');
    const command = {
      action: 'authorize_send',
      message_id: message.id,
      actor_uid: ACTOR_UID,
      owner_reason: 'The owner confirmed no downstream receipt exists and authorized one future send.',
      evidence: { receiver_query_sha256: 'b'.repeat(64), result: 'not_found' },
    };
    const { envelope } = await prepareRecovery(message, command);
    await expect(processNextItemTx(envelope)).rejects.toMatchObject({
      code: 'I04_OUTBOUND_RECONCILIATION_REFUSED',
    });

    const state = await setTenantTx(TENANT_ID, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT message.status, message.transport_state,
                message.acknowledgement_state, message.send_authority,
                message.recovery_inbox_id::text,
                message.owner_release_actor_uid::text,
                message.owner_release_reason,
                message.owner_release_client_event_id::text,
                COUNT(attempt.attempt_id)::integer AS attempt_count
           FROM hl7_outbound_messages AS message
           LEFT JOIN hl7_outbound_transport_attempts AS attempt
             ON attempt.tenant_id = message.tenant_id
            AND attempt.message_id = message.id
          WHERE message.tenant_id = $1::uuid AND message.id = $2::integer
          GROUP BY message.id`,
        TENANT_ID, message.id,
      );
      return rows[0];
    });
    expect(state).toMatchObject({
      status: 'reconciliation_required',
      transport_state: 'not_attempted',
      acknowledgement_state: 'pending',
      send_authority: 'held_owner_reconciliation',
      owner_release_actor_uid: null,
      owner_release_client_event_id: null,
      attempt_count: 0,
    });
    expect(state.owner_release_reason).toBeNull();
    expect(state.recovery_inbox_id).toBeNull();
  }, 60_000);
});

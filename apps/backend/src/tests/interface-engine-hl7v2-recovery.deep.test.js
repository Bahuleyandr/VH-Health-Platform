import { createHash, randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import { encryptField } from '../utils/fieldEncryption.js';
import {
  enqueueExternalRecoveryItem,
  processNextItemTx,
} from '../services/integrations/externalInterfaceRecoveryService.js';
import {
  authorizeExternalRecoveryResume,
  registerExternalRecoveryOffset,
} from './helpers/externalRecoveryOperabilityTestHelper.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const ACTOR_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const PAYLOAD = `MSH|^~\\&|VH|HOSPITAL|REMOTE|HOSPITAL|20260802120000||ADT^A01|CTRL-${SUFFIX}|P|2.5\rPID|1||patient-${SUFFIX}`;
const PAYLOAD_HASH = createHash('sha256').update(Buffer.from(PAYLOAD, 'utf8')).digest('hex');
let systemId;
let channelId;
let versionId;

async function createMessage(direction) {
  return setTenantTx(TENANT_ID, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO interop_messages
         (tenant_id, channel_id, channel_version_id, direction, protocol,
          message_type, external_control_id, dedupe_key, payload_hash,
          raw_payload_ciphertext, status, arrival_class, effect_disposition,
          send_authority, owner_reconciliation_required)
       VALUES ($1::uuid, $2::integer, $3::integer, $4::text, 'hl7v2',
               'ADT^A01', $5::text, $6::text, $7::text, $8::text,
               $9::text, 'live', 'live', 'live_authorized', false)
       RETURNING id, direction, protocol, payload_hash`,
      TENANT_ID,
      channelId,
      versionId,
      direction,
      `CTRL-${SUFFIX}`,
      `${direction}-${SUFFIX}`,
      PAYLOAD_HASH,
      encryptField(PAYLOAD, { tenantId: TENANT_ID }),
      direction === 'inbound' ? 'transformed' : 'queued',
    );
    return rows[0];
  });
}

async function recover(message) {
  const direction = message.direction;
  const partition = `channel:${channelId}:${direction}:target:${systemId}`;
  const offset = await registerExternalRecoveryOffset({
    tenantId: TENANT_ID,
    interfaceFamily: 'I05',
    protocol: 'hl7v2',
    streamDirection: direction,
    sourcePartition: partition,
    initialPosition: 0,
    initialToken: `${direction}-token-0`,
    retainedFromPosition: 0,
    retainedFromToken: `${direction}-token-0`,
    policyVersion: 'c-d8-v1',
    policySignature: `owner-signature-${SUFFIX}`,
    retentionPolicy: 'interop-message-owner-governed',
    retentionUntil: '2029-08-02T00:00:00.000Z',
  });
  await authorizeExternalRecoveryResume({
    tenantId: TENANT_ID,
    offsetId: offset.offset_id,
    interfaceFamily: 'I05',
    protocol: 'hl7v2',
    streamDirection: direction,
    resumeCutoffPosition: 1,
    resumeCutoffToken: `${direction}-token-1`,
  });
  const command = {
    message_id: message.id,
    actor_uid: ACTOR_UID,
    owner_reason: `The accountable owner classified the late ${direction} HL7v2 message for review.`,
    evidence: { outage_reconciliation_id: `recon-${direction}-${SUFFIX}` },
  };
  const envelope = {
    tenantId: TENANT_ID,
    offsetId: offset.offset_id,
    interfaceFamily: 'I05',
    protocol: 'hl7v2',
    streamDirection: direction,
    sourcePartition: partition,
    sourcePosition: 1,
    sourceToken: `${direction}-token-1`,
    predecessorToken: `${direction}-token-0`,
    duplicateKey: `hl7v2:${channelId}:${direction}:${systemId}:${PAYLOAD_HASH}`,
    command,
  };
  await enqueueExternalRecoveryItem({
    ...envelope,
    occurredAt: '2026-08-02T09:00:00.000Z',
  });
  return processNextItemTx(envelope);
}

describeIfDb('C6.1-E I05 HL7v2 recovery adapter', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'C6.1-E I05 HL7v2 tenant')`,
      TENANT_ID,
      `c61e-i05-hl7v2-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, email, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text,
               'C6.1-E I05 owner', 'ADMIN', true, NOW())`,
      ACTOR_UID,
      TENANT_ID,
      `93${SUFFIX.slice(0, 10)}`,
      `i05-owner-${SUFFIX}@example.test`,
    );
    await setTenantTx(TENANT_ID, async (tx) => {
      const systems = await tx.$queryRawUnsafe(
        `INSERT INTO interop_systems
           (tenant_id, system_key, display_name, kind, direction, status)
         VALUES ($1::uuid, $2::text, 'I05 recovery target', 'vh_backend',
                 'bidirectional', 'active') RETURNING id`,
        TENANT_ID,
        `recovery-target-${SUFFIX}`,
      );
      systemId = systems[0].id;
      const channels = await tx.$queryRawUnsafe(
        `INSERT INTO interop_channels
           (tenant_id, channel_key, display_name, source_system_id,
            target_system_id, direction, connector_kind, protocol,
            status, auth_kind)
         VALUES ($1::uuid, $2::text, 'I05 recovery channel', $3::integer,
                 $3::integer, 'bidirectional', 'internal_backend',
                 'hl7v2', 'active', 'internal') RETURNING id`,
        TENANT_ID,
        `recovery-channel-${SUFFIX}`,
        systemId,
      );
      channelId = channels[0].id;
      const versions = await tx.$queryRawUnsafe(
        `INSERT INTO interop_channel_versions
           (tenant_id, channel_id, version_number, status,
            routing_policy, transform_dsl)
         VALUES ($1::uuid, $2::integer, 1, 'active',
                 '{"adapter":"backend.interop.preview"}'::jsonb,
                 '{"kind":"hl7v2-to-backend-adapter"}'::jsonb)
         RETURNING id`,
        TENANT_ID,
        channelId,
      );
      versionId = versions[0].id;
      await tx.$executeRawUnsafe(
        `UPDATE interop_channels SET active_version_id = $3::integer
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        TENANT_ID,
        channelId,
        versionId,
      );
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test.each([
    ['inbound', 'pending_review', 'i05_hl7v2_inbound_pending_review'],
    ['outbound', 'send_held', 'i05_hl7v2_outbound_send_held'],
  ])('holds late %s bytes with a pending receipt and no effect', async (direction, receiptStatus, outcomeCode) => {
    const message = await createMessage(direction);
    const recovered = await recover(message);
    expect(recovered).toMatchObject({
      status: 'handled',
      outcome_code: outcomeCode,
      message_id: String(message.id),
      cursor: {
        high_water_position: '1',
        recovery_state: 'ready',
      },
    });

    const state = await setTenantTx(TENANT_ID, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT message.status, message.recovery_ledger_version,
                message.source_position::text, message.effect_disposition,
                message.send_authority, message.owner_reconciliation_required,
                receipt.receipt_status, receipt.payload_sha256::text,
                receipt.payload_bytes, receipt.evidence,
                COUNT(attempt.id)::integer AS attempt_count
           FROM interop_messages AS message
           JOIN interop_backend_delivery_receipts AS receipt
             ON receipt.tenant_id = message.tenant_id
            AND receipt.message_id = message.id
           LEFT JOIN interop_message_attempts AS attempt
             ON attempt.tenant_id = message.tenant_id
            AND attempt.message_id = message.id
          WHERE message.tenant_id = $1::uuid AND message.id = $2::integer
          GROUP BY message.id, receipt.id`,
        TENANT_ID,
        message.id,
      );
      return rows[0];
    });
    expect(state).toMatchObject({
      status: 'quarantined',
      recovery_ledger_version: 1,
      source_position: '1',
      effect_disposition: 'late_pending_only',
      send_authority: 'held',
      owner_reconciliation_required: true,
      receipt_status: receiptStatus,
      payload_sha256: PAYLOAD_HASH,
      payload_bytes: Buffer.byteLength(PAYLOAD, 'utf8'),
      evidence: expect.objectContaining({
        byte_parity_verified: true,
        target_domain_effect_performed: false,
        network_send_performed: false,
      }),
      attempt_count: 0,
    });
    await expect(setTenantTx(TENANT_ID, tx => tx.$executeRawUnsafe(
      `UPDATE interop_messages
          SET raw_payload_ciphertext = raw_payload_ciphertext || 'tampered'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_ID,
      message.id,
    ))).rejects.toThrow(/recovery identity and late disposition are immutable/i);
  }, 60_000);
});

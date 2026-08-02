import { createHash, randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { encryptField } from '../../utils/fieldEncryption.js';
import {
  authorizeExternalRecoveryResume,
  enqueueExternalRecoveryItem,
  processNextItemTx,
  registerExternalRecoveryOffset,
} from '../../services/integrations/externalInterfaceRecoveryService.js';

export function defineI05AdapterRecoveryContract({
  protocol,
  payload,
  backendAdapterKey,
  externalAdapterKey,
} = {}) {
  const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  const describeIfDb = databaseUrl ? describe : describe.skip;
  const tenantId = randomUUID();
  const actorUid = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const payloadHash = createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex');
  let systemId;
  let channelId;
  let versionId;

  async function createMessage(direction) {
    return setTenantTx(tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO interop_messages
           (tenant_id, channel_id, channel_version_id, direction, protocol,
            dedupe_key, payload_hash, raw_payload_ciphertext, status, arrival_class,
            effect_disposition, send_authority, owner_reconciliation_required)
         VALUES ($1::uuid, $2::integer, $3::integer, $4::text, $5::text,
                 $6::text, $7::text, $8::text, $9::text, 'live', 'live',
                 'live_authorized', false)
         RETURNING id, direction, protocol, payload_hash`,
        tenantId,
        channelId,
        versionId,
        direction,
        protocol,
        `${direction}-${suffix}`,
        payloadHash,
        encryptField(payload, { tenantId }),
        direction === 'inbound' ? 'transformed' : 'queued',
      );
      return rows[0];
    });
  }

  async function recover(message) {
    const direction = message.direction;
    const partition = `channel:${channelId}:${direction}:target:${systemId}`;
    const offset = await registerExternalRecoveryOffset({
      tenantId,
      interfaceFamily: 'I05',
      protocol,
      streamDirection: direction,
      sourcePartition: partition,
      initialPosition: 0,
      initialToken: `${direction}-token-0`,
      retainedFromPosition: 0,
      retainedFromToken: `${direction}-token-0`,
      policyVersion: 'c-d8-v1',
      policySignature: `owner-signature-${suffix}`,
      retentionPolicy: 'interop-message-owner-governed',
      retentionUntil: '2029-08-02T00:00:00.000Z',
    });
    await authorizeExternalRecoveryResume({
      tenantId,
      offsetId: offset.offset_id,
      interfaceFamily: 'I05',
      protocol,
      streamDirection: direction,
      resumeCutoffPosition: 1,
      resumeCutoffToken: `${direction}-token-1`,
    });
    const command = {
      message_id: message.id,
      actor_uid: actorUid,
      owner_reason: `The accountable owner classified the late ${direction} ${protocol} message for review.`,
      evidence: { outage_reconciliation_id: `${protocol}-recon-${direction}-${suffix}` },
    };
    const envelope = {
      tenantId,
      offsetId: offset.offset_id,
      interfaceFamily: 'I05',
      protocol,
      streamDirection: direction,
      sourcePartition: partition,
      sourcePosition: 1,
      sourceToken: `${direction}-token-1`,
      predecessorToken: `${direction}-token-0`,
      duplicateKey: `${protocol}:${channelId}:${direction}:${systemId}:${payloadHash}`,
      command,
    };
    await enqueueExternalRecoveryItem({ ...envelope, occurredAt: '2026-08-02T09:00:00.000Z' });
    return processNextItemTx(envelope);
  }

  describeIfDb(`C6.1-E I05 ${protocol} recovery adapter`, () => {
    beforeAll(async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2::text, 'C6.1-E I05 adapter tenant')`,
        tenantId,
        `c61e-i05-${protocol}-recovery-${suffix}`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, email, name, role, is_active, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::text, $4::text, 'C6.1-E I05 owner', 'ADMIN', true, NOW())`,
        actorUid,
        tenantId,
        `91${suffix.slice(0, 10)}`,
        `${protocol}-owner-${suffix}@example.test`,
      );
      await setTenantTx(tenantId, async (tx) => {
        const systems = await tx.$queryRawUnsafe(
          `INSERT INTO interop_systems (tenant_id, system_key, display_name, kind, direction, status)
           VALUES ($1::uuid, $2::text, 'I05 recovery target', 'vh_backend', 'bidirectional', 'active') RETURNING id`,
          tenantId,
          `${protocol}-recovery-target-${suffix}`,
        );
        systemId = systems[0].id;
        const channels = await tx.$queryRawUnsafe(
          `INSERT INTO interop_channels
             (tenant_id, channel_key, display_name, source_system_id, target_system_id,
              direction, connector_kind, protocol, status, auth_kind)
           VALUES ($1::uuid, $2::text, 'I05 recovery channel', $3::integer, $3::integer,
                   'bidirectional', 'internal_backend', $4::text, 'active', 'internal') RETURNING id`,
          tenantId,
          `${protocol}-recovery-channel-${suffix}`,
          systemId,
          protocol,
        );
        channelId = channels[0].id;
        const versions = await tx.$queryRawUnsafe(
          `INSERT INTO interop_channel_versions
             (tenant_id, channel_id, version_number, status, routing_policy, transform_dsl)
           VALUES ($1::uuid, $2::integer, 1, 'active',
                   jsonb_build_object('adapter', $3::text),
                   jsonb_build_object('kind', $4::text)) RETURNING id`,
          tenantId,
          channelId,
          backendAdapterKey,
          `${protocol}-to-backend-adapter`,
        );
        versionId = versions[0].id;
        await tx.$executeRawUnsafe(
          'UPDATE interop_channels SET active_version_id = $3::integer WHERE tenant_id = $1::uuid AND id = $2::integer',
          tenantId,
          channelId,
          versionId,
        );
      });
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    test.each([
      ['inbound', 'pending_review', `i05_${protocol}_inbound_pending_review`, backendAdapterKey],
      ['outbound', 'send_held', `i05_${protocol}_outbound_send_held`, externalAdapterKey],
    ])('holds late %s bytes without performing an effect or send', async (direction, receiptStatus, outcomeCode, adapterKey) => {
      const message = await createMessage(direction);
      const recovered = await recover(message);
      expect(recovered).toMatchObject({ status: 'handled', outcome_code: outcomeCode, message_id: String(message.id) });
      const state = await setTenantTx(tenantId, async (tx) => {
        const rows = await tx.$queryRawUnsafe(
          `SELECT message.status, message.recovery_ledger_version,
                  message.source_position::text, message.effect_disposition,
                  message.send_authority, message.owner_reconciliation_required,
                  receipt.receipt_status, receipt.adapter_key,
                  receipt.payload_sha256::text, receipt.payload_bytes, receipt.evidence,
                  COUNT(attempt.id)::integer AS attempt_count
             FROM interop_messages AS message
             JOIN interop_backend_delivery_receipts AS receipt
               ON receipt.tenant_id = message.tenant_id AND receipt.message_id = message.id
             LEFT JOIN interop_message_attempts AS attempt
               ON attempt.tenant_id = message.tenant_id AND attempt.message_id = message.id
            WHERE message.tenant_id = $1::uuid AND message.id = $2::integer
            GROUP BY message.id, receipt.id`,
          tenantId,
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
        adapter_key: adapterKey,
        payload_sha256: payloadHash,
        payload_bytes: Buffer.byteLength(payload, 'utf8'),
        evidence: expect.objectContaining({
          protocol_adapter: protocol,
          byte_parity_verified: true,
          target_domain_effect_performed: false,
          network_send_performed: false,
        }),
        attempt_count: 0,
      });
      await expect(setTenantTx(tenantId, tx => tx.$executeRawUnsafe(
        `UPDATE interop_messages SET raw_payload_ciphertext = raw_payload_ciphertext || 'tampered'
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        tenantId,
        message.id,
      ))).rejects.toThrow(/recovery identity and late disposition are immutable/i);
    }, 60_000);
  });
}

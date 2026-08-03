import { createHash, randomUUID } from 'node:crypto';

const { default: prisma, setTenantTx } = await import('../lib/prisma.js');
const {
  authorizeExternalRecoveryResume,
  enqueueExternalRecoveryItem,
  processNextItemTx,
  registerExternalRecoveryOffset,
} = await import('../services/integrations/externalInterfaceRecoveryService.js');
const {
  claimStrandedInboundNHCXMessage,
} = await import('../services/integrations/externalNhcxRecoveryService.js');

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const ACTOR_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const POLICY = Object.freeze({
  policyVersion: 'i19-owner-v1',
  retentionPolicy: 'nhcx-exchange-2555d',
  retentionUntil: '2033-08-03T00:00:00.000Z',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

describeIfDb('C6.1-F I19 NHCX outbound and callback recovery', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'I19 NHCX recovery tenant')`,
      TENANT_ID,
      `i19-nhcx-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, email, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3::text, $4::text,
          'I19 owner', 'ADMIN', true, 'active', NOW())`,
      ACTOR_UID,
      TENANT_ID,
      `98${SUFFIX.slice(0, 10)}`,
      `owner-${SUFFIX}@example.test`,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('freezes exact outbound ciphertext at its local message id without dispatch', async () => {
    const ciphertext = Buffer.from(`i19-exact-ciphertext-${SUFFIX}`, 'utf8');
    const apiCallId = `api-${SUFFIX}`;
    const inserted = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `INSERT INTO nhcx_messages
         (tenant_id, environment, direction, cycle, endpoint,
          participant_code_self, participant_code_counterparty,
          hcx_api_call_id, hcx_correlation_id, hcx_workflow_id,
          payload_hash, payload_ciphertext, status, attempt_count,
          next_retry_at, created_at, updated_at)
       VALUES
         ($1::uuid, 'sandbox', 'outbound', 'claim', 'claim/submit',
          'VH-I19', 'PAYER-I19', $2::text, $3::text, $4::text,
          $5::text, $6::text, 'failed', 1, NOW(),
          '2026-08-03T06:00:00.000Z'::timestamptz, NOW())
       RETURNING id::text, created_at::text`,
      TENANT_ID,
      apiCallId,
      `corr-${SUFFIX}`,
      `workflow-${SUFFIX}`,
      'a'.repeat(64),
      ciphertext.toString('utf8'),
    ));
    const messageId = inserted[0].id;
    const predecessorPosition = (BigInt(messageId) - 1n).toString();
    const sourcePartition = 'nhcx:sandbox:outbound:claim/submit';
    const predecessorToken = `nhcx-${predecessorPosition}`;
    const sourceToken = `nhcx-${messageId}`;
    const duplicateKey = `i19:outbound:${apiCallId}`;
    const offset = await registerExternalRecoveryOffset({
      tenantId: TENANT_ID,
      interfaceFamily: 'I19',
      sourcePartition,
      initialPosition: predecessorPosition,
      initialToken: predecessorToken,
      retainedFromPosition: predecessorPosition,
      retainedFromToken: predecessorToken,
      policySignature: `i19-${SUFFIX}`,
      ...POLICY,
    });
    await authorizeExternalRecoveryResume({
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      interfaceFamily: 'I19',
      resumeCutoffPosition: messageId,
      resumeCutoffToken: sourceToken,
    });
    const rawPayload = JSON.stringify({
      schema: 'vhhealth.i19.nhcx-outbound-owner-reconciliation/v1',
      nhcx_message_id: messageId,
      direction: 'outbound',
      environment: 'sandbox',
      endpoint: 'claim/submit',
      occurred_at: new Date(inserted[0].created_at).toISOString(),
      hcx_api_call_id: apiCallId,
      payload_hash: 'a'.repeat(64),
      payload_ciphertext_base64: ciphertext.toString('base64'),
      payload_ciphertext_sha256: sha256(ciphertext),
    });
    const operation = {
      tenantId: TENANT_ID,
      offsetId: offset.offset_id,
      interfaceFamily: 'I19',
      sourcePartition,
      generation: 1,
      sourcePosition: messageId,
      sourceToken,
      predecessorToken,
      duplicateKey,
      occurredAt: new Date(inserted[0].created_at).toISOString(),
      command: {
        raw_payload: rawPayload,
        payload_sha256: sha256(Buffer.from(rawPayload, 'utf8')),
        actor_uid: ACTOR_UID,
        owner_reason: 'Owner-directed NHCX downstream reconciliation',
        owner_disposition: 'investigate',
        evidence: { owner_reviewed: true, source_export: 'synthetic_i19_fixture' },
      },
    };
    await enqueueExternalRecoveryItem(operation);
    const outcome = await processNextItemTx(operation);
    expect(outcome).toMatchObject({
      status: 'handled',
      outcome_code: 'i19_outbound_message_pending_owner_reconciliation',
      receipt_id: messageId,
      cursor: {
        high_water_position: predecessorPosition,
        recovery_state: 'reconciliation_required_provider_state',
      },
    });
    const state = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT message.status, message.recovery_prior_status,
              message.recovery_disposition, message.next_retry_at,
              message.payload_ciphertext, message.recovery_evidence,
              inbox.status AS inbox_status, task.status AS task_status,
              task.assigned_to_role, task.workflow_sla_instance_id
         FROM nhcx_messages message
         JOIN pathway_projector_inbox inbox
           ON inbox.tenant_id = message.tenant_id
          AND inbox.inbox_id = message.recovery_inbox_id
         JOIN tasks task
           ON task.tenant_id = inbox.tenant_id AND task.id = inbox.pending_task_id
        WHERE message.tenant_id = $1::uuid AND message.id = $2::bigint`,
      TENANT_ID,
      messageId,
    ));
    expect(state[0]).toMatchObject({
      status: 'recovery_pending',
      recovery_prior_status: 'failed',
      recovery_disposition: 'investigate',
      next_retry_at: null,
      payload_ciphertext: ciphertext.toString('utf8'),
      recovery_evidence: expect.objectContaining({
        exact_ciphertext_byte_parity_verified: true,
        source_position_is_local_nhcx_message_id: true,
        provider_sequence_present_inbound: false,
        inbound_replay_authorized: false,
        outbound_dispatch_authorized: false,
        payment_notice_manual_only: true,
      }),
      inbox_status: 'handled',
      task_status: 'open',
      assigned_to_role: 'TENANT_ADMIN',
      workflow_sla_instance_id: null,
    });
  });

  test('claims a stale inbound processing receipt without domain replay', async () => {
    const token = randomUUID();
    const inserted = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `INSERT INTO nhcx_messages
         (tenant_id, environment, direction, cycle, endpoint,
          participant_code_self, participant_code_counterparty,
          hcx_api_call_id, hcx_correlation_id, hcx_workflow_id,
          payload_hash, payload_ciphertext, signature_verified, status,
          inbound_claim_token, inbound_claimed_at, received_at,
          created_at, updated_at)
       VALUES
         ($1::uuid, 'sandbox', 'inbound', 'preauth', 'preauth/on_submit',
          'VH-I19', 'PAYER-I19', $2::text, $3::text, $4::text,
          repeat('b', 64), 'inbound-i19-ciphertext', true, 'processing',
          $5::uuid, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes',
          NOW() - INTERVAL '10 minutes', NOW())
       RETURNING id::text`,
      TENANT_ID,
      `inbound-api-${SUFFIX}`,
      `inbound-corr-${SUFFIX}`,
      `inbound-workflow-${SUFFIX}`,
      token,
    ));
    const result = await claimStrandedInboundNHCXMessage({
      tenantId: TENANT_ID,
      messageId: inserted[0].id,
      actorUid: ACTOR_UID,
      ownerReason: 'Inbound processing claim exceeded the recovery fence',
      ownerDisposition: 'investigate',
    });
    expect(result).toMatchObject({
      message: {
        id: inserted[0].id,
        status: 'recovery_pending',
        inbound_claim_token: token,
        inbound_owner_disposition: 'investigate',
      },
      task: {
        status: 'open',
        assigned_to_role: 'TENANT_ADMIN',
        workflow_sla_instance_id: null,
      },
    });
    await expect(setTenantTx(TENANT_ID, tx => tx.$executeRawUnsafe(
      `UPDATE nhcx_messages SET status = 'processing'
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT_ID,
      inserted[0].id,
    ))).rejects.toThrow(/cannot be replayed or rewritten/);
  });

  test('does not claim payment notices or fresh callback processing', async () => {
    const rows = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `INSERT INTO nhcx_messages
         (tenant_id, environment, direction, cycle, endpoint,
          participant_code_self, hcx_api_call_id, payload_hash,
          payload_ciphertext, status, created_at, updated_at)
       VALUES
         ($1::uuid, 'sandbox', 'inbound', 'payment_notice', 'paymentnotice/request',
          'VH-I19', $2::text, repeat('c', 64), 'payment-ciphertext',
          'manual_review', NOW() - INTERVAL '10 minutes', NOW()),
         ($1::uuid, 'sandbox', 'inbound', 'claim', 'claim/on_submit',
          'VH-I19', $3::text, repeat('d', 64), 'fresh-ciphertext',
          'accepted', NOW(), NOW())
       RETURNING id::text, cycle`,
      TENANT_ID,
      `payment-api-${SUFFIX}`,
      `fresh-api-${SUFFIX}`,
    ));
    for (const row of rows) {
      await expect(claimStrandedInboundNHCXMessage({
        tenantId: TENANT_ID,
        messageId: row.id,
        actorUid: ACTOR_UID,
        ownerReason: 'Must remain blocked',
        ownerDisposition: 'investigate',
      })).rejects.toMatchObject({ code: 'I19_NHCX_INBOUND_NOT_CLAIMABLE' });
    }
  });
});

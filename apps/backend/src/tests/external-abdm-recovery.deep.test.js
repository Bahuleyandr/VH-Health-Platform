import { createHash, randomUUID } from 'node:crypto';

process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || 'i16-abdm-test-field-key-32-characters';

const { default: prisma, setTenantTx } = await import('../lib/prisma.js');
const {
  authorizeExternalRecoveryResume,
  enqueueExternalRecoveryItem,
  processNextItemTx,
  registerExternalRecoveryOffset,
} = await import('../services/integrations/externalInterfaceRecoveryService.js');
const {
  markAuthenticatedAbdmCallback,
  recordAuthenticatedAbdmCallback,
} = await import('../services/integrations/externalAbdmRecoveryService.js');
const { decryptField } = await import('../utils/fieldEncryption.js');

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const ACTOR_UID = randomUUID();
const PATIENT_UID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const POLICY = Object.freeze({
  policyVersion: 'i16-owner-v1',
  retentionPolicy: 'abdm-exchange-2555d',
  retentionUntil: '2033-08-03T00:00:00.000Z',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function authBinding(auth) {
  return sha256(Buffer.from([
    auth.hipId,
    auth.requestId,
    auth.timestamp,
    auth.signature,
  ].join('\0'), 'utf8'));
}

async function recover({
  recoveryKind,
  callbackPath,
  providerIdentityKind,
  providerTransactionId,
  environment,
  occurredAt,
  authenticatedAt,
  authBindingSha256,
  rawBody,
  webhookEventId,
  dataRequestId,
  ownerDisposition,
}) {
  const rawPayload = JSON.stringify({
    schema: 'vhhealth.i16.abdm-owner-reconciliation/v1',
    recovery_kind: recoveryKind,
    callback_path: callbackPath,
    provider_identity_kind: providerIdentityKind,
    provider_transaction_id: providerTransactionId,
    environment,
    occurred_at: occurredAt,
    auth_binding_sha256: authBindingSha256,
    authenticated_at: authenticatedAt,
    raw_body_base64: rawBody.toString('base64'),
    raw_body_sha256: sha256(rawBody),
    webhook_event_id: webhookEventId,
    data_request_id: dataRequestId,
  });
  const sourcePartition = `abdm:${environment}:inbound`;
  const predecessorToken = `${environment}-owner-10`;
  const sourceToken = `${environment}-owner-11`;
  const duplicateKey = `i16:${providerIdentityKind}:${providerTransactionId}`;
  const offset = await registerExternalRecoveryOffset({
    tenantId: TENANT_ID,
    interfaceFamily: 'I16',
    sourcePartition,
    initialPosition: 10,
    initialToken: predecessorToken,
    retainedFromPosition: 10,
    retainedFromToken: predecessorToken,
    policySignature: `i16-${environment}-${SUFFIX}`,
    ...POLICY,
  });
  await authorizeExternalRecoveryResume({
    tenantId: TENANT_ID,
    offsetId: offset.offset_id,
    interfaceFamily: 'I16',
    resumeCutoffPosition: 11,
    resumeCutoffToken: sourceToken,
  });
  const operation = {
    tenantId: TENANT_ID,
    offsetId: offset.offset_id,
    interfaceFamily: 'I16',
    sourcePartition,
    generation: 1,
    sourcePosition: '11',
    sourceToken,
    predecessorToken,
    duplicateKey,
    occurredAt,
    command: {
      raw_payload: rawPayload,
      payload_sha256: sha256(Buffer.from(rawPayload, 'utf8')),
      actor_uid: ACTOR_UID,
      owner_reason: 'Owner-directed ABDM reconciliation',
      owner_disposition: ownerDisposition,
      evidence: { owner_reviewed: true, source_export: 'synthetic_i16_fixture' },
    },
  };
  await enqueueExternalRecoveryItem(operation);
  return {
    outcome: await processNextItemTx(operation),
    rawPayload,
  };
}

describeIfDb('C6.1-F I16 ABDM callback and stranded-transfer recovery', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'I16 ABDM recovery tenant')`,
      TENANT_ID,
      `i16-abdm-${SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, email, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $3::uuid, $4::text, $6::text, 'I16 owner', 'ADMIN', true, 'active', NOW()),
         ($2::uuid, $3::uuid, $5::text, $7::text, 'I16 patient', 'PATIENT', true, 'active', NOW())`,
      ACTOR_UID,
      PATIENT_UID,
      TENANT_ID,
      `91${SUFFIX.slice(0, 10)}`,
      `92${SUFFIX.slice(0, 10)}`,
      `owner-${SUFFIX}@example.test`,
      `patient-${SUFFIX}@example.test`,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('records exact authenticated public callback bytes and deduplicates by transactionId', async () => {
    const transactionId = `txn-live-${SUFFIX}`;
    const rawBody = Buffer.from(`{"transactionId":"${transactionId}","hiRequest":{"consent":{"id":"consent-${SUFFIX}"}}}`, 'utf8');
    const body = JSON.parse(rawBody.toString('utf8'));
    const auth = {
      hipId: `hip-${SUFFIX}`,
      requestId: `request-${SUFFIX}`,
      timestamp: '1785733200000',
      signature: 'a'.repeat(64),
      authenticatedAt: '2026-08-03T05:00:00.000Z',
    };
    const first = await recordAuthenticatedAbdmCallback({
      tenantId: TENANT_ID,
      callbackPath: '/health-info/on-request',
      body,
      rawBody,
      environment: 'sandbox',
      auth,
    });
    expect(first.duplicate).toBe(false);
    const duplicate = await recordAuthenticatedAbdmCallback({
      tenantId: TENANT_ID,
      callbackPath: '/health-info/on-request',
      body,
      rawBody,
      environment: 'sandbox',
      auth: { ...auth, requestId: `retry-${SUFFIX}` },
    });
    expect(duplicate).toMatchObject({
      duplicate: true,
      event: { id: first.event.id, external_event_id: transactionId },
    });

    const receipts = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT raw_body_ciphertext, raw_body_sha256::text, raw_body_bytes,
              auth_binding_sha256::text, provider_identity_kind,
              provider_identity_value, metadata
         FROM abdm_webhook_events
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_ID,
      Number(first.event.id),
    ));
    expect(Buffer.from(decryptField(receipts[0].raw_body_ciphertext), 'base64')).toEqual(rawBody);
    expect(receipts[0]).toMatchObject({
      raw_body_sha256: sha256(rawBody),
      raw_body_bytes: rawBody.length,
      auth_binding_sha256: authBinding(auth),
      provider_identity_kind: 'transactionId',
      provider_identity_value: transactionId,
      metadata: expect.objectContaining({
        provider_sequence_present: false,
        replay_guard_role: 'pre_auth_short_ttl_only',
        automatic_recovery_authorized: false,
      }),
    });
    const guardRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
         FROM interop_replay_guard
        WHERE namespace = 'abdm-callback' AND request_id IN ($1::text, $2::text)`,
      auth.requestId,
      `retry-${SUFFIX}`,
    );
    expect(guardRows[0].count).toBe(0);

    await expect(recordAuthenticatedAbdmCallback({
      tenantId: TENANT_ID,
      callbackPath: '/health-info/on-request',
      body: { ...body, drift: true },
      rawBody: Buffer.from(`${rawBody.toString('utf8')} `, 'utf8'),
      environment: 'sandbox',
      auth,
    })).rejects.toMatchObject({ code: 'I16_ABDM_PROVIDER_IDENTITY_COLLISION' });
  });

  test('claims a stranded PROCESSING request for owner disposition without auto-resume', async () => {
    const transactionId = `txn-stranded-${SUFFIX}`;
    const rawBody = Buffer.from(`{"transactionId":"${transactionId}","hiRequest":{"consent":{"id":"consent-${SUFFIX}"},"hiTypes":["Prescription"]}}`, 'utf8');
    const auth = {
      hipId: `hip-${SUFFIX}`,
      requestId: `stranded-request-${SUFFIX}`,
      timestamp: '1785733260000',
      signature: 'b'.repeat(64),
      authenticatedAt: '2026-08-03T05:01:00.000Z',
    };
    const live = await recordAuthenticatedAbdmCallback({
      tenantId: TENANT_ID,
      callbackPath: '/health-info/on-request',
      body: JSON.parse(rawBody.toString('utf8')),
      rawBody,
      environment: 'sandbox',
      auth,
    });
    const requests = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `INSERT INTO abdm_data_requests
         (transaction_id, consent_id, patient_uid, tenant_id, hi_types, status, created_at)
       VALUES ($1::text, $2::text, $3::uuid, $4::uuid, ARRAY['Prescription'], 'PROCESSING', NOW())
       RETURNING id, transaction_id, status`,
      transactionId,
      `consent-${SUFFIX}`,
      PATIENT_UID,
      TENANT_ID,
    ));
    await markAuthenticatedAbdmCallback({
      tenantId: TENANT_ID,
      eventId: live.event.id,
      status: 'processed',
      relatedDataRequestId: requests[0].id,
    });

    const recovered = await recover({
      recoveryKind: 'stranded_processing',
      callbackPath: '/health-info/on-request',
      providerIdentityKind: 'transactionId',
      providerTransactionId: transactionId,
      environment: 'sandbox',
      occurredAt: '2026-08-03T05:02:00.000Z',
      authenticatedAt: auth.authenticatedAt,
      authBindingSha256: authBinding(auth),
      rawBody,
      webhookEventId: Number(live.event.id),
      dataRequestId: requests[0].id,
      ownerDisposition: 'investigate',
    });
    expect(recovered.outcome).toMatchObject({
      status: 'handled',
      outcome_code: 'i16_stranded_processing_pending_owner_disposition',
      receipt_id: live.event.id,
      cursor: {
        high_water_position: '10',
        recovery_state: 'reconciliation_required_provider_state',
      },
    });
    const state = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT request.status, request.recovery_disposition,
              event.status AS event_status, event.recovery_disposition AS event_disposition,
              event.processed_at, inbox.status AS inbox_status,
              task.status AS task_status, task.assigned_to_role,
              task.workflow_sla_instance_id, event.metadata
         FROM abdm_data_requests request
         JOIN abdm_webhook_events event
           ON event.tenant_id = request.tenant_id
          AND event.related_data_request_id = request.id
         JOIN pathway_projector_inbox inbox
           ON inbox.tenant_id = event.tenant_id
          AND inbox.inbox_id = event.recovery_inbox_id
         JOIN tasks task
           ON task.tenant_id = inbox.tenant_id AND task.id = inbox.pending_task_id
        WHERE request.tenant_id = $1::uuid AND request.id = $2::integer`,
      TENANT_ID,
      requests[0].id,
    ));
    expect(state[0]).toMatchObject({
      status: 'RECOVERY_PENDING_REVIEW',
      recovery_disposition: 'investigate',
      event_status: 'recovery_pending',
      event_disposition: 'investigate',
      processed_at: null,
      inbox_status: 'handled',
      task_status: 'open',
      assigned_to_role: 'TENANT_ADMIN',
      workflow_sla_instance_id: null,
      metadata: expect.objectContaining({
        exact_callback_byte_parity_verified: true,
        provider_sequence_present: false,
        replay_guard_role: 'pre_auth_short_ttl_only',
        automatic_resume_authorized: false,
      }),
    });
    await expect(setTenantTx(TENANT_ID, tx => tx.$executeRawUnsafe(
      `UPDATE abdm_data_requests SET status = 'PROCESSING'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_ID,
      requests[0].id,
    ))).rejects.toThrow(/cannot be resumed or rewritten/);
  });

  test('lands a late consent callback as pending evidence without consent mutation', async () => {
    const consentRequestId = `late-consent-${SUFFIX}`;
    const rawBody = Buffer.from(`{"notification":{"consentRequestId":"${consentRequestId}","patient":{"id":"patient@sbx"}}}`, 'utf8');
    const recovered = await recover({
      recoveryKind: 'late_callback',
      callbackPath: '/consent/on-notify',
      providerIdentityKind: 'consentRequestId',
      providerTransactionId: consentRequestId,
      environment: 'production',
      occurredAt: '2026-08-03T05:03:00.000Z',
      authenticatedAt: '2026-08-03T05:02:59.000Z',
      authBindingSha256: 'c'.repeat(64),
      rawBody,
      webhookEventId: null,
      dataRequestId: null,
      ownerDisposition: 'review_late_callback',
    });
    expect(recovered.outcome).toMatchObject({
      status: 'handled',
      outcome_code: 'i16_late_callback_pending_owner_review',
      cursor: {
        high_water_position: '10',
        recovery_state: 'reconciliation_required_provider_state',
      },
    });
    const evidence = await setTenantTx(TENANT_ID, tx => tx.$queryRawUnsafe(
      `SELECT event.status, event.receipt_source, event.provider_identity_kind,
              event.provider_identity_value, event.raw_body_ciphertext,
              event.raw_body_sha256::text, event.raw_body_bytes,
              event.recovery_disposition, event.related_data_request_id,
              (SELECT COUNT(*)::integer FROM abdm_consents consent
                WHERE consent.tenant_id = event.tenant_id
                  AND consent.consent_id = event.provider_identity_value) AS consent_effects
         FROM abdm_webhook_events event
        WHERE event.tenant_id = $1::uuid AND event.id = $2::integer`,
      TENANT_ID,
      Number(recovered.outcome.receipt_id),
    ));
    expect(Buffer.from(decryptField(evidence[0].raw_body_ciphertext), 'base64')).toEqual(rawBody);
    expect(evidence[0]).toMatchObject({
      status: 'recovery_pending',
      receipt_source: 'owner_reconciled_callback',
      provider_identity_kind: 'consentRequestId',
      provider_identity_value: consentRequestId,
      raw_body_sha256: sha256(rawBody),
      raw_body_bytes: rawBody.length,
      recovery_disposition: 'review_late_callback',
      related_data_request_id: null,
      consent_effects: 0,
    });
  });
});

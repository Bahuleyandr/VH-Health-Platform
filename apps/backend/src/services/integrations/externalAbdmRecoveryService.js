import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { encryptField } from '../../utils/fieldEncryption.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask } from '../workflow/taskService.js';
import { requireExternalRecoveryCapability } from './externalRecoveryEffectGate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const CALLBACKS = Object.freeze({
  '/consent/on-notify': Object.freeze({
    eventType: 'consent_on_notify',
    identityKind: 'consentRequestId',
  }),
  '/health-info/on-request': Object.freeze({
    eventType: 'health_info_on_request',
    identityKind: 'transactionId',
  }),
});
const ENVIRONMENTS = new Set(['sandbox', 'production']);
const STRANDED_DISPOSITIONS = new Set([
  'investigate',
  'manual_retry_requested',
  'cancel_requested',
]);
const PAYLOAD_KEYS = new Set([
  'schema',
  'recovery_kind',
  'callback_path',
  'provider_identity_kind',
  'provider_transaction_id',
  'environment',
  'occurred_at',
  'auth_binding_sha256',
  'authenticated_at',
  'raw_body_base64',
  'raw_body_sha256',
  'webhook_event_id',
  'data_request_id',
]);
const COMMAND_KEYS = new Set([
  'raw_payload',
  'payload_sha256',
  'actor_uid',
  'owner_reason',
  'owner_disposition',
  'evidence',
]);

function refuse(message, code = 'I16_ABDM_RECOVERY_REFUSED', details = undefined) {
  throw AppError.conflict(message, code, details);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireUuid(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(text)) refuse(`${label} must be a UUID`);
  return text;
}

function requireText(value, label, max) {
  const text = String(value || '').trim();
  if (!text || text.length > max) refuse(`${label} is invalid`);
  return text;
}

function requirePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) refuse(`${label} must be a positive integer`);
  return number;
}

function requireTimestamp(value, label) {
  const parsed = new Date(String(value || ''));
  if (Number.isNaN(parsed.getTime())) refuse(`${label} must be a timestamp`);
  return parsed.toISOString();
}

function requireSha256(value, label) {
  const text = String(value || '').trim();
  if (!SHA256_RE.test(text)) refuse(`${label} must be lowercase SHA-256`);
  return text;
}

function normalizeEnvironment(value) {
  const environment = String(value || 'sandbox').trim().toLowerCase();
  if (!ENVIRONMENTS.has(environment)) refuse('ABDM environment must be sandbox or production');
  return environment;
}

function decodeCanonicalBase64(value) {
  const text = String(value ?? '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    refuse('raw_body_base64 must be canonical base64');
  }
  const decoded = Buffer.from(text, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== text) {
    refuse('raw_body_base64 must contain canonical non-empty bytes');
  }
  return decoded;
}

function callbackIdentity(callbackPath, body) {
  const callback = CALLBACKS[callbackPath];
  if (!callback) refuse('ABDM callback path is not registered', 'I16_ABDM_CALLBACK_PATH_INVALID');
  const notification = body?.notification || body;
  const value = callback.identityKind === 'consentRequestId'
    ? notification?.consentRequestId || notification?.consentId
    : body?.transactionId;
  return Object.freeze({
    ...callback,
    value: requireText(value, callback.identityKind, 160),
  });
}

function exactRawBody(value) {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw AppError.internal(
      'Authenticated ABDM callback exact body is unavailable',
      'I16_ABDM_EXACT_BODY_REQUIRED',
    );
  }
  return Buffer.from(value);
}

function authBindingSha256({ hipId, requestId, timestamp, signature }) {
  const fields = [
    requireText(hipId, 'authenticated HIP id', 160),
    requireText(requestId, 'authenticated request id', 255),
    requireText(timestamp, 'authenticated timestamp', 80),
    requireText(signature, 'authenticated signature', 1024),
  ];
  return sha256(Buffer.from(fields.join('\0'), 'utf8'));
}

export async function recordAuthenticatedAbdmCallback({
  tenantId,
  callbackPath,
  body,
  rawBody,
  environment = 'sandbox',
  auth,
} = {}) {
  const tid = requireTenantId(tenantId);
  const identity = callbackIdentity(callbackPath, body);
  const exactBody = exactRawBody(rawBody);
  const bodyHash = sha256(exactBody);
  const env = normalizeEnvironment(environment);
  const authenticatedAt = requireTimestamp(auth?.authenticatedAt, 'authenticated_at');
  const bindingHash = authBindingSha256(auth || {});

  return setTenantTx(tid, async (tx) => {
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO abdm_webhook_events
         (tenant_id, external_event_id, event_type, source,
          signature_verified, payload, status, environment, metadata,
          receipt_source, callback_path, provider_identity_kind,
          provider_identity_value, raw_body_ciphertext, raw_body_sha256,
          raw_body_bytes, auth_binding_sha256, authenticated_at)
       VALUES
         ($1::uuid, $2::text, $3::text, 'abdm_public_callback', TRUE,
          $4::jsonb, 'pending', $5::text, $6::jsonb,
          'live_authenticated_callback', $7::text, $8::text, $2::text,
          $9::text, $10::char(64), $11::integer, $12::char(64),
          $13::timestamptz)
       ON CONFLICT (tenant_id, external_event_id, environment) DO NOTHING
       RETURNING id::text, tenant_id::text, external_event_id, event_type,
                 status, environment, receipt_source, callback_path,
                 provider_identity_kind, provider_identity_value,
                 raw_body_sha256::text, raw_body_bytes,
                 auth_binding_sha256::text, authenticated_at, created_at`,
      tid,
      identity.value,
      identity.eventType,
      JSON.stringify(body || {}),
      env,
      JSON.stringify({
        provider_sequence_present: false,
        duplicate_identity: identity.identityKind,
        replay_guard_role: 'pre_auth_short_ttl_only',
        automatic_recovery_authorized: false,
      }),
      callbackPath,
      identity.identityKind,
      encryptField(exactBody.toString('base64'), { tenantId: tid }),
      bodyHash,
      exactBody.length,
      bindingHash,
      authenticatedAt,
    );
    if (inserted[0]) return Object.freeze({ event: inserted[0], duplicate: false });

    const existing = await tx.$queryRawUnsafe(
      `SELECT id::text, tenant_id::text, external_event_id, event_type,
              status, environment, receipt_source, callback_path,
              provider_identity_kind, provider_identity_value,
              raw_body_sha256::text, raw_body_bytes,
              auth_binding_sha256::text, authenticated_at, created_at
         FROM abdm_webhook_events
        WHERE tenant_id = $1::uuid AND external_event_id = $2::text
          AND environment = $3::text
        LIMIT 1`,
      tid,
      identity.value,
      env,
    );
    const event = existing[0];
    if (!event
        || event.receipt_source !== 'live_authenticated_callback'
        || event.callback_path !== callbackPath
        || event.provider_identity_kind !== identity.identityKind
        || event.raw_body_sha256 !== bodyHash
        || Number(event.raw_body_bytes) !== exactBody.length) {
      refuse(
        'ABDM provider transaction identity collides with different callback bytes',
        'I16_ABDM_PROVIDER_IDENTITY_COLLISION',
      );
    }
    return Object.freeze({ event, duplicate: true });
  }, { isolationLevel: 'Serializable' });
}

export async function markAuthenticatedAbdmCallback({
  tenantId,
  eventId,
  status,
  relatedDataRequestId = null,
  failureReason = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const id = requirePositiveInteger(eventId, 'event_id');
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (!['processed', 'failed'].includes(normalizedStatus)) {
    refuse('ABDM callback terminal status must be processed or failed');
  }
  const requestId = relatedDataRequestId === null
    ? null
    : requirePositiveInteger(relatedDataRequestId, 'related_data_request_id');

  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE abdm_webhook_events
          SET status = $3::text,
              processed_at = NOW(),
              failure_reason = $4::text,
              related_data_request_id = COALESCE($5::integer, related_data_request_id)
        WHERE tenant_id = $1::uuid AND id = $2::integer
          AND receipt_source = 'live_authenticated_callback'
          AND recovery_inbox_id IS NULL
          AND status = 'pending'
        RETURNING id::text, status, processed_at, related_data_request_id`,
      tid,
      id,
      normalizedStatus,
      failureReason ? String(failureReason).slice(0, 8000) : null,
      requestId,
    );
    if (rows.length !== 1) {
      refuse('ABDM callback receipt is not eligible for terminal marking');
    }
    return rows[0];
  });
}

export function parseI16AbdmRecoveryPayload(value) {
  let payload;
  try {
    payload = JSON.parse(String(value ?? ''));
  } catch {
    refuse('I16 ABDM recovery payload is invalid JSON', 'I16_ABDM_PAYLOAD_INVALID');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    refuse('I16 ABDM recovery payload must be an object', 'I16_ABDM_PAYLOAD_INVALID');
  }
  const keys = Object.keys(payload);
  if (keys.length !== PAYLOAD_KEYS.size || keys.some(key => !PAYLOAD_KEYS.has(key))) {
    refuse('I16 ABDM recovery payload fields do not match the registered schema', 'I16_ABDM_PAYLOAD_INVALID');
  }
  if (payload.schema !== 'vhhealth.i16.abdm-owner-reconciliation/v1') {
    refuse('I16 ABDM recovery payload schema is not registered', 'I16_ABDM_PAYLOAD_INVALID');
  }
  const recoveryKind = String(payload.recovery_kind || '').trim().toLowerCase();
  if (!['late_callback', 'stranded_processing'].includes(recoveryKind)) {
    refuse('I16 recovery_kind is invalid', 'I16_ABDM_PAYLOAD_INVALID');
  }
  const callbackPath = String(payload.callback_path || '').trim();
  const callback = CALLBACKS[callbackPath];
  if (!callback) refuse('I16 callback_path is invalid', 'I16_ABDM_PAYLOAD_INVALID');
  if (payload.provider_identity_kind !== callback.identityKind) {
    refuse('I16 provider identity kind does not match callback path', 'I16_ABDM_PAYLOAD_INVALID');
  }
  const rawBody = decodeCanonicalBase64(payload.raw_body_base64);
  const bodyHash = requireSha256(payload.raw_body_sha256, 'raw_body_sha256');
  if (sha256(rawBody) !== bodyHash) refuse('I16 callback body hash does not match exact bytes', 'I16_ABDM_PAYLOAD_INVALID');
  let callbackBody;
  try {
    callbackBody = JSON.parse(rawBody.toString('utf8'));
  } catch {
    refuse('I16 callback body bytes are not valid JSON', 'I16_ABDM_PAYLOAD_INVALID');
  }
  const identity = callbackIdentity(callbackPath, callbackBody);
  const providerTransactionId = requireText(payload.provider_transaction_id, 'provider_transaction_id', 160);
  if (identity.identityKind !== payload.provider_identity_kind || identity.value !== providerTransactionId) {
    refuse('I16 provider identity does not match exact callback bytes', 'I16_ABDM_PAYLOAD_INVALID');
  }
  const webhookEventId = payload.webhook_event_id === null
    ? null
    : requirePositiveInteger(payload.webhook_event_id, 'webhook_event_id');
  const dataRequestId = payload.data_request_id === null
    ? null
    : requirePositiveInteger(payload.data_request_id, 'data_request_id');
  if (recoveryKind === 'stranded_processing'
      && (callbackPath !== '/health-info/on-request' || webhookEventId === null || dataRequestId === null)) {
    refuse('I16 stranded PROCESSING recovery requires the health-info callback receipt and data request', 'I16_ABDM_PAYLOAD_INVALID');
  }
  if (recoveryKind === 'late_callback' && dataRequestId !== null) {
    refuse('I16 late callback recovery cannot bind a data request', 'I16_ABDM_PAYLOAD_INVALID');
  }
  return Object.freeze({
    schema: payload.schema,
    recoveryKind,
    callbackPath,
    eventType: callback.eventType,
    providerIdentityKind: callback.identityKind,
    providerTransactionId,
    environment: normalizeEnvironment(payload.environment),
    occurredAt: requireTimestamp(payload.occurred_at, 'occurred_at'),
    authBindingSha256: requireSha256(payload.auth_binding_sha256, 'auth_binding_sha256'),
    authenticatedAt: requireTimestamp(payload.authenticated_at, 'authenticated_at'),
    rawBody,
    rawBodySha256: bodyHash,
    callbackBody,
    webhookEventId,
    dataRequestId,
  });
}

function requireClosedCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    refuse('I16 owner recovery command must be an object');
  }
  const unexpected = Object.keys(command).filter(key => !COMMAND_KEYS.has(key));
  if (unexpected.length) refuse('I16 owner recovery command contains unknown fields', undefined, { unexpected });
  if (!command.evidence || typeof command.evidence !== 'object'
      || Array.isArray(command.evidence) || Object.keys(command.evidence).length === 0) {
    refuse('I16 owner evidence must be a non-empty object');
  }
  return command;
}

export async function persistLateAbdmRecovery({
  tx,
  capability,
  tenantId,
  recoveryInboxId,
  sourcePartition,
  sourcePosition,
  sourceToken,
  predecessorToken,
  duplicateKey,
  occurredAt,
  command,
} = {}) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal('I16 recovery requires the canonical recovery transaction', 'I16_RECOVERY_TX_REQUIRED');
  }
  const tid = requireTenantId(tenantId);
  const inboxId = requireUuid(recoveryInboxId, 'recovery_inbox_id');
  requireExternalRecoveryCapability(capability, {
    tenantId: tid,
    facilityId: null,
    interfaceFamily: 'I16',
    effectDisposition: 'late_pending_only',
  });
  if (capability.inboxId !== inboxId) refuse('I16 recovery capability inbox does not match');

  const input = requireClosedCommand(command);
  const rawPayload = String(input.raw_payload || '');
  if (!rawPayload) refuse('raw_payload is required');
  const payloadHash = sha256(Buffer.from(rawPayload, 'utf8'));
  if (input.payload_sha256 !== payloadHash) refuse('I16 raw payload hash does not match exact bytes');
  const payload = parseI16AbdmRecoveryPayload(rawPayload);
  if (payload.occurredAt !== requireTimestamp(occurredAt, 'occurred_at')) {
    refuse('I16 occurred_at does not match durable source occurrence');
  }
  const actorUid = requireUuid(input.actor_uid, 'actor_uid');
  const ownerReason = requireText(input.owner_reason, 'owner_reason', 500);
  const ownerDisposition = String(input.owner_disposition || '').trim().toLowerCase();
  if (payload.recoveryKind === 'late_callback') {
    if (ownerDisposition !== 'review_late_callback') {
      refuse('I16 late callback disposition must be review_late_callback');
    }
  } else if (!STRANDED_DISPOSITIONS.has(ownerDisposition)) {
    refuse('I16 stranded PROCESSING owner disposition is invalid');
  }
  const expectedPartition = `abdm:${payload.environment}:inbound`;
  const expectedDuplicate = `i16:${payload.providerIdentityKind}:${payload.providerTransactionId}`;
  if (sourcePartition !== expectedPartition) refuse('I16 source partition does not match environment and direction');
  if (duplicateKey !== expectedDuplicate) refuse('I16 duplicate key must be the provider transaction identity');

  let requestRow = null;
  if (payload.recoveryKind === 'stranded_processing') {
    const claimed = await tx.$queryRawUnsafe(
      `UPDATE abdm_data_requests
          SET status = 'RECOVERY_PENDING_REVIEW',
              recovery_inbox_id = $4::uuid,
              recovery_interface_family = 'I16',
              recovery_owner_uid = $5::uuid,
              recovery_owner_reason = $6::text,
              recovery_disposition = $7::text,
              recovery_claimed_at = NOW(),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer
          AND transaction_id = $3::text AND status = 'PROCESSING'
          AND recovery_inbox_id IS NULL
        RETURNING id, transaction_id, consent_id, patient_uid::text, status,
                  recovery_inbox_id::text, recovery_disposition,
                  recovery_claimed_at`,
      tid,
      payload.dataRequestId,
      payload.providerTransactionId,
      inboxId,
      actorUid,
      ownerReason,
      ownerDisposition,
    );
    requestRow = claimed[0] || null;
    if (!requestRow) {
      refuse(
        'I16 data request is not a claimable stranded PROCESSING row',
        'I16_ABDM_PROCESSING_NOT_CLAIMABLE',
      );
    }
  }

  const existingRows = await tx.$queryRawUnsafe(
    `SELECT id::text, receipt_source, callback_path, provider_identity_kind,
            provider_identity_value, raw_body_sha256::text, raw_body_bytes,
            auth_binding_sha256::text, recovery_inbox_id::text
       FROM abdm_webhook_events
      WHERE tenant_id = $1::uuid AND external_event_id = $2::text
        AND environment = $3::text
      FOR UPDATE`,
    tid,
    payload.providerTransactionId,
    payload.environment,
  );
  const existing = existingRows[0] || null;
  if (payload.webhookEventId !== null && Number(existing?.id) !== payload.webhookEventId) {
    refuse('I16 webhook_event_id does not match provider transaction identity');
  }
  if (existing && (
    existing.recovery_inbox_id !== null
    || !['live_authenticated_callback', 'owner_reconciled_callback'].includes(existing.receipt_source)
    || existing.callback_path !== payload.callbackPath
    || existing.provider_identity_kind !== payload.providerIdentityKind
    || existing.provider_identity_value !== payload.providerTransactionId
    || existing.raw_body_sha256 !== payload.rawBodySha256
    || Number(existing.raw_body_bytes) !== payload.rawBody.length
    || existing.auth_binding_sha256 !== payload.authBindingSha256
  )) {
    refuse('I16 existing callback receipt does not match exact owner evidence');
  }
  if (payload.recoveryKind === 'stranded_processing' && !existing) {
    refuse('I16 stranded PROCESSING recovery requires its authenticated callback receipt');
  }

  let receipts;
  if (existing) {
    receipts = await tx.$queryRawUnsafe(
      `UPDATE abdm_webhook_events
          SET status = 'recovery_pending', processed_at = NULL,
              recovery_inbox_id = $4::uuid,
              recovery_interface_family = 'I16',
              recovery_owner_uid = $5::uuid,
              recovery_owner_reason = $6::text,
              recovery_disposition = $7::text,
              source_partition = $8::text,
              source_position = $9::bigint,
              source_token = $10::text,
              predecessor_token = $11::text,
              duplicate_key = $12::text,
              related_data_request_id = $13::integer,
              metadata = metadata || $14::jsonb
        WHERE tenant_id = $1::uuid AND id = $2::integer
          AND environment = $3::text AND recovery_inbox_id IS NULL
        RETURNING id::text, external_event_id, event_type, status, environment,
                  receipt_source, callback_path, provider_identity_kind,
                  provider_identity_value, raw_body_sha256::text,
                  raw_body_bytes, recovery_inbox_id::text,
                  recovery_disposition, related_data_request_id, created_at`,
      tid,
      Number(existing.id),
      payload.environment,
      inboxId,
      actorUid,
      ownerReason,
      ownerDisposition,
      sourcePartition,
      sourcePosition,
      sourceToken,
      predecessorToken,
      duplicateKey,
      payload.dataRequestId,
      JSON.stringify({
        ...input.evidence,
        recovery_payload_sha256: payloadHash,
        exact_callback_byte_parity_verified: true,
        provider_sequence_present: false,
        replay_guard_role: 'pre_auth_short_ttl_only',
        automatic_resume_authorized: false,
      }),
    );
  } else {
    receipts = await tx.$queryRawUnsafe(
      `INSERT INTO abdm_webhook_events
         (tenant_id, external_event_id, event_type, source,
          signature_verified, payload, status, environment, metadata,
          receipt_source, callback_path, provider_identity_kind,
          provider_identity_value, raw_body_ciphertext, raw_body_sha256,
          raw_body_bytes, auth_binding_sha256, authenticated_at,
          recovery_inbox_id, recovery_interface_family, recovery_owner_uid,
          recovery_owner_reason, recovery_disposition, source_partition,
          source_position, source_token, predecessor_token, duplicate_key)
       VALUES
         ($1::uuid, $2::text, $3::text, 'abdm_owner_recovery', TRUE,
          $4::jsonb, 'recovery_pending', $5::text, $6::jsonb,
          'owner_reconciled_callback', $7::text, $8::text, $2::text,
          $9::text, $10::char(64), $11::integer, $12::char(64),
          $13::timestamptz, $14::uuid, 'I16', $15::uuid, $16::text,
          $17::text, $18::text, $19::bigint, $20::text, $21::text,
          $22::text)
       RETURNING id::text, external_event_id, event_type, status, environment,
                 receipt_source, callback_path, provider_identity_kind,
                 provider_identity_value, raw_body_sha256::text,
                 raw_body_bytes, recovery_inbox_id::text,
                 recovery_disposition, related_data_request_id, created_at`,
      tid,
      payload.providerTransactionId,
      payload.eventType,
      JSON.stringify(payload.callbackBody),
      payload.environment,
      JSON.stringify({
        ...input.evidence,
        recovery_payload_sha256: payloadHash,
        exact_callback_byte_parity_verified: true,
        provider_sequence_present: false,
        replay_guard_role: 'pre_auth_short_ttl_only',
        automatic_resume_authorized: false,
      }),
      payload.callbackPath,
      payload.providerIdentityKind,
      encryptField(payload.rawBody.toString('base64'), { tenantId: tid }),
      payload.rawBodySha256,
      payload.rawBody.length,
      payload.authBindingSha256,
      payload.authenticatedAt,
      inboxId,
      actorUid,
      ownerReason,
      ownerDisposition,
      sourcePartition,
      sourcePosition,
      sourceToken,
      predecessorToken,
      duplicateKey,
    );
  }
  const receipt = receipts[0];
  if (!receipt) refuse('I16 callback receipt recovery claim was lost');

  const task = await createTask({
    tenantId: tid,
    taskKind: 'review',
    title: payload.recoveryKind === 'stranded_processing'
      ? 'Review stranded ABDM data request'
      : 'Review late ABDM callback',
    description: payload.recoveryKind === 'stranded_processing'
      ? 'The PROCESSING request was frozen for owner disposition. No collection, encryption, send, or automatic resume was started.'
      : 'The authenticated late callback bytes were retained as pending evidence. No consent or transfer mutation was performed.',
    relatedResourceType: payload.recoveryKind === 'stranded_processing'
      ? 'abdm_data_request'
      : 'abdm_webhook_event',
    relatedResourceId: payload.recoveryKind === 'stranded_processing'
      ? String(payload.dataRequestId)
      : String(receipt.id),
    priority: 'high',
    assignedToRole: 'TENANT_ADMIN',
    createdBy: actorUid,
    slaCompletionSemantics: 'none',
    tx,
    metadata: {
      contract: 'late_pending_only',
      interface_family: 'I16',
      recovery_inbox_id: inboxId,
      webhook_event_id: receipt.id,
      data_request_id: payload.dataRequestId,
      provider_identity_kind: payload.providerIdentityKind,
      provider_transaction_id: payload.providerTransactionId,
      owner_disposition: ownerDisposition,
      provider_sequence_present: false,
      replay_guard_role: 'pre_auth_short_ttl_only',
      exact_callback_byte_parity_verified: true,
      automatic_resume_authorized: false,
      target_domain_effect_performed: false,
    },
  });

  return Object.freeze({
    receipt: Object.freeze({ ...receipt, id: receipt.id }),
    request: requestRow ? Object.freeze(requestRow) : null,
    task,
    outcomeCode: payload.recoveryKind === 'stranded_processing'
      ? 'i16_stranded_processing_pending_owner_disposition'
      : 'i16_late_callback_pending_owner_review',
    recoveryCursorAction: 'pause',
  });
}

export default Object.freeze({
  recordAuthenticatedAbdmCallback,
  markAuthenticatedAbdmCallback,
  parseI16AbdmRecoveryPayload,
  persistLateAbdmRecovery,
});

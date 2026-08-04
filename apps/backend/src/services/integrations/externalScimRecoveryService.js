import { createHash } from 'node:crypto';

import { deactivateScimIdentityTx } from '../auth/scimProvisioningService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask } from '../workflow/taskService.js';
import { AppError } from '../../utils/AppError.js';
import { encryptField } from '../../utils/fieldEncryption.js';
import { requireExternalRecoveryCapability } from './externalRecoveryEffectGate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PROVIDER_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,78}[a-z0-9]$/;
const COMMAND_KINDS = new Set([
  'deactivate',
  'delete',
  'enable',
  'reactivate',
  'role_change',
  'profile_update',
]);
const REVOCATION_KINDS = new Set(['deactivate', 'delete']);
const METHODS = new Set(['PATCH', 'PUT', 'DELETE']);
const PAYLOAD_KEYS = new Set([
  'schema',
  'provider_id',
  'provider_key',
  'direction',
  'realm',
  'command_kind',
  'method',
  'resource_uid',
  'external_id',
  'auth_binding_sha256',
  'authenticated_at',
  'occurred_at',
  'scim_body_base64',
  'scim_body_sha256',
]);
const COMMAND_KEYS = new Set([
  'raw_payload',
  'payload_sha256',
  'actor_uid',
  'owner_reason',
  'evidence',
]);

function refuse(message, code = 'I13_SCIM_RECOVERY_REFUSED', details = undefined) {
  throw AppError.conflict(message, code, details);
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function decodeCanonicalBase64(value) {
  const text = String(value ?? '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    refuse('scim_body_base64 must be canonical base64');
  }
  const decoded = Buffer.from(text, 'base64');
  if (decoded.toString('base64') !== text) refuse('scim_body_base64 must be canonical base64');
  return decoded;
}

export function parseI13ScimRecoveryPayload(value) {
  let payload;
  try {
    payload = JSON.parse(String(value ?? ''));
  } catch {
    refuse('I13 SCIM recovery payload is invalid JSON', 'I13_SCIM_PAYLOAD_INVALID');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    refuse('I13 SCIM recovery payload must be an object', 'I13_SCIM_PAYLOAD_INVALID');
  }
  const keys = Object.keys(payload);
  if (keys.length !== PAYLOAD_KEYS.size || keys.some(key => !PAYLOAD_KEYS.has(key))) {
    refuse('I13 SCIM recovery payload fields do not match the registered schema', 'I13_SCIM_PAYLOAD_INVALID');
  }
  if (payload.schema !== 'vhhealth.i13.scim-owner-list-diff/v1') {
    refuse('I13 SCIM recovery payload schema is not registered', 'I13_SCIM_PAYLOAD_INVALID');
  }
  const providerId = String(payload.provider_id || '').trim();
  if (!/^[1-9][0-9]*$/.test(providerId)) refuse('provider_id is invalid', 'I13_SCIM_PAYLOAD_INVALID');
  const providerKey = String(payload.provider_key || '').trim().toLowerCase();
  if (!PROVIDER_KEY_RE.test(providerKey)) refuse('provider_key is invalid', 'I13_SCIM_PAYLOAD_INVALID');
  if (payload.direction !== 'inbound') refuse('I13 direction must be inbound', 'I13_SCIM_PAYLOAD_INVALID');
  const realm = String(payload.realm || '').trim().toLowerCase();
  if (!['staff', 'admin'].includes(realm)) refuse('I13 realm is invalid', 'I13_SCIM_PAYLOAD_INVALID');
  const commandKind = String(payload.command_kind || '').trim().toLowerCase();
  if (!COMMAND_KINDS.has(commandKind)) refuse('I13 command_kind is invalid', 'I13_SCIM_PAYLOAD_INVALID');
  const method = String(payload.method || '').trim().toUpperCase();
  if (!METHODS.has(method)) refuse('I13 method is invalid', 'I13_SCIM_PAYLOAD_INVALID');
  if (commandKind === 'delete' && method !== 'DELETE') {
    refuse('I13 delete requires DELETE', 'I13_SCIM_PAYLOAD_INVALID');
  }
  if (commandKind !== 'delete' && method === 'DELETE') {
    refuse('I13 DELETE is reserved for delete commands', 'I13_SCIM_PAYLOAD_INVALID');
  }
  const body = decodeCanonicalBase64(payload.scim_body_base64);
  const bodyHash = requireSha256(payload.scim_body_sha256, 'scim_body_sha256');
  if (sha256(body) !== bodyHash) refuse('I13 SCIM body hash does not match exact bytes', 'I13_SCIM_PAYLOAD_INVALID');
  const externalId = payload.external_id === null
    ? null
    : requireText(payload.external_id, 'external_id', 255);
  return Object.freeze({
    schema: payload.schema,
    providerId,
    providerKey,
    direction: 'inbound',
    realm,
    commandKind,
    method,
    resourceUid: requireUuid(payload.resource_uid, 'resource_uid'),
    externalId,
    authBindingSha256: requireSha256(payload.auth_binding_sha256, 'auth_binding_sha256'),
    authenticatedAt: requireTimestamp(payload.authenticated_at, 'authenticated_at'),
    occurredAt: requireTimestamp(payload.occurred_at, 'occurred_at'),
    body,
    bodySha256: bodyHash,
  });
}

function requireClosedCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    refuse('I13 owner reconciliation command must be an object');
  }
  const unexpected = Object.keys(command).filter(key => !COMMAND_KEYS.has(key));
  if (unexpected.length) refuse('I13 owner reconciliation command contains unknown fields', undefined, { unexpected });
  if (!command.evidence || typeof command.evidence !== 'object'
      || Array.isArray(command.evidence) || Object.keys(command.evidence).length === 0) {
    refuse('I13 owner evidence must be a non-empty object');
  }
  return command;
}

async function loadBoundIdentity(tx, tenantId, payload) {
  const providers = await tx.$queryRawUnsafe(
    `SELECT id::text, provider_key, realm, scim_bearer_token_hash
       FROM tenant_identity_providers
      WHERE tenant_id = $1::uuid AND id = $2::bigint
        AND provider_key = $3::text AND realm = $4::text
        AND status = 'active' AND scim_enabled = true
        AND scim_bearer_token_hash = $5::char(64)
      FOR UPDATE`,
    tenantId,
    payload.providerId,
    payload.providerKey,
    payload.realm,
    payload.authBindingSha256,
  );
  if (providers.length !== 1) {
    refuse('I13 provider authentication binding is stale or invalid', 'I13_SCIM_PROVIDER_BINDING_INVALID');
  }
  if (payload.realm === 'staff') {
    const rows = await tx.$queryRawUnsafe(
      `SELECT u.uid::text, u.is_active, u.status, u.is_break_glass_account,
              u.scim_external_id, s.id AS staff_id, s.is_active AS staff_is_active,
              s.archived, s.scim_external_id AS staff_external_id
         FROM users AS u
         JOIN staff AS s ON s.tenant_id = u.tenant_id AND s.user_id = u.uid
        WHERE u.tenant_id = $1::uuid AND u.uid = $2::uuid
          AND u.scim_provider_id = $3::bigint
          AND s.scim_provider_id = $3::bigint
        FOR UPDATE OF u, s`,
      tenantId,
      payload.resourceUid,
      payload.providerId,
    );
    if (rows.length !== 1) refuse('I13 staff identity is not bound to the provider', 'I13_SCIM_IDENTITY_BINDING_INVALID');
    return rows[0];
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid::text, is_active, status, is_break_glass_account,
            scim_external_id, NULL::integer AS staff_id
       FROM admins
      WHERE tenant_id = $1::uuid AND uid = $2::uuid
        AND scim_provider_id = $3::bigint
      FOR UPDATE`,
    tenantId,
    payload.resourceUid,
    payload.providerId,
  );
  if (rows.length !== 1) refuse('I13 admin identity is not bound to the provider', 'I13_SCIM_IDENTITY_BINDING_INVALID');
  return rows[0];
}

export async function persistLateScimRecovery({
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
    throw AppError.internal('I13 recovery requires the canonical recovery transaction', 'I13_RECOVERY_TX_REQUIRED');
  }
  const tid = requireTenantId(tenantId);
  const inboxId = requireUuid(recoveryInboxId, 'recovery_inbox_id');
  requireExternalRecoveryCapability(capability, {
    tenantId: tid,
    facilityId: null,
    interfaceFamily: 'I13',
    effectDisposition: 'late_pending_only',
  });
  if (capability.inboxId !== inboxId) refuse('I13 recovery capability inbox does not match');

  const input = requireClosedCommand(command);
  const rawPayload = String(input.raw_payload || '');
  if (!rawPayload) refuse('raw_payload is required');
  const payloadHash = sha256(Buffer.from(rawPayload, 'utf8'));
  if (input.payload_sha256 !== payloadHash) refuse('I13 raw payload hash does not match exact bytes');
  const payload = parseI13ScimRecoveryPayload(rawPayload);
  const sourceOccurrence = requireTimestamp(occurredAt, 'occurred_at');
  if (payload.occurredAt !== sourceOccurrence) refuse('I13 occurred_at does not match durable source occurrence');
  const actorUid = requireUuid(input.actor_uid, 'actor_uid');
  const ownerReason = requireText(input.owner_reason, 'owner_reason', 500);
  const expectedPartition = `scim-provider:${payload.providerId}:inbound`;
  const expectedDuplicate = `i13:${payload.providerId}:${payload.method}:${payload.resourceUid}:${payloadHash}`;
  if (sourcePartition !== expectedPartition) refuse('I13 source partition does not match provider and direction');
  if (duplicateKey !== expectedDuplicate) refuse('I13 duplicate key does not match the exact command payload');

  const identity = await loadBoundIdentity(tx, tid, payload);
  const externalIds = [identity.scim_external_id, identity.staff_external_id].filter(Boolean);
  if (payload.externalId && !externalIds.includes(payload.externalId)) {
    refuse('I13 external identity does not match the provider-bound local identity', 'I13_SCIM_IDENTITY_BINDING_INVALID');
  }

  let accessShutdown = null;
  let executionDisposition = 'pending_review_no_mutation';
  if (REVOCATION_KINDS.has(payload.commandKind)) {
    accessShutdown = await deactivateScimIdentityTx(tx, {
      tenantId: tid,
      uid: payload.resourceUid,
      staffId: identity.staff_id,
      realm: payload.realm,
      breakGlass: identity.is_break_glass_account === true,
      reason: 'Late SCIM revocation under countersigned C-D15',
    });
    executionDisposition = accessShutdown.excluded_break_glass
      ? 'break_glass_excluded_pending_review'
      : 'revocation_executed_pending_review';
  }

  const receipts = await tx.$queryRawUnsafe(
    `INSERT INTO scim_provisioning_commands
       (tenant_id, provider_id, provider_key, direction, realm, command_source,
        command_kind, http_method, target_uid, external_id, authenticated_at,
        auth_binding_sha256, body_ciphertext, body_sha256, body_bytes,
        payload_ciphertext, payload_sha256, payload_bytes, occurred_at,
        source_partition, source_position, source_token, predecessor_token,
        duplicate_key, recovery_inbox_id, recovery_interface_family,
        owner_actor_uid, owner_reason, effect_disposition,
        execution_disposition, access_shutdown_evidence, evidence)
     VALUES
       ($1::uuid, $2::bigint, $3::text, 'inbound', $4::text,
        'owner_reconciled_list_diff', $5::text, $6::text, $7::uuid,
        $8::text, $9::timestamptz, $10::char(64), $11::text,
        $12::char(64), $13::integer, $14::text, $15::char(64),
        $16::integer, $17::timestamptz, $18::text, $19::bigint,
        $20::text, $21::text, $22::text, $23::uuid, 'I13',
        $24::uuid, $25::text, 'late_pending_only', $26::text,
        $27::jsonb, $28::jsonb)
     RETURNING id::text, provider_id::text, provider_key, direction, realm,
               command_kind, http_method, target_uid::text, external_id,
               body_sha256::text, body_bytes, payload_sha256::text,
               payload_bytes, occurred_at, execution_disposition,
               recovery_inbox_id::text, created_at`,
    tid,
    payload.providerId,
    payload.providerKey,
    payload.realm,
    payload.commandKind,
    payload.method,
    payload.resourceUid,
    payload.externalId,
    payload.authenticatedAt,
    payload.authBindingSha256,
    encryptField(payload.body.toString('base64'), { tenantId: tid }),
    payload.bodySha256,
    payload.body.length,
    encryptField(rawPayload, { tenantId: tid }),
    payloadHash,
    Buffer.byteLength(rawPayload, 'utf8'),
    payload.occurredAt,
    sourcePartition,
    sourcePosition,
    sourceToken,
    predecessorToken,
    duplicateKey,
    inboxId,
    actorUid,
    ownerReason,
    executionDisposition,
    JSON.stringify(accessShutdown || {}),
    JSON.stringify({
      ...input.evidence,
      payload_schema: payload.schema,
      exact_payload_byte_parity_verified: true,
      exact_scim_body_byte_parity_verified: true,
      provider_sequence_present: false,
      push_replay_authorized: false,
      automatic_access_mutation: executionDisposition === 'revocation_executed_pending_review',
      c_d15_revocation_exception_applied: executionDisposition === 'revocation_executed_pending_review',
    }),
  );

  const task = await createTask({
    tenantId: tid,
    taskKind: 'review',
    title: `Review late SCIM ${payload.commandKind}`,
    description: executionDisposition === 'revocation_executed_pending_review'
      ? 'Access was shut off immediately under C-D15. Confirm the late provider command after the fact; no reactivation is authorized.'
      : 'The late identity command was retained for owner review without an automatic access mutation.',
    relatedResourceType: payload.realm === 'staff' ? 'staff_identity' : 'admin_identity',
    relatedResourceId: payload.resourceUid,
    priority: 'high',
    assignedToRole: 'TENANT_ADMIN',
    createdBy: actorUid,
    slaCompletionSemantics: 'none',
    tx,
    metadata: {
      contract: 'late_pending_only',
      countersigned_exception: 'C-D15',
      interface_family: 'I13',
      recovery_inbox_id: inboxId,
      scim_command_id: receipts[0].id,
      provider_id: payload.providerId,
      provider_key: payload.providerKey,
      command_kind: payload.commandKind,
      execution_disposition: executionDisposition,
      provider_sequence_present: false,
      push_replay_authorized: false,
      automatic_access_mutation: executionDisposition === 'revocation_executed_pending_review',
    },
  });

  return Object.freeze({
    receipt: Object.freeze({ ...receipts[0], id: receipts[0].id }),
    task,
    outcomeCode: executionDisposition === 'revocation_executed_pending_review'
      ? 'i13_revocation_executed_pending_identity_review'
      : executionDisposition === 'break_glass_excluded_pending_review'
        ? 'i13_break_glass_pending_identity_review'
        : 'i13_command_pending_identity_review',
    recoveryCursorAction: 'pause',
  });
}

export default Object.freeze({
  parseI13ScimRecoveryPayload,
  persistLateScimRecovery,
});

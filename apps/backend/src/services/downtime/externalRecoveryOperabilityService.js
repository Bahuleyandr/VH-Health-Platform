import { createHash } from 'node:crypto';

import { resolveExternalInterfaceDisposition } from '../../config/externalInterfaceRecoveryCatalog.js';
import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { isValidIdempotencyKey } from '../idempotency/idempotencyService.js';
import { recordClinicalAuditEvent } from '../clinical/canonicalClinicalPlatformService.js';
import {
  authorizeExternalRecoveryResume,
  registerExternalRecoveryOffset
} from '../integrations/externalInterfaceRecoveryService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { EXTERNAL_RECOVERY_OPERABILITY_SCHEMA } from '../../validators/externalRecoveryOperabilitySchemas.js';

const ACTION_VERSION = 1;
const BINDING_VERSION = 1;
const SERIALIZABLE_ATTEMPTS = 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);
const RECOVERY_STATES = new Set([
  'paused',
  'replaying',
  'ready',
  'retired',
  'reconciliation_required_missing_marker',
  'reconciliation_required_source_gap',
  'reconciliation_required_retention_gap',
  'reconciliation_required_provider_state'
]);

function sqlState(error) {
  return (
    error?.meta?.code ||
    error?.meta?.driverAdapterError?.cause?.originalCode ||
    error?.cause?.code ||
    error?.code
  );
}

function isRetryableCommandConflict(error) {
  return ['23505', '40001', 'P2002', 'P2034'].includes(sqlState(error));
}

async function runSerializableCommand(tenantId, command) {
  for (let attempt = 1; attempt <= SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await setTenantTx(tenantId, command, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (attempt < SERIALIZABLE_ATTEMPTS && isRetryableCommandConflict(error)) continue;
      throw error;
    }
  }
  throw new Error('External-recovery serializable command retry exhausted');
}

function normalizedRole(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function boundHash(values) {
  const hash = createHash('sha256');
  for (const value of values) {
    if (value === null || value === undefined) {
      hash.update('N;', 'utf8');
      continue;
    }
    const text = String(value);
    hash.update(`V${Buffer.byteLength(text, 'utf8')}:`, 'utf8');
    hash.update(text, 'utf8');
    hash.update(';', 'utf8');
  }
  return hash.digest('hex');
}

function externalRecoveryStateFingerprint(state) {
  return boundHash([
    state.tenant_id,
    state.offset_id,
    state.facility_scope,
    state.facility_id,
    state.interface_family,
    state.direction,
    state.source_partition,
    state.generation,
    state.high_water_position,
    state.high_water_token,
    state.retained_from_position,
    state.retained_from_token,
    state.resume_cutoff_position,
    state.resume_cutoff_token,
    state.recovery_state,
    state.reconciliation_reason,
    state.policy_version,
    state.retention_policy,
    state.retention_until,
    state.intake_retired_at
  ]);
}

function registerEffectHash(effect) {
  return boundHash([
    effect.action,
    effect.action_version,
    effect.binding_version,
    effect.schema_id,
    effect.schema_version,
    effect.tenant_id,
    effect.facility_scope,
    effect.facility_id,
    effect.interface_family,
    effect.subpath,
    effect.protocol,
    effect.direction,
    effect.source_partition,
    effect.generation,
    effect.initial_position,
    effect.initial_token,
    effect.retained_from_position,
    effect.retained_from_token,
    effect.policy_version,
    effect.policy_signature_sha256,
    effect.retention_policy,
    effect.retention_until,
    effect.owner_evidence_reference,
    effect.owner_evidence_signature_sha256
  ]);
}

function registerCommandFingerprint({ effectIdentity, actor, parsed, nextState }) {
  return boundHash([
    effectIdentity,
    actor.uid,
    actor.role,
    parsed.reasonCode,
    parsed.reasonDetail,
    'POST',
    '/api/v1/admin/continuity/external-recovery/offsets',
    null,
    nextState.recovery_state,
    nextState.reconciliation_reason
  ]);
}

function resumeEffectHash(effect) {
  return boundHash([
    effect.action,
    effect.action_version,
    effect.binding_version,
    effect.schema_id,
    effect.schema_version,
    effect.tenant_id,
    effect.offset_id,
    effect.facility_scope,
    effect.facility_id,
    effect.interface_family,
    effect.direction,
    effect.source_partition,
    effect.generation,
    effect.expected_state_fingerprint,
    effect.resume_cutoff_position,
    effect.resume_cutoff_token,
    effect.owner_evidence_reference,
    effect.owner_evidence_signature_sha256
  ]);
}

function resumeCommandFingerprint({ effectIdentity, actor, parsed, offsetId,
  priorStateFingerprint, nextStateFingerprint }) {
  return boundHash([
    effectIdentity,
    actor.uid,
    actor.role,
    parsed.reasonCode,
    parsed.reasonDetail,
    'POST',
    `/api/v1/admin/continuity/external-recovery/offsets/${offsetId}/resume-authorizations`,
    priorStateFingerprint,
    nextStateFingerprint
  ]);
}

function requiredUuid(value, label) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw AppError.badRequest(
      `${label} must be a UUID`,
      'EXTERNAL_RECOVERY_OPERABILITY_INPUT_INVALID'
    );
  }
  return normalized;
}

function idempotencyIdentity(value) {
  const normalized = String(value || '').trim();
  if (!isValidIdempotencyKey(normalized)) {
    throw AppError.badRequest(
      'A valid Idempotency-Key is required',
      'EXTERNAL_RECOVERY_OPERABILITY_IDEMPOTENCY_KEY_REQUIRED',
      { safe: true }
    );
  }
  return {
    raw: normalized,
    sha256: createHash('sha256').update(normalized, 'utf8').digest('hex')
  };
}

function deterministicUuid(value) {
  const chars = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deriveConfig(parsed) {
  let config;
  try {
    config = resolveExternalInterfaceDisposition({
      interfaceFamily: parsed.interfaceFamily,
      subpath: parsed.subpath
    });
  } catch (error) {
    throw AppError.badRequest(error.message, 'EXTERNAL_RECOVERY_OPERABILITY_CLASS_UNSUPPORTED', {
      safe: true
    });
  }
  const disposition = config.selectedDisposition || config.disposition;
  if (!config.implemented || disposition !== 'hwm_required') {
    throw AppError.conflict(
      `${config.id} is not an implemented HWM recovery class`,
      'EXTERNAL_RECOVERY_OPERABILITY_CLASS_UNSUPPORTED',
      { safe: true }
    );
  }
  let direction = config.direction;
  if (config.id === 'I05') {
    if (!config.implementedProtocols?.includes(parsed.protocol)) {
      throw AppError.conflict(
        'I05 protocol is not implemented',
        'EXTERNAL_RECOVERY_OPERABILITY_CLASS_UNSUPPORTED',
        { safe: true }
      );
    }
    if (!config.directions?.includes(parsed.streamDirection)) {
      throw AppError.badRequest(
        'I05 stream_direction must be inbound or outbound',
        'EXTERNAL_RECOVERY_OPERABILITY_INPUT_INVALID',
        { safe: true }
      );
    }
    direction = parsed.streamDirection;
  } else if (parsed.protocol || parsed.streamDirection) {
    throw AppError.badRequest(
      `${config.id} does not accept protocol or stream_direction`,
      'EXTERNAL_RECOVERY_OPERABILITY_INPUT_INVALID',
      { safe: true }
    );
  }
  if (config.facilityScope === 'facility' && parsed.facilityId == null) {
    throw AppError.badRequest(
      `${config.id} requires facility_id`,
      'EXTERNAL_RECOVERY_OPERABILITY_FACILITY_REQUIRED',
      { safe: true }
    );
  }
  if (config.facilityScope === 'tenant' && parsed.facilityId != null) {
    throw AppError.badRequest(
      `${config.id} is tenant-scoped and forbids facility_id`,
      'EXTERNAL_RECOVERY_OPERABILITY_FACILITY_FORBIDDEN',
      { safe: true }
    );
  }
  return Object.freeze({ ...config, direction });
}

async function loadCurrentAdminTx(tx, { tenantId, actorUid, authenticatedRole }) {
  const uid = requiredUuid(actorUid, 'actor_uid');
  const claimedRole = normalizedRole(authenticatedRole);
  if (!ADMIN_ROLES.has(claimedRole)) {
    throw AppError.forbidden(
      'External-recovery operability requires an administrator',
      'EXTERNAL_RECOVERY_OPERABILITY_FORBIDDEN',
      { safe: true }
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid::text, UPPER(BTRIM(role)) AS role
       FROM users
      WHERE tenant_id = $1::uuid AND uid = $2::uuid
        AND is_active = TRUE AND is_deleted = FALSE AND status = 'active'
      LIMIT 2
      FOR SHARE`,
    tenantId,
    uid
  );
  const role = normalizedRole(rows[0]?.role);
  if (rows.length !== 1 || !ADMIN_ROLES.has(role) || role !== claimedRole) {
    throw AppError.forbidden(
      'Current administrator authority could not be verified',
      'EXTERNAL_RECOVERY_OPERABILITY_FORBIDDEN',
      { safe: true }
    );
  }
  return Object.freeze({ uid, role });
}

async function requiredAudit(tx, input) {
  const row = await recordClinicalAuditEvent(input, { db: tx });
  if (!row) {
    throw AppError.internal(
      'External-recovery operator audit evidence was not recorded',
      'EXTERNAL_RECOVERY_OPERABILITY_AUDIT_REQUIRED'
    );
  }
  return row;
}

function registerIdentity({ tenantId, config, parsed }) {
  return Object.freeze({
    action: 'register_offset',
    action_version: ACTION_VERSION,
    binding_version: BINDING_VERSION,
    schema_id: EXTERNAL_RECOVERY_OPERABILITY_SCHEMA.id,
    schema_version: EXTERNAL_RECOVERY_OPERABILITY_SCHEMA.version,
    tenant_id: tenantId,
    facility_scope: config.facilityScope,
    facility_id: parsed.facilityId,
    interface_family: config.id,
    subpath: config.selectedSubpath || null,
    protocol: config.id === 'I05' ? parsed.protocol : null,
    direction: config.direction,
    source_partition: parsed.sourcePartition,
    generation: parsed.generation,
    initial_position: parsed.initialPosition,
    initial_token: parsed.initialToken,
    retained_from_position: parsed.retainedFromPosition,
    retained_from_token: parsed.retainedFromToken,
    policy_version: parsed.policyVersion,
    policy_signature_sha256: createHash('sha256').update(parsed.policySignature).digest('hex'),
    retention_policy: parsed.retentionPolicy,
    retention_until: parsed.retentionUntil,
    owner_evidence_reference: parsed.ownerEvidence.reference,
    owner_evidence_signature_sha256: createHash('sha256')
      .update(parsed.ownerEvidence.signature)
      .digest('hex')
  });
}

function registerCommand({ effectIdentity, actor, parsed }) {
  const nextState =
    parsed.initialPosition == null
      ? {
          recovery_state: 'reconciliation_required_missing_marker',
          reconciliation_reason: 'marker_absent'
        }
      : { recovery_state: 'paused', reconciliation_reason: null };
  return Object.freeze({
    effect_identity: effectIdentity,
    actor_uid: actor.uid,
    actor_role: actor.role,
    reason_code: parsed.reasonCode,
    reason_detail: parsed.reasonDetail,
    http_method: 'POST',
    http_path: '/api/v1/admin/continuity/external-recovery/offsets',
    prior_state: null,
    next_state: nextState
  });
}

async function loadAppliedRegistrationActionTx(tx, {
  tenantId,
  actionId,
  effectIdentity,
  idempotencyKeySha256
}) {
  return tx.$queryRawUnsafe(
    `SELECT id::text, offset_id::text, actor_uid::text, actor_role,
            facility_scope, facility_id, interface_family, subpath, protocol,
            direction, source_partition, generation,
            initial_position::text, initial_token,
            retained_from_position::text, retained_from_token,
            reason_code, reason_detail, owner_evidence_reference,
            owner_evidence_signature_sha256, policy_version,
            policy_signature_sha256, retention_policy, retention_until::text,
            effect_identity, command_fingerprint, receipt
       FROM external_recovery_operability_actions
      WHERE tenant_id = $1::uuid
        AND action = 'register_offset'
        AND outcome = 'applied'
        AND (
          id = $2::uuid
          OR effect_identity = $3::text
          OR idempotency_key_sha256 = $4::text
        )
      ORDER BY recorded_at
      LIMIT 2
      FOR SHARE`,
    tenantId,
    actionId,
    effectIdentity,
    idempotencyKeySha256
  );
}

function exactRegistrationReceipt(rows, {
  actor,
  config,
  parsed,
  actionId,
  effectIdentity,
  commandFingerprint
}) {
  if (rows.length === 0) return null;
  const expected = {
    action_id: actionId,
    actor_uid: actor.uid,
    actor_role: actor.role,
    facility_scope: config.facilityScope,
    facility_id: parsed.facilityId,
    interface_family: config.id,
    subpath: config.selectedSubpath || null,
    protocol: config.id === 'I05' ? parsed.protocol : null,
    direction: config.direction,
    source_partition: parsed.sourcePartition,
    generation: parsed.generation,
    initial_position: parsed.initialPosition,
    initial_token: parsed.initialToken,
    retained_from_position: parsed.retainedFromPosition,
    retained_from_token: parsed.retainedFromToken,
    reason_code: parsed.reasonCode,
    reason_detail: parsed.reasonDetail,
    owner_evidence_reference: parsed.ownerEvidence.reference,
    owner_evidence_signature_sha256: createHash('sha256')
      .update(parsed.ownerEvidence.signature)
      .digest('hex'),
    policy_version: parsed.policyVersion,
    policy_signature_sha256: createHash('sha256')
      .update(parsed.policySignature)
      .digest('hex'),
    retention_policy: parsed.retentionPolicy,
    retention_until: parsed.retentionUntil,
    effect_identity: effectIdentity,
    command_fingerprint: commandFingerprint
  };
  const row = rows[0];
  const exact = rows.length === 1 && Object.entries(expected).every(([key, value]) => {
    if (key === 'action_id') return row.id === value;
    if (key === 'facility_id' || key === 'generation') {
      return (row[key] == null ? null : Number(row[key])) === value;
    }
    if (key === 'retention_until') {
      return new Date(row[key]).toISOString() === value;
    }
    return row[key] === value;
  });
  if (!exact) {
    throw AppError.conflict(
      'External-recovery registration identity drifted',
      'EXTERNAL_RECOVERY_OPERABILITY_IDEMPOTENCY_DRIFT',
      { safe: true }
    );
  }
  return Object.freeze({ ...row.receipt, disposition: 'exact_duplicate' });
}

function offsetSafeState(row) {
  return Object.freeze({
    tenant_id: row.tenant_id,
    offset_id: row.offset_id,
    facility_scope: row.facility_scope,
    facility_id: row.facility_id == null ? null : Number(row.facility_id),
    interface_family: row.interface_family,
    direction: row.direction,
    source_partition: row.source_partition,
    generation: Number(row.generation),
    high_water_position: row.high_water_position,
    high_water_token: row.high_water_token,
    retained_from_position: row.retained_from_position,
    retained_from_token: row.retained_from_token,
    resume_cutoff_position: row.resume_cutoff_position,
    resume_cutoff_token: row.resume_cutoff_token,
    recovery_state: row.recovery_state,
    reconciliation_reason: row.reconciliation_reason,
    policy_version: row.policy_version,
    retention_policy: row.retention_policy,
    retention_until: row.retention_until,
    intake_retired_at: row.intake_retired_at
  });
}

async function recordRefusal({ tenantId, actorUid, actorRole, action, requestId, error }) {
  if (!UUID_PATTERN.test(String(tenantId || '')) || !UUID_PATTERN.test(String(actorUid || '')))
    return;
  if (!ADMIN_ROLES.has(normalizedRole(actorRole))) return;
  try {
    await setTenantTx(tenantId, async tx => {
      const actor = await loadCurrentAdminTx(tx, {
        tenantId,
        actorUid,
        authenticatedRole: actorRole
      });
      await tx.$queryRawUnsafe(
        `SELECT public.external_recovery_operability_record_refusal($1::jsonb) AS receipt`,
        JSON.stringify({
          action,
          actor_uid: actor.uid,
          actor_role: actor.role,
          request_id: requestId || null,
          outcome:
            error?.code === 'EXTERNAL_RECOVERY_OPERABILITY_FORBIDDEN'
              ? 'refused_scope'
              : error?.code?.includes('DRIFT') || error?.code?.includes('STALE')
                ? 'refused_drift'
                : error?.code?.includes('POLICY') || error?.code?.includes('EVIDENCE')
                  ? 'refused_policy'
                  : 'refused_stale',
          refusal_code: String(error?.code || 'EXTERNAL_RECOVERY_OPERABILITY_REFUSED').slice(0, 120)
        })
      );
    });
  } catch (refusalError) {
    logger.warn('external recovery refusal evidence could not be appended', {
      code: refusalError?.code,
      action,
      requestId
    });
  }
}

async function loadAppliedResumeActionTx(tx, {
  tenantId,
  offsetId,
  idempotencyKeySha256,
  expectedStateFingerprint
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id::text, offset_id::text, actor_uid::text, actor_role,
            idempotency_key_sha256, expected_state_fingerprint,
            resume_cutoff_position::text, resume_cutoff_token,
            reason_code, reason_detail, owner_evidence_reference,
            owner_evidence_signature_sha256, receipt
       FROM external_recovery_operability_actions
      WHERE tenant_id = $1::uuid
        AND action = 'authorize_resume'
        AND outcome = 'applied'
        AND (
          idempotency_key_sha256 = $3::text
          OR (
            offset_id = $2::uuid
            AND expected_state_fingerprint = $4::text
          )
        )
      ORDER BY recorded_at
      LIMIT 2
      FOR SHARE`,
    tenantId,
    offsetId,
    idempotencyKeySha256,
    expectedStateFingerprint
  );
  return rows;
}

function exactResumeReceipt(rows, {
  actor,
  offsetId,
  parsed
}) {
  if (rows.length === 0) return null;
  const ownerSignatureSha256 = createHash('sha256')
    .update(parsed.ownerEvidence.signature)
    .digest('hex');
  const exact = rows.length === 1 &&
    rows[0].offset_id === offsetId &&
    rows[0].actor_uid === actor.uid &&
    normalizedRole(rows[0].actor_role) === actor.role &&
    rows[0].expected_state_fingerprint === parsed.expectedStateFingerprint &&
    rows[0].resume_cutoff_position === parsed.resumeCutoffPosition &&
    rows[0].resume_cutoff_token === parsed.resumeCutoffToken &&
    rows[0].reason_code === parsed.reasonCode &&
    rows[0].reason_detail === parsed.reasonDetail &&
    rows[0].owner_evidence_reference === parsed.ownerEvidence.reference &&
    rows[0].owner_evidence_signature_sha256 === ownerSignatureSha256;
  if (!exact) {
    throw AppError.conflict(
      'External-recovery resume identity drifted',
      'EXTERNAL_RECOVERY_OPERABILITY_IDEMPOTENCY_DRIFT',
      { safe: true }
    );
  }
  return Object.freeze({ ...rows[0].receipt, disposition: 'exact_duplicate' });
}

export async function registerExternalRecoveryOperabilityOffset({
  tenantId,
  actorUid,
  actorRole,
  requestId = null,
  idempotencyKey,
  parsed
} = {}) {
  const tid = requireTenantId(tenantId);
  const requestIdentity = idempotencyIdentity(idempotencyKey);
  try {
    return await runSerializableCommand(
      tid,
      async tx => {
        const actor = await loadCurrentAdminTx(tx, {
          tenantId: tid,
          actorUid,
          authenticatedRole: actorRole
        });
        const config = deriveConfig(parsed);
        const effect = registerIdentity({ tenantId: tid, config, parsed });
        const effectHash = registerEffectHash(effect);
        const offsetId = deterministicUuid(`external-recovery-offset:${effectHash}`);
        const actionId = deterministicUuid(`external-recovery-action:${effectHash}`);
        const command = registerCommand({
          effectIdentity: effectHash,
          actor,
          parsed
        });
        const commandFingerprint = registerCommandFingerprint({
          effectIdentity: effectHash,
          actor,
          parsed,
          nextState: command.next_state
        });
        const appliedRows = await loadAppliedRegistrationActionTx(tx, {
          tenantId: tid,
          actionId,
          effectIdentity: effectHash,
          idempotencyKeySha256: requestIdentity.sha256
        });
        const priorReceipt = exactRegistrationReceipt(appliedRows, {
          actor,
          config,
          parsed,
          actionId,
          effectIdentity: effectHash,
          commandFingerprint
        });
        if (priorReceipt) return priorReceipt;
        const audit = await requiredAudit(tx, {
          tenantId: tid,
          action: 'external_recovery.offset.register',
          actorUid: actor.uid,
          actorRole: actor.role,
          resourceType: 'external_recovery_operability_action',
          resourceTable: 'external_recovery_operability_actions',
          resourceId: actionId,
          requestId,
          afterState: {
            action_id: actionId,
            effect_identity: effectHash,
            command_fingerprint: commandFingerprint,
            offset_id: offsetId,
            network_or_worker_effect: false
          },
          idempotencyKey: `external-recovery-register:${effectHash}`
        });
        return registerExternalRecoveryOffset({
          tenantId: tid,
          facilityId: parsed.facilityId,
          interfaceFamily: config.id,
          subpath: config.selectedSubpath || null,
          protocol: config.id === 'I05' ? parsed.protocol : null,
          streamDirection: config.id === 'I05' ? config.direction : null,
          sourcePartition: parsed.sourcePartition,
          generation: parsed.generation,
          initialPosition: parsed.initialPosition,
          initialToken: parsed.initialToken,
          retainedFromPosition: parsed.retainedFromPosition,
          retainedFromToken: parsed.retainedFromToken,
          policyVersion: parsed.policyVersion,
          policySignature: parsed.policySignature,
          retentionPolicy: parsed.retentionPolicy,
          retentionUntil: parsed.retentionUntil,
          tx,
          operabilityCommand: {
            ...effect,
            action_id: actionId,
            offset_id: offsetId,
            command_class:
              parsed.initialPosition == null
                ? 'register_marker_absent_offset'
                : 'register_paused_offset',
            effect_identity: effectHash,
            command_fingerprint: commandFingerprint,
            idempotency_key_sha256: requestIdentity.sha256,
            request_id: requestId || null,
            actor_uid: actor.uid,
            actor_role: actor.role,
            reason_code: parsed.reasonCode,
            reason_detail: parsed.reasonDetail,
            owner_evidence_reference: parsed.ownerEvidence.reference,
            owner_evidence_signature: parsed.ownerEvidence.signature,
            policy_signature: parsed.policySignature,
            schema_checksum: EXTERNAL_RECOVERY_OPERABILITY_SCHEMA.checksum,
            audit_event_id: audit.id
          }
        });
      }
    );
  } catch (error) {
    await recordRefusal({
      tenantId: tid,
      actorUid,
      actorRole,
      action: 'register_offset',
      requestId,
      error
    });
    throw error;
  }
}

export async function authorizeExternalRecoveryOperabilityResume({
  tenantId,
  actorUid,
  actorRole,
  requestId = null,
  idempotencyKey,
  offsetId,
  parsed
} = {}) {
  const tid = requireTenantId(tenantId);
  const oid = requiredUuid(offsetId, 'offset_id');
  const requestIdentity = idempotencyIdentity(idempotencyKey);
  try {
    return await runSerializableCommand(
      tid,
      async tx => {
        const actor = await loadCurrentAdminTx(tx, {
          tenantId: tid,
          actorUid,
          authenticatedRole: actorRole
        });
        let appliedRows = await loadAppliedResumeActionTx(tx, {
          tenantId: tid,
          offsetId: oid,
          idempotencyKeySha256: requestIdentity.sha256,
          expectedStateFingerprint: parsed.expectedStateFingerprint
        });
        let priorReceipt = exactResumeReceipt(appliedRows, {
          actor,
          offsetId: oid,
          parsed
        });
        if (priorReceipt) return priorReceipt;
        const rows = await tx.$queryRawUnsafe(
          `SELECT offsets.offset_id::text, offsets.tenant_id::text,
                offsets.facility_scope, offsets.facility_id,
                offsets.interface_family, offsets.direction,
                offsets.source_partition, offsets.generation,
                high_water_position::text, high_water_token,
                retained_from_position::text, retained_from_token,
                resume_cutoff_position::text, resume_cutoff_token,
                recovery_state, reconciliation_reason, policy_version,
                retention_policy, retention_until::text, intake_retired_at::text,
                registration.subpath, registration.protocol
           FROM event_consumer_offsets AS offsets
           LEFT JOIN LATERAL (
             SELECT action.subpath, action.protocol
               FROM external_recovery_operability_actions AS action
              WHERE action.tenant_id = offsets.tenant_id
                AND action.offset_id = offsets.offset_id
                AND action.action = 'register_offset'
                AND action.outcome = 'applied'
              LIMIT 1
           ) AS registration ON TRUE
          WHERE offsets.tenant_id = $1::uuid AND offsets.offset_id = $2::uuid
            AND offsets.scope_kind = 'external_interface'
          FOR UPDATE OF offsets`,
          tid,
          oid
        );
        appliedRows = await loadAppliedResumeActionTx(tx, {
          tenantId: tid,
          offsetId: oid,
          idempotencyKeySha256: requestIdentity.sha256,
          expectedStateFingerprint: parsed.expectedStateFingerprint
        });
        priorReceipt = exactResumeReceipt(appliedRows, {
          actor,
          offsetId: oid,
          parsed
        });
        if (priorReceipt) return priorReceipt;
        if (rows.length !== 1) {
          throw AppError.notFound(
            'External-recovery offset not found',
            'EXTERNAL_RECOVERY_OPERABILITY_OFFSET_NOT_FOUND',
            { safe: true }
          );
        }
        const priorState = offsetSafeState(rows[0]);
        const stateFingerprint = externalRecoveryStateFingerprint(priorState);
        if (stateFingerprint !== parsed.expectedStateFingerprint) {
          throw AppError.conflict(
            'External-recovery offset state changed',
            'EXTERNAL_RECOVERY_OPERABILITY_STATE_DRIFT',
            { safe: true }
          );
        }
        if (
          priorState.recovery_state !== 'paused' ||
          priorState.high_water_position == null ||
          priorState.high_water_token == null ||
          priorState.intake_retired_at != null ||
          BigInt(parsed.resumeCutoffPosition) < BigInt(priorState.high_water_position)
        ) {
          throw AppError.conflict(
            'External-recovery offset is not eligible for exact resume authorization',
            'EXTERNAL_RECOVERY_OPERABILITY_RESUME_NOT_ELIGIBLE',
            { safe: true }
          );
        }
        const effect = Object.freeze({
          action: 'authorize_resume',
          action_version: ACTION_VERSION,
          binding_version: BINDING_VERSION,
          schema_id: EXTERNAL_RECOVERY_OPERABILITY_SCHEMA.id,
          schema_version: EXTERNAL_RECOVERY_OPERABILITY_SCHEMA.version,
          tenant_id: tid,
          offset_id: oid,
          facility_scope: priorState.facility_scope,
          facility_id: priorState.facility_id,
          interface_family: priorState.interface_family,
          direction: priorState.direction,
          source_partition: priorState.source_partition,
          generation: priorState.generation,
          expected_state_fingerprint: stateFingerprint,
          resume_cutoff_position: parsed.resumeCutoffPosition,
          resume_cutoff_token: parsed.resumeCutoffToken,
          owner_evidence_reference: parsed.ownerEvidence.reference,
          owner_evidence_signature_sha256: createHash('sha256')
            .update(parsed.ownerEvidence.signature)
            .digest('hex')
        });
        const effectHash = resumeEffectHash(effect);
        const actionId = deterministicUuid(`external-recovery-action:${effectHash}`);
        const nextState = Object.freeze({
          ...priorState,
          recovery_state: 'replaying',
          reconciliation_reason: null,
          resume_cutoff_position: parsed.resumeCutoffPosition,
          resume_cutoff_token: parsed.resumeCutoffToken
        });
        const commandFingerprint = resumeCommandFingerprint({
          effectIdentity: effectHash,
          actor,
          parsed,
          offsetId: oid,
          priorStateFingerprint: stateFingerprint,
          nextStateFingerprint: externalRecoveryStateFingerprint(nextState)
        });
        const audit = await requiredAudit(tx, {
          tenantId: tid,
          action: 'external_recovery.offset.resume_authorized',
          actorUid: actor.uid,
          actorRole: actor.role,
          resourceType: 'external_recovery_operability_action',
          resourceTable: 'external_recovery_operability_actions',
          resourceId: actionId,
          requestId,
          beforeState: priorState,
          afterState: {
            ...nextState,
            action_id: actionId,
            effect_identity: effectHash,
            command_fingerprint: commandFingerprint,
            worker_started: false,
            cursor_advanced: false
          },
          idempotencyKey: `external-recovery-resume:${effectHash}`
        });
        return authorizeExternalRecoveryResume({
          tenantId: tid,
          offsetId: oid,
          interfaceFamily: priorState.interface_family,
          subpath: rows[0].subpath || null,
          protocol: rows[0].protocol || null,
          streamDirection: priorState.interface_family === 'I05'
            ? priorState.direction
            : null,
          resumeCutoffPosition: parsed.resumeCutoffPosition,
          resumeCutoffToken: parsed.resumeCutoffToken,
          tx,
          operabilityCommand: {
            ...effect,
            action_id: actionId,
            command_class: 'authorize_partition_resume',
            effect_identity: effectHash,
            command_fingerprint: commandFingerprint,
            idempotency_key_sha256: requestIdentity.sha256,
            request_id: requestId || null,
            actor_uid: actor.uid,
            actor_role: actor.role,
            reason_code: parsed.reasonCode,
            reason_detail: parsed.reasonDetail,
            owner_evidence_signature: parsed.ownerEvidence.signature,
            schema_checksum: EXTERNAL_RECOVERY_OPERABILITY_SCHEMA.checksum,
            prior_state: priorState,
            next_state: nextState,
            audit_event_id: audit.id
          }
        });
      }
    );
  } catch (error) {
    await recordRefusal({
      tenantId: tid,
      actorUid,
      actorRole,
      action: 'authorize_resume',
      requestId,
      error
    });
    throw error;
  }
}

function workbenchItem(row) {
  const state = offsetSafeState(row);
  const stateFingerprint = externalRecoveryStateFingerprint(state);
  return Object.freeze({
    ...state,
    state_fingerprint: stateFingerprint,
    command_class:
      row.recovery_state === 'paused'
        ? 'authorize_partition_resume'
        : row.recovery_state === 'reconciliation_required_missing_marker'
          ? 'register_marker_absent_offset'
          : 'none',
    capabilities: {
      can_authorize_resume:
        row.recovery_state === 'paused' &&
        row.high_water_position != null &&
        row.high_water_token != null &&
        row.intake_retired_at == null
    },
    refusal_reasons:
      row.recovery_state === 'paused' ? [] : [`recovery_state_${row.recovery_state}`],
    observations: {
      pending_rows: Number(row.pending_rows || 0),
      oldest_pending_age_seconds: Number(row.oldest_pending_age_seconds || 0),
      dead_rows: Number(row.dead_rows || 0),
      unacknowledged_critical_reviews: Number(row.unacknowledged_critical_reviews || 0),
      oldest_unacknowledged_age_seconds: Number(row.oldest_unacknowledged_age_seconds || 0)
    },
    latest_command_receipt: row.latest_command_receipt || null
  });
}

export async function listExternalRecoveryOperabilityWorkbench({
  tenantId,
  actorUid,
  actorRole,
  filters = {}
} = {}) {
  const tid = requireTenantId(tenantId);
  if (filters.recoveryState && !RECOVERY_STATES.has(filters.recoveryState)) {
    throw AppError.badRequest(
      'recovery_state filter is invalid',
      'EXTERNAL_RECOVERY_OPERABILITY_INPUT_INVALID',
      { safe: true }
    );
  }
  return setTenantTx(tid, async tx => {
    await loadCurrentAdminTx(tx, {
      tenantId: tid,
      actorUid,
      authenticatedRole: actorRole
    });
    const rows = await tx.$queryRawUnsafe(
      `SELECT offsets.offset_id::text, offsets.tenant_id::text,
              offsets.facility_scope, offsets.facility_id,
              offsets.interface_family, offsets.direction,
              offsets.source_partition, offsets.generation,
              offsets.high_water_position::text, offsets.high_water_token,
              offsets.retained_from_position::text, offsets.retained_from_token,
              offsets.resume_cutoff_position::text, offsets.resume_cutoff_token,
              offsets.recovery_state, offsets.reconciliation_reason,
              offsets.policy_version, offsets.retention_policy,
              offsets.retention_until::text, offsets.intake_retired_at::text,
              COALESCE(inbox.pending_rows, 0)::text AS pending_rows,
              COALESCE(inbox.oldest_pending_age_seconds, 0)::text
                AS oldest_pending_age_seconds,
              COALESCE(inbox.dead_rows, 0)::text AS dead_rows,
              COALESCE(critical.unacknowledged_rows, 0)::text
                AS unacknowledged_critical_reviews,
              COALESCE(critical.oldest_unacknowledged_age_seconds, 0)::text
                AS oldest_unacknowledged_age_seconds,
              action.receipt AS latest_command_receipt
         FROM event_consumer_offsets AS offsets
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE inbox.status = 'pending') AS pending_rows,
                  COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(inbox.recorded_at)
                    FILTER (WHERE inbox.status = 'pending')), 0)
                    AS oldest_pending_age_seconds,
                  COUNT(*) FILTER (WHERE inbox.status = 'dead') AS dead_rows
             FROM pathway_projector_inbox AS inbox
            WHERE inbox.tenant_id = offsets.tenant_id
              AND inbox.offset_id = offsets.offset_id
              AND inbox.scope_kind = 'external_interface'
         ) AS inbox ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (
                    WHERE obligation.id IS NOT NULL AND ack.id IS NULL
                  ) AS unacknowledged_rows,
                  COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(obligation.recorded_at)
                    FILTER (WHERE obligation.id IS NOT NULL AND ack.id IS NULL)), 0)
                    AS oldest_unacknowledged_age_seconds
             FROM external_recovery_critical_review_obligations AS obligation
             LEFT JOIN external_recovery_critical_review_acknowledgements AS ack
               ON ack.tenant_id = obligation.tenant_id
              AND ack.obligation_id = obligation.id
            WHERE obligation.tenant_id = offsets.tenant_id
              AND obligation.offset_id = offsets.offset_id
         ) AS critical ON TRUE
         LEFT JOIN LATERAL (
           SELECT jsonb_build_object(
                    'action_id', action.id,
                    'action', action.action,
                    'command_class', action.command_class,
                    'outcome', action.outcome,
                    'effect_identity', action.effect_identity,
                    'command_fingerprint', action.command_fingerprint,
                    'recorded_at', action.recorded_at
                  ) AS receipt
             FROM external_recovery_operability_actions AS action
            WHERE action.tenant_id = offsets.tenant_id
              AND action.offset_id = offsets.offset_id
            ORDER BY action.recorded_at DESC, action.id DESC
            LIMIT 1
         ) AS action ON TRUE
        WHERE offsets.tenant_id = $1::uuid
          AND offsets.scope_kind = 'external_interface'
          AND offsets.intake_retired_at IS NULL
          AND ($2::text IS NULL OR offsets.interface_family = $2::text)
          AND ($3::text IS NULL OR offsets.recovery_state = $3::text)
        ORDER BY offsets.interface_family, offsets.direction,
                 offsets.source_partition, offsets.generation`,
      tid,
      filters.interfaceFamily || null,
      filters.recoveryState || null
    );
    return Object.freeze({
      offsets: rows.map(workbenchItem),
      count: rows.length,
      capabilities: Object.freeze({
        can_register_exact_partition: true,
        supports_predicate_bulk_mutation: false
      })
    });
  });
}

export const __testing__ = Object.freeze({
  deriveConfig,
  deterministicUuid,
  offsetSafeState,
  registerIdentity
});

export default Object.freeze({
  authorizeExternalRecoveryOperabilityResume,
  listExternalRecoveryOperabilityWorkbench,
  registerExternalRecoveryOperabilityOffset
});

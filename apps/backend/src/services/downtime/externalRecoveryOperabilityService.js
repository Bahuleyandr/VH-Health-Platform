import { createHash } from 'node:crypto';

import { resolveExternalInterfaceDisposition } from '../../config/externalInterfaceRecoveryCatalog.js';
import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { isValidIdempotencyKey } from '../idempotency/idempotencyService.js';
import { recordClinicalAuditEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { EXTERNAL_RECOVERY_OPERABILITY_SCHEMA } from '../../validators/externalRecoveryOperabilitySchemas.js';
import { hashCanonicalValue } from './continuityPackCanonical.js';

const ACTION_VERSION = 1;
const BINDING_VERSION = 1;
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

function normalizedRole(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
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

function registerCommand({ effectIdentity, actor, parsed, idempotency, requestId }) {
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
    idempotency_key_sha256: idempotency.sha256,
    request_id: requestId || null,
    http_method: 'POST',
    http_path: '/api/v1/admin/continuity/external-recovery/offsets',
    prior_state: null,
    next_state: nextState
  });
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
    return await setTenantTx(
      tid,
      async tx => {
        const actor = await loadCurrentAdminTx(tx, {
          tenantId: tid,
          actorUid,
          authenticatedRole: actorRole
        });
        const config = deriveConfig(parsed);
        const effect = registerIdentity({ tenantId: tid, config, parsed });
        const effectHash = hashCanonicalValue(effect);
        const offsetId = deterministicUuid(`external-recovery-offset:${effectHash}`);
        const actionId = deterministicUuid(`external-recovery-action:${effectHash}`);
        const command = registerCommand({
          effectIdentity: effect,
          actor,
          parsed,
          idempotency: requestIdentity,
          requestId
        });
        const commandFingerprint = hashCanonicalValue(command);
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
        const rows = await tx.$queryRawUnsafe(
          `SELECT public.external_recovery_operability_register_offset($1::jsonb) AS receipt`,
          JSON.stringify({
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
          })
        );
        if (!rows[0]?.receipt) {
          throw AppError.internal(
            'External-recovery registration returned no durable receipt',
            'EXTERNAL_RECOVERY_OPERABILITY_RECEIPT_REQUIRED'
          );
        }
        return rows[0].receipt;
      },
      { isolationLevel: 'Serializable' }
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
    return await setTenantTx(
      tid,
      async tx => {
        const actor = await loadCurrentAdminTx(tx, {
          tenantId: tid,
          actorUid,
          authenticatedRole: actorRole
        });
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
        if (rows.length !== 1) {
          throw AppError.notFound(
            'External-recovery offset not found',
            'EXTERNAL_RECOVERY_OPERABILITY_OFFSET_NOT_FOUND',
            { safe: true }
          );
        }
        const priorState = offsetSafeState(rows[0]);
        const stateFingerprint = hashCanonicalValue(priorState);
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
        const effectHash = hashCanonicalValue(effect);
        const actionId = deterministicUuid(`external-recovery-action:${effectHash}`);
        const nextState = Object.freeze({
          ...priorState,
          recovery_state: 'replaying',
          reconciliation_reason: null,
          resume_cutoff_position: parsed.resumeCutoffPosition,
          resume_cutoff_token: parsed.resumeCutoffToken
        });
        const commandFingerprint = hashCanonicalValue({
          effect_identity: effect,
          actor_uid: actor.uid,
          actor_role: actor.role,
          reason_code: parsed.reasonCode,
          reason_detail: parsed.reasonDetail,
          idempotency_key_sha256: requestIdentity.sha256,
          request_id: requestId || null,
          http_method: 'POST',
          http_path: `/api/v1/admin/continuity/external-recovery/offsets/${oid}/resume-authorizations`,
          prior_state: priorState,
          next_state: nextState
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
        const commandRows = await tx.$queryRawUnsafe(
          `SELECT public.external_recovery_operability_authorize_resume($1::jsonb) AS receipt`,
          JSON.stringify({
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
          })
        );
        if (!commandRows[0]?.receipt) {
          throw AppError.internal(
            'External-recovery resume returned no durable receipt',
            'EXTERNAL_RECOVERY_OPERABILITY_RECEIPT_REQUIRED'
          );
        }
        return commandRows[0].receipt;
      },
      { isolationLevel: 'Serializable' }
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
  const stateFingerprint = hashCanonicalValue(state);
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

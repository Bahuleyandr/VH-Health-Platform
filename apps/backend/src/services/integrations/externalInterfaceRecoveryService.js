import { createHash, randomUUID } from 'node:crypto';

import { resolveExternalInterfaceDisposition } from '../../config/externalInterfaceRecoveryCatalog.js';
import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { persistLateColdChainRecovery } from '../devices/coldChainService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { mintExternalRecoveryCapability } from './externalRecoveryEffectGate.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Recovery command contains a non-finite number');
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('Recovery command contains an invalid date');
    return value.toISOString();
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  throw new TypeError('Recovery command contains an unsupported value');
}

export function canonicalCommandFingerprint(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('Recovery command must be an object');
  }
  return createHash('sha256').update(JSON.stringify(canonicalize(command))).digest('hex');
}

function requireUuid(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'EXTERNAL_RECOVERY_INPUT_INVALID');
  }
  return normalized;
}

function requireText(value, label, max) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > max) {
    throw AppError.badRequest(`${label} is invalid`, 'EXTERNAL_RECOVERY_INPUT_INVALID');
  }
  return normalized;
}

function optionalText(value, label, max) {
  if (value === null || value === undefined || value === '') return null;
  return requireText(value, label, max);
}

function requirePosition(value, label) {
  let position;
  try {
    position = BigInt(String(value));
  } catch {
    throw AppError.badRequest(`${label} must be a non-negative BIGINT`, 'EXTERNAL_RECOVERY_INPUT_INVALID');
  }
  if (position < 0n || position > MAX_BIGINT) {
    throw AppError.badRequest(`${label} must be a non-negative BIGINT`, 'EXTERNAL_RECOVERY_INPUT_INVALID');
  }
  return position.toString();
}

function optionalPosition(value, label) {
  if (value === null || value === undefined || value === '') return null;
  return requirePosition(value, label);
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'EXTERNAL_RECOVERY_INPUT_INVALID');
  }
  return parsed;
}

function requireTimestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(String(value || ''));
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.badRequest(`${label} must be a valid timestamp`, 'EXTERNAL_RECOVERY_INPUT_INVALID');
  }
  return parsed.toISOString();
}

function normalizeMarker({ position, token }, { optional = false } = {}) {
  const normalizedPosition = optional ? optionalPosition(position, 'marker position') : requirePosition(position, 'marker position');
  const normalizedToken = optional ? optionalText(token, 'marker token', 255) : requireText(token, 'marker token', 255);
  if ((normalizedPosition === null) !== (normalizedToken === null)) {
    throw AppError.badRequest('marker position and token must be supplied together', 'EXTERNAL_RECOVERY_MARKER_INCOMPLETE');
  }
  return { position: normalizedPosition, token: normalizedToken };
}

function normalizePolicy({ policyVersion, policySignature, retentionPolicy, retentionUntil }) {
  return {
    policyVersion: requireText(policyVersion, 'policy_version', 80),
    policySignature: requireText(policySignature, 'policy_signature', 128),
    retentionPolicy: requireText(retentionPolicy, 'retention_policy', 80),
    retentionUntil: requireTimestamp(retentionUntil, 'retention_until'),
  };
}

function recoveryConfig(interfaceFamily = 'I10', subpath = null, {
  protocol = null,
  streamDirection = null,
} = {}) {
  const config = resolveExternalInterfaceDisposition({ interfaceFamily, subpath });
  const disposition = config.selectedDisposition || config.disposition;
  if (!EXTERNAL_INTERFACE_RECOVERY_ADAPTER_FAMILIES.includes(config.id)
      || disposition !== 'hwm_required') {
    throw AppError.conflict(
      `${config.id} is not implemented on the canonical recovery substrate`,
      'EXTERNAL_RECOVERY_INTERFACE_NOT_IMPLEMENTED',
    );
  }
  if (config.id === 'I05') {
    const normalizedProtocol = String(protocol || '').trim().toLowerCase();
    const normalizedDirection = String(streamDirection || '').trim().toLowerCase();
    if (!config.implementedProtocols?.includes(normalizedProtocol)) {
      throw AppError.conflict(
        `${normalizedProtocol || 'Unknown'} I05 recovery protocol is not implemented`,
        'EXTERNAL_RECOVERY_PROTOCOL_NOT_IMPLEMENTED',
      );
    }
    if (!config.directions?.includes(normalizedDirection)) {
      throw AppError.badRequest(
        'I05 stream_direction must be inbound or outbound',
        'EXTERNAL_RECOVERY_INPUT_INVALID',
      );
    }
    return Object.freeze({
      ...config,
      protocol: normalizedProtocol,
      direction: normalizedDirection,
    });
  }
  return config;
}

function normalizeFingerprint(command, commandFingerprint = null) {
  if (commandFingerprint === null || commandFingerprint === undefined || commandFingerprint === '') {
    return canonicalCommandFingerprint(command);
  }
  const fingerprint = String(commandFingerprint).trim().toLowerCase();
  if (!SHA256_PATTERN.test(fingerprint)) {
    throw AppError.badRequest('command_fingerprint must be lowercase SHA-256', 'EXTERNAL_RECOVERY_INPUT_INVALID');
  }
  return fingerprint;
}

export async function registerExternalRecoveryOffset({
  tenantId,
  facilityId = null,
  interfaceFamily = 'I10',
  subpath = null,
  protocol = null,
  streamDirection = null,
  sourcePartition,
  generation = 1,
  initialPosition = null,
  initialToken = null,
  retainedFromPosition = null,
  retainedFromToken = null,
  policyVersion,
  policySignature,
  retentionPolicy,
  retentionUntil,
} = {}) {
  const config = recoveryConfig(interfaceFamily, subpath, { protocol, streamDirection });
  const tid = requireTenantId(tenantId);
  const facilityScope = config.facilityScope || 'tenant';
  const facility = facilityScope === 'facility'
    ? requirePositiveInteger(facilityId, 'facility_id')
    : null;
  if (facilityScope === 'tenant' && facilityId !== null && facilityId !== undefined && facilityId !== '') {
    throw AppError.badRequest(`${config.id} recovery is tenant-scoped and does not accept facility_id`, 'EXTERNAL_RECOVERY_INPUT_INVALID');
  }
  const partition = requireText(sourcePartition, 'source_partition', 160);
  const safeGeneration = requirePositiveInteger(generation, 'generation');
  const marker = normalizeMarker({ position: initialPosition, token: initialToken }, { optional: true });
  const retained = normalizeMarker({ position: retainedFromPosition, token: retainedFromToken }, { optional: true });
  const policy = normalizePolicy({ policyVersion, policySignature, retentionPolicy, retentionUntil });
  const state = marker.position === null ? 'reconciliation_required_missing_marker' : 'paused';

  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO event_consumer_offsets
         (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
          direction, source_partition, consumer_key, generation, cursor_kind,
          high_water_position, high_water_token, retained_from_position,
          retained_from_token, recovery_state, reconciliation_reason,
          policy_version, policy_signature, retention_policy, retention_until,
          historical_cutoff_event_id, backfill_cursor_event_id)
       VALUES
         ('external_interface', $1::uuid, $2::text, $3::integer, $4::text,
          $5::text, $6::text, $7::text, $8::integer,
          $9::text, $10::bigint, $11::text, $12::bigint, $13::text, $14::text,
          CASE WHEN $10::bigint IS NULL THEN 'marker_absent' ELSE NULL END,
          $15::text, $16::text, $17::text, $18::timestamptz, NULL, NULL)
       RETURNING offset_id::text, tenant_id::text, facility_scope, facility_id,
                 interface_family, direction, source_partition, generation,
                 high_water_position::text, high_water_token,
                 retained_from_position::text, retained_from_token,
                 recovery_state, reconciliation_reason, policy_version,
                 policy_signature, retention_policy, retention_until`,
      tid, facilityScope, facility, config.id, config.direction, partition, `external:${config.id}`,
      safeGeneration, config.cursorKind || 'monotonic_position_and_predecessor',
      marker.position, marker.token, retained.position, retained.token,
      state, policy.policyVersion, policy.policySignature, policy.retentionPolicy, policy.retentionUntil,
    );
    return rows[0];
  }, { isolationLevel: 'Serializable' });
}

export async function readExternalRecoveryResumeState({
  tenantId,
  offsetId = null,
  interfaceFamily = 'I10',
  subpath = null,
  protocol = null,
  streamDirection = null,
  sourcePartition = null,
} = {}) {
  const config = recoveryConfig(interfaceFamily, subpath, { protocol, streamDirection });
  const tid = requireTenantId(tenantId);
  const oid = offsetId ? requireUuid(offsetId, 'offset_id') : null;
  const partition = sourcePartition ? requireText(sourcePartition, 'source_partition', 160) : null;
  if (!oid && !partition) {
    throw AppError.badRequest('offset_id or source_partition is required', 'EXTERNAL_RECOVERY_INPUT_INVALID');
  }
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT offset_id::text, source_partition, generation, recovery_state,
              high_water_position::text, high_water_token,
              retained_from_position::text, retained_from_token,
              resume_cutoff_position::text, resume_cutoff_token,
              policy_version, policy_signature, retention_policy, retention_until
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid
          AND scope_kind = 'external_interface'
          AND interface_family = $2::text
          AND intake_retired_at IS NULL
          AND ($3::uuid IS NULL OR offset_id = $3::uuid)
          AND ($4::text IS NULL OR source_partition = $4::text)
        LIMIT 1`,
      tid, config.id, oid, partition,
    );
    if (rows.length !== 1) {
      throw AppError.conflict(
        'Canonical recovery marker is missing; owner reconciliation is required',
        'EXTERNAL_RECOVERY_MARKER_MISSING',
      );
    }
    const row = rows[0];
    return Object.freeze({
      contract: config.id === 'I09' ? 'vhhealth.i09.gateway-sequence/v1' : `vhhealth.${config.id.toLowerCase()}.recovery/v1`,
      interface_family: config.id,
      tenant_id: tid,
      offset_id: row.offset_id,
      source_partition: row.source_partition,
      generation: Number(row.generation),
      recovery_state: row.recovery_state,
      high_water_position: row.high_water_position,
      high_water_token: row.high_water_token,
      retained_from_position: row.retained_from_position,
      retained_from_token: row.retained_from_token,
      resume_cutoff_position: row.resume_cutoff_position,
      resume_cutoff_token: row.resume_cutoff_token,
      policy_version: row.policy_version,
      policy_signature: row.policy_signature,
      retention_policy: row.retention_policy,
      retention_until: row.retention_until,
    });
  });
}

export async function authorizeExternalRecoveryResume({
  tenantId,
  offsetId,
  interfaceFamily = 'I10',
  subpath = null,
  protocol = null,
  streamDirection = null,
  resumeCutoffPosition,
  resumeCutoffToken,
} = {}) {
  const config = recoveryConfig(interfaceFamily, subpath, { protocol, streamDirection });
  const tid = requireTenantId(tenantId);
  const oid = requireUuid(offsetId, 'offset_id');
  const cutoff = normalizeMarker({ position: resumeCutoffPosition, token: resumeCutoffToken });
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE event_consumer_offsets
          SET resume_cutoff_position = $3::bigint, resume_cutoff_token = $4::text,
              recovery_state = 'replaying', reconciliation_reason = NULL, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid
          AND scope_kind = 'external_interface' AND interface_family = $5::text
          AND recovery_state = 'paused'
          AND high_water_position IS NOT NULL AND high_water_token IS NOT NULL
          AND $3::bigint >= high_water_position
        RETURNING offset_id::text, recovery_state, high_water_position::text,
                  high_water_token, resume_cutoff_position::text, resume_cutoff_token`,
      tid, oid, cutoff.position, cutoff.token, config.id,
    );
    if (rows.length !== 1) {
      throw AppError.conflict(
        `${config.id} recovery offset is not eligible for owner-authorized resume`,
        'EXTERNAL_RECOVERY_RESUME_NOT_ELIGIBLE',
      );
    }
    return rows[0];
  }, { isolationLevel: 'Serializable' });
}

async function loadOffsetTx(tx, tenantId, offsetId, interfaceFamily, { lock = false } = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT offset_id::text, tenant_id::text, facility_scope, facility_id,
            interface_family, direction, source_partition, generation,
            high_water_position::text, high_water_token,
            retained_from_position::text, retained_from_token,
            resume_cutoff_position::text, resume_cutoff_token, recovery_state,
            policy_version, policy_signature, retention_policy, retention_until
       FROM event_consumer_offsets
      WHERE tenant_id = $1::uuid AND offset_id = $2::uuid
        AND scope_kind = 'external_interface' AND interface_family = $3::text
      ${lock ? 'FOR UPDATE' : ''}`,
    tenantId, offsetId, interfaceFamily,
  );
  return rows[0] || null;
}

async function markSourceGap(tenantId, offsetId, reason) {
  await setTenantTx(tenantId, (tx) => tx.$executeRawUnsafe(
    `UPDATE event_consumer_offsets
        SET recovery_state = 'reconciliation_required_source_gap',
            reconciliation_reason = $3::text, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND offset_id = $2::uuid
        AND scope_kind = 'external_interface'`,
    tenantId, offsetId, String(reason).slice(0, 160),
  ));
}

export async function enqueueExternalRecoveryItem({
  tenantId,
  offsetId,
  interfaceFamily = 'I10',
  subpath = null,
  protocol = null,
  streamDirection = null,
  sourcePartition = null,
  generation = null,
  sourcePosition,
  sourceToken,
  predecessorToken,
  duplicateKey,
  occurredAt,
  command,
  commandFingerprint = null,
  arrivalClass = 'recovery_backlog',
} = {}) {
  const config = recoveryConfig(interfaceFamily, subpath, { protocol, streamDirection });
  const tid = requireTenantId(tenantId);
  const oid = requireUuid(offsetId, 'offset_id');
  const position = requirePosition(sourcePosition, 'source_position');
  const token = requireText(sourceToken, 'source_token', 255);
  const predecessor = requireText(predecessorToken, 'predecessor_token', 255);
  const duplicate = requireText(duplicateKey, 'duplicate_key', 255);
  const occurred = requireTimestamp(occurredAt, 'occurred_at');
  if (arrivalClass !== 'recovery_backlog') {
    throw AppError.conflict(`${config.id} recovery accepts backlog items only`, 'EXTERNAL_RECOVERY_WORKER_PAUSED');
  }
  const fingerprint = normalizeFingerprint(command, commandFingerprint);
  const result = await setTenantTx(tid, async (tx) => {
    const offset = await loadOffsetTx(tx, tid, oid, config.id, { lock: true });
    if (!offset) throw AppError.notFound(`${config.id} recovery offset not found`, 'EXTERNAL_RECOVERY_OFFSET_NOT_FOUND');
    if (
      (sourcePartition !== null && sourcePartition !== offset.source_partition)
      || (generation !== null && Number(generation) !== Number(offset.generation))
    ) {
      throw AppError.conflict(
        'Recovery envelope partition or generation does not match its canonical offset',
        'EXTERNAL_RECOVERY_OFFSET_MISMATCH',
      );
    }
    if (offset.recovery_state === 'reconciliation_required_missing_marker') {
      return Object.freeze({ held: true, reason: 'missing_marker', offset });
    }
    if (offset.recovery_state === 'retired') {
      throw AppError.conflict(`${config.id} recovery offset is retired`, 'EXTERNAL_RECOVERY_OFFSET_RETIRED');
    }
    const collisions = await tx.$queryRawUnsafe(
      `SELECT inbox_id::text, source_position::text, source_token, predecessor_token,
              duplicate_key, command_fingerprint, occurred_at::text, status,
              outcome_code, pending_task_id
         FROM pathway_projector_inbox
        WHERE tenant_id = $1::uuid AND scope_kind = 'external_interface'
          AND interface_family = $2::text AND direction = $3::text
          AND source_partition = $4::text
          AND (duplicate_key = $5::text OR
            (offset_id = $6::uuid AND generation = $7::integer AND source_position = $8::bigint))
        FOR UPDATE`,
      tid, config.id, config.direction, offset.source_partition, duplicate, oid, offset.generation, position,
    );
    if (collisions.length > 0) {
      const exact = collisions.find((row) => row.source_position === position
        && row.source_token === token && row.predecessor_token === predecessor
        && row.duplicate_key === duplicate && row.command_fingerprint === fingerprint
        && new Date(row.occurred_at).toISOString() === occurred);
      if (exact && collisions.length === 1) {
        return Object.freeze({ duplicate: true, inbox_id: exact.inbox_id, status: exact.status,
          outcome_code: exact.outcome_code, pending_task_id: exact.pending_task_id });
      }
      return Object.freeze({ conflict: true });
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO pathway_projector_inbox
         (scope_kind, tenant_id, consumer_key, generation, offset_id, facility_id,
          interface_family, direction, source_partition, source_position,
          source_token, predecessor_token, duplicate_key, command_fingerprint,
          occurred_at, received_at, recorded_at, arrival_class, effect_disposition,
          status, next_attempt_at, policy_version, policy_signature, retention_policy, retention_until)
       VALUES ('external_interface', $1::uuid, $2::text, $3::integer, $4::uuid,
          $5::integer, $6::text, $7::text, $8::text, $9::bigint, $10::text,
          $11::text, $12::text, $13::char(64), $14::timestamptz, NOW(), NOW(),
          'recovery_backlog', 'late_pending_only', 'pending', NOW(), $15::text,
          $16::text, $17::text, $18::timestamptz)
       RETURNING inbox_id::text, source_position::text, source_token, duplicate_key,
                 command_fingerprint, status, arrival_class, effect_disposition, occurred_at`,
      tid, `external:${config.id}`, offset.generation, oid, offset.facility_id, config.id,
      config.direction, offset.source_partition, position, token, predecessor, duplicate, fingerprint,
      occurred, offset.policy_version, offset.policy_signature, offset.retention_policy, offset.retention_until,
    );
    return rows[0];
  }, { isolationLevel: 'Serializable' });

  if (result.conflict) {
    await markSourceGap(tid, oid, 'duplicate_or_position_fingerprint_conflict');
    throw AppError.conflict(
      `${config.id} recovery identity was reused with different evidence`,
      'EXTERNAL_RECOVERY_IDENTITY_CONFLICT',
    );
  }
  return result;
}

function matchesQueuedItem(row, expected) {
  return row.source_position === expected.sourcePosition
    && row.source_token === expected.sourceToken
    && row.predecessor_token === expected.predecessorToken
    && row.duplicate_key === expected.duplicateKey
    && row.command_fingerprint === expected.fingerprint;
}

async function persistLateHl7Outbound({ tx, capability, inbox, tenantId, command }) {
  const { persistLateHl7OutboundRecovery } = await import('./externalHl7OutboundRecoveryService.js');
  return persistLateHl7OutboundRecovery({
    tx, capability, tenantId,
    recoveryInboxId: inbox.inbox_id,
    command,
  });
}

async function persistLateNotification({ tx, capability, inbox, tenantId, command }) {
  const { persistLateNotificationRecovery } = await import('./externalNotificationRecoveryService.js');
  return persistLateNotificationRecovery({
    tx, capability, tenantId,
    recoveryInboxId: inbox.inbox_id,
    command,
  });
}

async function persistLateWebhook({ tx, capability, inbox, tenantId, command }) {
  const { persistLateWebhookRecovery } = await import('./externalWebhookRecoveryService.js');
  return persistLateWebhookRecovery({
    tx,
    capability,
    tenantId,
    recoveryInboxId: inbox.inbox_id,
    sourcePartition: inbox.source_partition,
    sourcePosition: inbox.source_position,
    duplicateKey: inbox.duplicate_key,
    occurredAt: inbox.occurred_at,
    command,
  });
}

async function persistLateClinicalTrialPage({ tx, capability, inbox, tenantId, command }) {
  const { persistLateClinicalTrialPageRecovery } = await import('./externalClinicalTrialRecoveryService.js');
  return persistLateClinicalTrialPageRecovery({
    tx,
    capability,
    tenantId,
    recoveryInboxId: inbox.inbox_id,
    sourcePartition: inbox.source_partition,
    sourcePosition: inbox.source_position,
    duplicateKey: inbox.duplicate_key,
    occurredAt: inbox.occurred_at,
    command,
  });
}

async function persistLateSiemAttempt({ tx, capability, inbox, tenantId, command }) {
  const { persistLateSiemAttemptRecovery } = await import('./externalSiemRecoveryService.js');
  return persistLateSiemAttemptRecovery({
    tx,
    capability,
    tenantId,
    recoveryInboxId: inbox.inbox_id,
    sourcePartition: inbox.source_partition,
    sourcePosition: inbox.source_position,
    duplicateKey: inbox.duplicate_key,
    occurredAt: inbox.occurred_at,
    command,
  });
}

async function persistLateInterfaceEngine({ tx, capability, config, inbox, tenantId, command }) {
  const { persistLateInterfaceEngineRecovery } = await import('./externalInterfaceEngineRecoveryService.js');
  return persistLateInterfaceEngineRecovery({
    tx,
    capability,
    tenantId,
    recoveryInboxId: inbox.inbox_id,
    protocol: config.protocol,
    streamDirection: config.direction,
    sourcePartition: inbox.source_partition,
    sourcePosition: inbox.source_position,
    sourceToken: inbox.source_token,
    predecessorToken: inbox.predecessor_token,
    duplicateKey: inbox.duplicate_key,
    command,
  });
}

async function persistLateImagingStudyLink({ tx, capability, inbox, tenantId, command }) {
  const { persistLateImagingStudyLinkRecovery } = await import('./externalImagingStudyLinkRecoveryService.js');
  return persistLateImagingStudyLinkRecovery({
    tx,
    capability,
    tenantId,
    recoveryInboxId: inbox.inbox_id,
    sourcePartition: inbox.source_partition,
    sourcePosition: inbox.source_position,
    sourceToken: inbox.source_token,
    predecessorToken: inbox.predecessor_token,
    duplicateKey: inbox.duplicate_key,
    occurredAt: inbox.occurred_at,
    command,
  });
}

async function persistLateScim({ tx, capability, inbox, tenantId, command }) {
  const { persistLateScimRecovery } = await import('./externalScimRecoveryService.js');
  return persistLateScimRecovery({
    tx,
    capability,
    tenantId,
    recoveryInboxId: inbox.inbox_id,
    sourcePartition: inbox.source_partition,
    sourcePosition: inbox.source_position,
    sourceToken: inbox.source_token,
    predecessorToken: inbox.predecessor_token,
    duplicateKey: inbox.duplicate_key,
    occurredAt: inbox.occurred_at,
    command,
  });
}

async function persistLateAbdm({ tx, capability, inbox, tenantId, command }) {
  const { persistLateAbdmRecovery } = await import('./externalAbdmRecoveryService.js');
  return persistLateAbdmRecovery({
    tx,
    capability,
    tenantId,
    recoveryInboxId: inbox.inbox_id,
    sourcePartition: inbox.source_partition,
    sourcePosition: inbox.source_position,
    sourceToken: inbox.source_token,
    predecessorToken: inbox.predecessor_token,
    duplicateKey: inbox.duplicate_key,
    occurredAt: inbox.occurred_at,
    command,
  });
}

async function persistLateNhcx({ tx, capability, inbox, tenantId, command }) {
  const { persistLateNhcxRecovery } = await import('./externalNhcxRecoveryService.js');
  return persistLateNhcxRecovery({
    tx,
    capability,
    tenantId,
    recoveryInboxId: inbox.inbox_id,
    sourcePartition: inbox.source_partition,
    sourcePosition: inbox.source_position,
    sourceToken: inbox.source_token,
    predecessorToken: inbox.predecessor_token,
    duplicateKey: inbox.duplicate_key,
    occurredAt: inbox.occurred_at,
    command,
  });
}

async function persistLateLab({ tx, capability, config, inbox, tenantId, command }) {
  const { persistLateLabRecovery } = await import('./externalLabRecoveryService.js');
  return persistLateLabRecovery({
    tx, capability, tenantId, interfaceFamily: config.id,
    recoveryInboxId: inbox.inbox_id, occurredAt: inbox.occurred_at, command,
  });
}

async function persistLateColdChain({ tx, capability, inbox, tenantId, command }) {
  return persistLateColdChainRecovery({
    tx, capability, tenantId, facilityId: inbox.facility_id,
    recoveryInboxId: inbox.inbox_id, occurredAt: inbox.occurred_at, command,
  });
}

async function persistLateVitals({ tx, capability, config, inbox, tenantId, command }) {
  const { persistLateVitalsRecovery } = await import('./externalVitalsRecoveryService.js');
  return persistLateVitalsRecovery({
    tx, capability, tenantId, interfaceFamily: config.id,
    recoveryInboxId: inbox.inbox_id, occurredAt: inbox.occurred_at, command,
  });
}

const EXTERNAL_INTERFACE_RECOVERY_ADAPTERS = Object.freeze({
  I01: persistLateLab,
  I02: persistLateLab,
  I04: persistLateHl7Outbound,
  I05: persistLateInterfaceEngine,
  I06: persistLateImagingStudyLink,
  I09: persistLateVitals,
  I10: persistLateColdChain,
  I13: persistLateScim,
  I15: persistLateVitals,
  I16: persistLateAbdm,
  I17: persistLateNotification,
  I18: persistLateWebhook,
  I19: persistLateNhcx,
  I23: persistLateClinicalTrialPage,
  I25: persistLateSiemAttempt,
});

export const EXTERNAL_INTERFACE_RECOVERY_ADAPTER_FAMILIES = Object.freeze(
  Object.keys(EXTERNAL_INTERFACE_RECOVERY_ADAPTERS),
);

async function persistLateDomain(input) {
  const adapter = EXTERNAL_INTERFACE_RECOVERY_ADAPTERS[input.config.id];
  if (!adapter) {
    throw AppError.conflict(
      `${input.config.id} is not implemented on the canonical recovery substrate`,
      'EXTERNAL_RECOVERY_INTERFACE_NOT_IMPLEMENTED',
    );
  }
  return adapter(input);
}

export async function processNextItemTx({
  tenantId,
  offsetId,
  interfaceFamily = 'I10',
  subpath = null,
  protocol = null,
  streamDirection = null,
  sourcePartition = null,
  generation = null,
  sourcePosition,
  sourceToken,
  predecessorToken,
  duplicateKey,
  command,
  commandFingerprint = null,
  leaseOwner = randomUUID(),
} = {}) {
  const config = recoveryConfig(interfaceFamily, subpath, { protocol, streamDirection });
  const tid = requireTenantId(tenantId);
  const oid = requireUuid(offsetId, 'offset_id');
  const position = requirePosition(sourcePosition, 'source_position');
  const token = requireText(sourceToken, 'source_token', 255);
  const predecessor = requireText(predecessorToken, 'predecessor_token', 255);
  const duplicate = requireText(duplicateKey, 'duplicate_key', 255);
  const owner = requireUuid(leaseOwner, 'lease_owner');
  const fingerprint = normalizeFingerprint(command, commandFingerprint);

  return setTenantTx(tid, async (tx) => {
    const offset = await loadOffsetTx(tx, tid, oid, config.id, { lock: true });
    if (!offset) throw AppError.notFound(`${config.id} recovery offset not found`, 'EXTERNAL_RECOVERY_OFFSET_NOT_FOUND');
    if (
      (sourcePartition !== null && sourcePartition !== offset.source_partition)
      || (generation !== null && Number(generation) !== Number(offset.generation))
    ) {
      throw AppError.conflict(
        'Recovery envelope partition or generation does not match its canonical offset',
        'EXTERNAL_RECOVERY_OFFSET_MISMATCH',
      );
    }
    if (offset.recovery_state !== 'replaying') {
      throw AppError.conflict(`${config.id} recovery offset is not in owner-authorized replay`, 'EXTERNAL_RECOVERY_OFFSET_NOT_REPLAYING');
    }
    if (offset.high_water_position === null || offset.high_water_token === null) {
      throw AppError.conflict(`${config.id} recovery marker is missing`, 'EXTERNAL_RECOVERY_MARKER_MISSING');
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT inbox_id::text, tenant_id::text, facility_id, offset_id::text,
              interface_family, generation, source_position::text, source_token,
              predecessor_token, duplicate_key, command_fingerprint, occurred_at::text,
              source_partition, arrival_class, effect_disposition, status, attempts,
              outcome_code, pending_task_id
         FROM pathway_projector_inbox
        WHERE tenant_id = $1::uuid AND offset_id = $2::uuid
          AND scope_kind = 'external_interface' AND interface_family = $3::text
          AND status = 'pending' AND next_attempt_at <= NOW()
        ORDER BY source_position LIMIT 1 FOR UPDATE`,
      tid, oid, config.id,
    );
    const inbox = rows[0];
    if (!inbox) return null;
    if (!matchesQueuedItem(inbox, { sourcePosition: position, sourceToken: token,
      predecessorToken: predecessor, duplicateKey: duplicate, fingerprint })) {
      throw AppError.conflict('Worker command does not match the next durable recovery item', 'EXTERNAL_RECOVERY_COMMAND_MISMATCH');
    }
    const expectedPosition = (BigInt(offset.high_water_position) + 1n).toString();
    if (inbox.source_position !== expectedPosition || inbox.predecessor_token !== offset.high_water_token) {
      await tx.$executeRawUnsafe(
        `UPDATE event_consumer_offsets SET recovery_state = 'reconciliation_required_source_gap',
             reconciliation_reason = 'non_contiguous_source_item', updated_at = NOW()
           WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`, tid, oid,
      );
      return Object.freeze({ held: true, reason: 'source_gap', inbox_id: inbox.inbox_id });
    }
    if (offset.retained_from_position !== null && BigInt(offset.retained_from_position) > BigInt(expectedPosition)) {
      await tx.$executeRawUnsafe(
        `UPDATE event_consumer_offsets SET recovery_state = 'reconciliation_required_retention_gap',
             reconciliation_reason = 'marker_precedes_retained_source', updated_at = NOW()
           WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`, tid, oid,
      );
      return Object.freeze({ held: true, reason: 'retention_gap', inbox_id: inbox.inbox_id });
    }
    const claimed = await tx.$queryRawUnsafe(
      `UPDATE pathway_projector_inbox SET lease_owner = $3::uuid,
              lease_expires_at = NOW() + INTERVAL '5 minutes', attempts = attempts + 1
        WHERE tenant_id = $1::uuid AND inbox_id = $2::uuid AND status = 'pending' AND lease_owner IS NULL
        RETURNING attempts`, tid, inbox.inbox_id, owner,
    );
    if (claimed.length !== 1) throw AppError.conflict('Recovery claim fence was lost', 'EXTERNAL_RECOVERY_CLAIM_FENCE_LOST');

    await tx.$executeRawUnsafe(
      `SELECT set_config('app.external_recovery_effect_disposition', $1::text, true)`,
      inbox.effect_disposition,
    );
    const capability = mintExternalRecoveryCapability({
      inboxId: inbox.inbox_id, tenantId: tid, facilityId: inbox.facility_id,
      interfaceFamily: config.id, effectDisposition: inbox.effect_disposition,
    });
    const domain = await persistLateDomain({ tx, capability, config, inbox, tenantId: tid, command });
    const evidence = config.id === 'I17' || config.id === 'I18' || config.id === 'I23'
      || config.id === 'I25' || config.id === 'I13'
      || config.id === 'I16' || config.id === 'I19'
      ? domain?.receipt
      : config.id === 'I04'
        ? domain?.acknowledgement || domain?.authority
        : (config.id === 'I05' || config.id === 'I06')
          ? domain?.receipt
        : domain?.reading || domain?.observation || domain?.result;
    if (!evidence?.id || !domain?.task?.id) {
      throw AppError.internal('Late recovery did not produce domain evidence and pending work', 'EXTERNAL_RECOVERY_PENDING_WORK_MISSING');
    }
    const outcomeCode = domain.outcomeCode || (config.id === 'I10'
      ? 'cold_chain_reading_pending_review'
      : `${config.id.toLowerCase()}_vitals_observation_pending_review`);
    const terminal = await tx.$queryRawUnsafe(
      `UPDATE pathway_projector_inbox SET status = 'handled', lease_owner = NULL,
              lease_expires_at = NULL, last_error = NULL, outcome_at = NOW(),
              outcome_code = $4::text, pending_task_id = $5::integer
        WHERE tenant_id = $1::uuid AND inbox_id = $2::uuid
          AND status = 'pending' AND lease_owner = $3::uuid
        RETURNING inbox_id::text, status, attempts, outcome_code, pending_task_id, outcome_at`,
      tid, inbox.inbox_id, owner, outcomeCode, domain.task.id,
    );
    if (terminal.length !== 1) throw AppError.conflict('Recovery terminal fence was lost', 'EXTERNAL_RECOVERY_CLAIM_FENCE_LOST');
    const advanced = domain?.recoveryCursorAction === 'pause'
      ? await tx.$queryRawUnsafe(
          `UPDATE event_consumer_offsets
              SET recovery_state = 'reconciliation_required_provider_state',
                  reconciliation_reason = $3::text, updated_at = NOW()
            WHERE tenant_id = $1::uuid AND offset_id = $2::uuid
              AND recovery_state = 'replaying'
              AND high_water_position = $4::bigint AND high_water_token = $5::text
            RETURNING high_water_position::text, high_water_token, recovery_state`,
          tid, oid, domain.outcomeCode, offset.high_water_position, offset.high_water_token,
        )
      : await tx.$queryRawUnsafe(
          `UPDATE event_consumer_offsets SET high_water_position = $3::bigint,
                  high_water_token = $4::text,
                  recovery_state = CASE WHEN resume_cutoff_position = $3::bigint THEN 'ready' ELSE 'replaying' END,
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid AND offset_id = $2::uuid AND recovery_state = 'replaying'
              AND high_water_position = $5::bigint AND high_water_token = $6::text
            RETURNING high_water_position::text, high_water_token, recovery_state`,
          tid, oid, inbox.source_position, inbox.source_token, offset.high_water_position, offset.high_water_token,
        );
    if (advanced.length !== 1) throw AppError.conflict('Recovery cursor fence was lost', 'EXTERNAL_RECOVERY_CURSOR_FENCE_LOST');
    return Object.freeze({
      ...terminal[0], cursor: advanced[0],
      ...(config.id === 'I17' || config.id === 'I18' || config.id === 'I23'
        || config.id === 'I25' || config.id === 'I13'
        || config.id === 'I16' || config.id === 'I19'
        ? { receipt_id: String(evidence.id || evidence.receipt_id) }
        : config.id === 'I04'
          ? domain?.acknowledgement
            ? { acknowledgement_id: String(evidence.acknowledgement_id || evidence.id) }
            : { message_id: String(evidence.id) }
        : config.id === 'I05'
          ? { receipt_id: String(evidence.id), message_id: String(domain.message.id) }
        : config.id === 'I06'
          ? { receipt_id: String(evidence.id), radiology_order_id: String(domain.order.id) }
        : config.id === 'I10'
        ? { reading_id: String(evidence.id) }
        : (config.id === 'I01' || config.id === 'I02')
          ? { result_id: String(evidence.id), result_ids: domain.results.map(result => String(result.id)) }
          : { observation_id: String(evidence.id) }),
    });
  }, { isolationLevel: 'Serializable' });
}

export const registerColdChainRecoveryOffset = (input) => registerExternalRecoveryOffset({ ...input, interfaceFamily: 'I10' });
export const authorizeColdChainRecoveryResume = (input) => authorizeExternalRecoveryResume({ ...input, interfaceFamily: 'I10' });
export const enqueueColdChainRecoveryItem = (input) => enqueueExternalRecoveryItem({ ...input, interfaceFamily: 'I10' });

export function isCanonicalRecoveryFingerprint(value) {
  return SHA256_PATTERN.test(String(value || ''));
}

export const externalInterfaceRecoveryService = Object.freeze({
  registerExternalRecoveryOffset,
  readExternalRecoveryResumeState,
  authorizeExternalRecoveryResume,
  enqueueExternalRecoveryItem,
  processNextItemTx,
  registerColdChainRecoveryOffset,
  authorizeColdChainRecoveryResume,
  enqueueColdChainRecoveryItem,
});

export default externalInterfaceRecoveryService;

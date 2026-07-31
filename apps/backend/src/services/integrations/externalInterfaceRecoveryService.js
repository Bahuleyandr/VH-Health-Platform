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
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
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
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  throw new TypeError('Recovery command contains an unsupported value');
}

export function canonicalCommandFingerprint(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('Recovery command must be an object');
  }
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(command)))
    .digest('hex');
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
  const normalizedPosition = optional
    ? optionalPosition(position, 'marker position')
    : requirePosition(position, 'marker position');
  const normalizedToken = optional
    ? optionalText(token, 'marker token', 255)
    : requireText(token, 'marker token', 255);
  if ((normalizedPosition === null) !== (normalizedToken === null)) {
    throw AppError.badRequest(
      'marker position and token must be supplied together',
      'EXTERNAL_RECOVERY_MARKER_INCOMPLETE',
    );
  }
  return { position: normalizedPosition, token: normalizedToken };
}

function normalizePolicy({
  policyVersion,
  policySignature,
  retentionPolicy,
  retentionUntil,
}) {
  return {
    policyVersion: requireText(policyVersion, 'policy_version', 80),
    policySignature: requireText(policySignature, 'policy_signature', 128),
    retentionPolicy: requireText(retentionPolicy, 'retention_policy', 80),
    retentionUntil: requireTimestamp(retentionUntil, 'retention_until'),
  };
}

export async function registerColdChainRecoveryOffset({
  tenantId,
  facilityId,
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
  resolveExternalInterfaceDisposition({ interfaceFamily: 'I10' });
  const tid = requireTenantId(tenantId);
  const facility = requirePositiveInteger(facilityId, 'facility_id');
  const partition = requireText(sourcePartition, 'source_partition', 160);
  const safeGeneration = requirePositiveInteger(generation, 'generation');
  const marker = normalizeMarker(
    { position: initialPosition, token: initialToken },
    { optional: true },
  );
  const retained = normalizeMarker(
    { position: retainedFromPosition, token: retainedFromToken },
    { optional: true },
  );
  const policy = normalizePolicy({
    policyVersion,
    policySignature,
    retentionPolicy,
    retentionUntil,
  });
  const state = marker.position === null
    ? 'reconciliation_required_missing_marker'
    : 'paused';

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
         ('external_interface', $1::uuid, 'facility', $2::integer, 'I10',
          'inbound', $3::text, 'external:I10', $4::integer,
          'monotonic_position_and_predecessor',
          $5::bigint, $6::text, $7::bigint, $8::text, $9::text,
          CASE WHEN $5::bigint IS NULL THEN 'marker_absent' ELSE NULL END,
          $10::text, $11::text, $12::text, $13::timestamptz,
          NULL, NULL)
       RETURNING offset_id::text, tenant_id::text, facility_id, interface_family,
                 direction, source_partition, generation, high_water_position::text,
                 high_water_token, retained_from_position::text,
                 retained_from_token, recovery_state, reconciliation_reason,
                 policy_version, retention_policy, retention_until`,
      tid,
      facility,
      partition,
      safeGeneration,
      marker.position,
      marker.token,
      retained.position,
      retained.token,
      state,
      policy.policyVersion,
      policy.policySignature,
      policy.retentionPolicy,
      policy.retentionUntil,
    );
    return rows[0];
  }, { isolationLevel: 'Serializable' });
}

export async function authorizeColdChainRecoveryResume({
  tenantId,
  offsetId,
  resumeCutoffPosition,
  resumeCutoffToken,
} = {}) {
  const tid = requireTenantId(tenantId);
  const oid = requireUuid(offsetId, 'offset_id');
  const cutoff = normalizeMarker({
    position: resumeCutoffPosition,
    token: resumeCutoffToken,
  });

  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE event_consumer_offsets
          SET resume_cutoff_position = $3::bigint,
              resume_cutoff_token = $4::text,
              recovery_state = 'replaying',
              reconciliation_reason = NULL,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND offset_id = $2::uuid
          AND scope_kind = 'external_interface'
          AND interface_family = 'I10'
          AND recovery_state = 'paused'
          AND high_water_position IS NOT NULL
          AND high_water_token IS NOT NULL
          AND $3::bigint >= high_water_position
        RETURNING offset_id::text, recovery_state,
                  high_water_position::text, high_water_token,
                  resume_cutoff_position::text, resume_cutoff_token`,
      tid,
      oid,
      cutoff.position,
      cutoff.token,
    );
    if (rows.length !== 1) {
      throw AppError.conflict(
        'Cold-chain recovery offset is not eligible for owner-authorized resume',
        'EXTERNAL_RECOVERY_RESUME_NOT_ELIGIBLE',
      );
    }
    return rows[0];
  }, { isolationLevel: 'Serializable' });
}

async function loadOffsetTx(tx, tenantId, offsetId, { lock = false } = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT offset_id::text, tenant_id::text, facility_id, interface_family,
            direction, source_partition, generation, high_water_position::text,
            high_water_token, retained_from_position::text, retained_from_token,
            resume_cutoff_position::text, resume_cutoff_token, recovery_state,
            policy_version, policy_signature, retention_policy, retention_until
       FROM event_consumer_offsets
      WHERE tenant_id = $1::uuid
        AND offset_id = $2::uuid
        AND scope_kind = 'external_interface'
        AND interface_family = 'I10'
      ${lock ? 'FOR UPDATE' : ''}`,
    tenantId,
    offsetId,
  );
  return rows[0] || null;
}

async function markSourceGap(tenantId, offsetId, reason) {
  await setTenantTx(tenantId, (tx) => tx.$executeRawUnsafe(
    `UPDATE event_consumer_offsets
        SET recovery_state = 'reconciliation_required_source_gap',
            reconciliation_reason = $3::text,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND offset_id = $2::uuid
        AND scope_kind = 'external_interface'`,
    tenantId,
    offsetId,
    String(reason).slice(0, 160),
  ));
}

export async function enqueueColdChainRecoveryItem({
  tenantId,
  offsetId,
  sourcePosition,
  sourceToken,
  predecessorToken,
  duplicateKey,
  occurredAt,
  command,
  arrivalClass = 'recovery_backlog',
} = {}) {
  const tid = requireTenantId(tenantId);
  const oid = requireUuid(offsetId, 'offset_id');
  const position = requirePosition(sourcePosition, 'source_position');
  const token = requireText(sourceToken, 'source_token', 255);
  const predecessor = requireText(predecessorToken, 'predecessor_token', 255);
  const duplicate = requireText(duplicateKey, 'duplicate_key', 255);
  const occurred = requireTimestamp(occurredAt, 'occurred_at');
  if (arrivalClass !== 'recovery_backlog') {
    throw AppError.conflict(
      'C6.1-A accepts only recovery_backlog I10 items',
      'EXTERNAL_RECOVERY_WORKER_PAUSED',
    );
  }
  const fingerprint = canonicalCommandFingerprint(command);

  const result = await setTenantTx(tid, async (tx) => {
    const offset = await loadOffsetTx(tx, tid, oid, { lock: true });
    if (!offset) {
      throw AppError.notFound('Cold-chain recovery offset not found', 'EXTERNAL_RECOVERY_OFFSET_NOT_FOUND');
    }
    if (offset.recovery_state === 'reconciliation_required_missing_marker') {
      return Object.freeze({ held: true, reason: 'missing_marker', offset });
    }
    if (offset.recovery_state === 'retired') {
      throw AppError.conflict('Cold-chain recovery offset is retired', 'EXTERNAL_RECOVERY_OFFSET_RETIRED');
    }

    const collisions = await tx.$queryRawUnsafe(
      `SELECT inbox_id::text, source_position::text, source_token,
              predecessor_token, duplicate_key, command_fingerprint,
              occurred_at::text, status, outcome_code, pending_task_id
         FROM pathway_projector_inbox
        WHERE tenant_id = $1::uuid
          AND scope_kind = 'external_interface'
          AND interface_family = 'I10'
          AND direction = 'inbound'
          AND source_partition = $2::text
          AND (
            duplicate_key = $3::text
            OR (offset_id = $4::uuid AND generation = $5::integer
                AND source_position = $6::bigint)
          )
        FOR UPDATE`,
      tid,
      offset.source_partition,
      duplicate,
      oid,
      offset.generation,
      position,
    );
    if (collisions.length > 0) {
      const exact = collisions.find((row) => (
        row.source_position === position
        && row.source_token === token
        && row.predecessor_token === predecessor
        && row.duplicate_key === duplicate
        && row.command_fingerprint === fingerprint
        && new Date(row.occurred_at).toISOString() === occurred
      ));
      if (exact && collisions.length === 1) {
        return Object.freeze({
          duplicate: true,
          inbox_id: exact.inbox_id,
          status: exact.status,
          outcome_code: exact.outcome_code,
          pending_task_id: exact.pending_task_id,
        });
      }
      return Object.freeze({ conflict: true });
    }

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO pathway_projector_inbox
         (scope_kind, tenant_id, consumer_key, generation, offset_id, facility_id,
          interface_family, direction, source_partition, source_position,
          source_token, predecessor_token, duplicate_key, command_fingerprint,
          occurred_at, received_at, recorded_at, arrival_class,
          effect_disposition, status, next_attempt_at, policy_version,
          policy_signature, retention_policy, retention_until)
       VALUES
         ('external_interface', $1::uuid, 'external:I10', $2::integer,
          $3::uuid, $4::integer, 'I10', 'inbound', $5::text, $6::bigint,
          $7::text, $8::text, $9::text, $10::char(64), $11::timestamptz,
          NOW(), NOW(), 'recovery_backlog', 'late_pending_only', 'pending',
          NOW(), $12::text, $13::text, $14::text, $15::timestamptz)
       RETURNING inbox_id::text, source_position::text, source_token,
                 duplicate_key, command_fingerprint, status, arrival_class,
                 effect_disposition, occurred_at`,
      tid,
      offset.generation,
      oid,
      offset.facility_id,
      offset.source_partition,
      position,
      token,
      predecessor,
      duplicate,
      fingerprint,
      occurred,
      offset.policy_version,
      offset.policy_signature,
      offset.retention_policy,
      offset.retention_until,
    );
    return rows[0];
  }, { isolationLevel: 'Serializable' });

  if (result.conflict) {
    await markSourceGap(tid, oid, 'duplicate_or_position_fingerprint_conflict');
    throw AppError.conflict(
      'Cold-chain recovery identity was reused with different evidence',
      'EXTERNAL_RECOVERY_IDENTITY_CONFLICT',
    );
  }
  return result;
}

function matchesQueuedItem(row, {
  sourcePosition,
  sourceToken,
  predecessorToken,
  duplicateKey,
  fingerprint,
}) {
  return (
    row.source_position === sourcePosition
    && row.source_token === sourceToken
    && row.predecessor_token === predecessorToken
    && row.duplicate_key === duplicateKey
    && row.command_fingerprint === fingerprint
  );
}

export async function processNextItemTx({
  tenantId,
  offsetId,
  sourcePosition,
  sourceToken,
  predecessorToken,
  duplicateKey,
  command,
  leaseOwner = randomUUID(),
} = {}) {
  const tid = requireTenantId(tenantId);
  const oid = requireUuid(offsetId, 'offset_id');
  const position = requirePosition(sourcePosition, 'source_position');
  const token = requireText(sourceToken, 'source_token', 255);
  const predecessor = requireText(predecessorToken, 'predecessor_token', 255);
  const duplicate = requireText(duplicateKey, 'duplicate_key', 255);
  const owner = requireUuid(leaseOwner, 'lease_owner');
  const fingerprint = canonicalCommandFingerprint(command);

  return setTenantTx(tid, async (tx) => {
    const offset = await loadOffsetTx(tx, tid, oid, { lock: true });
    if (!offset) {
      throw AppError.notFound('Cold-chain recovery offset not found', 'EXTERNAL_RECOVERY_OFFSET_NOT_FOUND');
    }
    if (offset.recovery_state !== 'replaying') {
      throw AppError.conflict(
        'Cold-chain recovery offset is not in owner-authorized replay',
        'EXTERNAL_RECOVERY_OFFSET_NOT_REPLAYING',
      );
    }
    if (offset.high_water_position === null || offset.high_water_token === null) {
      throw AppError.conflict(
        'Cold-chain recovery marker is missing',
        'EXTERNAL_RECOVERY_MARKER_MISSING',
      );
    }

    const rows = await tx.$queryRawUnsafe(
      `SELECT inbox_id::text, tenant_id::text, facility_id, offset_id::text,
              generation, source_position::text, source_token, predecessor_token,
              duplicate_key, command_fingerprint, occurred_at::text, arrival_class,
              effect_disposition, status, attempts, outcome_code, pending_task_id
         FROM pathway_projector_inbox
        WHERE tenant_id = $1::uuid
          AND offset_id = $2::uuid
          AND scope_kind = 'external_interface'
          AND status = 'pending'
          AND next_attempt_at <= NOW()
        ORDER BY source_position
        LIMIT 1
        FOR UPDATE`,
      tid,
      oid,
    );
    const inbox = rows[0];
    if (!inbox) return null;
    if (!matchesQueuedItem(inbox, {
      sourcePosition: position,
      sourceToken: token,
      predecessorToken: predecessor,
      duplicateKey: duplicate,
      fingerprint,
    })) {
      throw AppError.conflict(
        'Worker command does not match the next durable recovery item',
        'EXTERNAL_RECOVERY_COMMAND_MISMATCH',
      );
    }

    const expectedPosition = (BigInt(offset.high_water_position) + 1n).toString();
    if (
      inbox.source_position !== expectedPosition
      || inbox.predecessor_token !== offset.high_water_token
    ) {
      await tx.$executeRawUnsafe(
        `UPDATE event_consumer_offsets
            SET recovery_state = 'reconciliation_required_source_gap',
                reconciliation_reason = 'non_contiguous_source_item',
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
        tid,
        oid,
      );
      return Object.freeze({ held: true, reason: 'source_gap', inbox_id: inbox.inbox_id });
    }
    if (
      offset.retained_from_position !== null
      && BigInt(offset.retained_from_position) > BigInt(expectedPosition)
    ) {
      await tx.$executeRawUnsafe(
        `UPDATE event_consumer_offsets
            SET recovery_state = 'reconciliation_required_retention_gap',
                reconciliation_reason = 'marker_precedes_retained_source',
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND offset_id = $2::uuid`,
        tid,
        oid,
      );
      return Object.freeze({ held: true, reason: 'retention_gap', inbox_id: inbox.inbox_id });
    }

    const claimed = await tx.$queryRawUnsafe(
      `UPDATE pathway_projector_inbox
          SET lease_owner = $3::uuid,
              lease_expires_at = NOW() + INTERVAL '5 minutes',
              attempts = attempts + 1
        WHERE tenant_id = $1::uuid
          AND inbox_id = $2::uuid
          AND status = 'pending'
          AND lease_owner IS NULL
        RETURNING attempts`,
      tid,
      inbox.inbox_id,
      owner,
    );
    if (claimed.length !== 1) {
      throw AppError.conflict(
        'Cold-chain recovery claim fence was lost',
        'EXTERNAL_RECOVERY_CLAIM_FENCE_LOST',
      );
    }

    await tx.$executeRawUnsafe(
      `SELECT set_config(
         'app.external_recovery_effect_disposition',
         $1::text,
         true
       )`,
      inbox.effect_disposition,
    );
    const capability = mintExternalRecoveryCapability({
      inboxId: inbox.inbox_id,
      tenantId: tid,
      facilityId: inbox.facility_id,
      effectDisposition: inbox.effect_disposition,
    });
    const domain = await persistLateColdChainRecovery({
      tx,
      capability,
      tenantId: tid,
      facilityId: inbox.facility_id,
      recoveryInboxId: inbox.inbox_id,
      occurredAt: inbox.occurred_at,
      command,
    });
    if (!domain?.reading?.id || !domain?.task?.id) {
      throw AppError.internal(
        'Late cold-chain recovery did not produce required pending work',
        'EXTERNAL_RECOVERY_PENDING_WORK_MISSING',
      );
    }

    const terminal = await tx.$queryRawUnsafe(
      `UPDATE pathway_projector_inbox
          SET status = 'handled',
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = NULL,
              outcome_at = NOW(),
              outcome_code = 'cold_chain_reading_pending_review',
              pending_task_id = $4::integer
        WHERE tenant_id = $1::uuid
          AND inbox_id = $2::uuid
          AND status = 'pending'
          AND lease_owner = $3::uuid
        RETURNING inbox_id::text, status, attempts, outcome_code,
                  pending_task_id, outcome_at`,
      tid,
      inbox.inbox_id,
      owner,
      domain.task.id,
    );
    if (terminal.length !== 1) {
      throw AppError.conflict(
        'Cold-chain recovery terminal fence was lost',
        'EXTERNAL_RECOVERY_CLAIM_FENCE_LOST',
      );
    }

    const advanced = await tx.$queryRawUnsafe(
      `UPDATE event_consumer_offsets
          SET high_water_position = $3::bigint,
              high_water_token = $4::text,
              recovery_state = CASE
                WHEN resume_cutoff_position = $3::bigint THEN 'ready'
                ELSE 'replaying'
              END,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND offset_id = $2::uuid
          AND recovery_state = 'replaying'
          AND high_water_position = $5::bigint
          AND high_water_token = $6::text
        RETURNING high_water_position::text, high_water_token, recovery_state`,
      tid,
      oid,
      inbox.source_position,
      inbox.source_token,
      offset.high_water_position,
      offset.high_water_token,
    );
    if (advanced.length !== 1) {
      throw AppError.conflict(
        'Cold-chain recovery cursor fence was lost',
        'EXTERNAL_RECOVERY_CURSOR_FENCE_LOST',
      );
    }

    return Object.freeze({
      ...terminal[0],
      cursor: advanced[0],
      reading_id: String(domain.reading.id),
    });
  }, { isolationLevel: 'Serializable' });
}

export function isCanonicalRecoveryFingerprint(value) {
  return SHA256_PATTERN.test(String(value || ''));
}

export const externalInterfaceRecoveryService = Object.freeze({
  registerColdChainRecoveryOffset,
  authorizeColdChainRecoveryResume,
  enqueueColdChainRecoveryItem,
  processNextItemTx,
});

export default externalInterfaceRecoveryService;

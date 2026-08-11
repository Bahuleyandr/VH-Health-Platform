// src/services/devices/deviceAssociationService.js

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { recordClinicalAuditEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { canManageDeviceAssociation } from '../../utils/roleHelpers.js';
import { normalizeRole } from '../../utils/roles.js';

const START_METHODS = new Set(['scan', 'manual', 'adt']);
const END_REASONS = new Set(['manual', 'device_reassigned', 'discharge', 'transfer', 'device_retired', 'ttl_expired']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ASSOCIATION_SELECT = `
  a.id, a.tenant_id, a.device_registry_id, d.device_code, d.display_name AS device_name,
  d.kind AS device_kind, a.channel, a.patient_uid, a.bed_id, a.started_at,
  a.started_by, a.start_method, a.ended_at, a.ended_by, a.end_reason, a.metadata
`;
const ASSOCIATION_SELECT_WITH_POLICY = `${ASSOCIATION_SELECT}, d.metadata AS device_metadata`;

function safeText(value, max = 255) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function normalizeChannel(value) {
  return safeText(value, 80) || '';
}

function normalizeUuid(value, label) {
  const text = safeText(value, 80);
  if (!text || !UUID_RE.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function maybeUuid(value, label) {
  if (value === null || value === undefined || value === '') return null;
  return normalizeUuid(value, label);
}

function optionalUuid(value) {
  const text = safeText(value, 80);
  return text && UUID_RE.test(text) ? text : null;
}

function positiveInt(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function startMethod(value) {
  const text = safeText(value, 20) || 'manual';
  if (!START_METHODS.has(text)) {
    throw AppError.badRequest('start_method must be one of: scan, manual, adt');
  }
  return text;
}

function endReason(value) {
  const text = safeText(value, 40) || 'manual';
  if (!END_REASONS.has(text)) {
    throw AppError.badRequest('end_reason must be one of: manual, device_reassigned, discharge, transfer, device_retired, ttl_expired');
  }
  return text;
}

function jsonObject(value) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest('metadata must be a JSON object');
  }
  return value;
}

async function resolveDevice(db, tenantId, { deviceId = null, deviceCode = null } = {}) {
  const filters = ['tenant_id = $1::uuid', 'status = \'active\''];
  const params = [tenantId];
  if (deviceId) {
    params.push(positiveInt(deviceId, 'device_id'));
    filters.push(`id = $${params.length}`);
  } else if (safeText(deviceCode, 120)) {
    params.push(safeText(deviceCode, 120));
    filters.push(`device_code = $${params.length}`);
  } else {
    throw AppError.badRequest('device_id or device_code is required', 'DEVICE_REQUIRED');
  }
  const rows = await db.$queryRawUnsafe(
    `SELECT id, device_code, display_name, kind
       FROM device_registry
      WHERE ${filters.join(' AND ')}
      LIMIT 1`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Active device not found', 'DEVICE_NOT_FOUND');
  return rows[0];
}

async function assertPatient(db, tenantId, patientUid) {
  const rows = await db.$queryRawUnsafe(
    `SELECT uid, role, is_active, status, is_deleted, deleted_at, merged_into_uid
       FROM users
      WHERE uid = $1::uuid
        AND tenant_id = $2::uuid
        AND role = 'PATIENT'
        AND is_active = TRUE
        AND status = 'active'
        AND is_deleted IS FALSE
        AND deleted_at IS NULL
        AND merged_into_uid IS NULL
      LIMIT 1
      FOR SHARE`,
    patientUid,
    tenantId,
  );
  const patient = rows[0];
  if (
    !patient
    || normalizeRole(patient.role) !== 'PATIENT'
    || patient.is_active !== true
    || String(patient.status || '').trim().toLowerCase() !== 'active'
    || patient.is_deleted !== false
    || patient.deleted_at !== null
    || patient.merged_into_uid !== null
  ) {
    throw AppError.notFound('Patient not found', 'DEVICE_ASSOCIATION_PATIENT_NOT_FOUND');
  }
}

async function assertAssociationOperator(db, tenantId, actorUid, claimedRole) {
  const uid = normalizeUuid(actorUid, 'actor uid');
  const role = normalizeRole(claimedRole);
  if (!canManageDeviceAssociation(role)) {
    throw AppError.forbidden(
      'Current actor is not authorized to manage device associations',
      'DEVICE_ASSOCIATION_OPERATOR_FORBIDDEN',
    );
  }
  const rows = await db.$queryRawUnsafe(
    `SELECT actor.uid, actor.role, actor.is_active, actor.status,
            actor.is_deleted, actor.deleted_at
       FROM users actor
      WHERE actor.tenant_id = $1::uuid
        AND actor.uid = $2::uuid
      LIMIT 1
      FOR SHARE`,
    tenantId,
    uid,
  );
  const actor = rows[0];
  if (
    !actor
    || actor.is_active !== true
    || String(actor.status || '').trim().toLowerCase() !== 'active'
    || actor.is_deleted !== false
    || actor.deleted_at !== null
    || normalizeRole(actor.role) !== role
    || !canManageDeviceAssociation(actor.role)
  ) {
    throw AppError.forbidden(
      'Current actor is not authorized to manage device associations',
      'DEVICE_ASSOCIATION_OPERATOR_FORBIDDEN',
    );
  }
}

async function assertBed(db, tenantId, bedId) {
  if (!bedId) return;
  const rows = await db.$queryRawUnsafe(
    `SELECT id FROM beds WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    bedId,
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Bed not found', 'DEVICE_ASSOCIATION_BED_NOT_FOUND');
}

async function auditAssociation(db, {
  tenantId,
  patientUid,
  actorUid,
  actorRole,
  action,
  association,
  beforeState = null,
  afterState = null,
  metadata = {},
}) {
  await recordClinicalAuditEvent({
    tenantId,
    patientUid,
    action,
    actorUid,
    actorRole,
    resourceType: 'device_association',
    resourceTable: 'device_patient_associations',
    resourceId: String(association.id),
    beforeState,
    afterState,
    metadata,
    idempotencyKey: `${action}:${association.id}:${association.ended_at || association.started_at}`,
  }, { db });
}

function configuredTtlMinutes(deviceMetadata = {}) {
  const metadata = deviceMetadata && typeof deviceMetadata === 'object' ? deviceMetadata : {};
  const nested = metadata.association_reconfirm && typeof metadata.association_reconfirm === 'object'
    ? metadata.association_reconfirm
    : {};
  if (nested.enabled === false || metadata.association_reconfirm_enabled === false) return null;
  const raw = nested.ttl_minutes
    ?? nested.ttlMinutes
    ?? metadata.association_reconfirm_ttl_minutes
    ?? metadata.associationReconfirmTtlMinutes;
  if (raw === null || raw === undefined || raw === '') return null;
  const minutes = Number.parseInt(raw, 10);
  if (!Number.isInteger(minutes) || minutes <= 0) return null;
  return Math.min(minutes, 7 * 24 * 60);
}

async function expireAssociationIfStale(db, association) {
  const ttlMinutes = configuredTtlMinutes(association?.device_metadata);
  if (!ttlMinutes || !association?.started_at) return false;
  const startedAt = new Date(association.started_at).getTime();
  if (!Number.isFinite(startedAt)) return false;
  if (Date.now() - startedAt < ttlMinutes * 60 * 1000) return false;

  const rows = await db.$queryRawUnsafe(
    `UPDATE device_patient_associations
        SET ended_at = NOW(),
            ended_by = NULL,
            end_reason = 'ttl_expired',
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2
        AND ended_at IS NULL
      RETURNING *`,
    association.tenant_id,
    association.id,
  );
  const expired = rows[0];
  if (!expired) return true;
  await auditAssociation(db, {
    tenantId: association.tenant_id,
    patientUid: association.patient_uid,
    actorUid: null,
    actorRole: 'DEVICE_ASSOCIATION_TTL',
    action: 'device.association_ended',
    association: expired,
    afterState: { ended_at: expired.ended_at, end_reason: 'ttl_expired' },
    metadata: {
      reason: 'ttl_expired',
      ttl_minutes: ttlMinutes,
      device_code: association.device_code,
      channel: association.channel || '',
    },
  });
  return true;
}

export async function listAssociations({
  tenantId,
  activeOnly = true,
  patientUid = null,
  deviceId = null,
  limit = 100,
} = {}) {
  const tid = requireTenantId(tenantId);
  const params = [tid];
  const where = ['a.tenant_id = $1::uuid'];
  if (activeOnly) where.push('a.ended_at IS NULL');
  if (patientUid) {
    params.push(normalizeUuid(patientUid, 'patient_uid'));
    where.push(`a.patient_uid = $${params.length}::uuid`);
  }
  if (deviceId) {
    params.push(positiveInt(deviceId, 'device_id'));
    where.push(`a.device_registry_id = $${params.length}`);
  }
  params.push(Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500)));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${ASSOCIATION_SELECT}
       FROM device_patient_associations a
       JOIN device_registry d ON d.id = a.device_registry_id AND d.tenant_id = a.tenant_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.started_at DESC
      LIMIT $${params.length}::int`,
    ...params,
  );
  return { associations: rows, count: rows.length };
}

export async function resolveActiveAssociation({
  tenantId,
  deviceId = null,
  deviceCode = null,
  channel = '',
} = {}, options = {}) {
  const tid = requireTenantId(tenantId);
  const db = options.db || prisma;
  const chan = normalizeChannel(channel);
  const params = [tid, chan];
  let deviceFilter;
  if (deviceId) {
    params.push(positiveInt(deviceId, 'device_id'));
    deviceFilter = `d.id = $${params.length}`;
  } else if (safeText(deviceCode, 120)) {
    params.push(safeText(deviceCode, 120));
    deviceFilter = `d.device_code = $${params.length}`;
  } else {
    throw AppError.badRequest('device_id or device_code is required', 'DEVICE_REQUIRED');
  }
  const rows = await db.$queryRawUnsafe(
    `SELECT ${ASSOCIATION_SELECT_WITH_POLICY}
       FROM device_patient_associations a
       JOIN device_registry d ON d.id = a.device_registry_id AND d.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1::uuid
        AND a.channel = $2
        AND a.ended_at IS NULL
        AND ${deviceFilter}
      LIMIT 1`,
    ...params,
  );
  if (!rows[0]) return null;
  if (await expireAssociationIfStale(db, rows[0])) return null;
  const { device_metadata: _deviceMetadata, ...association } = rows[0];
  return association;
}

export async function associateDevicePatient(input = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId || input.tenantId);
  const patientUid = normalizeUuid(input.patient_uid ?? input.patientUid, 'patient_uid');
  const channel = normalizeChannel(input.channel);
  const method = startMethod(input.start_method ?? input.startMethod);
  const bedId = positiveInt(input.bed_id ?? input.bedId, 'bed_id');
  const metadata = jsonObject(input.metadata);
  const actorUid = maybeUuid(context.actorUid, 'actor uid');
  const actorRole = safeText(context.actorRole, 80);

  return setTenantTx(tenantId, async (tx) => {
    await assertAssociationOperator(tx, tenantId, actorUid, actorRole);
    const device = await resolveDevice(tx, tenantId, {
      deviceId: input.device_id ?? input.deviceId,
      deviceCode: input.device_code ?? input.deviceCode,
    });
    await assertPatient(tx, tenantId, patientUid);
    await assertBed(tx, tenantId, bedId);

    const priorRows = await tx.$queryRawUnsafe(
      `UPDATE device_patient_associations
          SET ended_at = NOW(),
              ended_by = $5::uuid,
              end_reason = 'device_reassigned',
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND device_registry_id = $2
          AND channel = $3
          AND ended_at IS NULL
        RETURNING *`,
      tenantId,
      device.id,
      channel,
      patientUid,
      actorUid,
    );

    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO device_patient_associations
         (tenant_id, device_registry_id, channel, patient_uid, bed_id, started_by, start_method, metadata)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5::int, $6::uuid, $7, $8::jsonb)
       RETURNING *`,
      tenantId,
      device.id,
      channel,
      patientUid,
      bedId,
      actorUid,
      method,
      JSON.stringify(metadata),
    );
    const association = inserted[0];

    for (const prior of priorRows) {
      await auditAssociation(tx, {
        tenantId,
        patientUid: prior.patient_uid,
        actorUid,
        actorRole,
        action: 'device.association_ended',
        association: prior,
        afterState: { ended_at: prior.ended_at, end_reason: 'device_reassigned' },
        metadata: { device_code: device.device_code, channel },
      });
    }
    await auditAssociation(tx, {
      tenantId,
      patientUid,
      actorUid,
      actorRole,
      action: 'device.associated',
      association,
      afterState: { patient_uid: patientUid, device_registry_id: device.id, channel, start_method: method },
      metadata: { device_code: device.device_code, bed_id: bedId, ...metadata },
    });

    return {
      ...association,
      device_code: device.device_code,
      device_name: device.display_name,
      device_kind: device.kind,
    };
  });
}

export async function disconnectAssociation(input = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId || input.tenantId);
  const associationId = positiveInt(input.id, 'association id');
  const reason = endReason(input.end_reason ?? input.endReason ?? 'manual');
  const actorUid = maybeUuid(context.actorUid, 'actor uid');
  const actorRole = safeText(context.actorRole, 80);

  return setTenantTx(tenantId, async (tx) => {
    await assertAssociationOperator(tx, tenantId, actorUid, actorRole);
    const rows = await tx.$queryRawUnsafe(
      `UPDATE device_patient_associations
          SET ended_at = NOW(),
              ended_by = $3::uuid,
              end_reason = $4,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2 AND ended_at IS NULL
        RETURNING *`,
      tenantId,
      associationId,
      actorUid,
      reason,
    );
    if (!rows[0]) throw AppError.notFound('Active device association not found', 'DEVICE_ASSOCIATION_NOT_FOUND');
    await auditAssociation(tx, {
      tenantId,
      patientUid: rows[0].patient_uid,
      actorUid,
      actorRole,
      action: 'device.association_ended',
      association: rows[0],
      afterState: { ended_at: rows[0].ended_at, end_reason: reason },
      metadata: { reason },
    });
    return rows[0];
  });
}

export async function endActiveAssociationsForPatient({
  tenantId,
  patientUid,
  reason,
  actorUid = null,
  actorRole = null,
} = {}, options = {}) {
  const tid = requireTenantId(tenantId);
  const uid = normalizeUuid(patientUid, 'patient_uid');
  const cleanReason = endReason(reason);
  const actor = optionalUuid(actorUid);
  const db = options.db || prisma;
  let rows;
  try {
    rows = await db.$queryRawUnsafe(
      `UPDATE device_patient_associations
          SET ended_at = NOW(),
              ended_by = $3::uuid,
              end_reason = $4,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND ended_at IS NULL
        RETURNING *`,
      tid,
      uid,
      actor,
      cleanReason,
    );
  } catch (err) {
    const cause = err?.meta?.driverAdapterError?.cause;
    if (cause?.originalCode === '42P01' || cause?.code === '42P01') {
      return [];
    }
    throw err;
  }
  for (const association of rows) {
    await auditAssociation(db, {
      tenantId: tid,
      patientUid: uid,
      actorUid: actor,
      actorRole: safeText(actorRole, 80),
      action: 'device.association_ended',
      association,
      afterState: { ended_at: association.ended_at, end_reason: cleanReason },
      metadata: { reason: cleanReason },
    });
  }
  return rows;
}

export default {
  listAssociations,
  resolveActiveAssociation,
  associateDevicePatient,
  disconnectAssociation,
  endActiveAssociationsForPatient,
};

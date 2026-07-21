import PDFDocument from 'pdfkit';

import { COLD_CHAIN_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { emitColdChainEvent } from '../../utils/websocket/realtimeEmitter.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { authenticateDeviceCredential } from './deviceRegistryService.js';
import {
  acknowledgeColdChainTaskFromTrustedWorkflow,
  createTask,
  getTask,
  transitionTask,
} from '../workflow/taskService.js';
import { startWorkflowSla } from '../clinical/canonicalClinicalPlatformService.js';

const COLD_CHAIN_SLA_KEY = 'cold_chain_excursion_ack';
const COLD_CHAIN_ALERT_ROLE_ERROR_CODE = 'COLD_CHAIN_ALERT_ROLE_INVALID';
const TASK_MATERIALIZATION_CONTRACT = 'application_atomic_v1';

const UNIT_KINDS = ['fridge', 'freezer', 'ilr', 'ambient'];
const DEPARTMENTS = ['pharmacy', 'blood_bank', 'lab', 'ward', 'ot'];
const UNIT_STATUSES = ['active', 'paused', 'retired'];
const DEFAULT_ALERT_ROLES = Object.freeze({
  pharmacy: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
  blood_bank: ['BLOOD_BANK_TECHNICIAN', 'LAB_INCHARGE'],
  lab: ['LAB_STAFF', 'LAB_INCHARGE'],
  ward: ['NURSING_STAFF', 'NURSING_INCHARGE'],
  ot: ['OT_NURSE', 'OT_INCHARGE'],
});

const DEFAULT_GRACE_MINUTES = Object.freeze({
  pharmacy: 15,
  blood_bank: 5,
  lab: 10,
  ward: 15,
  ot: 10,
});
const COLD_CHAIN_ALERT_ROLE_SET = new Set(COLD_CHAIN_ROUTE_ROLES);

function cleanText(value, max = 255) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function normalizeEnum(value, allowed, label, fallback = null) {
  const text = cleanText(value, 80) || fallback;
  if (!text || !allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function normalizePositiveInt(value, label, { required = false, min = 1, max = null } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function normalizeNumber(value, label, { required = false, min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be numeric`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return Number(parsed.toFixed(2));
}

function normalizeTimestamp(value, label, fallback = new Date()) {
  if (value === null || value === undefined || value === '') return fallback.toISOString();
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw AppError.badRequest(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function jsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function normalizeRoles(value, department) {
  const fallback = DEFAULT_ALERT_ROLES[department] || DEFAULT_ALERT_ROLES.pharmacy;
  if (value === null || value === undefined || value === '') return fallback;
  if (!Array.isArray(value)) {
    throw AppError.badRequest(
      'alert_roles must be an array of permitted cold-chain staff roles',
      COLD_CHAIN_ALERT_ROLE_ERROR_CODE,
    );
  }
  const normalized = value.map((role) => cleanText(role, 80));
  const invalidRoles = normalized
    .filter((role) => !role || !COLD_CHAIN_ALERT_ROLE_SET.has(role))
    .map((role) => role || '<blank>');
  if (invalidRoles.length > 0) {
    throw AppError.badRequest(
      `alert_roles contains roles not permitted for cold-chain operations: ${invalidRoles.join(', ')}`,
      COLD_CHAIN_ALERT_ROLE_ERROR_CODE,
      { invalid_roles: invalidRoles },
    );
  }
  const roles = [...new Set(normalized)];
  return roles.length > 0 ? roles : fallback;
}

function resolveLiveAlertRoles(unit, { tenantId, eventKind }) {
  try {
    return {
      alertRoles: normalizeRoles(unit.alert_roles, unit.department),
      alertRoleDegradation: null,
    };
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== COLD_CHAIN_ALERT_ROLE_ERROR_CODE) throw err;
    const fallbackRoles = [...defaultAlertRoles(unit.department)];
    const alertRoleDegradation = {
      status: 'degraded',
      code: err.code,
      message: err.message,
      invalid_roles: err.details?.invalid_roles || [],
      fallback_roles: fallbackRoles,
    };
    logger.error('Cold-chain alert roles degraded to safe department defaults', {
      tenantId,
      unitId: unit.id,
      eventKind,
      ...alertRoleDegradation,
    });
    return { alertRoles: fallbackRoles, alertRoleDegradation };
  }
}

function monthRange(month) {
  const text = cleanText(month, 20);
  if (!/^\d{4}-\d{2}$/.test(text || '')) {
    throw AppError.badRequest('month must be YYYY-MM', 'COLD_CHAIN_MONTH_INVALID');
  }
  const start = new Date(`${text}-01T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start: start.toISOString(), end: end.toISOString(), label: text };
}

function formatDateTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function defaultAlertRoles(department) {
  return DEFAULT_ALERT_ROLES[department] || DEFAULT_ALERT_ROLES.pharmacy;
}

export function isReadingOutOfRange(unit, tempC) {
  const temp = Number(tempC);
  return temp < Number(unit.min_temp_c) || temp > Number(unit.max_temp_c);
}

export function breachSurvivedGrace({ breachStartedAt, observedAt, graceMinutes }) {
  const start = new Date(breachStartedAt).getTime();
  const end = new Date(observedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return (end - start) / 60000 >= Number(graceMinutes || 0);
}

function severityFor(unit, tempC, direction) {
  if (unit.department === 'blood_bank') return 'critical';
  const temp = Number(tempC);
  if (direction === 'low' && Number(unit.min_temp_c) - temp >= 2) return 'critical';
  if (direction === 'high' && temp - Number(unit.max_temp_c) >= 2) return 'critical';
  return 'warning';
}

function breachDirection(unit, tempC) {
  return Number(tempC) < Number(unit.min_temp_c) ? 'low' : 'high';
}

async function requireFridgeSensor(tx, { tenantId, deviceRegistryId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, kind, status
       FROM device_registry
      WHERE tenant_id = $1::uuid
        AND id = $2::int
      LIMIT 1`,
    tenantId,
    deviceRegistryId,
  );
  const device = rows[0];
  if (!device) throw AppError.badRequest('device_registry_id does not exist', 'COLD_CHAIN_DEVICE_NOT_FOUND');
  if (device.kind !== 'fridge_sensor') {
    throw AppError.badRequest('device_registry_id must reference a fridge_sensor', 'COLD_CHAIN_DEVICE_KIND_INVALID');
  }
  if (device.status !== 'active') {
    throw AppError.badRequest('device_registry_id must be active', 'COLD_CHAIN_DEVICE_NOT_ACTIVE');
  }
  return device;
}

async function findUnit(tx, { tenantId, unitId = null, unitCode = null, deviceRegistryId = null, activeOnly = false }) {
  const filters = ['u.tenant_id = $1::uuid'];
  const params = [tenantId];
  if (activeOnly) filters.push("u.status = 'active'");
  if (unitId) {
    params.push(normalizePositiveInt(unitId, 'unit_id'));
    filters.push(`u.id = $${params.length}::int`);
  }
  if (unitCode) {
    params.push(cleanText(unitCode, 120));
    filters.push(`u.unit_code = $${params.length}`);
  }
  if (deviceRegistryId) {
    params.push(normalizePositiveInt(deviceRegistryId, 'device_registry_id'));
    filters.push(`u.device_registry_id = $${params.length}::int`);
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT u.*,
            d.device_code,
            d.display_name AS device_name,
            d.last_seen_at,
            d.expected_interval_seconds
       FROM cold_chain_units u
       JOIN device_registry d
         ON d.id = u.device_registry_id
        AND d.tenant_id = u.tenant_id
      WHERE ${filters.join(' AND ')}
      ORDER BY u.id
      LIMIT 2`,
    ...params,
  );
  if (rows.length > 1) throw AppError.conflict('Multiple cold-chain units matched; include unit_id or unit_code');
  return rows[0] || null;
}

async function findActiveExcursion(tx, { tenantId, unitId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM cold_chain_excursions
      WHERE tenant_id = $1::uuid
        AND unit_id = $2::int
        AND status IN ('open', 'acknowledged')
      ORDER BY opened_at DESC
      LIMIT 1`,
    tenantId,
    unitId,
  );
  return rows[0] || null;
}

async function findBreachWindow(tx, { tenantId, unit, observedAt }) {
  const rows = await tx.$queryRawUnsafe(
    `WITH boundary AS (
       SELECT COALESCE(MAX(recorded_at), '-infinity'::timestamptz) AS last_in_range_at
         FROM cold_chain_readings
        WHERE tenant_id = $1::uuid
          AND unit_id = $2::int
          AND recorded_at <= $3::timestamptz
          AND temp_c BETWEEN $4::numeric AND $5::numeric
     )
     SELECT MIN(r.recorded_at) AS breach_started_at,
            MAX(r.recorded_at) AS last_out_of_range_at,
            MIN(r.temp_c)::float AS min_seen_temp_c,
            MAX(r.temp_c)::float AS max_seen_temp_c,
            COUNT(*)::int AS reading_count
       FROM cold_chain_readings r
       CROSS JOIN boundary b
      WHERE r.tenant_id = $1::uuid
        AND r.unit_id = $2::int
        AND r.recorded_at > b.last_in_range_at
        AND r.recorded_at <= $3::timestamptz
        AND (r.temp_c < $4::numeric OR r.temp_c > $5::numeric)`,
    tenantId,
    unit.id,
    observedAt,
    Number(unit.min_temp_c),
    Number(unit.max_temp_c),
  );
  return rows[0] || null;
}

async function latestReading(tx, { tenantId, unitId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM cold_chain_readings
      WHERE tenant_id = $1::uuid
        AND unit_id = $2::int
      ORDER BY recorded_at DESC, id DESC
      LIMIT 1`,
    tenantId,
    unitId,
  );
  return rows[0] || null;
}

async function completeTaskIfPossible({ tenantId, taskId, tx }) {
  if (!taskId) return null;
  let lastConflict = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await transitionTask({
        tenantId,
        id: taskId,
        nextStatus: 'completed',
        tx,
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'INVALID_STATE_TRANSITION') return null;
      if (!(err instanceof AppError) || err.code !== 'TASK_TRANSITION_CONFLICT') throw err;
      lastConflict = err;
      const latest = await getTask({ tenantId, id: taskId, tx });
      if (latest.status === 'completed' || latest.status === 'cancelled') return latest;
      if (!['open', 'in_progress', 'overdue'].includes(latest.status)) return null;
    }
  }
  throw lastConflict;
}

async function wireAlertRails(tx, {
  tenantId,
  unit,
  excursion,
  alertRoles,
  alertRoleDegradation = null,
  actorUid = null,
  eventKind,
}) {
  const roles = alertRoles;
  const roleResolutionMetadata = alertRoleDegradation
    ? { alert_role_degradation: alertRoleDegradation }
    : {};
  const sla = await startWorkflowSla({
    tenantId,
    ruleCode: COLD_CHAIN_SLA_KEY,
    sourceTable: 'cold_chain_excursions',
    sourceId: String(excursion.id),
    priority: excursion.severity === 'critical' ? 'critical' : 'high',
    assignedRoleCodes: roles,
    metadata: {
      unit_id: unit.id,
      department: unit.department,
      event_kind: eventKind,
      task_materialization_contract: TASK_MATERIALIZATION_CONTRACT,
      ...roleResolutionMetadata,
    },
  }, { db: tx, strict: true });
  const slaPolicyMissing = !sla;
  if (
    sla
    && (
      !sla.id
      || sla.completed_at != null
      || !['active', 'breached', 'escalated'].includes(String(sla.status || '').toLowerCase())
    )
  ) {
    throw AppError.conflict(
      'Cold-chain acknowledgement SLA could not be started as an active clock',
      'COLD_CHAIN_SLA_MATERIALIZATION_FAILED',
    );
  }
  const taskSlaFields = slaPolicyMissing
    ? { slaCompletionSemantics: 'none' }
    : {
        workflowSlaInstanceId: sla.id,
        slaCompletionSemantics: 'acknowledgement',
      };
  const taskSlaMetadata = slaPolicyMissing
    ? {
        requested_sla_key: COLD_CHAIN_SLA_KEY,
        sla_policy_status: 'missing',
      }
    : { sla_key: COLD_CHAIN_SLA_KEY };
  let task = await createTask({
    tenantId,
    taskKind: 'review',
    title: `Cold-chain ${eventKind === 'silent_sensor' ? 'sensor silence' : 'excursion'}: ${unit.unit_code}`,
    description: eventKind === 'silent_sensor'
      ? `${unit.display_name} has not reported within three expected intervals.`
      : `${unit.display_name} is outside ${unit.min_temp_c}-${unit.max_temp_c} C and needs acknowledgement.`,
    relatedResourceType: 'cold_chain_excursions',
    relatedResourceId: String(excursion.id),
    priority: excursion.severity === 'critical' ? 'critical' : 'high',
    assignedToRole: roles[0] || null,
    createdBy: actorUid,
    ...taskSlaFields,
    metadata: {
      ...taskSlaMetadata,
      unit_id: unit.id,
      department: unit.department,
      event_kind: eventKind,
      alert_roles: roles,
      ...roleResolutionMetadata,
    },
    tx,
    onConflictResourceDoNothing: true,
  });
  if (!task?.id) {
    const existing = await tx.$queryRawUnsafe(
      `SELECT id, workflow_sla_instance_id, sla_completion_semantics, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'cold_chain_excursions'
          AND related_resource_id = $2::text
          AND status IN ('open', 'in_progress', 'blocked', 'overdue')
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE`,
      tenantId,
      String(excursion.id),
    );
    task = existing[0] || null;
    const existingMatchesPolicy = slaPolicyMissing
      ? (
          task?.sla_completion_semantics === 'none'
          && !task?.workflow_sla_instance_id
          && task?.metadata?.requested_sla_key === COLD_CHAIN_SLA_KEY
          && task?.metadata?.sla_policy_status === 'missing'
        )
      : (
          task?.sla_completion_semantics === 'acknowledgement'
          && String(task?.workflow_sla_instance_id || '') === String(sla.id)
        );
    if (!task?.id || !existingMatchesPolicy) {
      throw AppError.conflict(
        'Cold-chain task could not be materialized for the resolved SLA policy',
        'COLD_CHAIN_TASK_MATERIALIZATION_FAILED',
      );
    }
  }
  const rows = await tx.$queryRawUnsafe(
    `UPDATE cold_chain_excursions
        SET task_id = COALESCE($3::int, task_id),
            sla_instance_id = COALESCE($4::uuid, sla_instance_id),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
      RETURNING *`,
    tenantId,
    excursion.id,
    task.id,
    sla?.id || null,
  );
  const updated = rows[0];
  if (!updated) {
    throw AppError.conflict(
      'Cold-chain excursion could not be linked to its task and SLA',
      'COLD_CHAIN_RAIL_ATTACHMENT_FAILED',
    );
  }
  if (unit.department === 'blood_bank') {
    await tx.$queryRawUnsafe(
      `INSERT INTO cold_chain_blood_bank_review_flags
         (tenant_id, excursion_id, unit_id)
       VALUES ($1::uuid, $2::bigint, $3::int)
       ON CONFLICT (tenant_id, excursion_id) DO NOTHING`,
      tenantId,
      updated.id,
      unit.id,
    );
  }
  return { excursion: updated, alertRoles: roles };
}

async function queueColdChainNotifications({ tenantId, unit, excursion, alertRoles, eventKind }) {
  const roles = alertRoles;
  const recipients = await prisma.$queryRawUnsafe(
    `SELECT id, uid, phone, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND is_active = true
        AND role = ANY($2::text[])
      ORDER BY role, name NULLS LAST, id`,
    tenantId,
    roles,
  );
  const roleSet = new Set(roles);
  const eligibleRecipients = recipients.filter((recipient) => roleSet.has(recipient.role));
  const title = eventKind === 'silent_sensor' ? 'Cold-chain sensor silent' : 'Cold-chain excursion';
  const body = eventKind === 'silent_sensor'
    ? `${unit.display_name} has missed readings.`
    : `${unit.display_name} is outside range (${excursion.severity}).`;
  let queued = 0;
  for (const recipient of eligibleRecipients) {
    const row = await notificationOutbox.queue({
      type: 'push',
      recipientId: recipient.id,
      recipientPhone: recipient.phone || null,
      title,
      body,
      data: {
        kind: 'cold_chain',
        event_kind: eventKind,
        unit_id: unit.id,
        unit_code: unit.unit_code,
        excursion_id: excursion.id,
        severity: excursion.severity,
        department: unit.department,
      },
    });
    if (row) queued += 1;
  }
  if (queued > 0) {
    await prisma.$queryRawUnsafe(
      `UPDATE cold_chain_excursions
          SET notification_count = notification_count + $3::int,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tenantId,
      excursion.id,
      queued,
    );
  } else {
    logger.warn('Cold-chain notification had no recipients', {
      tenantId,
      unitId: unit.id,
      excursionId: excursion.id,
      alertRoles: roles,
    });
  }
  return { recipients: eligibleRecipients.length, queued };
}

function emitColdChain(kind, { tenantId, unit, excursion }) {
  emitColdChainEvent(kind, {
    tenantId,
    unitId: unit?.id || excursion?.unit_id || null,
    excursionId: excursion?.id || null,
    status: excursion?.status || null,
    severity: excursion?.severity || null,
  });
}

async function closeExcursionIfAllowed(tx, { tenantId, unit, excursion, reading, actorUid = null }) {
  if (!excursion?.corrective_action || !reading || isReadingOutOfRange(unit, reading.temp_c)) {
    if (reading && !isReadingOutOfRange(unit, reading.temp_c)) {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE cold_chain_excursions
            SET returned_in_range_at = COALESCE(returned_in_range_at, $3::timestamptz),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint
          RETURNING *`,
        tenantId,
        excursion.id,
        reading.recorded_at,
      );
      return rows[0] || excursion;
    }
    return excursion;
  }
  await completeTaskIfPossible({ tenantId, taskId: excursion.task_id, tx });
  const rows = await tx.$queryRawUnsafe(
    `UPDATE cold_chain_excursions
        SET status = 'closed',
            returned_in_range_at = COALESCE(returned_in_range_at, $3::timestamptz),
            closed_at = COALESCE(closed_at, NOW()),
            duration_minutes = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (COALESCE($3::timestamptz, NOW()) - breach_started_at)) / 60)::int),
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object('closed_by', $4::text),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
      RETURNING *`,
    tenantId,
    excursion.id,
    reading.recorded_at,
    actorUid || null,
  );
  return rows[0] || excursion;
}

async function openTemperatureExcursion(tx, {
  tenantId,
  unit,
  reading,
  window,
  alertRoles,
  alertRoleDegradation = null,
  actorUid = null,
}) {
  const direction = breachDirection(unit, reading.temp_c);
  const minSeen = Number(window.min_seen_temp_c ?? reading.temp_c);
  const maxSeen = Number(window.max_seen_temp_c ?? reading.temp_c);
  const peak = direction === 'low' ? minSeen : maxSeen;
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO cold_chain_excursions
       (tenant_id, unit_id, breach_started_at, opened_at, last_out_of_range_at,
        breach_direction, peak_temp_c, min_seen_temp_c, max_seen_temp_c,
        duration_minutes, severity, status, metadata)
     VALUES ($1::uuid, $2::int, $3::timestamptz, NOW(), $4::timestamptz,
             $5, $6::numeric, $7::numeric, $8::numeric,
             GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($9::timestamptz - $3::timestamptz)) / 60)::int),
             $10, 'open', $11::jsonb)
     RETURNING *`,
    tenantId,
    unit.id,
    window.breach_started_at,
    window.last_out_of_range_at || reading.recorded_at,
    direction,
    peak,
    minSeen,
    maxSeen,
    reading.recorded_at,
    severityFor(unit, peak, direction),
    JSON.stringify({
      kind: 'temperature_excursion',
      opened_by: actorUid || null,
      ...(alertRoleDegradation ? { alert_role_degradation: alertRoleDegradation } : {}),
    }),
  );
  return wireAlertRails(tx, {
    tenantId,
    unit,
    excursion: rows[0],
    alertRoles,
    alertRoleDegradation,
    actorUid,
    eventKind: 'temperature_excursion',
  });
}

export async function createColdChainUnit(input = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId || input.tenant_id || input.tenantId);
  const department = normalizeEnum(input.department, DEPARTMENTS, 'department');
  const normalized = {
    unitCode: cleanText(input.unit_code ?? input.unitCode, 120),
    displayName: cleanText(input.display_name ?? input.displayName, 255),
    kind: normalizeEnum(input.kind, UNIT_KINDS, 'kind'),
    department,
    locationId: normalizePositiveInt(input.location_id ?? input.locationId, 'location_id'),
    biomedDeviceId: normalizePositiveInt(input.biomed_device_id ?? input.biomedDeviceId, 'biomed_device_id'),
    deviceRegistryId: normalizePositiveInt(input.device_registry_id ?? input.deviceRegistryId, 'device_registry_id', { required: true }),
    minTempC: normalizeNumber(input.min_temp_c ?? input.minTempC, 'min_temp_c', { required: true }),
    maxTempC: normalizeNumber(input.max_temp_c ?? input.maxTempC, 'max_temp_c', { required: true }),
    graceMinutes: normalizePositiveInt(
      input.excursion_grace_minutes ?? input.excursionGraceMinutes,
      'excursion_grace_minutes',
      { min: 1, max: 240 },
    ) || DEFAULT_GRACE_MINUTES[department],
    alertRoles: normalizeRoles(input.alert_roles ?? input.alertRoles, department),
    status: normalizeEnum(input.status, UNIT_STATUSES, 'status', 'active'),
    retentionDays: normalizePositiveInt(input.retention_days ?? input.retentionDays, 'retention_days', { min: 730 }) || 730,
    metadata: jsonObject(input.metadata, 'metadata'),
  };
  if (!normalized.unitCode) throw AppError.badRequest('unit_code is required');
  if (!normalized.displayName) throw AppError.badRequest('display_name is required');
  if (normalized.minTempC >= normalized.maxTempC) throw AppError.badRequest('min_temp_c must be less than max_temp_c');

  return setTenantTx(tenantId, async (tx) => {
    await requireFridgeSensor(tx, { tenantId, deviceRegistryId: normalized.deviceRegistryId });
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cold_chain_units
         (tenant_id, unit_code, display_name, kind, department, location_id, biomed_device_id,
          device_registry_id, min_temp_c, max_temp_c, excursion_grace_minutes, alert_roles,
          status, retention_days, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::int, $7::int,
               $8::int, $9::numeric, $10::numeric, $11::int, $12::text[],
               $13, $14::int, $15::jsonb, $16::uuid)
       RETURNING *`,
      tenantId,
      normalized.unitCode,
      normalized.displayName,
      normalized.kind,
      normalized.department,
      normalized.locationId,
      normalized.biomedDeviceId,
      normalized.deviceRegistryId,
      normalized.minTempC,
      normalized.maxTempC,
      normalized.graceMinutes,
      normalized.alertRoles,
      normalized.status,
      normalized.retentionDays,
      JSON.stringify(normalized.metadata),
      context.actorUid || null,
    );
    return rows[0];
  });
}

export async function updateColdChainUnit({ tenantId, id, patch = {} } = {}) {
  const tid = requireTenantId(tenantId);
  const unitId = normalizePositiveInt(id, 'unit_id', { required: true });
  return setTenantTx(tid, async (tx) => {
    const existing = await findUnit(tx, { tenantId: tid, unitId });
    if (!existing) throw AppError.notFound('Cold-chain unit not found', 'COLD_CHAIN_UNIT_NOT_FOUND');
    const department = normalizeEnum(patch.department ?? existing.department, DEPARTMENTS, 'department', existing.department);
    const deviceRegistryId = normalizePositiveInt(patch.device_registry_id ?? patch.deviceRegistryId ?? existing.device_registry_id, 'device_registry_id', { required: true });
    if (deviceRegistryId !== existing.device_registry_id) {
      await requireFridgeSensor(tx, { tenantId: tid, deviceRegistryId });
    }
    const minTempC = normalizeNumber(patch.min_temp_c ?? patch.minTempC ?? existing.min_temp_c, 'min_temp_c', { required: true });
    const maxTempC = normalizeNumber(patch.max_temp_c ?? patch.maxTempC ?? existing.max_temp_c, 'max_temp_c', { required: true });
    if (minTempC >= maxTempC) throw AppError.badRequest('min_temp_c must be less than max_temp_c');
    const rows = await tx.$queryRawUnsafe(
      `UPDATE cold_chain_units
          SET unit_code = $3,
              display_name = $4,
              kind = $5,
              department = $6,
              location_id = $7::int,
              biomed_device_id = $8::int,
              device_registry_id = $9::int,
              min_temp_c = $10::numeric,
              max_temp_c = $11::numeric,
              excursion_grace_minutes = $12::int,
              alert_roles = $13::text[],
              status = $14,
              retention_days = $15::int,
              metadata = $16::jsonb,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::int
        RETURNING *`,
      tid,
      unitId,
      cleanText(patch.unit_code ?? patch.unitCode ?? existing.unit_code, 120),
      cleanText(patch.display_name ?? patch.displayName ?? existing.display_name, 255),
      normalizeEnum(patch.kind ?? existing.kind, UNIT_KINDS, 'kind', existing.kind),
      department,
      normalizePositiveInt(patch.location_id ?? patch.locationId ?? existing.location_id, 'location_id'),
      normalizePositiveInt(patch.biomed_device_id ?? patch.biomedDeviceId ?? existing.biomed_device_id, 'biomed_device_id'),
      deviceRegistryId,
      minTempC,
      maxTempC,
      normalizePositiveInt(
        patch.excursion_grace_minutes ?? patch.excursionGraceMinutes ?? existing.excursion_grace_minutes,
        'excursion_grace_minutes',
        { min: 1, max: 240 },
      ),
      normalizeRoles(patch.alert_roles ?? patch.alertRoles ?? existing.alert_roles, department),
      normalizeEnum(patch.status ?? existing.status, UNIT_STATUSES, 'status', existing.status),
      normalizePositiveInt(patch.retention_days ?? patch.retentionDays ?? existing.retention_days, 'retention_days', { min: 730 }),
      JSON.stringify(jsonObject(patch.metadata ?? existing.metadata, 'metadata')),
    );
    return rows[0];
  });
}

export async function listColdChainUnits({ tenantId, status = null, department = null, limit = 100 } = {}) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, async (tx) => {
    const params = [tid];
    const filters = ['u.tenant_id = $1::uuid'];
    if (status) {
      params.push(normalizeEnum(status, UNIT_STATUSES, 'status'));
      filters.push(`u.status = $${params.length}`);
    }
    if (department) {
      params.push(normalizeEnum(department, DEPARTMENTS, 'department'));
      filters.push(`u.department = $${params.length}`);
    }
    params.push(Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500)));
    const rows = await tx.$queryRawUnsafe(
      `SELECT u.*,
              d.device_code,
              d.display_name AS device_name,
              d.last_seen_at,
              d.expected_interval_seconds
         FROM cold_chain_units u
         JOIN device_registry d
           ON d.id = u.device_registry_id
          AND d.tenant_id = u.tenant_id
        WHERE ${filters.join(' AND ')}
        ORDER BY u.department, u.display_name
        LIMIT $${params.length}::int`,
      ...params,
    );
    return { units: rows, count: rows.length };
  });
}

export async function ingestColdChainReading(input = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId || input.tenant_id || input.tenantId);
  const token = cleanText(context.bearerToken || input.bearer_token || input.sender_bearer_token, 512);
  const device = await authenticateDeviceCredential({
    tenantId,
    plaintext: token,
    sourceIp: context.sourceIp || input.source_ip || null,
    deviceCode: input.device_code || input.deviceCode || null,
  });
  if (!device) throw AppError.unauthorized('Invalid cold-chain device credential', 'COLD_CHAIN_DEVICE_AUTH_FAILED');
  if (device.kind !== 'fridge_sensor') {
    throw AppError.forbidden('Device credential is not registered as a fridge_sensor', 'COLD_CHAIN_DEVICE_KIND_FORBIDDEN');
  }

  const normalized = {
    unitId: normalizePositiveInt(input.unit_id ?? input.unitId, 'unit_id'),
    unitCode: cleanText(input.unit_code ?? input.unitCode, 120),
    tempC: normalizeNumber(input.temp_c ?? input.temperature_c ?? input.temperatureC ?? input.tempC, 'temp_c', { required: true }),
    humidityPct: normalizeNumber(input.humidity_pct ?? input.humidityPct, 'humidity_pct', { min: 0, max: 100 }),
    batteryPct: normalizeNumber(input.battery_pct ?? input.batteryPct, 'battery_pct', { min: 0, max: 100 }),
    recordedAt: normalizeTimestamp(input.recorded_at ?? input.recordedAt, 'recorded_at'),
    metadata: jsonObject(input.metadata, 'metadata'),
  };

  const result = await setTenantTx(tenantId, async (tx) => {
    const unit = await findUnit(tx, {
      tenantId,
      unitId: normalized.unitId,
      unitCode: normalized.unitCode,
      deviceRegistryId: device.id,
      activeOnly: true,
    });
    if (!unit) throw AppError.notFound('Cold-chain unit not found for device', 'COLD_CHAIN_UNIT_NOT_FOUND');
    const readingRows = await tx.$queryRawUnsafe(
      `INSERT INTO cold_chain_readings
         (tenant_id, unit_id, device_registry_id, temp_c, humidity_pct, battery_pct, recorded_at, metadata)
       VALUES ($1::uuid, $2::int, $3::int, $4::numeric, $5::numeric, $6::numeric, $7::timestamptz, $8::jsonb)
       RETURNING *`,
      tenantId,
      unit.id,
      device.id,
      normalized.tempC,
      normalized.humidityPct,
      normalized.batteryPct,
      normalized.recordedAt,
      JSON.stringify(normalized.metadata),
    );
    const reading = readingRows[0];
    const activeExcursion = await findActiveExcursion(tx, { tenantId, unitId: unit.id });

    if (!isReadingOutOfRange(unit, reading.temp_c)) {
      if (!activeExcursion) return { unit, reading, excursion: null, action: 'reading_recorded' };
      const updated = await closeExcursionIfAllowed(tx, {
        tenantId,
        unit,
        excursion: activeExcursion,
        reading,
        actorUid: context.actorUid || null,
      });
      return {
        unit,
        reading,
        excursion: updated,
        action: updated.status === 'closed' ? 'excursion_closed' : 'returned_in_range_pending_corrective_action',
      };
    }

    if (activeExcursion) {
      const direction = breachDirection(unit, reading.temp_c);
      const rows = await tx.$queryRawUnsafe(
        `UPDATE cold_chain_excursions
            SET last_out_of_range_at = GREATEST(COALESCE(last_out_of_range_at, $3::timestamptz), $3::timestamptz),
                peak_temp_c = CASE
                  WHEN $4 = 'low' THEN LEAST(COALESCE(peak_temp_c, $5::numeric), $5::numeric)
                  ELSE GREATEST(COALESCE(peak_temp_c, $5::numeric), $5::numeric)
                END,
                min_seen_temp_c = LEAST(COALESCE(min_seen_temp_c, $5::numeric), $5::numeric),
                max_seen_temp_c = GREATEST(COALESCE(max_seen_temp_c, $5::numeric), $5::numeric),
                severity = CASE WHEN severity = 'critical' OR $6 = 'critical' THEN 'critical' ELSE 'warning' END,
                duration_minutes = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($3::timestamptz - breach_started_at)) / 60)::int),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint
          RETURNING *`,
        tenantId,
        activeExcursion.id,
        reading.recorded_at,
        direction,
        Number(reading.temp_c),
        severityFor(unit, reading.temp_c, direction),
      );
      return { unit, reading, excursion: rows[0], action: 'excursion_updated' };
    }

    const window = await findBreachWindow(tx, { tenantId, unit, observedAt: reading.recorded_at });
    if (!window?.breach_started_at || !breachSurvivedGrace({
      breachStartedAt: window.breach_started_at,
      observedAt: reading.recorded_at,
      graceMinutes: unit.excursion_grace_minutes,
    })) {
      return { unit, reading, excursion: null, action: 'grace_window_observing' };
    }

    const { alertRoles, alertRoleDegradation } = resolveLiveAlertRoles(unit, {
      tenantId,
      eventKind: 'temperature_excursion',
    });

    const opened = await openTemperatureExcursion(tx, {
      tenantId,
      unit,
      reading,
      window,
      alertRoles,
      alertRoleDegradation,
      actorUid: context.actorUid || null,
    });
    return {
      unit,
      reading,
      excursion: opened.excursion,
      alertRoles: opened.alertRoles,
      alert_role_degraded: Boolean(alertRoleDegradation),
      alert_role_degradation: alertRoleDegradation,
      action: 'excursion_opened',
    };
  });

  if (result.action === 'excursion_opened') {
    await queueColdChainNotifications({
      tenantId,
      unit: result.unit,
      excursion: result.excursion,
      alertRoles: result.alertRoles,
      eventKind: 'temperature_excursion',
    });
    emitColdChain('excursion-opened', { tenantId, unit: result.unit, excursion: result.excursion });
  } else if (result.action === 'excursion_closed') {
    emitColdChain('excursion-closed', { tenantId, unit: result.unit, excursion: result.excursion });
  } else {
    emitColdChain('reading-recorded', { tenantId, unit: result.unit, excursion: result.excursion });
  }
  return result;
}

export async function acknowledgeColdChainExcursion({ tenantId, id, actorUid, actorRoles = [] } = {}) {
  const tid = requireTenantId(tenantId);
  const excursionId = normalizePositiveInt(id, 'excursion_id', { required: true });
  const result = await setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE cold_chain_excursions
          SET status = CASE WHEN status = 'open' THEN 'acknowledged' ELSE status END,
              acknowledged_by = COALESCE(acknowledged_by, $3::uuid),
              acknowledged_at = COALESCE(acknowledged_at, NOW()),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND status IN ('open', 'acknowledged')
        RETURNING *`,
      tid,
      excursionId,
      actorUid || null,
    );
    const excursion = rows[0];
    if (!excursion) throw AppError.notFound('Open cold-chain excursion not found', 'COLD_CHAIN_EXCURSION_NOT_FOUND');
    if (excursion.task_id) {
      // The excursion acknowledge is itself route-authorized (COLD_CHAIN_ROUTE_ROLES)
      // and audited on the excursion row; acking its linked coordination task is a
      // side-effect of that action. Pass the actor's roles so a responder holding
      // the task's assigned role records as a normal role-ack; a different but
      // route-authorized cold-chain responder records as an audited override
      // (rather than 403-ing and rolling back the excursion acknowledge).
      await acknowledgeColdChainTaskFromTrustedWorkflow({
        tenantId: tid,
        id: excursion.task_id,
        actorUid,
        actorRoles,
        excursionId: excursion.id,
        tx,
      });
    }
    const unit = await findUnit(tx, { tenantId: tid, unitId: excursion.unit_id });
    return { unit, excursion };
  });
  emitColdChain('excursion-acknowledged', { tenantId: tid, unit: result.unit, excursion: result.excursion });
  return result.excursion;
}

export async function recordColdChainCorrectiveAction({
  tenantId,
  id,
  correctiveAction,
  dispositionNote = null,
  actorUid = null,
  actorRoles = [],
} = {}) {
  const tid = requireTenantId(tenantId);
  const excursionId = normalizePositiveInt(id, 'excursion_id', { required: true });
  const action = cleanText(correctiveAction, 4000);
  if (!action) throw AppError.badRequest('corrective_action is required', 'COLD_CHAIN_CORRECTIVE_ACTION_REQUIRED');
  const result = await setTenantTx(tid, async (tx) => {
    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE cold_chain_excursions
          SET corrective_action = $3,
              disposition_note = COALESCE($4, disposition_note),
              acknowledged_by = COALESCE(acknowledged_by, $5::uuid),
              acknowledged_at = COALESCE(acknowledged_at, NOW()),
              status = CASE WHEN status = 'open' THEN 'acknowledged' ELSE status END,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND status IN ('open', 'acknowledged')
        RETURNING *`,
      tid,
      excursionId,
      action,
      cleanText(dispositionNote, 4000),
      actorUid || null,
    );
    const excursion = updatedRows[0];
    if (!excursion) throw AppError.notFound('Open cold-chain excursion not found', 'COLD_CHAIN_EXCURSION_NOT_FOUND');
    if (excursion.task_id) {
      await acknowledgeColdChainTaskFromTrustedWorkflow({
        tenantId: tid,
        id: excursion.task_id,
        actorUid,
        actorRoles,
        excursionId: excursion.id,
        tx,
      });
    }
    const unit = await findUnit(tx, { tenantId: tid, unitId: excursion.unit_id });
    const reading = await latestReading(tx, { tenantId: tid, unitId: unit.id });
    const maybeClosed = await closeExcursionIfAllowed(tx, { tenantId: tid, unit, excursion, reading, actorUid });
    return { unit, excursion: maybeClosed };
  });
  emitColdChain(
    result.excursion.status === 'closed' ? 'excursion-closed' : 'corrective-action-recorded',
    { tenantId: tid, unit: result.unit, excursion: result.excursion },
  );
  return result.excursion;
}

export async function runSilentSensorWatchdog({ tenantId } = {}) {
  const tid = requireTenantId(tenantId);
  const result = await setTenantTx(tid, async (tx) => {
    const units = await tx.$queryRawUnsafe(
      `SELECT u.*,
              d.device_code,
              d.display_name AS device_name,
              d.last_seen_at,
              d.expected_interval_seconds
         FROM cold_chain_units u
         JOIN device_registry d
           ON d.id = u.device_registry_id
          AND d.tenant_id = u.tenant_id
        WHERE u.tenant_id = $1::uuid
          AND u.status = 'active'
          AND d.status = 'active'
          AND (
            d.last_seen_at IS NULL
            OR d.last_seen_at < NOW() - (GREATEST(d.expected_interval_seconds, 60) * 3 * INTERVAL '1 second')
          )
          AND NOT EXISTS (
            SELECT 1
              FROM cold_chain_excursions e
             WHERE e.tenant_id = u.tenant_id
               AND e.unit_id = u.id
               AND e.status IN ('open', 'acknowledged')
          )
        ORDER BY u.department, u.unit_code
        LIMIT 100`,
      tid,
    );
    const events = [];
    const degraded = [];
    for (const unit of units) {
      const { alertRoles, alertRoleDegradation } = resolveLiveAlertRoles(unit, {
        tenantId: tid,
        eventKind: 'silent_sensor',
      });
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO cold_chain_excursions
           (tenant_id, unit_id, breach_started_at, opened_at, last_out_of_range_at,
            breach_direction, severity, status, metadata)
         VALUES ($1::uuid, $2::int,
                 COALESCE($3::timestamptz, NOW() - (GREATEST($4::int, 60) * 3 * INTERVAL '1 second')),
                 NOW(), NULL, 'silent', 'warning', 'open', $5::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        tid,
        unit.id,
        unit.last_seen_at,
        unit.expected_interval_seconds || 300,
        JSON.stringify({
          kind: 'silent_sensor',
          device_code: unit.device_code,
          ...(alertRoleDegradation ? { alert_role_degradation: alertRoleDegradation } : {}),
        }),
      );
      if (!rows[0]) continue;
      const wired = await wireAlertRails(tx, {
        tenantId: tid,
        unit,
        excursion: rows[0],
        alertRoles,
        alertRoleDegradation,
        eventKind: 'silent_sensor',
      });
      const event = {
        unit,
        excursion: wired.excursion,
        alertRoles: wired.alertRoles,
        alert_role_degraded: Boolean(alertRoleDegradation),
        alert_role_degradation: alertRoleDegradation,
      };
      events.push(event);
      if (alertRoleDegradation) degraded.push(event);
    }
    return { opened: events, degraded };
  });

  const { opened, degraded } = result;
  for (const event of opened) {
    await queueColdChainNotifications({
      tenantId: tid,
      unit: event.unit,
      excursion: event.excursion,
      alertRoles: event.alertRoles,
      eventKind: 'silent_sensor',
    });
    emitColdChain('silent-sensor-warning', { tenantId: tid, unit: event.unit, excursion: event.excursion });
  }
  return {
    opened,
    count: opened.length,
    degraded,
    degradedCount: degraded.length,
  };
}

export async function listColdChainDashboard({ tenantId } = {}) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, async (tx) => {
    const units = await tx.$queryRawUnsafe(
      `SELECT u.*,
              d.device_code,
              d.display_name AS device_name,
              d.last_seen_at,
              d.expected_interval_seconds,
              lr.temp_c AS latest_temp_c,
              lr.recorded_at AS latest_recorded_at,
              oe.id AS open_excursion_id,
              oe.severity AS open_excursion_severity,
              oe.status AS open_excursion_status
         FROM cold_chain_units u
         JOIN device_registry d
           ON d.id = u.device_registry_id
          AND d.tenant_id = u.tenant_id
         LEFT JOIN LATERAL (
           SELECT temp_c, recorded_at
             FROM cold_chain_readings r
            WHERE r.tenant_id = u.tenant_id
              AND r.unit_id = u.id
            ORDER BY recorded_at DESC, id DESC
            LIMIT 1
         ) lr ON true
         LEFT JOIN LATERAL (
           SELECT id, severity, status
             FROM cold_chain_excursions e
            WHERE e.tenant_id = u.tenant_id
              AND e.unit_id = u.id
              AND e.status IN ('open', 'acknowledged')
            ORDER BY opened_at DESC
            LIMIT 1
         ) oe ON true
        WHERE u.tenant_id = $1::uuid
        ORDER BY u.department, u.display_name`,
      tid,
    );
    const excursions = await tx.$queryRawUnsafe(
      `SELECT e.*, u.unit_code, u.display_name, u.department, u.min_temp_c, u.max_temp_c
         FROM cold_chain_excursions e
         JOIN cold_chain_units u
           ON u.id = e.unit_id
          AND u.tenant_id = e.tenant_id
        WHERE e.tenant_id = $1::uuid
          AND e.status IN ('open', 'acknowledged')
        ORDER BY CASE e.severity WHEN 'critical' THEN 0 ELSE 1 END, e.opened_at DESC
        LIMIT 100`,
      tid,
    );
    const recentReadings = await tx.$queryRawUnsafe(
      `SELECT r.*, u.unit_code, u.display_name
         FROM cold_chain_readings r
         JOIN cold_chain_units u
           ON u.id = r.unit_id
          AND u.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1::uuid
        ORDER BY r.recorded_at DESC, r.id DESC
        LIMIT 100`,
      tid,
    );
    const reviewFlags = await tx.$queryRawUnsafe(
      `SELECT f.*, u.unit_code, u.display_name, e.severity, e.opened_at
         FROM cold_chain_blood_bank_review_flags f
         JOIN cold_chain_units u
           ON u.id = f.unit_id
          AND u.tenant_id = f.tenant_id
         JOIN cold_chain_excursions e
           ON e.id = f.excursion_id
          AND e.tenant_id = f.tenant_id
        WHERE f.tenant_id = $1::uuid
          AND f.status = 'open'
        ORDER BY f.created_at DESC
        LIMIT 50`,
      tid,
    );
    return {
      units,
      excursions,
      recent_readings: recentReadings,
      blood_bank_review_flags: reviewFlags,
      generated_at: new Date().toISOString(),
    };
  });
}

export function buildTemperatureRegisterCsv({ unit, readings, month }) {
  const lines = [
    ['unit_code', 'unit_name', 'month', 'recorded_at', 'temp_c', 'humidity_pct', 'battery_pct', 'in_range'].join(','),
  ];
  for (const row of readings) {
    lines.push([
      unit.unit_code,
      unit.display_name,
      month,
      formatDateTime(row.recorded_at),
      row.temp_c,
      row.humidity_pct,
      row.battery_pct,
      !isReadingOutOfRange(unit, row.temp_c),
    ].map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function buildTemperatureRegisterPdf({ unit, readings, month }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.fontSize(18).text('Cold-Chain Temperature Register');
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Unit: ${unit.display_name} (${unit.unit_code})`);
    doc.text(`Department: ${unit.department}`);
    doc.text(`Range: ${unit.min_temp_c} C to ${unit.max_temp_c} C`);
    doc.text(`Month: ${month}`);
    doc.moveDown();
    doc.fontSize(9).text('Recorded at | Temp C | Humidity % | Battery % | Status');
    doc.moveDown(0.25);
    for (const row of readings.slice(0, 900)) {
      const status = isReadingOutOfRange(unit, row.temp_c) ? 'OUT OF RANGE' : 'OK';
      doc.text(`${formatDateTime(row.recorded_at)} | ${row.temp_c ?? ''} | ${row.humidity_pct ?? ''} | ${row.battery_pct ?? ''} | ${status}`);
      if (doc.y > 760) doc.addPage();
    }
    doc.end();
  });
}

export async function exportTemperatureRegister({ tenantId, unitId, month, format = 'csv' } = {}) {
  const tid = requireTenantId(tenantId);
  const unitPk = normalizePositiveInt(unitId, 'unit_id', { required: true });
  const range = monthRange(month);
  const fmt = cleanText(format, 20)?.toLowerCase() || 'csv';
  if (!['csv', 'pdf'].includes(fmt)) throw AppError.badRequest('format must be csv or pdf');
  const payload = await setTenantTx(tid, async (tx) => {
    const unit = await findUnit(tx, { tenantId: tid, unitId: unitPk });
    if (!unit) throw AppError.notFound('Cold-chain unit not found', 'COLD_CHAIN_UNIT_NOT_FOUND');
    const readings = await tx.$queryRawUnsafe(
      `SELECT *
         FROM cold_chain_readings
        WHERE tenant_id = $1::uuid
          AND unit_id = $2::int
          AND recorded_at >= $3::timestamptz
          AND recorded_at < $4::timestamptz
        ORDER BY recorded_at ASC, id ASC`,
      tid,
      unitPk,
      range.start,
      range.end,
    );
    return { unit, readings };
  });
  const baseName = `cold-chain-${payload.unit.unit_code}-${range.label}`;
  if (fmt === 'pdf') {
    return {
      filename: `${baseName}.pdf`,
      contentType: 'application/pdf',
      body: await buildTemperatureRegisterPdf({ ...payload, month: range.label }),
    };
  }
  return {
    filename: `${baseName}.csv`,
    contentType: 'text/csv; charset=utf-8',
    body: buildTemperatureRegisterCsv({ ...payload, month: range.label }),
  };
}

export default {
  createColdChainUnit,
  updateColdChainUnit,
  listColdChainUnits,
  ingestColdChainReading,
  acknowledgeColdChainExcursion,
  recordColdChainCorrectiveAction,
  runSilentSensorWatchdog,
  listColdChainDashboard,
  exportTemperatureRegister,
};

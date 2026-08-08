import { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { sendStaffNotifications } from '../notification/staffNotificationService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  recordClinicalAuditEvent,
  recordTimelineEvent,
} from '../clinical/canonicalClinicalPlatformService.js';
import { emitTransportEvent } from '../../utils/websocket/realtimeEmitter.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEZONE = process.env.APP_TIMEZONE || process.env.TZ || 'Asia/Kolkata';
const DEFAULT_TRANSPORT_ROLES = Object.freeze([
  'DRIVER',
  'AMBULANCE_DRIVER',
  'DELIVERY_STAFF',
  'EMERGENCY_RESPONDER',
  'AMBULANCE_COORDINATOR',
]);
const DEFAULT_ESCALATION_ROLES = Object.freeze([
  'RECEPTION_INCHARGE',
  'IP_INCHARGE',
  'MEDICAL_SUPERINTENDENT',
]);
// B-L5(b) — cancellation ownership. The route mount admits the whole
// transport role union (requesters + coordinators + the porters who
// execute jobs), but cancelling a transport job — which closes its SLA
// instance — belongs to the people who own the demand side: the staff
// member who raised it, transport coordination, and the escalation
// chain. Porters (DRIVER / AMBULANCE_DRIVER / DELIVERY_STAFF /
// EMERGENCY_RESPONDER) must decline/hand back instead of killing the
// task and its SLA evidence.
const TRANSPORT_CANCEL_ROLES = Object.freeze([
  'SUPER_ADMIN',
  'ADMIN',
  'AMBULANCE_COORDINATOR',
  'ADMISSION_OFFICER',
  ...DEFAULT_ESCALATION_ROLES,
]);
const DEFAULT_SOURCE_SLA_MINUTES = Object.freeze({
  appointment_checkin: 20,
  admission: 20,
  discharge: 20,
  imaging: 25,
  lab: 20,
  bed_transfer: 15,
  transfer: 15,
  sample: 20,
  equipment: 45,
  manual: 30,
});
const DEFAULT_SOURCE_PRIORITY = Object.freeze({
  appointment_checkin: 'medium',
  admission: 'high',
  discharge: 'high',
  imaging: 'medium',
  lab: 'medium',
  bed_transfer: 'high',
  transfer: 'high',
  sample: 'medium',
  equipment: 'medium',
  manual: 'medium',
});
const SOURCE_RULE_CODES = Object.freeze({
  appointment_checkin: 'porter_transport_general',
  admission: 'porter_transport_general',
  discharge: 'porter_transport_discharge',
  imaging: 'porter_transport_general',
  lab: 'porter_transport_sample',
  bed_transfer: 'porter_transport_transfer',
  transfer: 'porter_transport_transfer',
  sample: 'porter_transport_sample',
  equipment: 'porter_transport_equipment',
  manual: 'porter_transport_general',
});
const ACTIVE_STATUSES = Object.freeze(['open', 'assigned', 'accepted', 'picked_up']);
const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);
const VALID_SOURCE_TYPES = new Set(Object.keys(SOURCE_RULE_CODES));
const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const DEFAULT_ESCALATION_LIMIT = 100;

// Cap on the role-fallback recipient fan-out. Distinct from the task-page cap
// above (DEFAULT_ESCALATION_LIMIT): this one bounds WHO is told, not how many
// transports are evaluated.
const TRANSPORT_RECIPIENT_CAP = 80;

function cleanText(value, max = 255) {
  const text = value == null ? '' : String(value).trim();
  return text ? text.slice(0, max) : '';
}

function maybeUuid(value) {
  const text = cleanText(value, 80);
  return UUID_RE.test(text) ? text : null;
}

function intId(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  const text = cleanText(value, 20).toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return false;
  return false;
}

function normalizeRoleList(value, fallback) {
  const list = Array.isArray(value) ? value : fallback;
  const normalized = list
    .map((role) => cleanText(role, 80).toUpperCase())
    .filter(Boolean);
  return [...new Set(normalized)].slice(0, 40);
}

function jsonObject(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  return value;
}

function jsonString(value, fallback = {}) {
  return JSON.stringify(value ?? fallback);
}

function normalizeSourceType(value) {
  const raw = cleanText(value || 'manual', 80).toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return VALID_SOURCE_TYPES.has(normalized) ? normalized : 'manual';
}

function normalizePriority(value, fallback = 'medium') {
  const text = cleanText(value || fallback, 40).toLowerCase();
  return VALID_PRIORITIES.has(text) ? text : fallback;
}

function priorityForNotification(priority) {
  if (priority === 'urgent') return 'HIGH';
  if (priority === 'high') return 'HIGH';
  if (priority === 'low') return 'LOW';
  return 'MEDIUM';
}

function clampLimit(value, fallback = 100, max = 500) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function serializeRow(row = {}) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return out;
}

function serializeTask(row = {}) {
  const out = serializeRow(row);
  if (out.recipient_count != null) out.recipient_count = Number(out.recipient_count);
  return out;
}

function uniqueRecipients(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = Number(row?.id ?? row?.staff_id);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      uid: row.uid || row.staff_uid || null,
      name: row.name || row.staff_name || null,
      phone: row.phone || null,
      role: row.role || row.staff_role || null,
      recipient_kind: row.recipient_kind || 'assigned_staff',
      source: row.source || 'role_fallback',
    });
  }
  return out;
}

function primaryRecipient(recipients = []) {
  return recipients.find((row) => row.recipient_kind === 'assigned_staff') || recipients[0] || null;
}

function isTransportAssignee(task, reqUser = {}) {
  const uid = maybeUuid(reqUser.uid || reqUser.user_uid);
  if (!uid) return false;
  return String(task?.assigned_porter_uid || '').toLowerCase() === uid.toLowerCase()
    || String(task?.accepted_by || '').toLowerCase() === uid.toLowerCase()
    || String(task?.picked_up_by || '').toLowerCase() === uid.toLowerCase();
}

function taskTitle(task) {
  const taskNumber = task?.task_number || `#${task?.id}`;
  const destination = task?.destination_label || task?.destination_location_text;
  return destination ? `Transport task ${taskNumber} to ${destination}` : `Transport task ${taskNumber}`;
}

function sourceRuleCode(sourceType) {
  return SOURCE_RULE_CODES[sourceType] || SOURCE_RULE_CODES.manual;
}

function settingResponse(row = {}) {
  return {
    tenant_id: row.tenant_id,
    enabled: row.enabled === true,
    roster_department: row.roster_department || 'ambulance',
    roster_target_type: row.roster_target_type || 'porter_transport_zone',
    recipient_role_codes: Array.isArray(row.recipient_role_codes) ? row.recipient_role_codes : [...DEFAULT_TRANSPORT_ROLES],
    escalation_role_codes: Array.isArray(row.escalation_role_codes) ? row.escalation_role_codes : [...DEFAULT_ESCALATION_ROLES],
    source_sla_minutes: jsonObject(row.source_sla_minutes, { ...DEFAULT_SOURCE_SLA_MINUTES }),
    source_priority: jsonObject(row.source_priority, { ...DEFAULT_SOURCE_PRIORITY }),
    enabled_at: row.enabled_at ?? null,
    updated_at: row.updated_at ?? null,
    metadata: jsonObject(row.metadata, {}),
  };
}

async function getSettings(db, tenantId) {
  const rows = await db.$queryRawUnsafe(
    `INSERT INTO porter_transport_settings (tenant_id)
     VALUES ($1::uuid)
     ON CONFLICT (tenant_id) DO NOTHING
     RETURNING tenant_id, enabled, roster_department, roster_target_type,
               recipient_role_codes, escalation_role_codes, source_sla_minutes,
               source_priority, enabled_at, updated_at, metadata`,
    tenantId,
  );
  if (rows[0]) return settingResponse(rows[0]);
  const existing = await db.$queryRawUnsafe(
    `SELECT tenant_id, enabled, roster_department, roster_target_type,
            recipient_role_codes, escalation_role_codes, source_sla_minutes,
            source_priority, enabled_at, updated_at, metadata
       FROM porter_transport_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    tenantId,
  );
  return settingResponse(existing[0]);
}

export async function readTransportSettings({ tenantId }) {
  const tid = requireTenantId(tenantId);
  return setTenant(tid, (tx) => getSettings(tx, tid));
}

export async function updateTransportSettings({
  tenantId,
  enabled,
  rosterDepartment,
  rosterTargetType,
  recipientRoleCodes,
  escalationRoleCodes,
  sourceSlaMinutes,
  sourcePriority,
  actorUid,
  metadata = {},
}) {
  const tid = requireTenantId(tenantId);
  const nextEnabled = normalizeBoolean(enabled);
  const recipientRoles = normalizeRoleList(recipientRoleCodes, DEFAULT_TRANSPORT_ROLES);
  const escalationRoles = normalizeRoleList(escalationRoleCodes, DEFAULT_ESCALATION_ROLES);
  const slaMinutes = {
    ...DEFAULT_SOURCE_SLA_MINUTES,
    ...jsonObject(sourceSlaMinutes, {}),
  };
  const priority = {
    ...DEFAULT_SOURCE_PRIORITY,
    ...jsonObject(sourcePriority, {}),
  };

  const rows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
    `INSERT INTO porter_transport_settings (
       tenant_id, enabled, roster_department, roster_target_type,
       recipient_role_codes, escalation_role_codes, source_sla_minutes,
       source_priority, enabled_at, enabled_by, updated_by, metadata,
       created_at, updated_at
     )
     VALUES (
       $1::uuid, $2::boolean, $3, $4,
       $5::text[], $6::text[], $7::jsonb,
       $8::jsonb,
       CASE WHEN $2::boolean THEN NOW() ELSE NULL END,
       CASE WHEN $2::boolean THEN $9::uuid ELSE NULL END,
       $9::uuid, $10::jsonb, NOW(), NOW()
     )
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       roster_department = EXCLUDED.roster_department,
       roster_target_type = EXCLUDED.roster_target_type,
       recipient_role_codes = EXCLUDED.recipient_role_codes,
       escalation_role_codes = EXCLUDED.escalation_role_codes,
       source_sla_minutes = EXCLUDED.source_sla_minutes,
       source_priority = EXCLUDED.source_priority,
       enabled_at = CASE
         WHEN EXCLUDED.enabled THEN COALESCE(porter_transport_settings.enabled_at, NOW())
         ELSE NULL
       END,
       enabled_by = CASE
         WHEN EXCLUDED.enabled THEN COALESCE(porter_transport_settings.enabled_by, EXCLUDED.enabled_by)
         ELSE NULL
       END,
       updated_by = EXCLUDED.updated_by,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING tenant_id, enabled, roster_department, roster_target_type,
               recipient_role_codes, escalation_role_codes, source_sla_minutes,
               source_priority, enabled_at, updated_at, metadata`,
    tid,
    nextEnabled,
    cleanText(rosterDepartment || 'ambulance', 80).toLowerCase(),
    cleanText(rosterTargetType || 'porter_transport_zone', 80).toLowerCase(),
    recipientRoles,
    escalationRoles,
    jsonString(slaMinutes),
    jsonString(priority),
    maybeUuid(actorUid),
    jsonString(metadata, {}),
  ));

  emitTransportEvent('settings-updated', { tenantId: tid });
  return settingResponse(rows[0]);
}

export async function listTransportZones({ tenantId, activeOnly = false }) {
  const tid = requireTenantId(tenantId);
  const active = normalizeBoolean(activeOnly);
  const rows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT id, tenant_id, zone_key, zone_name AS name, zone_type, building, floor,
            role_codes, is_active, sort_order, metadata, created_at, updated_at
       FROM porter_transport_zones
      WHERE tenant_id = $1::uuid
        AND ($2::boolean IS NOT TRUE OR is_active = TRUE)
      ORDER BY sort_order ASC, zone_name ASC, id ASC`,
    tid,
    active,
  ));
  return rows.map(serializeRow);
}

export async function upsertTransportZone({
  tenantId,
  zoneKey,
  name,
  zoneType = 'ward',
  building = null,
  floor = null,
  roleCodes = DEFAULT_TRANSPORT_ROLES,
  isActive = true,
  sortOrder = 100,
  metadata = {},
}) {
  const tid = requireTenantId(tenantId);
  const key = cleanText(zoneKey || name, 120).toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!key) throw AppError.badRequest('Transport zone key is required', 'TRANSPORT_ZONE_KEY_REQUIRED');
  const label = cleanText(name || key, 160);
  const rows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
    `INSERT INTO porter_transport_zones (
       tenant_id, zone_key, zone_name, zone_type, building, floor,
       role_codes, is_active, sort_order, metadata, created_at, updated_at
     )
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::text[], $8::boolean, $9::int, $10::jsonb, NOW(), NOW())
     ON CONFLICT (tenant_id, zone_key) DO UPDATE SET
       zone_name = EXCLUDED.zone_name,
       zone_type = EXCLUDED.zone_type,
       building = EXCLUDED.building,
       floor = EXCLUDED.floor,
       role_codes = EXCLUDED.role_codes,
       is_active = EXCLUDED.is_active,
       sort_order = EXCLUDED.sort_order,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id, tenant_id, zone_key, zone_name AS name, zone_type, building, floor,
               role_codes, is_active, sort_order, metadata, created_at, updated_at`,
    tid,
    key,
    label,
    cleanText(zoneType, 40).toLowerCase() || 'ward',
    cleanText(building, 120) || null,
    cleanText(floor, 80) || null,
    normalizeRoleList(roleCodes, DEFAULT_TRANSPORT_ROLES),
    normalizeBoolean(isActive),
    Number.parseInt(String(sortOrder), 10) || 100,
    jsonString(metadata, {}),
  ));
  emitTransportEvent('zone-updated', { tenantId: tid });
  return serializeRow(rows[0]);
}

async function resolveSourceContext(db, tenantId, body = {}) {
  const patientUid = maybeUuid(body.patientUid ?? body.patient_uid);
  const admissionId = intId(body.admissionId ?? body.admission_id);
  const appointmentId = intId(body.appointmentId ?? body.appointment_id);
  if (patientUid || admissionId || appointmentId) {
    return {
      patientUid,
      admissionId,
      appointmentId,
    };
  }

  const sourceType = normalizeSourceType(body.sourceType ?? body.source_type);
  const sourceId = cleanText(body.sourceId ?? body.source_id, 120);
  const numericSourceId = intId(sourceId);
  if (!numericSourceId) return { patientUid: null, admissionId: null, appointmentId: null };

  if (['admission', 'discharge', 'bed_transfer', 'transfer'].includes(sourceType)) {
    const rows = await db.$queryRawUnsafe(
      `SELECT id AS admission_id, patient_uid
         FROM admissions
        WHERE tenant_id = $1::uuid
          AND id = $2::int
        LIMIT 1`,
      tenantId,
      numericSourceId,
    );
    return {
      patientUid: rows[0]?.patient_uid || null,
      admissionId: rows[0]?.admission_id || numericSourceId,
      appointmentId: null,
    };
  }

  if (sourceType === 'appointment_checkin') {
    const rows = await db.$queryRawUnsafe(
      `SELECT a.id AS appointment_id, u.uid AS patient_uid
         FROM appointments a
         LEFT JOIN users u ON u.id = a.patient_id
        WHERE a.tenant_id = $1::uuid
          AND a.id = $2::int
        LIMIT 1`,
      tenantId,
      numericSourceId,
    );
    return {
      patientUid: rows[0]?.patient_uid || null,
      admissionId: null,
      appointmentId: rows[0]?.appointment_id || numericSourceId,
    };
  }

  return { patientUid: null, admissionId: null, appointmentId: null };
}

async function findCurrentRosterRecipients(db, {
  tenantId,
  settings,
  pickupZoneId = null,
  destinationZoneId = null,
  now = new Date(),
  timezone = DEFAULT_TIMEZONE,
}) {
  const targetIds = [pickupZoneId, destinationZoneId]
    .map(intId)
    .filter(Boolean);
  if (!targetIds.length) return [];
  return db.$queryRawUnsafe(
    `WITH ctx AS (
       SELECT $4::timestamptz AS ts,
              ($4::timestamptz AT TIME ZONE $5)::date AS local_date,
              ($4::timestamptz AT TIME ZONE $5)::time AS local_time
     )
     SELECT DISTINCT ON (u.id)
            u.id,
            u.uid,
            u.name,
            u.phone,
            u.role,
            'assigned_staff'::text AS recipient_kind,
            'published_roster'::text AS source
       FROM ctx
       JOIN staff_shift_roster_boards b
         ON b.tenant_id = $1::uuid
        AND b.department = $2
        AND b.status = 'published'
        AND b.roster_date IN (ctx.local_date, ctx.local_date - 1)
       JOIN staff_shift_roster_assignments a
         ON a.roster_id = b.id
        AND a.status = 'published'
        AND a.assignment_target_type = $3
        AND a.assignment_target_id = ANY($6::int[])
       JOIN users u ON u.id = a.staff_id
      WHERE u.tenant_id = $1::uuid
        AND COALESCE(u.is_active, true) = true
        AND UPPER(u.role) = ANY($7::text[])
        AND (
          (
            b.shift_end > b.shift_start
            AND b.roster_date = ctx.local_date
            AND ctx.local_time >= b.shift_start
            AND ctx.local_time < b.shift_end
          )
          OR (
            b.shift_end <= b.shift_start
            AND (
              (b.roster_date = ctx.local_date AND ctx.local_time >= b.shift_start)
              OR (b.roster_date = ctx.local_date - 1 AND ctx.local_time < b.shift_end)
            )
          )
        )
      ORDER BY u.id, a.is_lead DESC, b.shift_start ASC`,
    tenantId,
    settings.roster_department,
    settings.roster_target_type,
    now.toISOString(),
    timezone,
    targetIds,
    settings.recipient_role_codes,
  );
}

async function findActiveZoneAssignments(db, {
  tenantId,
  settings,
  pickupZoneId = null,
  destinationZoneId = null,
  now = new Date(),
}) {
  const targetIds = [pickupZoneId, destinationZoneId]
    .map(intId)
    .filter(Boolean);
  if (!targetIds.length) return [];
  return db.$queryRawUnsafe(
    `SELECT DISTINCT ON (u.id)
            u.id,
            u.uid,
            u.name,
            u.phone,
            u.role,
            'assigned_staff'::text AS recipient_kind,
            CASE
              WHEN pta.assignment_kind = 'roster_projection' THEN 'roster_projection'
              ELSE 'transport_zone_assignment'
            END AS source
       FROM porter_transport_zone_assignments pta
       JOIN users u ON u.id = pta.staff_id
      WHERE pta.tenant_id = $1::uuid
        AND pta.zone_id = ANY($2::bigint[])
        AND pta.status = 'active'
        AND pta.effective_from <= $3::timestamptz
        AND (pta.effective_to IS NULL OR pta.effective_to > $3::timestamptz)
        AND u.tenant_id = $1::uuid
        AND COALESCE(u.is_active, true) = true
        AND UPPER(u.role) = ANY($4::text[])
      ORDER BY u.id, pta.assignment_kind DESC, pta.created_at ASC`,
    tenantId,
    targetIds,
    now.toISOString(),
    settings.recipient_role_codes,
  );
}

async function findFallbackRecipients(db, { tenantId, settings, kind = 'assigned_staff' }) {
  const roleList = kind === 'escalation'
    ? settings.escalation_role_codes
    : settings.recipient_role_codes;
  if (!roleList.length) return [];
  const rows = await db.$queryRawUnsafe(
    `SELECT id,
            uid,
            name,
            phone,
            role,
            $3::text AS recipient_kind,
            CASE WHEN $3::text = 'escalation' THEN 'transport_escalation_role' ELSE 'transport_role_fallback' END AS source,
            COUNT(*) OVER () AS total_matched
       FROM users
      WHERE tenant_id = $1::uuid
        AND COALESCE(is_active, true) = true
        AND UPPER(role) = ANY($2::text[])
      ORDER BY name NULLS LAST, id
      LIMIT $4::int`,
    tenantId,
    roleList,
    kind,
    TRANSPORT_RECIPIENT_CAP,
  );

  // The ordering here is ALPHABETICAL BY NAME, which is not a clinical ranking —
  // it means a trim always evicts the same staff at the end of the alphabet. The
  // escalation path stamps metadata.escalated_at and is not retried, so an evicted
  // recipient is dropped permanently rather than picked up next sweep. Report the
  // exact loss rather than letting it pass silently.
  const totalMatched = rows.length ? Number(rows[0].total_matched) : 0;
  if (totalMatched > rows.length) {
    logger.warn('Porter transport recipient fan-out truncated by cap', {
      tenantId,
      kind,
      roles: roleList,
      cap: TRANSPORT_RECIPIENT_CAP,
      totalMatched,
      notified: rows.length,
      dropped: totalMatched - rows.length,
    });
  }
  return rows;
}

async function resolveRecipients(db, {
  tenantId,
  settings,
  pickupZoneId = null,
  destinationZoneId = null,
  now = new Date(),
  includeEscalation = true,
}) {
  const [rosterRows, assignedRows, fallbackRows, escalationRows] = await Promise.all([
    findCurrentRosterRecipients(db, { tenantId, settings, pickupZoneId, destinationZoneId, now }),
    findActiveZoneAssignments(db, { tenantId, settings, pickupZoneId, destinationZoneId, now }),
    findFallbackRecipients(db, { tenantId, settings, kind: 'assigned_staff' }),
    includeEscalation ? findFallbackRecipients(db, { tenantId, settings, kind: 'escalation' }) : [],
  ]);

  return uniqueRecipients([
    ...rosterRows,
    ...assignedRows,
    ...fallbackRows,
    ...escalationRows,
  ]);
}

async function insertRecipients(db, { tenantId, taskId, recipients }) {
  const saved = [];
  for (const recipient of uniqueRecipients(recipients)) {
    const rows = await db.$queryRawUnsafe(
      `INSERT INTO porter_transport_task_recipients
         (tenant_id, task_id, staff_id, staff_uid, recipient_kind, source, created_at, updated_at)
       VALUES ($1::uuid, $2::bigint, $3::int, $4::uuid, $5, $6, NOW(), NOW())
       ON CONFLICT (tenant_id, task_id, staff_id)
       WHERE staff_id IS NOT NULL
       DO UPDATE SET
         staff_uid = EXCLUDED.staff_uid,
         recipient_kind = EXCLUDED.recipient_kind,
         source = EXCLUDED.source,
         updated_at = NOW()
       RETURNING id, tenant_id, task_id, staff_id, staff_uid, recipient_kind, source, notified_at`,
      tenantId,
      taskId,
      recipient.id,
      maybeUuid(recipient.uid),
      recipient.recipient_kind || 'assigned_staff',
      recipient.source || 'manual',
    );
    if (rows[0]) saved.push(serializeRow(rows[0]));
  }
  return saved;
}

async function startTransportSla(db, {
  tenantId,
  task,
  settings,
  assigneeUid = null,
  recipients = [],
  sourceType,
}) {
  const ruleCode = task.sla_rule_code || sourceRuleCode(sourceType);
  const dueAt = task.sla_due_at instanceof Date ? task.sla_due_at.toISOString() : task.sla_due_at;
  const ownerRoles = uniqueRecipients(recipients)
    .map((row) => row.role)
    .filter(Boolean);
  const roleCodes = ownerRoles.length ? [...new Set(ownerRoles)] : settings.recipient_role_codes;
  const rows = await db.$queryRawUnsafe(
    `WITH selected_rule AS (
       SELECT id, rule_code
         FROM workflow_sla_rules
        WHERE enabled = TRUE
          AND rule_code = $2
          AND (tenant_id = $1::uuid OR tenant_id IS NULL)
        ORDER BY CASE WHEN tenant_id = $1::uuid THEN 0 ELSE 1 END
        LIMIT 1
     )
     INSERT INTO workflow_sla_instances (
       tenant_id, rule_id, rule_code, patient_uid, source_table, source_id,
       status, priority, started_at, due_at, assigned_role_codes,
       assigned_user_uid, metadata
     )
     SELECT $1::uuid, selected_rule.id, selected_rule.rule_code, $3::uuid, 'porter_transport_tasks', $4,
            'active', $5, NOW(), $6::timestamptz, $7::text[], $8::uuid, $9::jsonb
       FROM selected_rule
     ON CONFLICT (tenant_id, rule_code, source_table, source_id)
     WHERE source_table IS NOT NULL AND source_id IS NOT NULL
     DO UPDATE SET
       status = CASE
         WHEN workflow_sla_instances.status IN ('completed', 'cancelled') THEN workflow_sla_instances.status
         ELSE 'active'
       END,
       due_at = EXCLUDED.due_at,
       assigned_role_codes = EXCLUDED.assigned_role_codes,
       assigned_user_uid = EXCLUDED.assigned_user_uid,
       metadata = workflow_sla_instances.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id, status, due_at`,
    tenantId,
    ruleCode,
    maybeUuid(task.patient_uid),
    String(task.id),
    normalizePriority(task.priority, 'medium'),
    dueAt,
    roleCodes,
    maybeUuid(assigneeUid),
    jsonString({
      source: sourceType,
      task_number: task.task_number,
      transport_task_id: String(task.id),
    }),
  );
  if (!rows[0]) return null;
  await db.$executeRawUnsafe(
    `UPDATE porter_transport_tasks
        SET sla_instance_id = $3::uuid,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint`,
    tenantId,
    task.id,
    rows[0].id,
  );
  return rows[0];
}

async function closeTransportSla(db, { tenantId, task, status, actorUid }) {
  if (!task?.sla_rule_code) return null;
  const rows = await db.$queryRawUnsafe(
    `UPDATE workflow_sla_instances
        SET status = $4::varchar,
            completed_at = CASE WHEN $4::varchar = 'completed' THEN NOW() ELSE completed_at END,
            metadata = metadata || $5::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND rule_code = $2
        AND source_table = 'porter_transport_tasks'
        AND source_id = $3
      RETURNING id, status, due_at, completed_at`,
    tenantId,
    task.sla_rule_code,
    String(task.id),
    status,
    jsonString({ closed_by: maybeUuid(actorUid), closed_status: status }),
  );
  return rows[0] || null;
}

async function appendUpdate(db, {
  tenantId,
  taskId,
  authorUid,
  authorRole,
  fromStatus = null,
  toStatus = null,
  message = null,
  locationText = null,
  internal = false,
  metadata = {},
}) {
  const updateMessage = cleanText(message, 1000)
    || (toStatus ? `Transport task ${toStatus}` : 'Transport task updated');
  const rows = await db.$queryRawUnsafe(
    `INSERT INTO porter_transport_task_updates (
       tenant_id, task_id, author_uid, author_role, status_from, status_to,
       message, location_text, is_internal, metadata, created_at
     )
     VALUES ($1::uuid, $2::bigint, $3::uuid, $4, $5, $6, $7, $8, $9::boolean, $10::jsonb, NOW())
     RETURNING id`,
    tenantId,
    taskId,
    maybeUuid(authorUid),
    cleanText(authorRole, 100) || null,
    cleanText(fromStatus, 40) || null,
    cleanText(toStatus, 40) || null,
    updateMessage,
    cleanText(locationText, 255) || null,
    internal === true,
    jsonString(metadata, {}),
  );
  return rows[0] || null;
}

async function recordTaskCanonicalEvents(db, {
  tenantId,
  task,
  actorUid,
  actorRole,
  action,
  status,
  summary,
  beforeState = null,
  afterState = null,
}) {
  if (!task?.patient_uid) return;
  const common = {
    tenantId,
    patientUid: task.patient_uid,
    eventType: 'patient_transport.task',
    eventSubtype: action,
    eventStatus: status,
    sourceTable: 'porter_transport_tasks',
    sourceId: String(task.id),
    resourceType: 'porter_transport_task',
    resourceId: String(task.id),
    actorUid,
    actorRole,
    summary,
    visibleToPatient: false,
    payload: {
      task_number: task.task_number,
      source_type: task.source_type,
      pickup_label: task.pickup_label,
      destination_label: task.destination_label,
      status,
    },
    tags: ['patient_transport', 'porter_transport'],
  };
  await recordTimelineEvent({
    ...common,
    idempotencyKey: `porter-transport:${task.id}:timeline:${status}`,
  }, { db });
  await recordClinicalAuditEvent({
    tenantId,
    patientUid: task.patient_uid,
    action: `porter_transport.${action}`,
    actionStatus: status,
    resourceTable: 'porter_transport_tasks',
    resourceId: String(task.id),
    resourceType: 'porter_transport_task',
    actorUid,
    actorRole,
    beforeState,
    afterState,
    metadata: common.payload,
    idempotencyKey: `porter-transport:${task.id}:audit:${status}`,
  }, { db });
}

async function loadTask(db, { tenantId, taskId, lock = false }) {
  const rows = await db.$queryRawUnsafe(
    `SELECT t.*,
            (
              SELECT COUNT(*)::int
                FROM porter_transport_task_recipients r
               WHERE r.tenant_id = t.tenant_id
                 AND r.task_id = t.id
            ) AS recipient_count
       FROM porter_transport_tasks t
      WHERE t.tenant_id = $1::uuid
        AND t.id = $2::bigint
      LIMIT 1
      ${lock ? 'FOR UPDATE OF t' : ''}`,
    tenantId,
    taskId,
  );
  if (!rows[0]) throw AppError.notFound('Transport task not found', 'TRANSPORT_TASK_NOT_FOUND');
  return serializeTask(rows[0]);
}

async function checkAssignedRecipient(db, { tenantId, taskId, actorUid }) {
  const uid = maybeUuid(actorUid);
  if (!uid) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT r.id, r.staff_id, r.staff_uid, r.recipient_kind, u.role
       FROM porter_transport_task_recipients r
       JOIN users u ON u.id = r.staff_id
      WHERE r.tenant_id = $1::uuid
        AND r.task_id = $2::bigint
        AND r.staff_uid = $3::uuid
      LIMIT 1`,
    tenantId,
    taskId,
    uid,
  );
  return rows[0] || null;
}

async function notifyRecipients({
  tenantId,
  task,
  recipients = [],
  eventKind,
  title = null,
  body = null,
}) {
  const target = uniqueRecipients(recipients).filter((row) => row.id);
  if (!target.length) return { notification_count: 0, outbox_count: 0 };
  const messageTitle = title || 'Patient transport task';
  const messageBody = body || taskTitle(task);
  let outboxCount = 0;

  for (const row of target) {
    const queued = await notificationOutbox.queue({
      type: 'push',
      recipientId: row.id,
      recipientPhone: row.phone || null,
      title: messageTitle,
      body: messageBody,
      data: {
        kind: eventKind,
        task_id: Number(task.id),
        task_number: task.task_number,
        source_type: task.source_type,
      },
    });
    if (queued) outboxCount += 1;
  }

  const notificationResult = await sendStaffNotifications({
    tenantId,
    recipientUserIds: target.map((row) => row.id),
    title: messageTitle,
    body: messageBody,
    type: 'PORTER_TRANSPORT',
    priority: priorityForNotification(task.priority),
    relatedId: Number(task.id),
    data: {
      kind: eventKind,
      task_id: Number(task.id),
      task_number: task.task_number,
      source_type: task.source_type,
    },
    dedupe: true,
  });

  const notifiedIds = notificationResult.recipients.map((row) => Number(row.id)).filter(Boolean);
  if (notifiedIds.length) {
    await setTenant(tenantId, (tx) => tx.$executeRawUnsafe(
      `UPDATE porter_transport_task_recipients
          SET notified_at = COALESCE(notified_at, NOW()),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND task_id = $2::bigint
          AND staff_id = ANY($3::int[])`,
      tenantId,
      task.id,
      notifiedIds,
    ));
  }

  return {
    notification_count: notificationResult.notification_count,
    outbox_count: outboxCount,
  };
}

export async function createTransportTask({ tenantId, actorUid, actorRole, body = {} }) {
  const tid = requireTenantId(tenantId);
  const result = await setTenantTx(tid, async (tx) => {
    const settings = await getSettings(tx, tid);
    if (!settings.enabled) {
      throw AppError.forbidden('Patient transport is not enabled for this tenant', 'TRANSPORT_DISABLED');
    }

    const sourceType = normalizeSourceType(body.sourceType ?? body.source_type);
    const sourceId = cleanText(body.sourceId ?? body.source_id ?? cryptoSafeManualId(), 120);
    const sourceContext = await resolveSourceContext(tx, tid, { ...body, sourceType, sourceId });
    const pickupZoneId = intId(body.pickupZoneId ?? body.pickup_zone_id);
    const destinationZoneId = intId(body.destinationZoneId ?? body.destination_zone_id);
    const sourceSla = jsonObject(settings.source_sla_minutes, DEFAULT_SOURCE_SLA_MINUTES);
    const sourcePriority = jsonObject(settings.source_priority, DEFAULT_SOURCE_PRIORITY);
    const priority = normalizePriority(body.priority, sourcePriority[sourceType] || DEFAULT_SOURCE_PRIORITY[sourceType] || 'medium');
    const slaMinutesRaw = Number.parseInt(String(body.slaMinutes ?? body.sla_minutes ?? sourceSla[sourceType] ?? DEFAULT_SOURCE_SLA_MINUTES[sourceType] ?? 30), 10);
    const slaMinutes = Number.isInteger(slaMinutesRaw) && slaMinutesRaw > 0 ? Math.min(slaMinutesRaw, 1440) : 30;
    const dueAt = new Date(Date.now() + slaMinutes * 60_000).toISOString();

    const recipients = await resolveRecipients(tx, {
      tenantId: tid,
      settings,
      pickupZoneId,
      destinationZoneId,
      includeEscalation: true,
    });
    const primary = primaryRecipient(recipients);
    const status = primary ? 'assigned' : 'open';

    let taskRows;
    try {
      taskRows = await tx.$queryRawUnsafe(
        `INSERT INTO porter_transport_tasks (
           tenant_id, source_type, source_id, patient_uid, admission_id, appointment_id,
           pickup_zone_id, pickup_label, pickup_location_id, pickup_location_text,
           destination_zone_id, destination_label, destination_location_id, destination_location_text,
           priority, mobility_flags, infection_flags, isolation_flags,
           requested_by, requester_id, assigned_porter_uid, assigned_porter_id,
           status, sla_rule_code, sla_due_at, metadata, created_by, updated_by,
           requested_at, assigned_at, created_at, updated_at
         )
         VALUES (
           $1::uuid, $2, $3, $4::uuid, $5::int, $6::int,
           $7::bigint, $8, $9::int, $10,
           $11::bigint, $12, $13::int, $14,
           $15, $16::jsonb, $17::jsonb, $18::jsonb,
           $19::uuid, $20::int, $21::uuid, $22::int,
           $23::varchar, $24::varchar, $25::timestamptz, $26::jsonb, $19::uuid, $19::uuid,
           NOW(), CASE WHEN $23::varchar = 'assigned' THEN NOW() ELSE NULL END, NOW(), NOW()
         )
         RETURNING *`,
        tid,
        sourceType,
        sourceId,
        maybeUuid(body.patientUid ?? body.patient_uid) || sourceContext.patientUid,
        intId(body.admissionId ?? body.admission_id) || sourceContext.admissionId,
        intId(body.appointmentId ?? body.appointment_id) || sourceContext.appointmentId,
        pickupZoneId,
        cleanText(body.pickupLabel ?? body.pickup_label, 255) || null,
        intId(body.pickupLocationId ?? body.pickup_location_id),
        cleanText(body.pickupLocationText ?? body.pickup_location_text, 255) || null,
        destinationZoneId,
        cleanText(body.destinationLabel ?? body.destination_label, 255) || null,
        intId(body.destinationLocationId ?? body.destination_location_id),
        cleanText(body.destinationLocationText ?? body.destination_location_text, 255) || null,
        priority,
        jsonString(body.mobilityNotes ?? body.mobility_notes ?? {}),
        jsonString(body.infectionFlags ?? body.infection_flags ?? {}),
        jsonString(body.isolationPrecautions ?? body.isolation_precautions ?? {}),
        maybeUuid(actorUid),
        intId(body.requesterId ?? body.requester_id),
        maybeUuid(primary?.uid),
        primary?.id || null,
        status,
        sourceRuleCode(sourceType),
        dueAt,
        jsonString({
          ...(jsonObject(body.metadata, {})),
          sla_minutes: slaMinutes,
          recipient_source_count: recipients.length,
        }),
      );
    } catch (err) {
      if (String(err?.message || '').includes('ux_porter_transport_tasks_active_source')) {
        throw AppError.conflict('An active transport task already exists for this source', 'TRANSPORT_SOURCE_DUPLICATE');
      }
      throw err;
    }

    let task = serializeTask(taskRows[0]);
    const savedRecipients = await insertRecipients(tx, { tenantId: tid, taskId: task.id, recipients });
    const sla = await startTransportSla(tx, {
      tenantId: tid,
      task,
      settings,
      assigneeUid: primary?.uid || null,
      recipients,
      sourceType,
    });
    task = await loadTask(tx, { tenantId: tid, taskId: task.id, lock: false });

    await appendUpdate(tx, {
      tenantId: tid,
      taskId: task.id,
      authorUid: actorUid,
      authorRole: actorRole,
      fromStatus: null,
      toStatus: task.status,
      message: cleanText(body.message, 1000) || 'Transport task created',
      metadata: { source_type: sourceType, source_id: sourceId, sla_instance_id: sla?.id || null },
    });
    await recordTaskCanonicalEvents(tx, {
      tenantId: tid,
      task,
      actorUid,
      actorRole,
      action: 'created',
      status: task.status,
      summary: `Patient transport task ${task.task_number} created`,
      beforeState: null,
      afterState: { status: task.status, assigned_porter_uid: task.assigned_porter_uid || null },
    });

    return {
      task,
      recipients: savedRecipients,
      notifyRecipients: recipients.filter((row) => row.recipient_kind !== 'escalation'),
    };
  });

  await notifyRecipients({
    tenantId: tid,
    task: result.task,
    recipients: result.notifyRecipients,
    eventKind: 'transport-task-created',
    title: 'New patient transport task',
    body: taskTitle(result.task),
  });
  emitTransportEvent('transport-task-created', { tenantId: tid });
  return {
    task: result.task,
    recipients: result.recipients,
  };
}

function cryptoSafeManualId() {
  return `manual-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function listTransportTasks({
  tenantId,
  status = null,
  patientUid = null,
  assignedToMeUid = null,
  sourceType = null,
  limit = 100,
}) {
  const tid = requireTenantId(tenantId);
  const params = [tid];
  const where = ['t.tenant_id = $1::uuid'];
  let idx = 2;
  const statusText = cleanText(status, 40).toLowerCase();
  if (statusText) {
    where.push(`t.status = $${idx}`);
    params.push(statusText);
    idx += 1;
  }
  const patient = maybeUuid(patientUid);
  if (patient) {
    where.push(`t.patient_uid = $${idx}::uuid`);
    params.push(patient);
    idx += 1;
  }
  const source = sourceType ? normalizeSourceType(sourceType) : null;
  if (source) {
    where.push(`t.source_type = $${idx}`);
    params.push(source);
    idx += 1;
  }
  const assignedUid = maybeUuid(assignedToMeUid);
  if (assignedUid) {
    where.push(`EXISTS (
      SELECT 1 FROM porter_transport_task_recipients r
       WHERE r.tenant_id = t.tenant_id
         AND r.task_id = t.id
         AND r.staff_uid = $${idx}::uuid
    )`);
    params.push(assignedUid);
    idx += 1;
  }
  const rows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT t.*,
            COUNT(r.id)::int AS recipient_count
       FROM porter_transport_tasks t
       LEFT JOIN porter_transport_task_recipients r
         ON r.tenant_id = t.tenant_id AND r.task_id = t.id
      WHERE ${where.join(' AND ')}
      GROUP BY t.id
      ORDER BY
        CASE t.status
          WHEN 'picked_up' THEN 0
          WHEN 'accepted' THEN 1
          WHEN 'assigned' THEN 2
          WHEN 'open' THEN 3
          ELSE 4
        END,
        t.sla_due_at ASC NULLS LAST,
        t.created_at DESC
      LIMIT $${idx}::int`,
    ...params,
    clampLimit(limit),
  ));
  return rows.map(serializeTask);
}

export async function getTransportTask({ tenantId, taskId }) {
  const tid = requireTenantId(tenantId);
  const id = intId(taskId);
  if (!id) throw AppError.badRequest('Transport task id is required', 'TRANSPORT_TASK_ID_REQUIRED');
  return setTenant(tid, async (tx) => {
    const task = await loadTask(tx, { tenantId: tid, taskId: id });
    const recipients = await tx.$queryRawUnsafe(
      `SELECT r.id, r.task_id, r.staff_id, r.staff_uid, r.recipient_kind,
              r.source, r.notified_at, r.accepted_at, r.declined_at, u.name, u.role
         FROM porter_transport_task_recipients r
         LEFT JOIN users u ON u.id = r.staff_id
        WHERE r.tenant_id = $1::uuid
          AND r.task_id = $2::bigint
        ORDER BY CASE r.recipient_kind WHEN 'assigned_staff' THEN 0 WHEN 'incharge' THEN 1 ELSE 2 END, r.id`,
      tid,
      id,
    );
    const updates = await tx.$queryRawUnsafe(
      `SELECT id, task_id, author_uid, author_role, status_from, status_to,
              message, location_text, is_internal AS internal, metadata, created_at
         FROM porter_transport_task_updates
        WHERE tenant_id = $1::uuid
          AND task_id = $2::bigint
        ORDER BY created_at ASC, id ASC`,
      tid,
      id,
    );
    return {
      task,
      recipients: recipients.map(serializeRow),
      updates: updates.map(serializeRow),
    };
  });
}

async function transitionTransportTask({
  tenantId,
  taskId,
  nextStatus,
  actorUid,
  actorRole,
  body = {},
  requireRecipient = true,
  allowedFrom,
}) {
  const tid = requireTenantId(tenantId);
  const id = intId(taskId);
  if (!id) throw AppError.badRequest('Transport task id is required', 'TRANSPORT_TASK_ID_REQUIRED');
  const result = await setTenantTx(tid, async (tx) => {
    const task = await loadTask(tx, { tenantId: tid, taskId: id, lock: true });
    if (TERMINAL_STATUSES.has(task.status)) {
      throw AppError.conflict('Transport task is already terminal', 'TRANSPORT_TASK_TERMINAL', { status: task.status });
    }
    if (Array.isArray(allowedFrom) && !allowedFrom.includes(task.status)) {
      throw AppError.invalidTransition(task.status, nextStatus, allowedFrom);
    }
    let recipient = null;
    if (requireRecipient) {
      recipient = await checkAssignedRecipient(tx, { tenantId: tid, taskId: id, actorUid });
      if (!recipient && !isTransportAssignee(task, { uid: actorUid })) {
        throw AppError.forbidden('Only an assigned transport recipient can update this task', 'TRANSPORT_ASSIGNEE_REQUIRED');
      }
    }
    if (nextStatus === 'cancelled') {
      // B-L5(b) — cancellation is not open to the whole transport role
      // union. Allowed: the staff member who raised the job, or a
      // coordination/escalation role (TRANSPORT_CANCEL_ROLES). Porters
      // executing the job cannot cancel it (and with it its SLA).
      const role = cleanText(actorRole, 80).toUpperCase();
      const uid = maybeUuid(actorUid);
      const isRequester = Boolean(uid)
        && Boolean(task.requested_by)
        && String(task.requested_by) === uid;
      if (!isRequester && !TRANSPORT_CANCEL_ROLES.includes(role)) {
        throw AppError.forbidden(
          'Only the requester or a transport coordination role can cancel a transport task',
          'TRANSPORT_CANCEL_ROLE_REQUIRED',
        );
      }
    }

    const updateParams = [
      tid,
      id,
      task.status,
      nextStatus,
      maybeUuid(actorUid),
      jsonString({
        ...(jsonObject(body.metadata, {})),
        last_location_text: cleanText(body.locationText ?? body.location_text, 255) || null,
      }),
    ];
    const setClauses = [
      'status = $4',
      'updated_by = $5::uuid',
      'updated_at = NOW()',
      'metadata = metadata || $6::jsonb',
    ];
    if (nextStatus === 'accepted') {
      setClauses.push('accepted_at = COALESCE(accepted_at, NOW())');
      setClauses.push('accepted_by = COALESCE(accepted_by, $5::uuid)');
    } else if (nextStatus === 'picked_up') {
      setClauses.push('picked_up_at = COALESCE(picked_up_at, NOW())');
      setClauses.push('picked_up_by = COALESCE(picked_up_by, $5::uuid)');
    } else if (nextStatus === 'completed') {
      // B-L5(a) — the verification identity is the authenticated caller,
      // never the request body. A caller-supplied verified_by/verifier_id
      // let any recipient stamp someone else (e.g. a ward nurse who never
      // saw the patient) as the completion verifier. verifier_id is
      // resolved from the actor's own users row inside the same tenant tx.
      const verifierUid = maybeUuid(actorUid);
      let verifierId = null;
      if (verifierUid) {
        const verifierRows = await tx.$queryRawUnsafe(
          `SELECT id FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid LIMIT 1`,
          tid,
          verifierUid,
        );
        verifierId = verifierRows[0] ? Number(verifierRows[0].id) : null;
      }
      updateParams.push(verifierUid);
      updateParams.push(verifierId);
      setClauses.push('completed_at = COALESCE(completed_at, NOW())');
      setClauses.push('completed_by = COALESCE(completed_by, $5::uuid)');
      setClauses.push('verified_by = COALESCE($7::uuid, verified_by)');
      setClauses.push('verifier_id = COALESCE($8::int, verifier_id)');
    } else if (nextStatus === 'cancelled') {
      updateParams.push(cleanText(body.reason ?? body.cancellationReason ?? body.cancellation_reason, 500) || null);
      setClauses.push('cancelled_at = COALESCE(cancelled_at, NOW())');
      setClauses.push('cancelled_by = COALESCE(cancelled_by, $5::uuid)');
      setClauses.push('cancellation_reason = COALESCE($7, cancellation_reason)');
    }

    const rows = await tx.$queryRawUnsafe(
      `UPDATE porter_transport_tasks
          SET ${setClauses.join(', ')}
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND status = $3
        RETURNING *`,
      ...updateParams,
    );
    const updated = serializeTask(rows[0]);
    if (!updated) throw AppError.conflict('Transport task changed while updating', 'TRANSPORT_TASK_STALE');

    if (recipient && nextStatus === 'accepted') {
      await tx.$executeRawUnsafe(
        `UPDATE porter_transport_task_recipients
            SET accepted_at = COALESCE(accepted_at, NOW()),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND task_id = $2::bigint
            AND staff_uid = $3::uuid`,
        tid,
        id,
        maybeUuid(actorUid),
      );
    }

    if (nextStatus === 'completed' || nextStatus === 'cancelled') {
      await closeTransportSla(tx, {
        tenantId: tid,
        task: updated,
        status: nextStatus,
        actorUid,
      });
    }

    await appendUpdate(tx, {
      tenantId: tid,
      taskId: id,
      authorUid: actorUid,
      authorRole: actorRole,
      fromStatus: task.status,
      toStatus: nextStatus,
      message: body.message || null,
      locationText: body.locationText ?? body.location_text ?? null,
      metadata: body.metadata || {},
    });
    await recordTaskCanonicalEvents(tx, {
      tenantId: tid,
      task: updated,
      actorUid,
      actorRole,
      action: nextStatus,
      status: nextStatus,
      summary: `Patient transport task ${updated.task_number} ${nextStatus}`,
      beforeState: { status: task.status },
      afterState: { status: nextStatus },
    });
    return updated;
  });

  emitTransportEvent(`transport-task-${nextStatus}`, { tenantId: tid });
  return result;
}

export function acceptTransportTask(args) {
  return transitionTransportTask({
    ...args,
    nextStatus: 'accepted',
    allowedFrom: ['open', 'assigned'],
    requireRecipient: true,
  });
}

export function pickupTransportTask(args) {
  return transitionTransportTask({
    ...args,
    nextStatus: 'picked_up',
    allowedFrom: ['assigned', 'accepted'],
    requireRecipient: true,
  });
}

export function completeTransportTask(args) {
  return transitionTransportTask({
    ...args,
    nextStatus: 'completed',
    allowedFrom: ['assigned', 'accepted', 'picked_up'],
    requireRecipient: true,
  });
}

export function cancelTransportTask(args) {
  return transitionTransportTask({
    ...args,
    nextStatus: 'cancelled',
    allowedFrom: ACTIVE_STATUSES,
    requireRecipient: false,
  });
}

export async function assignTransportTask({ tenantId, taskId, actorUid, actorRole, body = {} }) {
  const tid = requireTenantId(tenantId);
  const id = intId(taskId);
  const staffId = intId(body.staffId ?? body.staff_id);
  const staffUid = maybeUuid(body.staffUid ?? body.staff_uid);
  if (!id || (!staffId && !staffUid)) {
    throw AppError.badRequest('Transport task id and staff id or uid are required', 'TRANSPORT_ASSIGNMENT_REQUIRED');
  }

  const result = await setTenantTx(tid, async (tx) => {
    const task = await loadTask(tx, { tenantId: tid, taskId: id, lock: true });
    if (TERMINAL_STATUSES.has(task.status)) {
      throw AppError.conflict('Transport task is already terminal', 'TRANSPORT_TASK_TERMINAL');
    }
    const users = await tx.$queryRawUnsafe(
      `SELECT id, uid, name, phone, role
         FROM users
        WHERE tenant_id = $1::uuid
          AND COALESCE(is_active, true) = true
          AND (
            ($2::int IS NOT NULL AND id = $2::int)
            OR ($3::uuid IS NOT NULL AND uid = $3::uuid)
          )
        LIMIT 1`,
      tid,
      staffId,
      staffUid,
    );
    const staff = users[0];
    if (!staff) throw AppError.notFound('Transport staff member not found', 'TRANSPORT_STAFF_NOT_FOUND');

    const rows = await tx.$queryRawUnsafe(
      `UPDATE porter_transport_tasks
          SET assigned_porter_uid = $3::uuid,
              assigned_porter_id = $4::int,
              status = CASE WHEN status = 'open' THEN 'assigned' ELSE status END,
              assigned_at = COALESCE(assigned_at, NOW()),
              updated_by = $5::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
        RETURNING *`,
      tid,
      id,
      staff.uid,
      staff.id,
      maybeUuid(actorUid),
    );
    await insertRecipients(tx, {
      tenantId: tid,
      taskId: id,
      recipients: [{ ...staff, recipient_kind: 'assigned_staff', source: 'manual_assignment' }],
    });
    await appendUpdate(tx, {
      tenantId: tid,
      taskId: id,
      authorUid: actorUid,
      authorRole: actorRole,
      fromStatus: task.status,
      toStatus: rows[0].status,
      message: body.message || `Assigned to ${staff.name || staff.role || 'transport staff'}`,
      metadata: { assigned_staff_uid: staff.uid },
    });
    const updated = serializeTask(rows[0]);
    await recordTaskCanonicalEvents(tx, {
      tenantId: tid,
      task: updated,
      actorUid,
      actorRole,
      action: 'assigned',
      status: updated.status,
      summary: `Patient transport task ${updated.task_number} assigned`,
      beforeState: { status: task.status, assigned_porter_uid: task.assigned_porter_uid || null },
      afterState: { status: updated.status, assigned_porter_uid: updated.assigned_porter_uid || null },
    });
    return {
      task: updated,
      recipient: uniqueRecipients([{ ...staff, recipient_kind: 'assigned_staff', source: 'manual_assignment' }])[0],
    };
  });

  await notifyRecipients({
    tenantId: tid,
    task: result.task,
    recipients: [result.recipient],
    eventKind: 'transport-task-assigned',
    title: 'Patient transport task assigned',
    body: taskTitle(result.task),
  });
  emitTransportEvent('transport-task-assigned', { tenantId: tid });
  return result.task;
}

export async function runTransportEscalationSweep({ now = new Date(), limit = DEFAULT_ESCALATION_LIMIT } = {}) {
  const clock = now instanceof Date ? now : new Date(now);
  const cap = clampLimit(limit, DEFAULT_ESCALATION_LIMIT, 500);
  const counters = { scanned: 0, breached: 0, notified: 0 };
  let tenants = [];
  try {
    tenants = await setTenant(null, (tx) => tx.$queryRawUnsafe(
      `SELECT DISTINCT tenant_id
         FROM porter_transport_tasks
        WHERE status IN ('open', 'assigned', 'accepted', 'picked_up')
          AND sla_due_at IS NOT NULL
          AND sla_due_at < $1::timestamptz`,
      clock.toISOString(),
    ), { superAdmin: true });
  } catch (err) {
    logger.error('transport escalation sweep tenant discovery failed', { error: err?.message });
    return counters;
  }

  for (const row of Array.isArray(tenants) ? tenants : []) {
    const tenantId = row.tenant_id;
    if (!tenantId) continue;
    try {
      const tenantResult = await setTenantTx(tenantId, async (tx) => {
        const settings = await getSettings(tx, tenantId);
        const dueRows = await tx.$queryRawUnsafe(
          `SELECT *
             FROM porter_transport_tasks
            WHERE tenant_id = $1::uuid
              AND status IN ('open', 'assigned', 'accepted', 'picked_up')
              AND sla_due_at IS NOT NULL
              AND sla_due_at < $2::timestamptz
            ORDER BY sla_due_at ASC, id ASC
            LIMIT $3::int
            FOR UPDATE`,
          tenantId,
          clock.toISOString(),
          cap,
        );
        const notify = [];
        for (const task of dueRows) {
          counters.scanned += 1;
          const metadata = jsonObject(task.metadata, {});
          if (metadata.escalated_at) continue;
          const escalationRecipients = await resolveRecipients(tx, {
            tenantId,
            settings,
            pickupZoneId: task.pickup_zone_id,
            destinationZoneId: task.destination_zone_id,
            now: clock,
            includeEscalation: true,
          });
          const escalationOnly = escalationRecipients.filter((recipient) => recipient.recipient_kind === 'escalation');
          await insertRecipients(tx, {
            tenantId,
            taskId: task.id,
            recipients: escalationOnly,
          });
          await tx.$executeRawUnsafe(
            `UPDATE porter_transport_tasks
                SET metadata = metadata || $3::jsonb,
                    updated_at = NOW()
              WHERE tenant_id = $1::uuid
                AND id = $2::bigint`,
            tenantId,
            task.id,
            jsonString({
              escalated_at: clock.toISOString(),
              escalation_reason: 'sla_due',
            }),
          );
          await tx.$executeRawUnsafe(
            `UPDATE workflow_sla_instances
                SET status = 'breached',
                    breached_at = COALESCE(breached_at, $3::timestamptz),
                    metadata = metadata || $4::jsonb,
                    updated_at = NOW()
              WHERE tenant_id = $1::uuid
                AND source_table = 'porter_transport_tasks'
                AND source_id = $2`,
            tenantId,
            String(task.id),
            clock.toISOString(),
            jsonString({ breached_by: 'porter_transport_escalation_sweep' }),
          );
          await appendUpdate(tx, {
            tenantId,
            taskId: task.id,
            authorUid: null,
            authorRole: 'SYSTEM',
            fromStatus: task.status,
            toStatus: task.status,
            internal: true,
            message: 'Transport task SLA breached; escalation recipients notified',
            metadata: { escalated_at: clock.toISOString() },
          });
          counters.breached += 1;
          notify.push({
            task: serializeTask(task),
            recipients: escalationOnly,
          });
        }
        return notify;
      });

      for (const item of tenantResult) {
        const notificationResult = await notifyRecipients({
          tenantId,
          task: item.task,
          recipients: item.recipients,
          eventKind: 'transport-task-escalated',
          title: 'Patient transport SLA breached',
          body: taskTitle(item.task),
        });
        counters.notified += notificationResult.notification_count;
      }
      if (tenantResult.length) emitTransportEvent('transport-task-escalated', { tenantId });
    } catch (err) {
      logger.error('transport escalation sweep tenant pass failed', {
        tenantId,
        error: err?.message,
      });
    }
  }
  return counters;
}

export default {
  acceptTransportTask,
  assignTransportTask,
  cancelTransportTask,
  completeTransportTask,
  createTransportTask,
  getTransportTask,
  listTransportTasks,
  listTransportZones,
  pickupTransportTask,
  readTransportSettings,
  runTransportEscalationSweep,
  updateTransportSettings,
  upsertTransportZone,
};

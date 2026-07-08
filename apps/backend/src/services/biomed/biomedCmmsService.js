import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_SERVICE_INTERVALS_HOURS } from '../ai/biomedDeviceMaintenanceService.js';
import { requireTenantId } from '../tenant/tenantService.js';

const WORK_ORDER_KINDS = new Set(['preventive', 'corrective', 'calibration', 'inspection', 'condemnation']);
const SCHEDULE_KINDS = new Set(['preventive', 'calibration', 'inspection']);
const PRIORITIES = new Set(['normal', 'high', 'urgent']);
const STATUSES = new Set(['open', 'assigned', 'in_progress', 'completed', 'verified', 'cancelled']);
const SOURCES = new Set(['schedule', 'manual', 'device_fault', 'ai_prediction']);
const CERTIFICATE_RESULTS = new Set(['pass', 'fail', 'adjusted']);
const ACTIVE_STATUSES = ['open', 'assigned', 'in_progress'];
const DONE_STATUSES = ['completed', 'verified', 'cancelled'];
const BIOMED_NOTIFICATION_ROLES = [
  'BIOMEDICAL_STAFF',
  'MAINTENANCE',
  'FACILITY_MANAGER',
  'ADMIN',
  'SUPER_ADMIN',
];
const SLA_HOURS = { urgent: 4, high: 24, normal: 168 };

function cleanText(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function toNullableText(value) {
  const text = cleanText(value);
  return text || null;
}

function optionalInt(value, fieldName = 'id') {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function requiredInt(value, fieldName = 'id') {
  const parsed = optionalInt(value, fieldName);
  if (!parsed) throw AppError.badRequest(`${fieldName} is required`);
  return parsed;
}

function optionalNumber(value, fieldName) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw AppError.badRequest(`${fieldName} must be a non-negative number`);
  }
  return parsed;
}

function optionalDateIso(value, fieldName) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw AppError.badRequest(`${fieldName} must be a valid date`);
  return date.toISOString();
}

function normalizeEnum(value, allowed, fallback, fieldName) {
  const text = cleanText(value, fallback).toLowerCase();
  if (!allowed.has(text)) {
    throw AppError.badRequest(`${fieldName} must be one of: ${[...allowed].join(', ')}`);
  }
  return text;
}

function normalizePriority(value, fallback = 'normal') {
  return normalizeEnum(value, PRIORITIES, fallback, 'priority');
}

function normalizeKind(value, fallback = 'corrective') {
  return normalizeEnum(value, WORK_ORDER_KINDS, fallback, 'kind');
}

function normalizeScheduleKind(value, fallback = 'preventive') {
  return normalizeEnum(value, SCHEDULE_KINDS, fallback, 'kind');
}

function normalizeSource(value, fallback = 'manual') {
  return normalizeEnum(value, SOURCES, fallback, 'source');
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function addHours(base, hours) {
  const date = base instanceof Date ? new Date(base.getTime()) : new Date(base);
  date.setUTCHours(date.getUTCHours() + hours);
  return date.toISOString();
}

function addDays(base, days) {
  const date = base instanceof Date ? new Date(base.getTime()) : new Date(base);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

export function calculateDowntimeMinutes(startedAt, endedAt) {
  if (!startedAt || !endedAt) return 0;
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return 0;
  return Math.round((end.getTime() - start.getTime()) / 60000);
}

export function assertWorkOrderTransition(from, to) {
  const current = cleanText(from, 'open').toLowerCase();
  const next = cleanText(to).toLowerCase();
  const allowed = {
    open: ['assigned', 'in_progress', 'cancelled'],
    assigned: ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed: ['verified'],
    verified: [],
    cancelled: [],
  }[current] || [];
  if (!allowed.includes(next)) {
    throw AppError.invalidTransition(current, next, allowed);
  }
  return true;
}

export function rejectRawCertificatePayload(payload = {}) {
  if (
    payload.document_base64 ||
    payload.file_base64 ||
    payload.certificate_base64 ||
    payload.raw_document
  ) {
    throw AppError.badRequest('Calibration certificates must reference a validated upload document_id/storage key');
  }
}

function normalizeWorkOrderRow(row) {
  if (!row) return null;
  const downtimeMinutes = calculateDowntimeMinutes(row.downtime_started_at, row.downtime_ended_at);
  const slaDue = row.sla_due_at ? new Date(row.sla_due_at) : null;
  const isOpen = ACTIVE_STATUSES.includes(row.status);
  return {
    id: toNumber(row.id),
    tenant_id: row.tenant_id,
    work_order_number: row.work_order_number,
    biomed_device_id: toNumber(row.biomed_device_id),
    schedule_id: row.schedule_id === null || row.schedule_id === undefined ? null : toNumber(row.schedule_id),
    kind: row.kind,
    priority: row.priority,
    status: row.status,
    description: row.description,
    assigned_to_id: row.assigned_to_id === null || row.assigned_to_id === undefined ? null : toNumber(row.assigned_to_id),
    assigned_to_uid: row.assigned_to_uid || null,
    assigned_to_role: row.assigned_to_role || null,
    assigned_vendor: row.assigned_vendor || null,
    assigned_at: row.assigned_at || null,
    sla_due_at: row.sla_due_at || null,
    sla_breached_at: row.sla_breached_at || null,
    completion_notes: row.completion_notes || null,
    parts_used: safeJson(row.parts_used, []),
    cost_amount: row.cost_amount === null || row.cost_amount === undefined ? null : Number(row.cost_amount),
    downtime_started_at: row.downtime_started_at || null,
    downtime_ended_at: row.downtime_ended_at || null,
    downtime_minutes: downtimeMinutes,
    completed_at: row.completed_at || null,
    verified_at: row.verified_at || null,
    source: row.source,
    source_ref: row.source_ref || null,
    due_window_start: row.due_window_start || null,
    due_window_end: row.due_window_end || null,
    created_by: row.created_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    metadata: safeJson(row.metadata, {}),
    device_code: row.device_code || null,
    device_type: row.device_type || null,
    device_location: row.device_location || null,
    assignee_name: row.assignee_name || null,
    sla_breached: Boolean(row.sla_breached_at) || Boolean(isOpen && slaDue && slaDue < new Date()),
  };
}

function normalizeScheduleRow(row) {
  if (!row) return null;
  return {
    id: toNumber(row.id),
    tenant_id: row.tenant_id,
    biomed_device_id: toNumber(row.biomed_device_id),
    device_code: row.device_code || null,
    device_type: row.device_type || null,
    kind: row.kind,
    interval_days: row.interval_days === null || row.interval_days === undefined ? null : toNumber(row.interval_days),
    interval_usage_hours: row.interval_usage_hours === null || row.interval_usage_hours === undefined ? null : Number(row.interval_usage_hours),
    next_due_at: row.next_due_at || null,
    next_due_usage_hours: row.next_due_usage_hours === null || row.next_due_usage_hours === undefined ? null : Number(row.next_due_usage_hours),
    assigned_role: row.assigned_role || null,
    assigned_to_id: row.assigned_to_id === null || row.assigned_to_id === undefined ? null : toNumber(row.assigned_to_id),
    assigned_to_uid: row.assigned_to_uid || null,
    assigned_vendor: row.assigned_vendor || null,
    active: Boolean(row.active),
    last_work_order_id: row.last_work_order_id === null || row.last_work_order_id === undefined ? null : toNumber(row.last_work_order_id),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function normalizeCertificateRow(row) {
  if (!row) return null;
  return {
    id: toNumber(row.id),
    tenant_id: row.tenant_id,
    biomed_device_id: toNumber(row.biomed_device_id),
    work_order_id: row.work_order_id === null || row.work_order_id === undefined ? null : toNumber(row.work_order_id),
    certificate_number: row.certificate_number,
    calibrated_at: row.calibrated_at,
    due_at: row.due_at,
    performed_by: row.performed_by || null,
    performed_by_uid: row.performed_by_uid || null,
    document_id: row.document_id,
    document_storage_key: row.document_storage_key || null,
    document_mime_type: row.document_mime_type || null,
    result: row.result,
    notes: row.notes || null,
    device_code: row.device_code || null,
    device_type: row.device_type || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function ensureDevice(tx, tenantId, deviceId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, device_code, device_type, location, usage_hours, next_scheduled_maintenance_at
       FROM clinical_ai_biomed_devices
      WHERE tenant_id = $1::uuid
        AND id = $2::int
      LIMIT 1`,
    tenantId,
    deviceId
  );
  if (!rows[0]) throw AppError.notFound('Biomedical device not found');
  return rows[0];
}

async function loadWorkOrder(tx, tenantId, workOrderId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT wo.*,
            d.device_code,
            d.device_type,
            d.location AS device_location,
            u.name AS assignee_name
       FROM biomed_work_orders wo
       JOIN clinical_ai_biomed_devices d ON d.id = wo.biomed_device_id
       LEFT JOIN users u ON u.id = wo.assigned_to_id
      WHERE wo.tenant_id = $1::uuid
        AND wo.id = $2::bigint
      LIMIT 1`,
    tenantId,
    workOrderId
  );
  return normalizeWorkOrderRow(rows[0]);
}

async function insertWorkOrderUpdate(tx, {
  tenantId,
  workOrderId,
  previousStatus = null,
  status,
  message = null,
  actorId = null,
  actorUid = null,
  actorRole = null,
  metadata = {},
}) {
  await tx.$queryRawUnsafe(
    `INSERT INTO biomed_work_order_updates
       (tenant_id, work_order_id, previous_status, status, message, author_id, author_uid, author_role, metadata)
     VALUES ($1::uuid, $2::bigint, $3, $4, $5, $6::int, $7::uuid, $8, $9::jsonb)`,
    tenantId,
    workOrderId,
    previousStatus,
    status,
    message,
    actorId,
    actorUid,
    actorRole,
    JSON.stringify(metadata || {})
  );
}

async function resolveRecipients({ tenantId, assignedToId = null }) {
  if (assignedToId) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, uid, name, phone, role
         FROM users
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND is_active = true
        LIMIT 1`,
      tenantId,
      assignedToId
    );
    return rows;
  }

  return prisma.$queryRawUnsafe(
    `SELECT id, uid, name, phone, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND is_active = true
        AND role IN ('BIOMEDICAL_STAFF', 'MAINTENANCE', 'FACILITY_MANAGER', 'ADMIN', 'SUPER_ADMIN')
      ORDER BY CASE role
                 WHEN 'BIOMEDICAL_STAFF' THEN 0
                 WHEN 'MAINTENANCE' THEN 1
                 WHEN 'FACILITY_MANAGER' THEN 2
                 WHEN 'ADMIN' THEN 3
                 ELSE 4
               END,
               name NULLS LAST,
               id
      LIMIT 25`,
    tenantId
  );
}

async function ensureRecipientsForWorkOrder({ tenantId, workOrder }) {
  const recipients = await resolveRecipients({
    tenantId,
    assignedToId: workOrder.assigned_to_id,
  });
  if (!recipients.length) return [];

  await setTenantTx(tenantId, async (tx) => {
    for (const recipient of recipients) {
      await tx.$queryRawUnsafe(
        `INSERT INTO biomed_work_order_recipients
           (tenant_id, work_order_id, staff_id, staff_uid, recipient_kind, source, updated_at)
         VALUES ($1::uuid, $2::bigint, $3::int, $4::uuid, $5, $6, NOW())
         ON CONFLICT (tenant_id, work_order_id, staff_id)
         DO UPDATE SET
           staff_uid = EXCLUDED.staff_uid,
           recipient_kind = EXCLUDED.recipient_kind,
           source = EXCLUDED.source,
           updated_at = NOW()`,
        tenantId,
        workOrder.id,
        recipient.id,
        recipient.uid || null,
        workOrder.assigned_to_id ? 'assignee' : 'role_recipient',
        workOrder.assigned_to_id ? 'assigned_user' : 'biomed_role'
      );
    }
  });
  return recipients;
}

async function queueWorkOrderNotifications({ workOrder, recipients, title, body, priority = null }) {
  await Promise.all(recipients.map((recipient) =>
    notificationOutbox.queue({
      type: 'push',
      recipientId: recipient.id,
      recipientPhone: recipient.phone || null,
      title,
      body,
      data: {
        category: 'BIOMED_CMMS',
        priority: priority || workOrder.priority,
        work_order_id: workOrder.id,
        work_order_number: workOrder.work_order_number,
        device_code: workOrder.device_code,
        source: workOrder.source,
      },
    })
  ));
}

async function afterWorkOrderWrite({ tenantId, workOrder, notificationTitle, notificationBody }) {
  const recipients = await ensureRecipientsForWorkOrder({ tenantId, workOrder });
  if (recipients.length) {
    await queueWorkOrderNotifications({
      workOrder,
      recipients,
      title: notificationTitle,
      body: notificationBody,
    });
  }
  return { ...workOrder, recipient_count: recipients.length };
}

async function findExistingOpenWorkOrder(tx, { tenantId, deviceId, source, sourceRef, scheduleId, dueWindowStart }) {
  if (source === 'schedule' && scheduleId && dueWindowStart) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT wo.*,
              d.device_code,
              d.device_type,
              d.location AS device_location,
              u.name AS assignee_name
         FROM biomed_work_orders wo
         JOIN clinical_ai_biomed_devices d ON d.id = wo.biomed_device_id
         LEFT JOIN users u ON u.id = wo.assigned_to_id
        WHERE wo.tenant_id = $1::uuid
          AND wo.schedule_id = $2::bigint
          AND wo.due_window_start = $3::timestamptz
        LIMIT 1`,
      tenantId,
      scheduleId,
      dueWindowStart
    );
    return normalizeWorkOrderRow(rows[0]);
  }

  if (source === 'device_fault') {
    const rows = await tx.$queryRawUnsafe(
      `SELECT wo.*,
              d.device_code,
              d.device_type,
              d.location AS device_location,
              u.name AS assignee_name
         FROM biomed_work_orders wo
         JOIN clinical_ai_biomed_devices d ON d.id = wo.biomed_device_id
         LEFT JOIN users u ON u.id = wo.assigned_to_id
        WHERE wo.tenant_id = $1::uuid
          AND wo.biomed_device_id = $2::int
          AND wo.source = 'device_fault'
          AND wo.status IN ('open', 'assigned', 'in_progress')
          AND ($3::text IS NULL OR wo.source_ref = $3)
        ORDER BY wo.created_at DESC
        LIMIT 1`,
      tenantId,
      deviceId,
      sourceRef || null
    );
    return normalizeWorkOrderRow(rows[0]);
  }

  if (source === 'ai_prediction' && sourceRef) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT wo.*,
              d.device_code,
              d.device_type,
              d.location AS device_location,
              u.name AS assignee_name
         FROM biomed_work_orders wo
         JOIN clinical_ai_biomed_devices d ON d.id = wo.biomed_device_id
         LEFT JOIN users u ON u.id = wo.assigned_to_id
        WHERE wo.tenant_id = $1::uuid
          AND wo.source = 'ai_prediction'
          AND wo.source_ref = $2
          AND wo.status IN ('open', 'assigned', 'in_progress', 'completed')
        ORDER BY wo.created_at DESC
        LIMIT 1`,
      tenantId,
      sourceRef
    );
    return normalizeWorkOrderRow(rows[0]);
  }

  return null;
}

export async function createWorkOrder({
  tenantId = null,
  biomedDeviceId,
  kind = 'corrective',
  priority = 'normal',
  description,
  assignedToId = null,
  assignedToUid = null,
  assignedToRole = null,
  assignedVendor = null,
  actorId = null,
  actorUid = null,
  actorRole = null,
  slaDueAt = null,
  partsUsed = [],
  costAmount = null,
  downtimeStartedAt = null,
  source = 'manual',
  sourceRef = null,
  scheduleId = null,
  dueWindowStart = null,
  dueWindowEnd = null,
  metadata = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const deviceId = requiredInt(biomedDeviceId, 'biomed_device_id');
  const normalizedKind = normalizeKind(kind);
  const normalizedPriority = normalizePriority(priority);
  const normalizedSource = normalizeSource(source);
  const cleanDescription = cleanText(description);
  if (!cleanDescription) throw AppError.badRequest('description is required');
  const assigneeId = optionalInt(assignedToId, 'assigned_to_id');
  const orderStatus = assigneeId || assignedToUid ? 'assigned' : 'open';
  const now = new Date();
  const dueIso = optionalDateIso(slaDueAt, 'sla_due_at') || addHours(now, SLA_HOURS[normalizedPriority]);
  const sourceReference = toNullableText(sourceRef);
  const dueStartIso = optionalDateIso(dueWindowStart, 'due_window_start');
  const dueEndIso = optionalDateIso(dueWindowEnd, 'due_window_end');
  const schedule = optionalInt(scheduleId, 'schedule_id');

  const created = await setTenantTx(tid, async (tx) => {
    await ensureDevice(tx, tid, deviceId);
    const existing = await findExistingOpenWorkOrder(tx, {
      tenantId: tid,
      deviceId,
      source: normalizedSource,
      sourceRef: sourceReference,
      scheduleId: schedule,
      dueWindowStart: dueStartIso,
    });
    if (existing) return { workOrder: existing, deduped: true };

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO biomed_work_orders
         (tenant_id, biomed_device_id, schedule_id, kind, priority, status, description,
          assigned_to_id, assigned_to_uid, assigned_to_role, assigned_vendor,
          assigned_by, assigned_at, sla_due_at, parts_used, cost_amount,
          downtime_started_at, source, source_ref, due_window_start, due_window_end,
          created_by, metadata)
       VALUES ($1::uuid, $2::int, $3::bigint, $4, $5, $6, $7,
               $8::int, $9::uuid, $10, $11,
               $12::uuid, CASE WHEN $6 = 'assigned' THEN NOW() ELSE NULL END,
               $13::timestamptz, $14::jsonb, $15,
               $16::timestamptz, $17, $18, $19::timestamptz, $20::timestamptz,
               $21::uuid, $22::jsonb)
       RETURNING *`,
      tid,
      deviceId,
      schedule,
      normalizedKind,
      normalizedPriority,
      orderStatus,
      cleanDescription,
      assigneeId,
      assignedToUid || null,
      toNullableText(assignedToRole),
      toNullableText(assignedVendor),
      actorUid || null,
      dueIso,
      JSON.stringify(Array.isArray(partsUsed) ? partsUsed : []),
      optionalNumber(costAmount, 'cost_amount'),
      optionalDateIso(downtimeStartedAt, 'downtime_started_at'),
      normalizedSource,
      sourceReference,
      dueStartIso,
      dueEndIso,
      actorUid || null,
      JSON.stringify(metadata || {})
    );
    const workOrder = await loadWorkOrder(tx, tid, rows[0].id);
    await insertWorkOrderUpdate(tx, {
      tenantId: tid,
      workOrderId: workOrder.id,
      status: workOrder.status,
      message: 'Work order opened',
      actorId,
      actorUid,
      actorRole,
      metadata: { source: normalizedSource },
    });
    return { workOrder, deduped: false };
  });

  if (created.deduped) return { ...created.workOrder, deduped: true };
  return afterWorkOrderWrite({
    tenantId: tid,
    workOrder: created.workOrder,
    notificationTitle: 'Biomedical work order opened',
    notificationBody: `${created.workOrder.work_order_number}: ${created.workOrder.device_code || 'device'} needs ${created.workOrder.kind} work`,
  });
}

export async function listWorkOrders({
  tenantId = null,
  status = null,
  assignedToId = null,
  assignedToUid = null,
  source = null,
  deviceId = null,
  limit = 100,
} = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 250);
  const normalizedStatus = status && STATUSES.has(cleanText(status).toLowerCase())
    ? cleanText(status).toLowerCase()
    : null;
  const normalizedSource = source && SOURCES.has(cleanText(source).toLowerCase())
    ? cleanText(source).toLowerCase()
    : null;
  const did = optionalInt(deviceId, 'biomed_device_id');
  const assigneeId = optionalInt(assignedToId, 'assigned_to_id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT wo.*,
            d.device_code,
            d.device_type,
            d.location AS device_location,
            u.name AS assignee_name
       FROM biomed_work_orders wo
       JOIN clinical_ai_biomed_devices d ON d.id = wo.biomed_device_id
       LEFT JOIN users u ON u.id = wo.assigned_to_id
      WHERE wo.tenant_id = $1::uuid
        AND ($2::text IS NULL OR wo.status = $2)
        AND ($3::int IS NULL OR wo.assigned_to_id = $3)
        AND ($4::uuid IS NULL OR wo.assigned_to_uid = $4)
        AND ($5::text IS NULL OR wo.source = $5)
        AND ($6::int IS NULL OR wo.biomed_device_id = $6)
      ORDER BY
        CASE WHEN wo.status IN ('open', 'assigned', 'in_progress') THEN 0 ELSE 1 END,
        CASE wo.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
        wo.sla_due_at NULLS LAST,
        wo.created_at DESC
      LIMIT $7`,
    tid,
    normalizedStatus,
    assigneeId,
    assignedToUid || null,
    normalizedSource,
    did,
    safeLimit
  );
  const workOrders = rows.map(normalizeWorkOrderRow);
  return { work_orders: workOrders, count: workOrders.length };
}

export async function listMyWorkOrders({ tenantId = null, userId = null, userUid = null, limit = 100 } = {}) {
  const tid = requireTenantId(tenantId);
  const uid = userUid || null;
  const id = optionalInt(userId, 'user_id');
  if (!id && !uid) throw AppError.badRequest('user_id or user_uid is required');
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 250);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT wo.*,
            d.device_code,
            d.device_type,
            d.location AS device_location,
            u.name AS assignee_name
       FROM biomed_work_orders wo
       JOIN clinical_ai_biomed_devices d ON d.id = wo.biomed_device_id
       LEFT JOIN users u ON u.id = wo.assigned_to_id
       LEFT JOIN biomed_work_order_recipients r
         ON r.tenant_id = wo.tenant_id
        AND r.work_order_id = wo.id
      WHERE wo.tenant_id = $1::uuid
        AND (
          ($2::int IS NOT NULL AND (wo.assigned_to_id = $2 OR r.staff_id = $2))
          OR ($3::uuid IS NOT NULL AND (wo.assigned_to_uid = $3 OR r.staff_uid = $3))
        )
      ORDER BY
        CASE WHEN wo.status IN ('open', 'assigned', 'in_progress') THEN 0 ELSE 1 END,
        CASE wo.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
        wo.sla_due_at NULLS LAST,
        wo.created_at DESC
      LIMIT $4`,
    tid,
    id,
    uid,
    safeLimit
  );
  const workOrders = rows.map(normalizeWorkOrderRow);
  return {
    assigned: workOrders.filter((row) => ACTIVE_STATUSES.includes(row.status)),
    completed: workOrders.filter((row) => DONE_STATUSES.includes(row.status)),
    count: workOrders.length,
  };
}

async function transitionWorkOrder({
  tenantId,
  workOrderId,
  nextStatus,
  actorId = null,
  actorUid = null,
  actorRole = null,
  message = null,
  patch = {},
  updateMetadata = {},
}) {
  const tid = requireTenantId(tenantId);
  const id = requiredInt(workOrderId, 'work_order_id');
  return setTenantTx(tid, async (tx) => {
    const current = await loadWorkOrder(tx, tid, id);
    if (!current) throw AppError.notFound('Biomed work order not found');
    assertWorkOrderTransition(current.status, nextStatus);
    const downtimeEnd = patch.downtimeEndedAt
      ? optionalDateIso(patch.downtimeEndedAt, 'downtime_ended_at')
      : null;
    const rows = await tx.$queryRawUnsafe(
      `UPDATE biomed_work_orders
          SET status = $3,
              assigned_to_id = COALESCE($4::int, assigned_to_id),
              assigned_to_uid = COALESCE($5::uuid, assigned_to_uid),
              assigned_to_role = COALESCE($6, assigned_to_role),
              assigned_vendor = COALESCE($7, assigned_vendor),
              assigned_by = CASE WHEN $3 = 'assigned' THEN $8::uuid ELSE assigned_by END,
              assigned_at = CASE WHEN $3 = 'assigned' THEN NOW() ELSE assigned_at END,
              completion_notes = COALESCE($9, completion_notes),
              parts_used = CASE WHEN $10::jsonb IS NULL THEN parts_used ELSE $10::jsonb END,
              cost_amount = COALESCE($11, cost_amount),
              downtime_started_at = CASE
                WHEN $3 = 'in_progress' AND downtime_started_at IS NULL THEN NOW()
                ELSE downtime_started_at
              END,
              downtime_ended_at = CASE WHEN $3 = 'completed' THEN COALESCE($12::timestamptz, NOW()) ELSE downtime_ended_at END,
              completed_by = CASE WHEN $3 = 'completed' THEN $8::uuid ELSE completed_by END,
              completed_at = CASE WHEN $3 = 'completed' THEN NOW() ELSE completed_at END,
              verified_by = CASE WHEN $3 = 'verified' THEN $8::uuid ELSE verified_by END,
              verified_at = CASE WHEN $3 = 'verified' THEN NOW() ELSE verified_at END,
              sla_breached_at = CASE
                WHEN sla_breached_at IS NULL
                 AND status IN ('open', 'assigned', 'in_progress')
                 AND sla_due_at IS NOT NULL
                 AND sla_due_at < NOW() THEN NOW()
                ELSE sla_breached_at
              END,
              metadata = metadata || $13::jsonb,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
        RETURNING *`,
      tid,
      id,
      nextStatus,
      optionalInt(patch.assignedToId, 'assigned_to_id'),
      patch.assignedToUid || null,
      toNullableText(patch.assignedToRole),
      toNullableText(patch.assignedVendor),
      actorUid || null,
      toNullableText(patch.completionNotes),
      patch.partsUsed === undefined ? null : JSON.stringify(Array.isArray(patch.partsUsed) ? patch.partsUsed : []),
      optionalNumber(patch.costAmount, 'cost_amount'),
      downtimeEnd,
      JSON.stringify(updateMetadata || {})
    );
    await insertWorkOrderUpdate(tx, {
      tenantId: tid,
      workOrderId: id,
      previousStatus: current.status,
      status: nextStatus,
      message,
      actorId,
      actorUid,
      actorRole,
      metadata: updateMetadata,
    });
    if (nextStatus === 'verified' && ['preventive', 'calibration', 'inspection'].includes(current.kind)) {
      await tx.$queryRawUnsafe(
        `UPDATE clinical_ai_biomed_devices
            SET last_preventive_maintenance_at = COALESCE($3::timestamptz, NOW()),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::int`,
        tid,
        current.biomed_device_id,
        rows[0]?.completed_at || null
      );
    }
    return loadWorkOrder(tx, tid, id);
  });
}

export function assignWorkOrder(options = {}) {
  return transitionWorkOrder({
    ...options,
    nextStatus: 'assigned',
    message: 'Work order assigned',
    patch: {
      assignedToId: options.assignedToId,
      assignedToUid: options.assignedToUid,
      assignedToRole: options.assignedToRole,
      assignedVendor: options.assignedVendor,
    },
  });
}

export function startWorkOrder(options = {}) {
  return transitionWorkOrder({
    ...options,
    nextStatus: 'in_progress',
    message: 'Work order started',
  });
}

export function completeWorkOrder(options = {}) {
  return transitionWorkOrder({
    ...options,
    nextStatus: 'completed',
    message: 'Work order completed',
    patch: {
      completionNotes: options.completionNotes,
      partsUsed: options.partsUsed,
      costAmount: options.costAmount,
      downtimeEndedAt: options.downtimeEndedAt,
    },
  });
}

export function verifyWorkOrder(options = {}) {
  return transitionWorkOrder({
    ...options,
    nextStatus: 'verified',
    message: 'Work order verified',
  });
}

export async function createSchedule({
  tenantId = null,
  biomedDeviceId,
  kind = 'preventive',
  intervalDays = null,
  intervalUsageHours = null,
  nextDueAt = null,
  nextDueUsageHours = null,
  assignedRole = 'BIOMEDICAL_STAFF',
  assignedToId = null,
  assignedToUid = null,
  assignedVendor = null,
  active = true,
  actorUid = null,
  metadata = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const deviceId = requiredInt(biomedDeviceId, 'biomed_device_id');
  const normalizedKind = normalizeScheduleKind(kind);
  const intervalD = optionalInt(intervalDays, 'interval_days');
  const intervalH = optionalNumber(intervalUsageHours, 'interval_usage_hours');
  if (!intervalD && !intervalH) {
    throw AppError.badRequest('interval_days or interval_usage_hours is required');
  }
  const row = await setTenantTx(tid, async (tx) => {
    await ensureDevice(tx, tid, deviceId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO biomed_maintenance_schedules
         (tenant_id, biomed_device_id, kind, interval_days, interval_usage_hours,
          next_due_at, next_due_usage_hours, assigned_role, assigned_to_id,
          assigned_to_uid, assigned_vendor, active, created_by, metadata)
       VALUES ($1::uuid, $2::int, $3, $4::int, $5,
               $6::timestamptz, $7, $8, $9::int,
               $10::uuid, $11, $12, $13::uuid, $14::jsonb)
       ON CONFLICT (tenant_id, biomed_device_id, kind)
       WHERE active = TRUE
       DO UPDATE SET
          interval_days = EXCLUDED.interval_days,
          interval_usage_hours = EXCLUDED.interval_usage_hours,
          next_due_at = EXCLUDED.next_due_at,
          next_due_usage_hours = EXCLUDED.next_due_usage_hours,
          assigned_role = EXCLUDED.assigned_role,
          assigned_to_id = EXCLUDED.assigned_to_id,
          assigned_to_uid = EXCLUDED.assigned_to_uid,
          assigned_vendor = EXCLUDED.assigned_vendor,
          active = EXCLUDED.active,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
       RETURNING *`,
      tid,
      deviceId,
      normalizedKind,
      intervalD,
      intervalH,
      optionalDateIso(nextDueAt, 'next_due_at'),
      optionalNumber(nextDueUsageHours, 'next_due_usage_hours'),
      cleanText(assignedRole, 'BIOMEDICAL_STAFF').toUpperCase(),
      optionalInt(assignedToId, 'assigned_to_id'),
      assignedToUid || null,
      toNullableText(assignedVendor),
      Boolean(active),
      actorUid || null,
      JSON.stringify(metadata || {})
    );
    await refreshDeviceNextScheduledMaintenance(tx, tid, deviceId);
    return rows[0];
  });
  return normalizeScheduleRow(row);
}

export async function listSchedules({ tenantId = null, deviceId = null, active = null, limit = 100 } = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 250);
  const did = optionalInt(deviceId, 'biomed_device_id');
  const activeFilter = active === null || active === undefined || active === ''
    ? null
    : String(active).toLowerCase() !== 'false';
  const rows = await prisma.$queryRawUnsafe(
    `SELECT s.*,
            d.device_code,
            d.device_type
       FROM biomed_maintenance_schedules s
       JOIN clinical_ai_biomed_devices d ON d.id = s.biomed_device_id
      WHERE s.tenant_id = $1::uuid
        AND ($2::int IS NULL OR s.biomed_device_id = $2)
        AND ($3::boolean IS NULL OR s.active = $3)
      ORDER BY s.active DESC, s.next_due_at NULLS LAST, s.id
      LIMIT $4`,
    tid,
    did,
    activeFilter,
    safeLimit
  );
  const schedules = rows.map(normalizeScheduleRow);
  return { schedules, count: schedules.length };
}

async function refreshDeviceNextScheduledMaintenance(tx, tenantId, deviceId) {
  await tx.$queryRawUnsafe(
    `UPDATE clinical_ai_biomed_devices d
        SET next_scheduled_maintenance_at = (
              SELECT MIN(s.next_due_at)
                FROM biomed_maintenance_schedules s
               WHERE s.tenant_id = $1::uuid
                 AND s.biomed_device_id = $2::int
                 AND s.active = TRUE
                 AND s.next_due_at IS NOT NULL
            ),
            updated_at = NOW()
      WHERE d.tenant_id = $1::uuid
        AND d.id = $2::int`,
    tenantId,
    deviceId
  );
}

export async function seedDefaultMaintenanceSchedules({ tenantId = null, limit = 500 } = {}) {
  const tid = requireTenantId(tenantId);
  const devices = await prisma.$queryRawUnsafe(
    `SELECT d.id, d.device_code, d.device_type, d.usage_hours, d.next_scheduled_maintenance_at
       FROM clinical_ai_biomed_devices d
       LEFT JOIN biomed_maintenance_schedules s
         ON s.tenant_id = d.tenant_id
        AND s.biomed_device_id = d.id
        AND s.kind = 'preventive'
        AND s.active = TRUE
      WHERE d.tenant_id = $1::uuid
        AND s.id IS NULL
        AND d.status IN ('in_service', 'pending_inspection', 'unknown')
      ORDER BY d.id
      LIMIT $2`,
    tid,
    Math.min(Math.max(Number.parseInt(limit, 10) || 500, 1), 1000)
  );

  let seeded = 0;
  for (const device of devices) {
    const interval = DEFAULT_SERVICE_INTERVALS_HOURS[device.device_type] || DEFAULT_SERVICE_INTERVALS_HOURS.other;
    const usage = Math.max(0, Number(device.usage_hours || 0));
    const nextUsage = Math.max(interval, Math.ceil(usage / interval) * interval);
    await createSchedule({
      tenantId: tid,
      biomedDeviceId: device.id,
      kind: 'preventive',
      intervalUsageHours: interval,
      nextDueUsageHours: nextUsage,
      nextDueAt: device.next_scheduled_maintenance_at || null,
      assignedRole: 'BIOMEDICAL_STAFF',
      metadata: { seeded_from: 'DEFAULT_SERVICE_INTERVALS_HOURS' },
    });
    seeded += 1;
  }
  return { seeded };
}

function nextDueAfter(schedule, nowIso) {
  if (schedule.interval_days && schedule.next_due_at) {
    let next = addDays(schedule.next_due_at, Number(schedule.interval_days));
    while (new Date(next) <= new Date(nowIso)) {
      next = addDays(next, Number(schedule.interval_days));
    }
    return next;
  }
  return schedule.next_due_at || null;
}

export async function materializeDueMaintenanceSchedules({ tenantId = null, now = new Date(), limit = 100 } = {}) {
  const tid = requireTenantId(tenantId);
  const nowIso = optionalDateIso(now, 'now');
  const seeded = await seedDefaultMaintenanceSchedules({ tenantId: tid });
  const schedules = await prisma.$queryRawUnsafe(
    `SELECT s.*,
            d.device_code,
            d.device_type,
            d.usage_hours
       FROM biomed_maintenance_schedules s
       JOIN clinical_ai_biomed_devices d ON d.id = s.biomed_device_id
      WHERE s.tenant_id = $1::uuid
        AND s.active = TRUE
        AND (
          (s.next_due_at IS NOT NULL AND s.next_due_at <= $2::timestamptz)
          OR (
            s.interval_usage_hours IS NOT NULL
            AND s.next_due_usage_hours IS NOT NULL
            AND d.usage_hours >= s.next_due_usage_hours
          )
        )
      ORDER BY COALESCE(s.next_due_at, $2::timestamptz), s.id
      LIMIT $3`,
    tid,
    nowIso,
    Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500)
  );

  const created = [];
  for (const schedule of schedules) {
    const dueWindowStart = schedule.next_due_at || nowIso;
    const dueWindowEnd = schedule.interval_days
      ? addDays(dueWindowStart, Number(schedule.interval_days))
      : null;
    const workOrder = await createWorkOrder({
      tenantId: tid,
      biomedDeviceId: schedule.biomed_device_id,
      kind: schedule.kind,
      priority: schedule.kind === 'calibration' ? 'high' : 'normal',
      description: `${schedule.kind} maintenance due for ${schedule.device_code}`,
      assignedToId: schedule.assigned_to_id,
      assignedToUid: schedule.assigned_to_uid,
      assignedToRole: schedule.assigned_role,
      assignedVendor: schedule.assigned_vendor,
      source: 'schedule',
      sourceRef: `schedule:${schedule.id}`,
      scheduleId: schedule.id,
      dueWindowStart,
      dueWindowEnd,
      metadata: { materialized_from_schedule: schedule.id },
    });
    created.push(workOrder);

    await setTenantTx(tid, async (tx) => {
      const nextUsage = schedule.interval_usage_hours
        ? Number(schedule.usage_hours || 0) + Number(schedule.interval_usage_hours)
        : schedule.next_due_usage_hours;
      await tx.$queryRawUnsafe(
        `UPDATE biomed_maintenance_schedules
            SET last_materialized_due_at = $3::timestamptz,
                last_materialized_usage_hours = $4,
                last_work_order_id = $5::bigint,
                next_due_at = $6::timestamptz,
                next_due_usage_hours = $7,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint`,
        tid,
        schedule.id,
        dueWindowStart,
        schedule.next_due_usage_hours,
        workOrder.id,
        nextDueAfter(schedule, nowIso),
        nextUsage
      );
      await refreshDeviceNextScheduledMaintenance(tx, tid, schedule.biomed_device_id);
    });
  }
  return { ...seeded, materialized: created.length, work_orders: created };
}

function priorityFromPrediction(prediction) {
  if (prediction.risk_band === 'critical') return 'urgent';
  if (prediction.risk_band === 'high') return 'high';
  return 'normal';
}

export async function createWorkOrderFromPrediction({ tenantId = null, predictionId, actorUid = null, actorRole = null } = {}) {
  const tid = requireTenantId(tenantId);
  const id = requiredInt(predictionId, 'prediction_id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.id, p.device_id, p.device_code, p.risk_band, p.recommended_actions,
            p.recommended_service_window, p.reviewer_decision,
            d.device_type, d.location
       FROM clinical_ai_biomed_maintenance_predictions p
       JOIN clinical_ai_biomed_devices d ON d.id = p.device_id
      WHERE p.tenant_id = $1::uuid
        AND p.id = $2::int
      LIMIT 1`,
    tid,
    id
  );
  const prediction = rows[0];
  if (!prediction) throw AppError.notFound('Biomed maintenance prediction not found');
  if (prediction.reviewer_decision !== 'accepted') {
    throw AppError.badRequest('Only accepted maintenance predictions can create work orders');
  }
  const actions = safeJson(prediction.recommended_actions, []);
  const firstAction = Array.isArray(actions) && actions.length ? cleanText(actions[0]?.description || actions[0]) : '';
  return createWorkOrder({
    tenantId: tid,
    biomedDeviceId: prediction.device_id,
    kind: 'corrective',
    priority: priorityFromPrediction(prediction),
    description: firstAction || `Accepted AI maintenance prediction for ${prediction.device_code}`,
    assignedToRole: 'BIOMEDICAL_STAFF',
    actorUid,
    actorRole,
    source: 'ai_prediction',
    sourceRef: String(prediction.id),
    metadata: {
      prediction_id: prediction.id,
      risk_band: prediction.risk_band,
      human_reviewer_required: true,
    },
  });
}

export async function createDeviceFaultWorkOrder({
  tenantId = null,
  biomedDeviceId = null,
  deviceRegistryId = null,
  sourceRef = null,
  faultCode = null,
  description = null,
  priority = 'urgent',
  actorUid = null,
  actorRole = 'DEVICE_GATEWAY',
  metadata = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  let deviceId = optionalInt(biomedDeviceId, 'biomed_device_id');
  if (!deviceId && deviceRegistryId) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT biomed_device_id
         FROM device_registry
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND biomed_device_id IS NOT NULL
        LIMIT 1`,
      tid,
      requiredInt(deviceRegistryId, 'device_registry_id')
    );
    deviceId = rows[0]?.biomed_device_id || null;
  }
  if (!deviceId) throw AppError.badRequest('biomed_device_id or mapped device_registry_id is required');
  return createWorkOrder({
    tenantId: tid,
    biomedDeviceId: deviceId,
    kind: 'corrective',
    priority,
    description: cleanText(description, `Device fault${faultCode ? ` ${faultCode}` : ''} requires biomedical review`),
    assignedToRole: 'BIOMEDICAL_STAFF',
    actorUid,
    actorRole,
    downtimeStartedAt: new Date().toISOString(),
    source: 'device_fault',
    sourceRef: toNullableText(sourceRef || faultCode),
    metadata: { fault_code: faultCode || null, ...metadata },
  });
}

export async function createCalibrationCertificate({
  tenantId = null,
  biomedDeviceId,
  workOrderId = null,
  certificateNumber,
  calibratedAt,
  dueAt,
  performedBy = null,
  performedByUid = null,
  documentId,
  documentStorageKey = null,
  documentMimeType = null,
  result,
  notes = null,
  actorUid = null,
  metadata = {},
  rawPayload = {},
} = {}) {
  rejectRawCertificatePayload(rawPayload);
  const tid = requireTenantId(tenantId);
  const deviceId = requiredInt(biomedDeviceId, 'biomed_device_id');
  const certNumber = cleanText(certificateNumber);
  if (!certNumber) throw AppError.badRequest('certificate_number is required');
  const documentRef = cleanText(documentId || documentStorageKey);
  if (!documentRef) throw AppError.badRequest('document_id is required');
  const normalizedResult = normalizeEnum(result, CERTIFICATE_RESULTS, 'pass', 'result');
  const calibratedIso = optionalDateIso(calibratedAt, 'calibrated_at');
  const dueIso = optionalDateIso(dueAt, 'due_at');
  const orderId = optionalInt(workOrderId, 'work_order_id');
  const row = await setTenantTx(tid, async (tx) => {
    await ensureDevice(tx, tid, deviceId);
    if (orderId) {
      const order = await loadWorkOrder(tx, tid, orderId);
      if (!order || order.biomed_device_id !== deviceId) {
        throw AppError.badRequest('work_order_id must belong to the supplied device');
      }
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO biomed_calibration_certificates
         (tenant_id, biomed_device_id, work_order_id, certificate_number,
          calibrated_at, due_at, performed_by, performed_by_uid, document_id,
          document_storage_key, document_mime_type, result, notes, created_by, metadata)
       VALUES ($1::uuid, $2::int, $3::bigint, $4,
               $5::timestamptz, $6::timestamptz, $7, $8::uuid, $9,
               $10, $11, $12, $13, $14::uuid, $15::jsonb)
       RETURNING *`,
      tid,
      deviceId,
      orderId,
      certNumber,
      calibratedIso,
      dueIso,
      toNullableText(performedBy),
      performedByUid || null,
      documentRef,
      toNullableText(documentStorageKey),
      toNullableText(documentMimeType),
      normalizedResult,
      toNullableText(notes),
      actorUid || null,
      JSON.stringify(metadata || {})
    );
    await tx.$queryRawUnsafe(
      `UPDATE clinical_ai_biomed_devices
          SET last_preventive_maintenance_at = GREATEST(
                COALESCE(last_preventive_maintenance_at, $3::timestamptz),
                $3::timestamptz
              ),
              next_scheduled_maintenance_at = CASE
                WHEN next_scheduled_maintenance_at IS NULL THEN $4::timestamptz
                ELSE LEAST(next_scheduled_maintenance_at, $4::timestamptz)
              END,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::int`,
      tid,
      deviceId,
      calibratedIso,
      dueIso
    );
    return rows[0];
  });
  return normalizeCertificateRow(row);
}

export async function listCalibrationCertificates({ tenantId = null, deviceId = null, limit = 100 } = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 250);
  const did = optionalInt(deviceId, 'biomed_device_id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.*,
            d.device_code,
            d.device_type
       FROM biomed_calibration_certificates c
       JOIN clinical_ai_biomed_devices d ON d.id = c.biomed_device_id
      WHERE c.tenant_id = $1::uuid
        AND ($2::int IS NULL OR c.biomed_device_id = $2)
      ORDER BY c.due_at DESC, c.created_at DESC
      LIMIT $3`,
    tid,
    did,
    safeLimit
  );
  const certificates = rows.map(normalizeCertificateRow);
  return { certificates, count: certificates.length };
}

export async function listCmmsBoard({ tenantId = null, limit = 50 } = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100);
  const [statsRows, workOrderRows, calibrationRows, deviceRows] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT
          COUNT(*)::int AS device_count,
          COUNT(*) FILTER (WHERE status = 'in_service')::int AS in_service_count,
          COUNT(*) FILTER (WHERE next_scheduled_maintenance_at IS NOT NULL AND next_scheduled_maintenance_at < NOW())::int AS overdue_device_count
         FROM clinical_ai_biomed_devices
        WHERE tenant_id = $1::uuid`,
      tid
    ),
    prisma.$queryRawUnsafe(
      `SELECT
          COUNT(*) FILTER (WHERE status IN ('open', 'assigned', 'in_progress'))::int AS active_work_order_count,
          COUNT(*) FILTER (WHERE priority = 'urgent' AND status IN ('open', 'assigned', 'in_progress'))::int AS urgent_work_order_count,
          COUNT(*) FILTER (WHERE sla_due_at < NOW() AND status IN ('open', 'assigned', 'in_progress'))::int AS sla_breach_count,
          COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(downtime_ended_at, NOW()) - downtime_started_at)) / 60)
            FILTER (WHERE downtime_started_at IS NOT NULL AND created_at >= NOW() - INTERVAL '30 days'), 0)::int AS downtime_minutes_30d
         FROM biomed_work_orders
        WHERE tenant_id = $1::uuid`,
      tid
    ),
    prisma.$queryRawUnsafe(
      `WITH latest AS (
         SELECT DISTINCT ON (biomed_device_id)
                biomed_device_id, due_at, result
           FROM biomed_calibration_certificates
          WHERE tenant_id = $1::uuid
          ORDER BY biomed_device_id, calibrated_at DESC, id DESC
       )
       SELECT
          COUNT(*) FILTER (WHERE due_at >= NOW() AND result IN ('pass', 'adjusted'))::int AS current_count,
          COUNT(*) FILTER (WHERE due_at < NOW() OR result = 'fail')::int AS expired_or_failed_count,
          COUNT(*) FILTER (WHERE due_at >= NOW() AND due_at < NOW() + INTERVAL '30 days')::int AS due_soon_count
         FROM latest`,
      tid
    ),
    prisma.$queryRawUnsafe(
      `SELECT id, device_code, device_type, location, status,
              next_scheduled_maintenance_at, usage_hours, fault_events_last_90d,
              amc_vendor, amc_expires_on
         FROM clinical_ai_biomed_devices
        WHERE tenant_id = $1::uuid
        ORDER BY
          CASE WHEN next_scheduled_maintenance_at IS NOT NULL AND next_scheduled_maintenance_at < NOW() THEN 0 ELSE 1 END,
          device_type,
          device_code
        LIMIT $2`,
      tid,
      safeLimit
    ),
  ]);
  const workOrders = await listWorkOrders({ tenantId: tid, limit: safeLimit });
  return {
    stats: {
      ...(statsRows[0] || {}),
      ...(workOrderRows[0] || {}),
      ...(calibrationRows[0] || {}),
    },
    devices: deviceRows.map((row) => ({
      id: toNumber(row.id),
      device_code: row.device_code,
      device_type: row.device_type,
      location: row.location,
      status: row.status,
      next_scheduled_maintenance_at: row.next_scheduled_maintenance_at,
      usage_hours: Number(row.usage_hours || 0),
      fault_events_last_90d: Number(row.fault_events_last_90d || 0),
      amc_vendor: row.amc_vendor || null,
      amc_expires_on: row.amc_expires_on || null,
    })),
    work_orders: workOrders.work_orders,
  };
}

export async function escalateBreachedWorkOrders({ tenantId = null, now = new Date(), limit = 100 } = {}) {
  const tid = requireTenantId(tenantId);
  const rows = await setTenantTx(tid, async (tx) => tx.$queryRawUnsafe(
    `UPDATE biomed_work_orders
        SET priority = 'urgent',
            sla_breached_at = COALESCE(sla_breached_at, $2::timestamptz),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND status IN ('open', 'assigned', 'in_progress')
        AND sla_due_at IS NOT NULL
        AND sla_due_at < $2::timestamptz
        AND sla_breached_at IS NULL
      RETURNING *`,
    tid,
    optionalDateIso(now, 'now')
  ));
  const escalated = [];
  for (const row of rows.slice(0, Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 250))) {
    const workOrder = await setTenantTx(tid, (tx) => loadWorkOrder(tx, tid, row.id));
    await insertEscalationUpdate(tid, workOrder);
    const recipients = await ensureRecipientsForWorkOrder({ tenantId: tid, workOrder });
    await queueWorkOrderNotifications({
      workOrder,
      recipients,
      title: 'Urgent biomedical SLA breach',
      body: `${workOrder.work_order_number}: SLA breached for ${workOrder.device_code || 'device'}`,
      priority: 'urgent',
    });
    escalated.push({ ...workOrder, recipient_count: recipients.length });
  }
  return { escalated_count: escalated.length, work_orders: escalated };
}

async function insertEscalationUpdate(tenantId, workOrder) {
  await setTenantTx(tenantId, (tx) => insertWorkOrderUpdate(tx, {
    tenantId,
    workOrderId: workOrder.id,
    previousStatus: workOrder.status,
    status: workOrder.status,
    message: 'SLA breach escalated',
    metadata: { priority: 'urgent', sla_breach: true },
  }));
}

export async function runBiomedCmmsMaintenanceSweep({ tenantId = null, now = new Date() } = {}) {
  const tid = requireTenantId(tenantId);
  try {
    const materialized = await materializeDueMaintenanceSchedules({ tenantId: tid, now });
    const escalated = await escalateBreachedWorkOrders({ tenantId: tid, now });
    return {
      tenant_id: tid,
      seeded: materialized.seeded,
      materialized: materialized.materialized,
      escalated: escalated.escalated_count,
    };
  } catch (err) {
    if (isMissingSchemaError(err)) {
      logger.warn('biomed CMMS sweep skipped because schema is unavailable', { tenant_id: tid });
      return { tenant_id: tid, seeded: 0, materialized: 0, escalated: 0, schema_unavailable: true };
    }
    throw err;
  }
}

export default {
  ACTIVE_STATUSES,
  BIOMED_NOTIFICATION_ROLES,
  assertWorkOrderTransition,
  assignWorkOrder,
  calculateDowntimeMinutes,
  completeWorkOrder,
  createCalibrationCertificate,
  createDeviceFaultWorkOrder,
  createSchedule,
  createWorkOrder,
  createWorkOrderFromPrediction,
  escalateBreachedWorkOrders,
  listCalibrationCertificates,
  listCmmsBoard,
  listMyWorkOrders,
  listSchedules,
  listWorkOrders,
  materializeDueMaintenanceSchedules,
  rejectRawCertificatePayload,
  runBiomedCmmsMaintenanceSweep,
  seedDefaultMaintenanceSchedules,
  startWorkOrder,
  verifyWorkOrder,
};

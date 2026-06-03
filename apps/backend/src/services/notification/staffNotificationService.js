import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { sendToUser } from '../../utils/websocket/wsServer.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const MAX_RECIPIENTS = 500;
const PRIORITY_MAP = {
  CRITICAL: 'HIGH',
  URGENT: 'HIGH',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  NORMAL: 'MEDIUM',
  LOW: 'LOW',
};

function compact(value) {
  return String(value ?? '').trim();
}

function normalizeTenant(tenantId) {
  return compact(tenantId) || DEFAULT_TENANT_ID;
}

function normalizeRole(role) {
  return compact(role).toUpperCase();
}

function normalizeType(type) {
  return compact(type || 'SYSTEM').toUpperCase().slice(0, 50);
}

function normalizePriority(priority) {
  const value = normalizeRole(priority || 'MEDIUM');
  return PRIORITY_MAP[value] || 'MEDIUM';
}

function uniqueStrings(values = []) {
  return Array.from(new Set(
    values
      .map(value => compact(value))
      .filter(Boolean)
  ));
}

function uniqueInts(values = []) {
  return Array.from(new Set(
    values
      .map(value => Number.parseInt(String(value), 10))
      .filter(value => Number.isInteger(value) && value > 0)
  ));
}

function eventPayload(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.message ?? row.body,
    message: row.message ?? row.body,
    type: row.type,
    priority: row.priority,
    is_read: row.is_read === true,
    data: row.data || {},
    related_id: row.related_id ?? null,
    created_at: row.created_at,
  };
}

function emitNotification(row) {
  if (!row?.uid) return;
  try {
    sendToUser(String(row.uid), 'notification', eventPayload(row));
  } catch (err) {
    logger.warn('staff notification websocket emit failed', {
      notificationId: row.id,
      uid: row.uid,
      error: err?.message || err,
    });
  }
}

export async function resolveStaffNotificationRecipients({
  tenantId = DEFAULT_TENANT_ID,
  recipientUids = [],
  recipientUserIds = [],
  recipientRoles = [],
  departments = [],
  excludeUids = [],
  limit = MAX_RECIPIENTS,
} = {}) {
  const normalizedTenant = normalizeTenant(tenantId);
  const uidList = uniqueStrings(recipientUids);
  const idList = uniqueInts(recipientUserIds);
  const roleList = uniqueStrings(recipientRoles).map(normalizeRole);
  const departmentList = uniqueStrings(departments).map(value => value.toLowerCase());
  const excludeList = uniqueStrings(excludeUids);

  if (!uidList.length && !idList.length && !roleList.length && !departmentList.length) {
    return [];
  }

  const rows = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT ON (u.id)
            u.id,
            u.uid,
            u.name,
            u.phone,
            u.role,
            COALESCE(s.department, dpt.name, doc.department) AS department
       FROM users u
       LEFT JOIN staff s ON s.user_id = u.uid
       LEFT JOIN doctors doc ON doc.user_id = u.id
       LEFT JOIN departments dpt ON dpt.id = doc.department_id
      WHERE u.tenant_id = $1::uuid
        AND COALESCE(u.is_active, true) = true
        AND u.role <> 'PATIENT'
        AND (
          (cardinality($2::uuid[]) > 0 AND u.uid = ANY($2::uuid[]))
          OR (cardinality($3::int[]) > 0 AND u.id = ANY($3::int[]))
          OR (cardinality($4::text[]) > 0 AND UPPER(u.role) = ANY($4::text[]))
          OR (
            cardinality($5::text[]) > 0
            AND LOWER(COALESCE(s.department, dpt.name, doc.department, '')) = ANY($5::text[])
          )
        )
        AND NOT (cardinality($6::uuid[]) > 0 AND u.uid = ANY($6::uuid[]))
      ORDER BY u.id, u.name NULLS LAST
      LIMIT $7::int`,
    normalizedTenant,
    uidList,
    idList,
    roleList,
    departmentList,
    excludeList,
    Math.min(Math.max(Number(limit) || MAX_RECIPIENTS, 1), MAX_RECIPIENTS),
  );

  return rows;
}

export async function sendStaffNotifications({
  tenantId = DEFAULT_TENANT_ID,
  recipientUids = [],
  recipientUserIds = [],
  recipientRoles = [],
  departments = [],
  excludeUids = [],
  title,
  body,
  type = 'SYSTEM',
  priority = 'MEDIUM',
  data = {},
  relatedId = null,
  dedupe = true,
} = {}) {
  const safeTitle = compact(title).slice(0, 255);
  const safeBody = compact(body).slice(0, 4000);
  if (!safeTitle || !safeBody) {
    throw new Error('Notification title and body are required');
  }

  const recipients = await resolveStaffNotificationRecipients({
    tenantId,
    recipientUids,
    recipientUserIds,
    recipientRoles,
    departments,
    excludeUids,
  });

  if (!recipients.length) {
    return { notification_count: 0, recipients: [], notifications: [] };
  }

  const userIds = uniqueInts(recipients.map(row => row.id));
  const notificationType = normalizeType(type);
  const notificationPriority = normalizePriority(priority);
  const normalizedTenant = normalizeTenant(tenantId);
  const serializedData = JSON.stringify({
    ...data,
    event_type: data?.event_type || notificationType.toLowerCase(),
  });

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO notifications
       (tenant_id, uid, user_id, phone, title, body, type, priority,
        data, is_read, created_at, updated_at, related_id, recipient_role)
     SELECT $1::uuid,
            u.uid,
            u.id,
            COALESCE(NULLIF(TRIM(u.phone), ''), 'unknown'),
            $2,
            $3,
            $4,
            $5,
            $6::jsonb,
            false,
            NOW(),
            NOW(),
            $7::int,
            u.role
       FROM users u
      WHERE u.id = ANY($8::int[])
        AND COALESCE(u.is_active, true) = true
        AND (
          $9::boolean IS NOT TRUE
          OR $7::int IS NULL
          OR NOT EXISTS (
            SELECT 1
              FROM notifications n
             WHERE n.tenant_id = $1::uuid
               AND n.user_id = u.id
               AND n.type = $4
               AND n.related_id = $7::int
          )
        )
      RETURNING id, tenant_id, uid, user_id, phone, title, body AS message,
                type, priority, data, is_read, related_id, recipient_role, created_at`,
    normalizedTenant,
    safeTitle,
    safeBody,
    notificationType,
    notificationPriority,
    serializedData,
    relatedId == null ? null : Number(relatedId),
    userIds,
    dedupe === true,
  );

  for (const row of rows) {
    emitNotification(row);
  }

  return {
    notification_count: rows.length,
    recipients: recipients.map(row => ({
      id: row.id,
      uid: row.uid,
      name: row.name,
      role: row.role,
      department: row.department,
    })),
    notifications: rows.map(eventPayload),
  };
}

export async function notifyRoles(args = {}) {
  return sendStaffNotifications(args);
}

export default {
  resolveStaffNotificationRecipients,
  sendStaffNotifications,
  notifyRoles,
};

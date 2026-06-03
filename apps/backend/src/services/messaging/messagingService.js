// src/services/messaging/messagingService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import notificationOutbox from '../../utils/notifications/notificationOutbox.js'; // eslint-disable-line import/no-named-as-default
import { emitStaffMessage } from '../../utils/websocket/realtimeEmitter.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const VALID_PRIORITIES = ['normal', 'urgent', 'critical'];
const ADMIN_BROADCAST_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'HR_STAFF']);
const DEPARTMENT_BROADCAST_ROLES = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'HR_STAFF',
  'NURSING_INCHARGE',
  'OP_INCHARGE',
  'HOUSEKEEPING_INCHARGE',
  'RECEPTION_INCHARGE',
  'BILLING_INCHARGE',
  'FINANCE_INCHARGE',
  'DEPARTMENT_HEAD',
  'CNO',
  'CMO',
  'MEDICAL_SUPERINTENDENT'
]);

const normalizeRole = role =>
  String(role || '')
    .trim()
    .toUpperCase();
const normalizeTenant = tenantId => tenantId || DEFAULT_TENANT_ID;
const isAdminBroadcastRole = role => ADMIN_BROADCAST_ROLES.has(normalizeRole(role));
const isDepartmentBroadcastRole = role => DEPARTMENT_BROADCAST_ROLES.has(normalizeRole(role));

const query = async (sql, params = [], db = prisma) => {
  const normalizedSql = sql.trim();
  const upperSql = normalizedSql.toUpperCase();
  const usesReturning = /\bRETURNING\b/i.test(normalizedSql);
  const isReadQuery = upperSql.startsWith('SELECT') || upperSql.startsWith('WITH') || usesReturning;

  if (isReadQuery) {
    return db.$queryRawUnsafe(normalizedSql, ...params);
  }

  const rowCount = await db.$executeRawUnsafe(normalizedSql, ...params);
  return { rowCount: Number(rowCount) || 0 };
};

const ensurePriority = (priority = 'normal') => {
  const normalized = String(priority || 'normal')
    .trim()
    .toLowerCase();
  if (!VALID_PRIORITIES.includes(normalized)) {
    throw AppError.badRequest(`Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}`);
  }
  return normalized;
};

const compactString = value => String(value || '').trim();

const getUserIdForUid = async uid => {
  if (!uid) return null;

  const result = await query('SELECT id FROM users WHERE uid = $1::uuid LIMIT 1', [uid]);

  return result[0]?.id ?? null;
};

async function getSenderContext(senderUid, tenantId, db = prisma) {
  const rows = await query(
    `SELECT u.uid, u.name, u.role, u.tenant_id,
            s.department, s.employee_id, s.position
       FROM users u
       LEFT JOIN staff s ON s.user_id = u.uid
      WHERE u.uid = $1::uuid
        AND u.tenant_id = $2::uuid
      LIMIT 1`,
    [senderUid, normalizeTenant(tenantId)],
    db
  );
  return rows[0] || null;
}

function baseMessageSelect() {
  return `m.id, m.sender_uid, sender.name AS sender_name, sender.role AS sender_role,
          sender_staff.department AS sender_department,
          m.recipient_uid, recipient.name AS recipient_name, recipient.role AS recipient_role,
          recipient_staff.department AS recipient_department,
          m.patient_uid, m.subject, m.body, m.priority, m.is_read, m.read_at,
          m.created_at, m.tenant_id`;
}

function baseMessageJoins() {
  return `LEFT JOIN users sender ON sender.uid = m.sender_uid
          LEFT JOIN staff sender_staff ON sender_staff.user_id = sender.uid
          LEFT JOIN users recipient ON recipient.uid = m.recipient_uid
          LEFT JOIN staff recipient_staff ON recipient_staff.user_id = recipient.uid`;
}

async function insertMessage(
  db,
  { senderUid, recipientUid, tenantId, body, priority, patientUid = null, subject = null }
) {
  const result = await query(
    `INSERT INTO staff_messages
      (sender_uid, recipient_uid, patient_uid, subject, body, priority, is_read, tenant_id, created_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, false, $7::uuid, NOW())
     RETURNING id, sender_uid, recipient_uid, patient_uid, subject, body, priority,
               is_read, read_at, created_at, tenant_id`,
    [senderUid, recipientUid, patientUid, subject, body, priority, normalizeTenant(tenantId)],
    db
  );
  return result[0];
}

async function queueMessageNotification(message, senderUid, priority, subject, body) {
  const recipientUserId = await getUserIdForUid(message.recipient_uid);

  await notificationOutbox.queue({
    type: 'push',
    recipientId: recipientUserId,
    title: priority === 'critical' ? '[CRITICAL] New staff message' : 'New staff message',
    body: subject || body.substring(0, 100),
    data: {
      type: 'staff_message',
      message_id: message.id,
      sender_uid: senderUid,
      priority
    }
  });
}

async function notifyMessageRecipient(message, senderUid, priority, subject, body) {
  await queueMessageNotification(message, senderUid, priority, subject, body);
  emitStaffMessage({
    recipientUid: message.recipient_uid,
    message,
    senderUid,
    priority,
    subject,
    body
  });
}

async function resolveRecipientUids({
  tenantId,
  scope,
  department,
  recipientUids,
  senderUid,
  actorRole,
  db = prisma
}) {
  const normalizedScope = compactString(scope || 'selected').toLowerCase();
  const normalizedRole = normalizeRole(actorRole);
  const normalizedTenant = normalizeTenant(tenantId);
  const sender = await getSenderContext(senderUid, normalizedTenant, db);
  const senderDepartment = compactString(sender?.department);

  if (normalizedScope === 'all') {
    if (!isAdminBroadcastRole(normalizedRole)) {
      throw AppError.forbidden('Only HR/Admin can send all-staff messages');
    }
    const rows = await query(
      `SELECT u.uid
         FROM users u
         LEFT JOIN staff s ON s.user_id = u.uid
        WHERE u.tenant_id = $1::uuid
          AND u.uid <> $2::uuid
          AND u.role <> 'PATIENT'
          AND COALESCE(u.is_active, true) = true
          AND COALESCE(s.is_active, true) = true
        ORDER BY u.name`,
      [normalizedTenant, senderUid],
      db
    );
    return rows.map(r => String(r.uid));
  }

  if (normalizedScope === 'department') {
    const requestedDepartment = compactString(department || senderDepartment);
    if (!requestedDepartment) {
      throw AppError.badRequest('department is required for department messages');
    }
    if (!isAdminBroadcastRole(normalizedRole)) {
      if (!isDepartmentBroadcastRole(normalizedRole)) {
        throw AppError.forbidden(
          'Only HR/Admin or department incharges can message a full department'
        );
      }
      if (
        !senderDepartment ||
        requestedDepartment.toLowerCase() !== senderDepartment.toLowerCase()
      ) {
        throw AppError.forbidden('Department incharges can only message their own department');
      }
    }
    const rows = await query(
      `SELECT u.uid
         FROM users u
         JOIN staff s ON s.user_id = u.uid
        WHERE u.tenant_id = $1::uuid
          AND u.uid <> $2::uuid
          AND LOWER(COALESCE(s.department, '')) = LOWER($3)
          AND u.role <> 'PATIENT'
          AND COALESCE(u.is_active, true) = true
          AND COALESCE(s.is_active, true) = true
        ORDER BY u.name`,
      [normalizedTenant, senderUid, requestedDepartment],
      db
    );
    return rows.map(r => String(r.uid));
  }

  const uniqueRecipientUids = Array.from(
    new Set((recipientUids || []).map(uid => compactString(uid)).filter(Boolean))
  ).filter(uid => uid !== senderUid);

  if (uniqueRecipientUids.length === 0) {
    throw AppError.badRequest('At least one recipient is required');
  }

  if (uniqueRecipientUids.length > 1 && !isAdminBroadcastRole(normalizedRole)) {
    throw AppError.forbidden('Only HR/Admin can message selected teams');
  }

  const rows = await query(
    `SELECT u.uid
       FROM users u
       LEFT JOIN staff s ON s.user_id = u.uid
      WHERE u.tenant_id = $1::uuid
        AND u.uid = ANY($2::uuid[])
        AND u.role <> 'PATIENT'
        AND COALESCE(u.is_active, true) = true
        AND COALESCE(s.is_active, true) = true`,
    [normalizedTenant, uniqueRecipientUids],
    db
  );
  const found = rows.map(r => String(r.uid));
  if (found.length !== uniqueRecipientUids.length) {
    throw AppError.badRequest('One or more recipients are not active staff in this tenant');
  }
  return found;
}

const messagingService = {
  /**
   * Send a message from one staff member to another.
   */
  async sendMessage(
    senderUid,
    recipientUid,
    body,
    priority = 'normal',
    patientUid = null,
    subject = null,
    tenantId = DEFAULT_TENANT_ID
  ) {
    if (!senderUid || !recipientUid || !body) {
      throw AppError.badRequest('Sender, recipient, and body are required');
    }

    if (senderUid === recipientUid) {
      throw AppError.badRequest('Cannot send a message to yourself');
    }

    const normalizedPriority = ensurePriority(priority);

    try {
      const message = await insertMessage(prisma, {
        senderUid,
        recipientUid,
        tenantId,
        body,
        priority: normalizedPriority,
        patientUid,
        subject
      });

      await notifyMessageRecipient(message, senderUid, normalizedPriority, subject, body);

      logger.info(
        `Staff message sent: ${message.id} from ${senderUid} to ${recipientUid} [${normalizedPriority}]`
      );
      return message;
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.error('Error sending staff message:', err.message);
      throw AppError.internal('Failed to send message');
    }
  },

  async sendBroadcast({
    senderUid,
    tenantId = DEFAULT_TENANT_ID,
    actorRole,
    scope = 'selected',
    department = null,
    recipientUids = [],
    body,
    priority = 'normal',
    subject = null,
    patientUid = null
  }) {
    if (!senderUid || !body) {
      throw AppError.badRequest('Sender and body are required');
    }

    const normalizedPriority = ensurePriority(priority);
    const normalizedTenant = normalizeTenant(tenantId);

    try {
      const created = await prisma.$transaction(async tx => {
        const recipients = await resolveRecipientUids({
          tenantId: normalizedTenant,
          scope,
          department,
          recipientUids,
          senderUid,
          actorRole,
          db: tx
        });
        if (recipients.length === 0) {
          throw AppError.badRequest('No active recipients matched this message target');
        }

        const messages = [];
        for (const recipientUid of recipients) {
          messages.push(
            await insertMessage(tx, {
              senderUid,
              recipientUid,
              tenantId: normalizedTenant,
              body,
              priority: normalizedPriority,
              patientUid,
              subject
            })
          );
        }
        return messages;
      });

      await Promise.all(
        created.map(message =>
          notifyMessageRecipient(message, senderUid, normalizedPriority, subject, body)
        )
      );

      logger.info(
        `Staff broadcast sent by ${senderUid} to ${created.length} recipient(s) [${normalizedPriority}]`
      );
      return {
        count: created.length,
        messages: created
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.error('Error sending staff broadcast:', err.message);
      throw AppError.internal('Failed to send broadcast');
    }
  },

  async getTargets(
    staffUid,
    tenantId = DEFAULT_TENANT_ID,
    actorRole = 'GENERAL_STAFF',
    search = '',
    limit = 100
  ) {
    const safeLimit = Math.min(Math.max(1, parseInt(limit) || 100), 250);
    const normalizedTenant = normalizeTenant(tenantId);
    const q = compactString(search).toLowerCase();
    const sender = await getSenderContext(staffUid, normalizedTenant);
    const role = normalizeRole(actorRole);
    const departments = await query(
      `SELECT DISTINCT s.department
         FROM staff s
         JOIN users u ON u.uid = s.user_id
        WHERE u.tenant_id = $1::uuid
          AND s.department IS NOT NULL
          AND COALESCE(s.department, '') <> ''
          AND u.role <> 'PATIENT'
          AND COALESCE(u.is_active, true) = true
          AND COALESCE(s.is_active, true) = true
        ORDER BY s.department`,
      [normalizedTenant]
    );

    let targetSql = `
      SELECT u.uid, u.name, u.role, s.employee_id, s.department, s.position
        FROM users u
        LEFT JOIN staff s ON s.user_id = u.uid
       WHERE u.tenant_id = $1::uuid
         AND u.uid <> $2::uuid
         AND u.role <> 'PATIENT'
         AND COALESCE(u.is_active, true) = true
         AND COALESCE(s.is_active, true) = true`;
    const params = [normalizedTenant, staffUid];
    if (q) {
      params.push(`%${q}%`);
      targetSql += ` AND (
        LOWER(COALESCE(u.name, '')) LIKE $3
        OR LOWER(COALESCE(u.role, '')) LIKE $3
        OR LOWER(COALESCE(s.department, '')) LIKE $3
        OR LOWER(COALESCE(s.employee_id, '')) LIKE $3
      )`;
    }
    params.push(safeLimit);
    targetSql += ` ORDER BY s.department NULLS LAST, u.name LIMIT $${params.length}`;

    const staff = await query(targetSql, params);

    return {
      staff,
      departments: departments.map(row => row.department),
      viewer: {
        uid: staffUid,
        role,
        department: sender?.department || null,
        can_send_all: isAdminBroadcastRole(role),
        can_send_selected: isAdminBroadcastRole(role),
        can_send_department: isAdminBroadcastRole(role) || isDepartmentBroadcastRole(role)
      }
    };
  },

  /**
   * Get paginated inbox/sent messages for a staff member (most recent first).
   */
  async getInbox(staffUid, page = 1, limit = 20, tenantId = DEFAULT_TENANT_ID) {
    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(Math.max(1, parseInt(limit) || 20), 100);
    const offset = (safePage - 1) * safeLimit;
    const normalizedTenant = normalizeTenant(tenantId);

    try {
      const countResult = await query(
        `SELECT COUNT(*)::int AS total
           FROM staff_messages
          WHERE tenant_id = $1::uuid
            AND (recipient_uid = $2::uuid OR sender_uid = $2::uuid)`,
        [normalizedTenant, staffUid]
      );

      const result = await query(
        `SELECT ${baseMessageSelect()}
           FROM staff_messages m
           ${baseMessageJoins()}
          WHERE m.tenant_id = $1::uuid
            AND (m.recipient_uid = $2::uuid OR m.sender_uid = $2::uuid)
          ORDER BY m.created_at DESC
          LIMIT $3 OFFSET $4`,
        [normalizedTenant, staffUid, safeLimit, offset]
      );

      return {
        messages: result,
        total: countResult[0].total,
        page: safePage,
        limit: safeLimit
      };
    } catch (err) {
      logger.error('Error fetching inbox:', err.message);
      throw AppError.internal('Failed to fetch inbox');
    }
  },

  /**
   * Get conversation thread between two staff members.
   */
  async getThread(staffUid, otherStaffUid, patientUid = null, tenantId = DEFAULT_TENANT_ID) {
    try {
      let sql = `
        SELECT ${baseMessageSelect()}
        FROM staff_messages m
        ${baseMessageJoins()}
        WHERE m.tenant_id = $3::uuid
          AND (
            (m.sender_uid = $1::uuid AND m.recipient_uid = $2::uuid)
            OR (m.sender_uid = $2::uuid AND m.recipient_uid = $1::uuid)
          )`;
      const params = [staffUid, otherStaffUid, normalizeTenant(tenantId)];

      if (patientUid) {
        sql += ` AND m.patient_uid = $4::uuid`;
        params.push(patientUid);
      }

      sql += ` ORDER BY m.created_at ASC`;

      return await query(sql, params);
    } catch (err) {
      logger.error('Error fetching thread:', err.message);
      throw AppError.internal('Failed to fetch conversation thread');
    }
  },

  /**
   * Mark a message as read.
   */
  async markAsRead(messageId, staffUid, tenantId = DEFAULT_TENANT_ID) {
    const normalizedTenant = normalizeTenant(tenantId);
    try {
      const result = await query(
        `UPDATE staff_messages
         SET is_read = true, read_at = NOW()
         WHERE id = $1
           AND tenant_id = $3::uuid
           AND recipient_uid = $2::uuid
           AND is_read = false
         RETURNING id, is_read, read_at`,
        [messageId, staffUid, normalizedTenant]
      );

      if (result.length === 0) {
        const exists = await query(
          `SELECT id, recipient_uid, is_read, read_at
             FROM staff_messages
            WHERE id = $1
              AND tenant_id = $2::uuid`,
          [messageId, normalizedTenant]
        );

        if (exists.length === 0) {
          throw AppError.notFound('Message not found');
        }

        if (String(exists[0].recipient_uid) !== String(staffUid)) {
          throw AppError.forbidden("Cannot mark another user's message as read");
        }

        return { id: messageId, is_read: true, read_at: exists[0].read_at };
      }

      return result[0];
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.error('Error marking message as read:', err.message);
      throw AppError.internal('Failed to mark message as read');
    }
  },

  async getUnreadCount(staffUid, tenantId = DEFAULT_TENANT_ID) {
    try {
      const result = await query(
        `SELECT COUNT(*)::int AS unread_count
         FROM staff_messages
         WHERE tenant_id = $1::uuid
           AND recipient_uid = $2::uuid
           AND is_read = false`,
        [normalizeTenant(tenantId), staffUid]
      );

      return { unread_count: result[0].unread_count };
    } catch (err) {
      logger.error('Error fetching unread count:', err.message);
      throw AppError.internal('Failed to fetch unread count');
    }
  },

  async getAdminMessageLog({
    tenantId = DEFAULT_TENANT_ID,
    page = 1,
    limit = 50,
    search = '',
    department = '',
    priority = ''
  }) {
    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(Math.max(1, parseInt(limit) || 50), 200);
    const offset = (safePage - 1) * safeLimit;
    const normalizedTenant = normalizeTenant(tenantId);
    const where = ['m.tenant_id = $1::uuid'];
    const params = [normalizedTenant];
    let index = 2;

    if (compactString(priority)) {
      where.push(`m.priority = $${index}`);
      params.push(compactString(priority).toLowerCase());
      index += 1;
    }
    if (compactString(department)) {
      where.push(`(sender_staff.department = $${index} OR recipient_staff.department = $${index})`);
      params.push(compactString(department));
      index += 1;
    }
    if (compactString(search)) {
      where.push(`(
        LOWER(COALESCE(sender.name, '')) LIKE $${index}
        OR LOWER(COALESCE(recipient.name, '')) LIKE $${index}
        OR LOWER(COALESCE(m.subject, '')) LIKE $${index}
        OR LOWER(COALESCE(m.body, '')) LIKE $${index}
      )`);
      params.push(`%${compactString(search).toLowerCase()}%`);
      index += 1;
    }

    const whereSql = where.join(' AND ');
    const countRows = await query(
      `SELECT COUNT(*)::int AS total
         FROM staff_messages m
         ${baseMessageJoins()}
        WHERE ${whereSql}`,
      params
    );

    const rows = await query(
      `SELECT ${baseMessageSelect()}
         FROM staff_messages m
         ${baseMessageJoins()}
        WHERE ${whereSql}
        ORDER BY m.created_at DESC
        LIMIT $${index} OFFSET $${index + 1}`,
      [...params, safeLimit, offset]
    );

    return {
      messages: rows,
      total: countRows[0]?.total ?? 0,
      page: safePage,
      limit: safeLimit
    };
  },

  /**
   * Get all messages about a specific patient (cross-staff discussion).
   */
  async getPatientDiscussion(patientUid, tenantId = DEFAULT_TENANT_ID) {
    try {
      return await query(
        `SELECT ${baseMessageSelect()}
         FROM staff_messages m
         ${baseMessageJoins()}
         WHERE m.tenant_id = $2::uuid
           AND m.patient_uid = $1::uuid
         ORDER BY m.created_at ASC`,
        [patientUid, normalizeTenant(tenantId)]
      );
    } catch (err) {
      logger.error('Error fetching patient discussion:', err.message);
      throw AppError.internal('Failed to fetch patient discussion');
    }
  }
};

export default messagingService;

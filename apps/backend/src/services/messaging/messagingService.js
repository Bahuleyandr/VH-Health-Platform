// src/services/messaging/messagingService.js

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import notificationOutbox from '../../utils/notifications/notificationOutbox.js'; // eslint-disable-line import/no-named-as-default
import { getFileFromR2, uploadFileToR2 } from '../../utils/r2Storage.js';
import { scanBuffer } from '../../utils/virusScanner.js';
import { emitStaffMessage } from '../../utils/websocket/realtimeEmitter.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const VALID_PRIORITIES = ['normal', 'urgent', 'critical'];
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const ADMIN_BROADCAST_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'HR_STAFF']);
const DEPARTMENT_BROADCAST_ROLES = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'HR_STAFF',
  'NURSING_INCHARGE',
  'OP_INCHARGE',
  'IP_INCHARGE',
  'OT_INCHARGE',
  'CATH_LAB_INCHARGE',
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
const normalizeFileName = value =>
  compactString(value || 'attachment')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 180) || 'attachment';

const publicAttachment = row => ({
  id: row.id,
  thread_id: row.thread_id,
  message_id: row.message_id == null ? null : Number(row.message_id),
  uploaded_by_uid: row.uploaded_by_uid,
  file_name: row.file_name,
  content_type: row.content_type,
  file_size: row.file_size == null ? null : Number(row.file_size),
  scan_status: row.scan_status || 'pending',
  metadata: row.metadata || {},
  created_at: row.created_at,
  updated_at: row.updated_at
});

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

function baseMessageSelect(alias = 'm') {
  return `${alias}.id, ${alias}.thread_id, ${alias}.sender_uid, sender.name AS sender_name, sender.role AS sender_role,
          sender_staff.department AS sender_department,
          ${alias}.recipient_uid, recipient.name AS recipient_name, recipient.role AS recipient_role,
          recipient_staff.department AS recipient_department,
          ${alias}.patient_uid, ${alias}.subject, ${alias}.body, ${alias}.priority,
          ${alias}.is_read, ${alias}.read_at, ${alias}.created_at, ${alias}.tenant_id`;
}

function baseMessageJoins(alias = 'm') {
  return `LEFT JOIN users sender ON sender.uid = ${alias}.sender_uid
          LEFT JOIN staff sender_staff ON sender_staff.user_id = sender.uid
          LEFT JOIN users recipient ON recipient.uid = ${alias}.recipient_uid
          LEFT JOIN staff recipient_staff ON recipient_staff.user_id = recipient.uid`;
}

function attachmentSelect(alias = 'a') {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}id, ${prefix}thread_id, ${prefix}message_id, ${prefix}uploaded_by_uid,
          ${prefix}file_name, ${prefix}content_type, ${prefix}file_size, ${prefix}storage_key,
          ${prefix}scan_status, ${prefix}metadata, ${prefix}created_at, ${prefix}updated_at`;
}

async function addThreadParticipants(db, threadId, tenantId, participantUids) {
  const unique = Array.from(new Set(participantUids.map(uid => compactString(uid)).filter(Boolean)));
  if (unique.length === 0) return;

  await query(
    `INSERT INTO staff_message_thread_participants
      (thread_id, participant_uid, tenant_id, created_at, updated_at)
     SELECT $1::uuid, uid, $2::uuid, NOW(), NOW()
       FROM unnest($3::uuid[]) AS uid
     ON CONFLICT (thread_id, participant_uid) DO NOTHING`,
    [threadId, normalizeTenant(tenantId), unique],
    db
  );
}

async function assertThreadAccess(db, { threadId, staffUid, tenantId, recipientUid = null }) {
  const params = [threadId, normalizeTenant(tenantId), staffUid];
  let recipientClause = '';
  if (recipientUid) {
    params.push(recipientUid);
    recipientClause = `
      AND EXISTS (
        SELECT 1
          FROM staff_message_thread_participants rp
         WHERE rp.thread_id = t.id
           AND rp.participant_uid = $4::uuid
      )`;
  }

  const rows = await query(
    `SELECT t.id, t.thread_type, t.subject, t.patient_uid, t.admission_id,
            t.priority, t.status, t.tenant_id
       FROM staff_message_threads t
       JOIN staff_message_thread_participants p
         ON p.thread_id = t.id
        AND p.participant_uid = $3::uuid
      WHERE t.id = $1::uuid
        AND t.tenant_id = $2::uuid
        ${recipientClause}
      LIMIT 1`,
    params,
    db
  );

  if (rows.length === 0) {
    throw AppError.forbidden('Message thread is not available to this staff member');
  }

  return rows[0];
}

async function findExistingDirectThread(db, { senderUid, recipientUid, tenantId, patientUid, admissionId }) {
  const rows = await query(
    `SELECT t.id, t.priority, t.subject, t.patient_uid, t.admission_id
       FROM staff_message_threads t
       JOIN staff_message_thread_participants p1
         ON p1.thread_id = t.id
        AND p1.participant_uid = $2::uuid
       JOIN staff_message_thread_participants p2
         ON p2.thread_id = t.id
        AND p2.participant_uid = $3::uuid
      WHERE t.tenant_id = $1::uuid
        AND t.thread_type IN ('direct', 'patient_context')
        AND t.status = 'active'
        AND t.patient_uid IS NOT DISTINCT FROM $4::uuid
        AND t.admission_id IS NOT DISTINCT FROM $5::int
      ORDER BY t.last_message_at DESC NULLS LAST, t.created_at DESC
      LIMIT 1`,
    [normalizeTenant(tenantId), senderUid, recipientUid, patientUid, admissionId],
    db
  );
  return rows[0] || null;
}

async function createDirectThread(db, { senderUid, recipientUid, tenantId, patientUid, admissionId, subject, priority }) {
  const normalizedTenant = normalizeTenant(tenantId);
  const result = await query(
    `INSERT INTO staff_message_threads
      (tenant_id, thread_type, subject, patient_uid, admission_id, created_by_uid,
       status, priority, created_at, updated_at, last_message_at)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5::int, $6::uuid,
             'active', $7, NOW(), NOW(), NOW())
     RETURNING id, priority, subject, patient_uid, admission_id`,
    [
      normalizedTenant,
      patientUid || admissionId ? 'patient_context' : 'direct',
      subject || null,
      patientUid || null,
      admissionId || null,
      senderUid,
      priority
    ],
    db
  );
  const thread = result[0];
  await addThreadParticipants(db, thread.id, normalizedTenant, [senderUid, recipientUid]);
  return thread;
}

async function resolveMessageThread(
  db,
  { senderUid, recipientUid, tenantId, patientUid = null, admissionId = null, subject = null, priority, threadId = null }
) {
  if (threadId) {
    return assertThreadAccess(db, {
      threadId,
      staffUid: senderUid,
      recipientUid,
      tenantId
    });
  }

  const existing = await findExistingDirectThread(db, {
    senderUid,
    recipientUid,
    tenantId,
    patientUid,
    admissionId
  });
  if (existing) return existing;

  return createDirectThread(db, {
    senderUid,
    recipientUid,
    tenantId,
    patientUid,
    admissionId,
    subject,
    priority
  });
}

async function touchThreadAfterMessage(db, { threadId, messageId, priority, subject }) {
  if (!threadId) return;

  await query(
    `UPDATE staff_message_threads
        SET last_message_id = $2::int,
            last_message_at = NOW(),
            subject = COALESCE(NULLIF(subject, ''), NULLIF($3, '')),
            priority = CASE
              WHEN priority = 'critical' OR $4 = 'critical' THEN 'critical'
              WHEN priority = 'urgent' OR $4 = 'urgent' THEN 'urgent'
              ELSE 'normal'
            END,
            updated_at = NOW()
      WHERE id = $1::uuid`,
    [threadId, messageId, subject || null, priority],
    db
  );
}

async function insertMessage(
  db,
  { senderUid, recipientUid, tenantId, body, priority, patientUid = null, subject = null, threadId = null }
) {
  const result = await query(
    `INSERT INTO staff_messages
      (sender_uid, recipient_uid, patient_uid, subject, body, priority, is_read, tenant_id, thread_id, created_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, false, $7::uuid, $8::uuid, NOW())
     RETURNING id, thread_id, sender_uid, recipient_uid, patient_uid, subject, body, priority,
               is_read, read_at, created_at, tenant_id`,
    [senderUid, recipientUid, patientUid, subject, body, priority, normalizeTenant(tenantId), threadId],
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
      thread_id: message.thread_id || null,
      sender_uid: senderUid,
      priority
    }
  });
}

async function notifyMessageRecipient(message, senderUid, priority, subject, body) {
  if (message.thread_id) {
    const rows = await query(
      `SELECT muted_until, urgent_only
         FROM staff_message_thread_participants
        WHERE thread_id = $1::uuid
          AND participant_uid = $2::uuid
          AND tenant_id = $3::uuid
        LIMIT 1`,
      [message.thread_id, message.recipient_uid, normalizeTenant(message.tenant_id)]
    );
    const preference = rows[0] || {};
    const mutedUntil = preference.muted_until ? new Date(preference.muted_until) : null;
    const isMuted = mutedUntil && mutedUntil > new Date();
    if (isMuted && priority !== 'critical') return;
    if (preference.urgent_only === true && !['urgent', 'critical'].includes(priority)) return;
  }

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

async function resolveThreadRecipient(db, { threadId, senderUid, recipientUid = null, tenantId }) {
  const normalizedTenant = normalizeTenant(tenantId);
  await assertThreadAccess(db, {
    threadId,
    staffUid: senderUid,
    recipientUid,
    tenantId: normalizedTenant
  });

  if (recipientUid && recipientUid !== senderUid) {
    return recipientUid;
  }

  const rows = await query(
    `SELECT participant_uid
       FROM staff_message_thread_participants
      WHERE thread_id = $1::uuid
        AND tenant_id = $2::uuid
        AND participant_uid <> $3::uuid
      ORDER BY created_at ASC
      LIMIT 1`,
    [threadId, normalizedTenant, senderUid],
    db
  );

  const resolved = rows[0]?.participant_uid;
  if (!resolved) {
    throw AppError.badRequest('Message thread has no recipient for this attachment');
  }
  return resolved;
}

async function hydrateMessageAttachments(messages, tenantId, db = prisma) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const messageIds = messages.map(message => Number(message.id)).filter(Number.isInteger);
  if (messageIds.length === 0) return messages.map(message => ({ ...message, attachments: [] }));

  const attachments = await query(
    `SELECT ${attachmentSelect()}
       FROM staff_message_attachments a
      WHERE a.tenant_id = $1::uuid
        AND a.message_id = ANY($2::int[])
      ORDER BY a.created_at ASC`,
    [normalizeTenant(tenantId), messageIds],
    db
  );

  const byMessageId = new Map();
  for (const row of attachments) {
    const key = Number(row.message_id);
    if (!byMessageId.has(key)) byMessageId.set(key, []);
    byMessageId.get(key).push(publicAttachment(row));
  }

  return messages.map(message => ({
    ...message,
    attachments: byMessageId.get(Number(message.id)) || []
  }));
}

async function scanAttachmentBuffer(buffer) {
  try {
    await scanBuffer(Buffer.from(buffer));
    return {
      scanStatus: 'clean',
      metadata: {
        scanner: 'clamav',
        scanned_at: new Date().toISOString()
      }
    };
  } catch (err) {
    const message = compactString(err?.message || err);
    const infected = /virus detected|malicious|infected/i.test(message);
    return {
      scanStatus: infected ? 'quarantined' : 'failed',
      metadata: {
        scanner: 'clamav',
        scanned_at: new Date().toISOString(),
        scan_error: message || 'Attachment scan failed'
      }
    };
  }
}

function assertAttachmentFile(file) {
  if (!file || !file.buffer) {
    throw AppError.badRequest('file is required');
  }
  const size = Number(file.size || file.buffer.length || 0);
  if (!Number.isFinite(size) || size <= 0) {
    throw AppError.badRequest('Attachment file is empty');
  }
  if (size > MAX_ATTACHMENT_BYTES) {
    throw AppError.badRequest('Attachment file exceeds the 15 MB staff-message limit');
  }
  const fileName = normalizeFileName(file.originalname || file.filename || 'attachment');
  const contentType = compactString(file.mimetype || 'application/octet-stream');
  return {
    buffer: Buffer.from(file.buffer),
    fileName,
    contentType,
    size
  };
}

function storageKeyForAttachment({ tenantId, threadId, fileName }) {
  const suffix = `${Date.now()}-${crypto.randomUUID()}-${fileName}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `staff-messages/${normalizeTenant(tenantId)}/${threadId}/${suffix}`;
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
    tenantId = DEFAULT_TENANT_ID,
    options = {}
  ) {
    if (!senderUid || !recipientUid || !body) {
      throw AppError.badRequest('Sender, recipient, and body are required');
    }

    if (senderUid === recipientUid) {
      throw AppError.badRequest('Cannot send a message to yourself');
    }

    const normalizedPriority = ensurePriority(priority);
    const normalizedTenant = normalizeTenant(tenantId);

    try {
      const message = await prisma.$transaction(async tx => {
        const thread = await resolveMessageThread(tx, {
          senderUid,
          recipientUid,
          tenantId: normalizedTenant,
          patientUid,
          admissionId: options.admissionId || options.admission_id || null,
          subject,
          priority: normalizedPriority,
          threadId: options.threadId || options.thread_id || null
        });
        const saved = await insertMessage(tx, {
          senderUid,
          recipientUid,
          tenantId: normalizedTenant,
          body,
          priority: normalizedPriority,
          patientUid: patientUid || thread.patient_uid || null,
          subject,
          threadId: thread.id
        });
        await touchThreadAfterMessage(tx, {
          threadId: thread.id,
          messageId: saved.id,
          priority: normalizedPriority,
          subject
        });
        return saved;
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

  async sendThreadAttachment({
    senderUid,
    tenantId = DEFAULT_TENANT_ID,
    threadId,
    recipientUid = null,
    file,
    body = '',
    subject = null,
    priority = 'normal'
  }) {
    if (!senderUid || !threadId) {
      throw AppError.badRequest('senderUid and threadId are required');
    }

    const normalizedPriority = ensurePriority(priority);
    const normalizedTenant = normalizeTenant(tenantId);
    const attachmentFile = assertAttachmentFile(file);
    const thread = await assertThreadAccess(prisma, {
      threadId,
      staffUid: senderUid,
      recipientUid,
      tenantId: normalizedTenant
    });
    const resolvedRecipientUid = await resolveThreadRecipient(prisma, {
      threadId,
      senderUid,
      recipientUid,
      tenantId: normalizedTenant
    });
    if (resolvedRecipientUid === senderUid) {
      throw AppError.badRequest('Cannot send an attachment to yourself');
    }

    const scan = await scanAttachmentBuffer(attachmentFile.buffer);
    if (scan.scanStatus === 'quarantined') {
      throw AppError.badRequest('Attachment failed virus scan', 'ATTACHMENT_QUARANTINED');
    }

    const storageKey = storageKeyForAttachment({
      tenantId: normalizedTenant,
      threadId,
      fileName: attachmentFile.fileName
    });
    await uploadFileToR2(attachmentFile.buffer, storageKey, attachmentFile.contentType);

    const messageBody =
      compactString(body) || `Attachment: ${attachmentFile.fileName}`;
    const metadata = {
      ...scan.metadata,
      original_name: file.originalname || attachmentFile.fileName,
      storage_backend: 'r2'
    };

    try {
      const result = await prisma.$transaction(async tx => {
        await assertThreadAccess(tx, {
          threadId,
          staffUid: senderUid,
          recipientUid: resolvedRecipientUid,
          tenantId: normalizedTenant
        });
        const message = await insertMessage(tx, {
          senderUid,
          recipientUid: resolvedRecipientUid,
          tenantId: normalizedTenant,
          body: messageBody,
          priority: normalizedPriority,
          patientUid: thread.patient_uid || null,
          subject,
          threadId
        });
        const attachmentRows = await query(
          `INSERT INTO staff_message_attachments
             (tenant_id, thread_id, message_id, uploaded_by_uid, file_name, content_type,
              file_size, storage_key, scan_status, metadata, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::int, $4::uuid, $5, $6,
                   $7::int, $8, $9, $10::jsonb, NOW(), NOW())
           RETURNING ${attachmentSelect('')}`,
          [
            normalizedTenant,
            threadId,
            message.id,
            senderUid,
            attachmentFile.fileName,
            attachmentFile.contentType,
            attachmentFile.size,
            storageKey,
            scan.scanStatus,
            JSON.stringify(metadata)
          ],
          tx
        );
        const attachment = publicAttachment(attachmentRows[0]);
        await touchThreadAfterMessage(tx, {
          threadId,
          messageId: message.id,
          priority: normalizedPriority,
          subject
        });
        return {
          message: { ...message, attachments: [attachment] },
          attachment
        };
      });

      await notifyMessageRecipient(
        result.message,
        senderUid,
        normalizedPriority,
        subject,
        messageBody
      );

      logger.info(
        `Staff message attachment sent: ${result.attachment.id} in thread ${threadId} by ${senderUid}`
      );
      return result;
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.error('Error sending staff message attachment:', err.message);
      throw AppError.internal('Failed to send message attachment');
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
    patientUid = null,
    admissionId = null
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
          const thread = await resolveMessageThread(tx, {
            senderUid,
            recipientUid,
            tenantId: normalizedTenant,
            patientUid,
            admissionId,
            subject,
            priority: normalizedPriority
          });
          const message = await insertMessage(tx, {
            senderUid,
            recipientUid,
            tenantId: normalizedTenant,
            body,
            priority: normalizedPriority,
            patientUid: patientUid || thread.patient_uid || null,
            subject,
            threadId: thread.id
          });
          await touchThreadAfterMessage(tx, {
            threadId: thread.id,
            messageId: message.id,
            priority: normalizedPriority,
            subject
          });
          messages.push(message);
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
   * Get first-class conversation threads for a staff member.
   */
  async getThreads({
    staffUid,
    tenantId = DEFAULT_TENANT_ID,
    page = 1,
    limit = 30,
    status = 'active',
    priority = '',
    search = ''
  }) {
    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(Math.max(1, parseInt(limit) || 30), 100);
    const offset = (safePage - 1) * safeLimit;
    const normalizedTenant = normalizeTenant(tenantId);
    const where = ['t.tenant_id = $1::uuid', 'p.participant_uid = $2::uuid'];
    const params = [normalizedTenant, staffUid];
    let index = 3;
    const normalizedStatus = compactString(status || 'active').toLowerCase();

    if (normalizedStatus === 'archived') {
      where.push('p.archived_at IS NOT NULL');
    } else if (normalizedStatus !== 'all') {
      where.push('p.archived_at IS NULL');
    }

    if (compactString(priority)) {
      const normalizedPriority = ensurePriority(priority);
      where.push(`COALESCE(m.priority, t.priority) = $${index}`);
      params.push(normalizedPriority);
      index += 1;
    }

    if (compactString(search)) {
      where.push(`(
        LOWER(COALESCE(t.subject, '')) LIKE $${index}
        OR LOWER(COALESCE(m.subject, '')) LIKE $${index}
        OR LOWER(COALESCE(m.body, '')) LIKE $${index}
        OR LOWER(COALESCE(partner.name, '')) LIKE $${index}
        OR LOWER(COALESCE(partner_staff.department, '')) LIKE $${index}
        OR LOWER(COALESCE(patient.name, '')) LIKE $${index}
      )`);
      params.push(`%${compactString(search).toLowerCase()}%`);
      index += 1;
    }

    const rows = await query(
      `SELECT
          COUNT(*) OVER()::int AS total_count,
          t.id AS thread_id,
          t.thread_type,
          t.subject AS thread_subject,
          t.patient_uid AS context_patient_uid,
          patient.name AS patient_name,
          t.admission_id,
          t.status AS thread_status,
          t.priority AS thread_priority,
          t.last_message_id,
          t.last_message_at,
          t.created_at AS thread_created_at,
          t.updated_at AS thread_updated_at,
          p.archived_at,
          p.muted_until,
          p.urgent_only,
          p.last_read_at,
          COALESCE(unread.unread_count, 0)::int AS unread_count,
          partner.uid AS partner_uid,
          partner.name AS partner_name,
          partner.role AS partner_role,
          partner_staff.department AS partner_department,
          ${baseMessageSelect('m')}
       FROM staff_message_threads t
       JOIN staff_message_thread_participants p
         ON p.thread_id = t.id
       LEFT JOIN LATERAL (
         SELECT sm.*
           FROM staff_messages sm
          WHERE sm.thread_id = t.id
          ORDER BY sm.created_at DESC NULLS LAST, sm.id DESC
          LIMIT 1
       ) m ON true
       ${baseMessageJoins('m')}
       LEFT JOIN LATERAL (
         SELECT u.uid, u.name, u.role
           FROM staff_message_thread_participants pp
           JOIN users u ON u.uid = pp.participant_uid
          WHERE pp.thread_id = t.id
            AND pp.participant_uid <> $2::uuid
          ORDER BY u.name
          LIMIT 1
       ) partner ON true
       LEFT JOIN staff partner_staff ON partner_staff.user_id = partner.uid
       LEFT JOIN users patient ON patient.uid = t.patient_uid
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS unread_count
           FROM staff_messages unread
          WHERE unread.thread_id = t.id
            AND unread.tenant_id = $1::uuid
            AND unread.recipient_uid = $2::uuid
            AND unread.is_read = false
       ) unread ON true
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(t.last_message_at, t.updated_at, t.created_at) DESC
      LIMIT $${index} OFFSET $${index + 1}`,
      [...params, safeLimit, offset]
    );

    return {
      threads: rows.map(({ total_count: _total, ...row }) => row),
      total: rows[0]?.total_count ?? 0,
      page: safePage,
      limit: safeLimit
    };
  },

  async getThreadById(staffUid, threadId, tenantId = DEFAULT_TENANT_ID) {
    const normalizedTenant = normalizeTenant(tenantId);
    await assertThreadAccess(prisma, { threadId, staffUid, tenantId: normalizedTenant });

    const threadRows = await query(
      `SELECT
          t.id AS thread_id,
          t.thread_type,
          t.subject AS thread_subject,
          t.patient_uid AS context_patient_uid,
          patient.name AS patient_name,
          t.admission_id,
          t.status AS thread_status,
          t.priority AS thread_priority,
          t.last_message_id,
          t.last_message_at,
          t.created_at AS thread_created_at,
          t.updated_at AS thread_updated_at,
          p.archived_at,
          p.muted_until,
          p.urgent_only,
          p.last_read_at,
          partner.uid AS partner_uid,
          partner.name AS partner_name,
          partner.role AS partner_role,
          partner_staff.department AS partner_department
       FROM staff_message_threads t
       JOIN staff_message_thread_participants p
         ON p.thread_id = t.id
        AND p.participant_uid = $2::uuid
       LEFT JOIN LATERAL (
         SELECT u.uid, u.name, u.role
           FROM staff_message_thread_participants pp
           JOIN users u ON u.uid = pp.participant_uid
          WHERE pp.thread_id = t.id
            AND pp.participant_uid <> $2::uuid
          ORDER BY u.name
          LIMIT 1
       ) partner ON true
       LEFT JOIN staff partner_staff ON partner_staff.user_id = partner.uid
       LEFT JOIN users patient ON patient.uid = t.patient_uid
      WHERE t.id = $1::uuid
        AND t.tenant_id = $3::uuid
      LIMIT 1`,
      [threadId, staffUid, normalizedTenant]
    );

    const messages = await query(
      `SELECT ${baseMessageSelect()}
         FROM staff_messages m
         ${baseMessageJoins()}
        WHERE m.thread_id = $1::uuid
          AND m.tenant_id = $2::uuid
        ORDER BY m.created_at ASC NULLS LAST, m.id ASC`,
      [threadId, normalizedTenant]
    );
    const messagesWithAttachments = await hydrateMessageAttachments(
      messages,
      normalizedTenant
    );

    return {
      thread: threadRows[0] || null,
      messages: messagesWithAttachments
    };
  },

  async listThreadAttachments(staffUid, threadId, tenantId = DEFAULT_TENANT_ID) {
    const normalizedTenant = normalizeTenant(tenantId);
    await assertThreadAccess(prisma, { threadId, staffUid, tenantId: normalizedTenant });

    const rows = await query(
      `SELECT ${attachmentSelect()}
         FROM staff_message_attachments a
        WHERE a.thread_id = $1::uuid
          AND a.tenant_id = $2::uuid
        ORDER BY a.created_at DESC`,
      [threadId, normalizedTenant]
    );
    return rows.map(publicAttachment);
  },

  async getAttachmentDownload(staffUid, attachmentId, tenantId = DEFAULT_TENANT_ID) {
    const normalizedTenant = normalizeTenant(tenantId);
    const rows = await query(
      `SELECT ${attachmentSelect()}
         FROM staff_message_attachments a
        WHERE a.id = $1::uuid
          AND a.tenant_id = $2::uuid
        LIMIT 1`,
      [attachmentId, normalizedTenant]
    );
    const row = rows[0];
    if (!row) {
      throw AppError.notFound('Attachment not found');
    }

    await assertThreadAccess(prisma, {
      threadId: row.thread_id,
      staffUid,
      tenantId: normalizedTenant
    });
    if (row.scan_status === 'quarantined') {
      throw AppError.conflict('Attachment is quarantined and cannot be downloaded');
    }

    const bytes = Buffer.from(await getFileFromR2(row.storage_key));
    return {
      attachment: publicAttachment(row),
      bytes
    };
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

      const messages = await query(sql, params);
      return await hydrateMessageAttachments(messages, tenantId);
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
         RETURNING id, thread_id, is_read, read_at`,
        [messageId, staffUid, normalizedTenant]
      );

      if (result.length === 0) {
        const exists = await query(
          `SELECT id, thread_id, recipient_uid, is_read, read_at
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

        if (exists[0].thread_id) {
          await query(
            `UPDATE staff_message_thread_participants
                SET last_read_at = NOW(),
                    updated_at = NOW()
              WHERE thread_id = $1::uuid
                AND participant_uid = $2::uuid
                AND tenant_id = $3::uuid`,
            [exists[0].thread_id, staffUid, normalizedTenant]
          );
        }

        return { id: messageId, is_read: true, read_at: exists[0].read_at };
      }

      if (result[0].thread_id) {
        await query(
          `UPDATE staff_message_thread_participants
              SET last_read_at = NOW(),
                  updated_at = NOW()
            WHERE thread_id = $1::uuid
              AND participant_uid = $2::uuid
              AND tenant_id = $3::uuid`,
          [result[0].thread_id, staffUid, normalizedTenant]
        );
      }

      return result[0];
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.error('Error marking message as read:', err.message);
      throw AppError.internal('Failed to mark message as read');
    }
  },

  async setThreadArchived(threadId, staffUid, tenantId = DEFAULT_TENANT_ID, archived = true) {
    const result = await query(
      `UPDATE staff_message_thread_participants p
          SET archived_at = CASE WHEN $4::boolean THEN NOW() ELSE NULL END,
              updated_at = NOW()
         FROM staff_message_threads t
        WHERE p.thread_id = t.id
          AND t.id = $1::uuid
          AND p.participant_uid = $2::uuid
          AND t.tenant_id = $3::uuid
        RETURNING p.thread_id, p.participant_uid, p.archived_at`,
      [threadId, staffUid, normalizeTenant(tenantId), archived]
    );

    if (result.length === 0) {
      throw AppError.forbidden('Message thread is not available to this staff member');
    }
    return result[0];
  },

  async markThreadUnread(threadId, staffUid, tenantId = DEFAULT_TENANT_ID) {
    const normalizedTenant = normalizeTenant(tenantId);
    await assertThreadAccess(prisma, { threadId, staffUid, tenantId: normalizedTenant });

    const result = await query(
      `WITH latest_incoming AS (
         SELECT id
           FROM staff_messages
          WHERE thread_id = $1::uuid
            AND tenant_id = $3::uuid
            AND recipient_uid = $2::uuid
          ORDER BY created_at DESC NULLS LAST, id DESC
          LIMIT 1
       ), updated_message AS (
         UPDATE staff_messages
            SET is_read = false,
                read_at = NULL
          WHERE id IN (SELECT id FROM latest_incoming)
          RETURNING id
       ), updated_participant AS (
         UPDATE staff_message_thread_participants
            SET last_read_at = NULL,
                updated_at = NOW()
          WHERE thread_id = $1::uuid
            AND participant_uid = $2::uuid
            AND tenant_id = $3::uuid
          RETURNING thread_id
       )
       SELECT
         (SELECT thread_id FROM updated_participant) AS thread_id,
         (SELECT id FROM updated_message) AS message_id`,
      [threadId, staffUid, normalizedTenant]
    );

    return result[0] || { thread_id: threadId, message_id: null };
  },

  async setThreadMute({
    threadId,
    staffUid,
    tenantId = DEFAULT_TENANT_ID,
    mutedUntil = null,
    urgentOnly = false
  }) {
    const result = await query(
      `UPDATE staff_message_thread_participants p
          SET muted_until = $4::timestamptz,
              urgent_only = $5::boolean,
              updated_at = NOW()
         FROM staff_message_threads t
        WHERE p.thread_id = t.id
          AND t.id = $1::uuid
          AND p.participant_uid = $2::uuid
          AND t.tenant_id = $3::uuid
        RETURNING p.thread_id, p.participant_uid, p.muted_until, p.urgent_only`,
      [threadId, staffUid, normalizeTenant(tenantId), mutedUntil, urgentOnly]
    );

    if (result.length === 0) {
      throw AppError.forbidden('Message thread is not available to this staff member');
    }
    return result[0];
  },

  async clearThreadMute(threadId, staffUid, tenantId = DEFAULT_TENANT_ID) {
    return this.setThreadMute({
      threadId,
      staffUid,
      tenantId,
      mutedUntil: null,
      urgentOnly: false
    });
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

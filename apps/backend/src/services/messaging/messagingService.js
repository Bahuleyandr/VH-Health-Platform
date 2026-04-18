// src/services/messaging/messagingService.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import notificationOutbox from '../../utils/notifications/notificationOutbox.js'; // eslint-disable-line import/no-named-as-default


const query = async (sql, params = []) => {
  const normalizedSql = sql.trim();
  const upperSql = normalizedSql.toUpperCase();
  const usesReturning = /\bRETURNING\b/i.test(normalizedSql);
  const isReadQuery = upperSql.startsWith('SELECT') || upperSql.startsWith('WITH') || usesReturning;

  if (isReadQuery) {
    const rows = await prisma.$queryRawUnsafe(normalizedSql, ...params);
    return { rows, rowCount: Array.isArray(rows) ? rows.length : 0 };
  }

  const rowCount = await prisma.$executeRawUnsafe(normalizedSql, ...params);
  return { rows: [], rowCount: Number(rowCount) || 0 };
};


const VALID_PRIORITIES = ['normal', 'urgent', 'critical'];

const messagingService = {
  /**
   * Send a message from one staff member to another.
   * Optionally link to a patient context.
   * @param {string} senderUid - Sender staff UID
   * @param {string} recipientUid - Recipient staff UID
   * @param {string} body - Message body
   * @param {string} priority - normal | urgent | critical
   * @param {string|null} patientUid - Optional patient UID for context
   * @param {string|null} subject - Optional subject line
   * @returns {Object} Created message record
   */
  async sendMessage(senderUid, recipientUid, body, priority = 'normal', patientUid = null, subject = null) {
    if (!senderUid || !recipientUid || !body) {
      throw AppError.badRequest('Sender, recipient, and body are required');
    }

    if (senderUid === recipientUid) {
      throw AppError.badRequest('Cannot send a message to yourself');
    }

    if (!VALID_PRIORITIES.includes(priority)) {
      throw AppError.badRequest(`Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}`);
    }

    try {
      const result = await query(
        `INSERT INTO staff_messages
          (sender_uid, recipient_uid, patient_uid, subject, body, priority, is_read, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, false, NOW())
         RETURNING id, sender_uid, recipient_uid, patient_uid, subject, body, priority, is_read, created_at`,
        [senderUid, recipientUid, patientUid, subject, body, priority]
      );

      const message = result[0];

      // Queue notification for recipient (fire-and-forget)
      notificationOutbox.queue({
        type: 'push',
        recipientId: recipientUid,
        title: priority === 'critical' ? '[CRITICAL] New staff message' : 'New staff message',
        body: subject || body.substring(0, 100),
        data: {
          type: 'staff_message',
          message_id: message.id,
          sender_uid: senderUid,
          priority,
        },
      }).catch((err) => {
        logger.warn('Failed to queue notification for staff message:', err.message);
      });

      logger.info(`Staff message sent: ${message.id} from ${senderUid} to ${recipientUid} [${priority}]`);
      return message;
    } catch (err) {
      logger.error('Error sending staff message:', err.message);
      throw AppError.internal('Failed to send message');
    }
  },

  /**
   * Get paginated inbox for a staff member (most recent first).
   * @param {string} staffUid - Staff member UID
   * @param {number} page - Page number (1-based)
   * @param {number} limit - Items per page
   * @returns {Object} { messages, total, page, limit }
   */
  async getInbox(staffUid, page = 1, limit = 20) {
    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(Math.max(1, parseInt(limit) || 20), 100);
    const offset = (safePage - 1) * safeLimit;

    try {
      const countResult = await query(
        `SELECT COUNT(*)::int AS total FROM staff_messages WHERE recipient_uid = $1`,
        [staffUid]
      );

      const result = await query(
        `SELECT id, sender_uid, recipient_uid, patient_uid, subject, body, priority, is_read, read_at, created_at
         FROM staff_messages
         WHERE recipient_uid = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [staffUid, safeLimit, offset]
      );

      return {
        messages: result,
        total: countResult[0].total,
        page: safePage,
        limit: safeLimit,
      };
    } catch (err) {
      logger.error('Error fetching inbox:', err.message);
      throw AppError.internal('Failed to fetch inbox');
    }
  },

  /**
   * Get conversation thread between two staff members.
   * Optionally filter by patient context.
   * @param {string} staffUid - Current staff UID
   * @param {string} otherStaffUid - Other staff UID
   * @param {string|null} patientUid - Optional patient UID filter
   * @returns {Array} Messages in chronological order
   */
  async getThread(staffUid, otherStaffUid, patientUid = null) {
    try {
      let query = `
        SELECT id, sender_uid, recipient_uid, patient_uid, subject, body, priority, is_read, read_at, created_at
        FROM staff_messages
        WHERE (
          (sender_uid = $1 AND recipient_uid = $2)
          OR (sender_uid = $2 AND recipient_uid = $1)
        )`;
      const params = [staffUid, otherStaffUid];

      if (patientUid) {
        query += ` AND patient_uid = $3`;
        params.push(patientUid);
      }

      query += ` ORDER BY created_at ASC`;

      const result = await query(query, params);
      return result;
    } catch (err) {
      logger.error('Error fetching thread:', err.message);
      throw AppError.internal('Failed to fetch conversation thread');
    }
  },

  /**
   * Mark a message as read.
   * Only the recipient can mark their own messages as read.
   * @param {number} messageId - Message ID
   * @param {string} staffUid - Staff UID (must be recipient)
   * @returns {Object} Updated message
   */
  async markAsRead(messageId, staffUid) {
    try {
      const result = await query(
        `UPDATE staff_messages
         SET is_read = true, read_at = NOW()
         WHERE id = $1 AND recipient_uid = $2 AND is_read = false
         RETURNING id, is_read, read_at`,
        [messageId, staffUid]
      );

      if (result.length === 0) {
        // Check if message exists at all
        const exists = await query(
          `SELECT id, recipient_uid, is_read FROM staff_messages WHERE id = $1`,
          [messageId]
        );

        if (exists.length === 0) {
          throw AppError.notFound('Message not found');
        }

        if (String(exists[0].recipient_uid) !== String(staffUid)) {
          throw AppError.forbidden('Cannot mark another user\'s message as read');
        }

        // Already read
        return { id: messageId, is_read: true, read_at: exists[0].read_at };
      }

      return result[0];
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.error('Error marking message as read:', err.message);
      throw AppError.internal('Failed to mark message as read');
    }
  },

  /**
   * Get unread message count for badge display.
   * @param {string} staffUid - Staff member UID
   * @returns {Object} { unread_count }
   */
  async getUnreadCount(staffUid) {
    try {
      const result = await query(
        `SELECT COUNT(*)::int AS unread_count
         FROM staff_messages
         WHERE recipient_uid = $1 AND is_read = false`,
        [staffUid]
      );

      return { unread_count: result[0].unread_count };
    } catch (err) {
      logger.error('Error fetching unread count:', err.message);
      throw AppError.internal('Failed to fetch unread count');
    }
  },

  /**
   * Get all messages about a specific patient (cross-staff discussion).
   * @param {string} patientUid - Patient UID
   * @returns {Array} Messages in chronological order
   */
  async getPatientDiscussion(patientUid) {
    try {
      const result = await query(
        `SELECT id, sender_uid, recipient_uid, patient_uid, subject, body, priority, is_read, read_at, created_at
         FROM staff_messages
         WHERE patient_uid = $1
         ORDER BY created_at ASC`,
        [patientUid]
      );

      return result;
    } catch (err) {
      logger.error('Error fetching patient discussion:', err.message);
      throw AppError.internal('Failed to fetch patient discussion');
    }
  },
};

export default messagingService;

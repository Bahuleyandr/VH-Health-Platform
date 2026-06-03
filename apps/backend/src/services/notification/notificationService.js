// src/services/notification/notificationService.js

import { 
  NOTIFICATION_TYPES, 
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_LIMITS 
} from '../../config/notificationConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { 
   
  buildNotificationQuery,
  formatNotificationResponse 
} from '../../utils/notification/notificationHelpers.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { normalizePhone } from '../../utils/phoneUtils.js';


const query = async (sql, params = []) => {
  const normalizedSql = sql.trim();
  const upperSql = normalizedSql.toUpperCase();
  const usesReturning = /\bRETURNING\b/i.test(normalizedSql);
  const isReadQuery = upperSql.startsWith('SELECT') || upperSql.startsWith('WITH') || usesReturning;

  if (isReadQuery) {
    const rows = await prisma.$queryRawUnsafe(normalizedSql, ...params);
    return rows;
  }

  const rowCount = await prisma.$executeRawUnsafe(normalizedSql, ...params);
  return { rowCount: Number(rowCount) || 0 };
};

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ADMIN_NOTIFICATION_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

function normalizeTenant(tenantId) {
  return tenantId || DEFAULT_TENANT_ID;
}

function normalizeRole(role) {
  return String(role || '').trim().toUpperCase();
}

function isAdminNotificationRole(role) {
  return ADMIN_NOTIFICATION_ROLES.has(normalizeRole(role));
}

function offsetPlaceholders(sql, offset) {
  if (!offset) return sql;
  return sql.replace(/\$(\d+)/g, (_match, n) => `$${Number(n) + offset}`);
}

async function resolveNotificationUser(user) {
  const uid = user?.uid || user?.sub || user?.id;
  if (!uid) {
    throw new Error('User not found');
  }
  const rows = await query(
    `SELECT id, uid, phone, role, tenant_id
       FROM users
      WHERE uid = $1::uuid
      LIMIT 1`,
    [uid],
  );
  if (!rows.length) {
    throw new Error('User not found');
  }
  return {
    ...rows[0],
    phone_normalized: rows[0].phone ? normalizePhone(rows[0].phone) : null,
    tenant_id: normalizeTenant(rows[0].tenant_id || user?.tenantId || user?.tenant_id),
  };
}

async function buildOwnNotificationCondition(user, alias = 'n', startParamIndex = 1) {
  const current = await resolveNotificationUser(user);
  const params = [current.uid, current.id];
  const clauses = [
    `${alias}.uid = $${startParamIndex}::uuid`,
    `${alias}.user_id = $${startParamIndex + 1}::int`,
  ];
  let nextIndex = startParamIndex + 2;
  if (current.phone_normalized) {
    clauses.push(`${alias}.phone = $${nextIndex}`);
    params.push(current.phone_normalized);
    nextIndex += 1;
  }
  return {
    current,
    condition: `(${clauses.join(' OR ')})`,
    params,
    nextIndex,
  };
}


// Keep the original service object
const notificationService = {
async notifyEmergencyTeam(alertData, _nearbyHospitals = []) {
    try {
      // 1. Find all emergency responders
      const respondersResult = await query(
        "SELECT id, name, phone FROM users WHERE role = 'EMERGENCY_RESPONDER' AND is_active = true"
      );
      const responders = respondersResult;

      // In a real app, you might also find staff at nearby hospitals
      // For now, we'll just notify the central emergency team.

      const title = `SOS Alert: ${alertData.severity} - ${alertData.user_name || alertData.phone}`;
      const message = `SOS alert triggered by ${alertData.user_name || alertData.phone}. Message: "${alertData.message || 'No message'}". Location: ${alertData.latitude}, ${alertData.longitude}.`;

      // 2. Create a notification for each responder
      const notificationPromises = responders.map(responder => {
        return this.createNotification({
          user_id: responder.id,
          title: title,
          message: message,
          type: NOTIFICATION_TYPES.EMERGENCY,
          priority: NOTIFICATION_PRIORITIES.HIGH,
          data: { 
            sos_alert_id: alertData.id,
            latitude: alertData.latitude,
            longitude: alertData.longitude,
            user_phone: alertData.phone
          }
        }, { role: 'ADMIN' }); // Create as an admin to bypass permissions
      });

      await Promise.all(notificationPromises);
      logger.info(`Notified ${responders.length} emergency responders for SOS alert ${alertData.id}`);
      
      return { success: true, notified_count: responders.length };

    } catch (error) {
      logger.error('Error notifying emergency team:', error.message);
      throw error;
    }
  },

  /**
   * Get notifications by phone number
   */
  async getNotificationsByPhone(phone, user, options = {}) {
    try {
      const { limit = 50, offset = 0 } = options;
      const normalizedPhone = normalizePhone(phone);
      const userRole = user?.role?.toUpperCase();

      // Check access for patients
      if (userRole === 'PATIENT') {
        const userResult = await query('SELECT phone FROM users WHERE uid = $1::uuid', [user.uid]);
        if (userResult.length === 0 || normalizePhone(userResult[0].phone) !== normalizedPhone) {
          throw new Error('Access denied: Cannot view other user notifications');
        }
      }

      const safeLimit = Math.min(parseInt(limit) || 50, 100);
      const safeOffset = parseInt(offset) || 0;

      const result = await query(
        `SELECT id, phone, title, body AS message, type, priority, is_read, data, created_at
         FROM notifications
         WHERE phone = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [normalizedPhone, safeLimit, safeOffset]
      );

      const countResult = await query(
        'SELECT COUNT(*) FROM notifications WHERE phone = $1',
        [normalizedPhone]
      );

      return {
        notifications: result.map(n => formatNotificationResponse(n, userRole === 'ADMIN')),
        count: result.length,
        total: parseInt(countResult[0].count),
        limit: safeLimit,
        offset: safeOffset
      };
    } catch (error) {
      logger.error('Error getting notifications by phone:', error.message);
      throw error;
    }
  },

  /**
   * Get notifications for the authenticated user. Matches current rows by
   * uid/user_id and legacy rows by normalized phone.
   */
  async getMyNotifications(user, options = {}) {
    try {
      const { limit = 50, offset = 0, unread_only = false, type = null } = options;
      const safeLimit = Math.min(parseInt(limit, 10) || 50, 100);
      const safeOffset = parseInt(offset, 10) || 0;
      const { current, condition, params, nextIndex } =
        await buildOwnNotificationCondition(user, 'n', 1);

      const filters = [condition, 'n.tenant_id = $' + nextIndex + '::uuid'];
      const queryParams = [...params, current.tenant_id];
      let paramIndex = nextIndex + 1;

      if (unread_only === true || unread_only === 'true') {
        filters.push('n.is_read = false');
      }
      if (type) {
        filters.push(`UPPER(n.type) = $${paramIndex}`);
        queryParams.push(String(type).toUpperCase());
        paramIndex += 1;
      }

      const result = await query(
        `SELECT n.id, n.tenant_id, n.uid, n.user_id, n.phone, n.title,
                n.body AS message, n.type, n.priority, n.is_read, n.data,
                n.related_id, n.created_at, n.read_at, n.scheduled_for
           FROM notifications n
          WHERE ${filters.join(' AND ')}
          ORDER BY n.created_at DESC
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...queryParams, safeLimit, safeOffset],
      );

      const countRows = await query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE n.is_read = false)::int AS unread_count
           FROM notifications n
          WHERE ${filters.join(' AND ')}`,
        queryParams,
      );

      return {
        notifications: result.map(n => formatNotificationResponse(n, true)),
        count: result.length,
        total: Number(countRows[0]?.total || 0),
        unread_count: Number(countRows[0]?.unread_count || 0),
        limit: safeLimit,
        offset: safeOffset,
      };
    } catch (error) {
      logger.error('Error getting authenticated user notifications:', error.message);
      throw error;
    }
  },

  /**
   * Get notifications by user ID with filtering
   */
  async getNotificationsByUserId(userId, filters, user) {
    try {
      const userRole = user?.role?.toUpperCase();

      if (!isAdminNotificationRole(userRole)) {
        const userResult = await resolveNotificationUser(user);
        if (userResult.id !== parseInt(userId, 10)) {
          throw new Error('Access denied: Cannot view other user notifications');
        }
      }

      let sql = `
        SELECT n.id, n.title, n.body AS message, n.type, n.priority, n.is_read,
               n.created_at, n.read_at, n.scheduled_for, n.data,
               n.phone
        FROM notifications n
        WHERE n.user_id = $1
      `;
      const params = [userId];

      // Apply filters
      if (filters.unread_only === 'true') {
        sql += ' AND n.is_read = false';
      }

      if (filters.type) {
        sql += ` AND n.type = $${params.length + 1}`;
        params.push(filters.type.toUpperCase());
      }

      if (filters.priority) {
        sql += ` AND n.priority = $${params.length + 1}`;
        params.push(filters.priority.toUpperCase());
      }

      const limit = Math.min(parseInt(filters.limit) || NOTIFICATION_LIMITS.DEFAULT_PAGE_SIZE, NOTIFICATION_LIMITS.MAX_PAGE_SIZE);
      sql += ` ORDER BY n.created_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await query(sql, params);

      // Get unread count
      const unreadResult = await query(
        'SELECT COUNT(*) as unread_count FROM notifications WHERE user_id = $1 AND is_read = false',
        [userId]
      );

      return {
        notifications: result.map(n => formatNotificationResponse(n, userRole === 'ADMIN')),
        count: result.length,
        unread_count: parseInt(unreadResult[0]?.unread_count || 0),
        filters
      };
    } catch (error) {
      logger.error('Error getting notifications by user ID:', error.message);
      throw error;
    }
  },

  /**
   * Get single notification by ID
   */
  async getNotificationById(notificationId, user, markAsRead = true) {
    try {
      const userRole = normalizeRole(user?.role);
      let accessQuery = '';
      const params = [notificationId];

      if (!isAdminNotificationRole(userRole)) {
        const own = await buildOwnNotificationCondition(user, 'n', 2);
        accessQuery = ` AND ${own.condition} AND n.tenant_id = $${own.nextIndex}::uuid`;
        params.push(...own.params, own.current.tenant_id);
      }

      const result = await query(`
        SELECT n.id, n.phone, n.title, n.body AS message, n.type, n.is_read, n.data, n.created_at,
               n.user_id, n.read_at, n.scheduled_for, n.related_id, n.priority,
               u.name as recipient_name, u.phone as recipient_phone
               ${isAdminNotificationRole(userRole) ? ', u.email as recipient_email' : ''}
        FROM notifications n
        LEFT JOIN users u ON n.user_id = u.id
        WHERE n.id = $1${accessQuery}
      `, params);

      if (result.length === 0) {
        throw new Error('Notification not found or access denied');
      }

      // Auto-mark as read when viewed
      if (markAsRead && !result[0].is_read) {
        await query(
          `UPDATE notifications n SET is_read = true, read_at = NOW()
            WHERE id = $1${accessQuery}`,
          params
        );
        result[0].is_read = true;
        result[0].read_at = new Date();
      }

      return formatNotificationResponse(result[0], isAdminNotificationRole(userRole));
    } catch (error) {
      logger.error('Error getting notification by ID:', error.message);
      throw error;
    }
  },

  /**
   * Get notification list with pagination
   */
  async getNotificationList(filters, user) {
    try {
      const allowedSortFields = {
        created_at: 'n.created_at',
        title: 'n.title',
        type: 'n.type',
        priority: 'n.priority',
        is_read: 'n.is_read',
      };
      const listQuery = parseListQuery(filters, {
        defaultLimit: NOTIFICATION_LIMITS.DEFAULT_PAGE_SIZE,
        maxLimit: NOTIFICATION_LIMITS.MAX_PAGE_SIZE,
        defaultSortBy: 'created_at',
        defaultSortOrder: 'DESC',
        allowedSortFields: Object.keys(allowedSortFields),
      });
      const userRole = normalizeRole(user?.role);

      let baseConditions = '1=1';
      const params = [];

      if (!isAdminNotificationRole(userRole)) {
        const own = await buildOwnNotificationCondition(user, 'n', 1);
        baseConditions = `${own.condition} AND n.tenant_id = $${own.nextIndex}::uuid`;
        params.push(...own.params, own.current.tenant_id);
      }

      // Build filter query
      const filterQuery = buildNotificationQuery({
        type: filters.type,
        priority: filters.priority,
        read_status: filters.read === 'true' ? 'read' : filters.read === 'false' ? 'unread' : null,
        search: listQuery.search,
      });

      if (filterQuery.query) {
        baseConditions += offsetPlaceholders(filterQuery.query, params.length);
        params.push(...filterQuery.params);
      }

      const sql = `
        SELECT n.id, n.user_id, n.phone, n.title, n.body AS message, n.type, n.priority, n.is_read,
               n.created_at, n.read_at, n.scheduled_for,
               ${isAdminNotificationRole(userRole) ? 'n.data, u.name as recipient_name, u.phone as recipient_phone' : 'n.data, u.name as recipient_name'}
        FROM notifications n
        LEFT JOIN users u ON n.user_id = u.id
        WHERE ${baseConditions}
        ORDER BY ${allowedSortFields[listQuery.sortBy]} ${listQuery.sortOrder}, n.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;

      params.push(listQuery.limit, listQuery.offset);
      const result = await query(sql, params);

      // Get total count
      const countQuery = `
        SELECT COUNT(*)
        FROM notifications n
        LEFT JOIN users u ON n.user_id = u.id
        WHERE ${baseConditions}
      `;
      const countResult = await query(countQuery, params.slice(0, -2));
      const totalNotifications = parseInt(countResult[0].count);

      return {
        notifications: result.map(n => formatNotificationResponse(n, isAdminNotificationRole(userRole))),
        pagination: buildPagination(totalNotifications, listQuery.page, listQuery.limit),
        filters: {
          ...filters,
          search: listQuery.search || null,
          sortBy: listQuery.sortBy,
          sortOrder: listQuery.sortOrder,
        },
      };
    } catch (error) {
      logger.error('Error getting notification list:', error.message);
      throw error;
    }
  },

  /**
   * Mark notification as read
   */
  async markNotificationAsRead(notificationId, user) {
    try {
      const userRole = normalizeRole(user?.role);
      let accessCondition = '';
      const params = [notificationId];

      if (!isAdminNotificationRole(userRole)) {
        const own = await buildOwnNotificationCondition(user, 'n', 2);
        accessCondition = ` AND ${own.condition} AND n.tenant_id = $${own.nextIndex}::uuid`;
        params.push(...own.params, own.current.tenant_id);
      }

      const result = await query(`
        UPDATE notifications n SET
          is_read = true,
          read_at = NOW()
        WHERE n.id = $1${accessCondition}
        RETURNING id, title, is_read, read_at
      `, params);

      if (result.length === 0) {
        throw new Error('Notification not found or access denied');
      }

      return result[0];
    } catch (error) {
      logger.error('Error marking notification as read:', error.message);
      throw error;
    }
  },

  /**
   * Mark all notifications as read by phone
   */
  async markAllAsReadByPhone(phone, user) {
    try {
      const normalizedPhone = normalizePhone(phone);
      const userRole = normalizeRole(user?.role);

      if (!isAdminNotificationRole(userRole)) {
        const current = await resolveNotificationUser(user);
        if (!current.phone_normalized || current.phone_normalized !== normalizedPhone) {
          throw new Error('Access denied: Cannot modify other user notifications');
        }
      }

      const result = await query(`
        UPDATE notifications SET is_read = TRUE, read_at = NOW() 
        WHERE phone = $1 AND is_read = FALSE
      `, [normalizedPhone]);

      return {
        updated_count: result.rowCount || 0,
        phone: normalizedPhone
      };
    } catch (error) {
      logger.error('Error marking all notifications as read by phone:', error.message);
      throw error;
    }
  },

  /**
   * Mark all authenticated-user notifications as read.
   */
  async markAllMineAsRead(user) {
    try {
      const own = await buildOwnNotificationCondition(user, 'n', 1);
      const result = await query(`
        UPDATE notifications n
           SET is_read = true,
               read_at = COALESCE(read_at, NOW())
         WHERE ${own.condition}
           AND n.tenant_id = $${own.nextIndex}::uuid
           AND n.is_read = false
      `, [...own.params, own.current.tenant_id]);

      return {
        updated_count: result.rowCount || 0,
        user_id: own.current.id,
      };
    } catch (error) {
      logger.error('Error marking authenticated user notifications as read:', error.message);
      throw error;
    }
  },

  /**
   * Mark all user notifications as read
   */
  async markAllAsReadByUserId(userId, user) {
    try {
      const userRole = normalizeRole(user?.role);

      if (!isAdminNotificationRole(userRole)) {
        const current = await resolveNotificationUser(user);
        if (current.id !== parseInt(userId, 10)) {
          throw new Error('Access denied: Cannot modify other user notifications');
        }
      }

      const result = await query(`
        UPDATE notifications SET 
          is_read = true,
          read_at = NOW()
        WHERE user_id = $1 AND is_read = false
      `, [userId]);

      return {
        updated_count: result.rowCount || 0,
        user_id: userId
      };
    } catch (error) {
      logger.error('Error marking all notifications as read by user ID:', error.message);
      throw error;
    }
  },

  /**
   * Create a new notification
   */
  async createNotification(data, user) {
    try {
      const userRole = user?.role?.toUpperCase();

      // Only medical staff and admin can create notifications
      if (!['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(userRole)) {
        throw new Error('Access denied: Medical staff privileges required');
      }

      const {
        user_id, title, message, 
        type = NOTIFICATION_TYPES.SYSTEM, 
        priority = NOTIFICATION_PRIORITIES.MEDIUM,
        scheduled_for = null, data: extraData = null
      } = data;

      // Verify recipient user exists
      const userCheck = await query('SELECT id, uid, name, phone, role, tenant_id FROM users WHERE id = $1', [user_id]);
      if (userCheck.length === 0) {
        throw new Error('Recipient user not found');
      }

      const result = await query(`
        INSERT INTO notifications (
          tenant_id, uid, user_id, phone, title, body, type, priority,
          scheduled_for, data, is_read, created_at, updated_at
        ) VALUES ($1::uuid, $2::uuid, $3::int, $4, $5, $6, $7, $8, $9, $10, false, NOW(), NOW())
        RETURNING id, uid, user_id, phone, title, body AS message, type, priority, data, is_read, created_at
      `, [
        normalizeTenant(userCheck[0].tenant_id || user?.tenantId || user?.tenant_id),
        userCheck[0].uid,
        userCheck[0].id,
        normalizePhone(userCheck[0].phone || '') || 'unknown',
        title,
        message,
        type.toUpperCase(),
        priority.toUpperCase(),
        scheduled_for,
        extraData,
      ]);

      return {
        notification: formatNotificationResponse(result[0], true),
        recipient_name: userCheck[0].name
      };
    } catch (error) {
      logger.error('Error creating notification:', error.message);
      throw error;
    }
  },

  /**
   * Send bulk notifications
   */
  async sendBulkNotifications(data, user) {
    try {
      const userRole = user?.role?.toUpperCase();

      // Only admin can send bulk notifications
      if (userRole !== 'ADMIN') {
        throw new Error('Access denied: Admin privileges required for bulk notifications');
      }

      const { 
        user_ids, title, message, 
        type = NOTIFICATION_TYPES.SYSTEM, 
        priority = NOTIFICATION_PRIORITIES.MEDIUM, 
      } = data;

      if (user_ids.length > NOTIFICATION_LIMITS.MAX_BULK_RECIPIENTS) {
        throw new Error(`Maximum ${NOTIFICATION_LIMITS.MAX_BULK_RECIPIENTS} recipients allowed per bulk notification`);
      }

      // Verify all users exist
      const userCheck = await query(
        'SELECT id, uid, name, phone, tenant_id FROM users WHERE id = ANY($1)',
        [user_ids]
      );

      if (userCheck.length !== user_ids.length) {
        const foundIds = userCheck.map(user => user.id);
        const missingIds = user_ids.filter(id => !foundIds.includes(parseInt(id)));
        throw new Error(`Some users not found: ${missingIds.join(', ')}`);
      }

      // Create notifications for all users
      const notifications = userCheck.map(recipient => [
        normalizeTenant(recipient.tenant_id || user?.tenantId || user?.tenant_id),
        recipient.uid,
        recipient.id,
        normalizePhone(recipient.phone || '') || 'unknown',
        title,
        message,
        type.toUpperCase(),
        priority.toUpperCase(),
      ]);

      const placeholders = notifications.map((_, index) => {
        const offset = index * 8;
        return `($${offset + 1}::uuid, $${offset + 2}::uuid, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, false, NOW(), NOW())`;
      }).join(', ');

      const flatParams = notifications.flat();

      const result = await query(`
        INSERT INTO notifications (tenant_id, uid, user_id, phone, title, body, type, priority, is_read, created_at, updated_at)
        VALUES ${placeholders}
        RETURNING id, uid, user_id
      `, flatParams);

      return {
        notifications_sent: result.length,
        notification_ids: result.map(n => n.id),
        recipients: userCheck.map(u => ({ id: u.id, name: u.name }))
      };
    } catch (error) {
      logger.error('Error sending bulk notifications:', error.message);
      throw error;
    }
  },

  /**
   * Get notification statistics
   */
  async getNotificationStats(days = 7) {
    try {
      const safeDays = parseInt(days) || 7;

      const [totalStats, typeStats, priorityStats, recentActivity] = await Promise.all([
        // Total notification statistics
        query(`
          SELECT
            COUNT(*) as total_notifications,
            COUNT(CASE WHEN is_read = false THEN 1 END) as unread_notifications,
            COUNT(CASE WHEN is_read = true THEN 1 END) as read_notifications,
            COUNT(CASE WHEN created_at >= CURRENT_DATE - make_interval(days => $1) THEN 1 END) as recent_notifications,
            ROUND(AVG(CASE WHEN is_read = true THEN EXTRACT(EPOCH FROM (read_at - created_at))/3600 END), 2) as avg_read_time_hours
          FROM notifications
        `, [safeDays]),

        // Type breakdown
        query(`
          SELECT type, COUNT(*) as count
          FROM notifications
          WHERE created_at >= CURRENT_DATE - make_interval(days => $1)
          GROUP BY type
          ORDER BY count DESC
        `, [safeDays]),

        // Priority breakdown
        query(`
          SELECT priority, COUNT(*) as count
          FROM notifications
          WHERE created_at >= CURRENT_DATE - make_interval(days => $1)
          GROUP BY priority
          ORDER BY
            CASE priority
              WHEN 'HIGH' THEN 1
              WHEN 'MEDIUM' THEN 2
              WHEN 'LOW' THEN 3
            END
        `, [safeDays]),

        // Recent activity (daily counts)
        query(`
          SELECT DATE(created_at) as date, COUNT(*) as count,
                 COUNT(CASE WHEN is_read = true THEN 1 END) as read_count
          FROM notifications
          WHERE created_at >= CURRENT_DATE - make_interval(days => $1)
          GROUP BY DATE(created_at)
          ORDER BY date DESC
        `, [safeDays])
      ]);

      return {
        totals: totalStats[0],
        by_type: typeStats,
        by_priority: priorityStats,
        daily_activity: recentActivity,
        period_days: days
      };
    } catch (error) {
      logger.error('Error getting notification stats:', error.message);
      // Return empty stats on error
      return {
        totals: { total_notifications: 0, unread_notifications: 0, read_notifications: 0 },
        by_type: [],
        by_priority: [],
        daily_activity: [],
        period_days: days
      };
    }
  },

  /**
   * Get scheduled notifications pending delivery
   */
  async getScheduledPending(user) {
    try {
      const userRole = user?.role?.toUpperCase();

      if (!['ADMIN', 'DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
        throw new Error('Access denied: Medical staff privileges required');
      }

      const result = await query(`
        SELECT n.id, n.user_id, n.title, n.body AS message, n.type, n.priority,
               n.scheduled_for, n.data,
               u.name as recipient_name, u.phone, u.email
        FROM notifications n
        JOIN users u ON n.user_id = u.id
        WHERE n.scheduled_for <= NOW() AND n.is_read = false AND n.scheduled_for IS NOT NULL
        ORDER BY n.scheduled_for ASC
        LIMIT 100
      `);

      return {
        notifications: result.map(n => formatNotificationResponse(n, true)),
        count: result.length
      };
    } catch (error) {
      logger.error('Error getting scheduled pending notifications:', error.message);
      throw error;
    }
  },

  /**
   * Get emergency notifications
   */
  async getEmergencyActive(user) {
    try {
      const userRole = user?.role?.toUpperCase();

      if (!['ADMIN', 'DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
        throw new Error('Access denied: Medical staff privileges required');
      }

      const result = await query(`
        SELECT n.id, n.title, n.body AS message, n.created_at, n.data,
               u.name as recipient_name, u.phone
        FROM notifications n
        JOIN users u ON n.user_id = u.id
        WHERE n.type = 'EMERGENCY' AND n.priority = 'HIGH'
          AND n.created_at >= CURRENT_DATE - INTERVAL '24 hours'
        ORDER BY n.created_at DESC
      `);

      return {
        emergency_notifications: result.map(n => formatNotificationResponse(n, true)),
        count: result.length,
        period: 'Last 24 hours'
      };
    } catch (error) {
      logger.error('Error getting emergency notifications:', error.message);
      throw error;
    }
  },

  /**
   * Delete notification
   */
  async deleteNotification(notificationId, user) {
    try {
      const userRole = user?.role?.toUpperCase();

      // Only admin can delete notifications
      if (userRole !== 'ADMIN') {
        throw new Error('Access denied: Admin privileges required');
      }

      const result = await query(
        'DELETE FROM notifications WHERE id = $1 RETURNING id, title, user_id',
        [notificationId]
      );

      if (result.length === 0) {
        throw new Error('Notification not found');
      }

      return result[0];
    } catch (error) {
      logger.error('Error deleting notification:', error.message);
      throw error;
    }
  }
};
// Export the NotificationService class
export class NotificationService {
  static notifyEmergencyTeam = notificationService.notifyEmergencyTeam;
  static getMyNotifications = notificationService.getMyNotifications;
  static getNotificationsByPhone = notificationService.getNotificationsByPhone;
  static getNotificationsByUserId = notificationService.getNotificationsByUserId;
  static getNotificationById = notificationService.getNotificationById;
  static getNotificationList = notificationService.getNotificationList;
  static markNotificationAsRead = notificationService.markNotificationAsRead;
  static markAllAsReadByPhone = notificationService.markAllAsReadByPhone;
  static markAllMineAsRead = notificationService.markAllMineAsRead;
  static markAllAsReadByUserId = notificationService.markAllAsReadByUserId;
  static createNotification = notificationService.createNotification;
  static sendBulkNotifications = notificationService.sendBulkNotifications;
  static getNotificationStats = notificationService.getNotificationStats;
  static getScheduledPending = notificationService.getScheduledPending;
  static getEmergencyActive = notificationService.getEmergencyActive;
  static deleteNotification = notificationService.deleteNotification;
}

// Export individual methods directly for easier imports
export const notifyEmergencyTeam = notificationService.notifyEmergencyTeam;
export const getMyNotifications = notificationService.getMyNotifications;
export const getNotificationsByPhone = notificationService.getNotificationsByPhone;
export const getNotificationsByUserId = notificationService.getNotificationsByUserId;
export const getNotificationById = notificationService.getNotificationById;
export const getNotificationList = notificationService.getNotificationList;
export const markNotificationAsRead = notificationService.markNotificationAsRead;
export const markAllAsReadByPhone = notificationService.markAllAsReadByPhone;
export const markAllMineAsRead = notificationService.markAllMineAsRead;
export const markAllAsReadByUserId = notificationService.markAllAsReadByUserId;
export const createNotification = notificationService.createNotification;
export const sendBulkNotifications = notificationService.sendBulkNotifications;
export const getNotificationStats = notificationService.getNotificationStats;
export const getScheduledPending = notificationService.getScheduledPending;
export const getEmergencyActive = notificationService.getEmergencyActive;
export const deleteNotification = notificationService.deleteNotification;

// Also export the original service for backward compatibility
export { notificationService };
